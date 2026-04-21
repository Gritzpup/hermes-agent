import fs from 'node:fs';
import express from 'express';
import { logger, setupErrorEmitter } from '@hermes/logger';
import { HEALTH_PORT, POLL_INTERVAL_MS, DRY_RUN, HALT_FILE, MINIMAX_BUSY_LOCK, MINIMAX_LOCK_STALE_MS, FAST_PATH_INTERVAL_MS } from './config.js';
import { fastPathTick } from './fast-path.js';
import { ensureRuntimeDir, hasSeen, markSeen } from './state.js';
import { pollEvents, buildRollingContext, coldStartSeedSeen } from './hermes-poller.js';
import { RUNTIME_DIR } from './config.js';
import { askCoo } from './openclaw-client.js';
import { handleCooResponse } from './actions.js';

ensureRuntimeDir();

// Wire logger.error → error-emitter so any service error flows into events.jsonl
// for COO visibility and self-heal.  Safe to call multiple times (idempotent after
// the first patch is applied).
setupErrorEmitter(logger);

// Cold-start guard: on a fresh deploy (no seen-events.jsonl), seed it with current
// journal entries so the first COO dispatch only contains events from right now,
// not historical context the COO would misread as happening live.
(async () => {
  try {
    const initial = await pollEvents();
    coldStartSeedSeen(RUNTIME_DIR, initial.map(e => e.key));
  } catch (err) {
    logger.warn({ err: String(err) }, 'cold-start seeding skipped');
  }
})();

let lastPollAt: string | null = null;
let lastCooAt: string | null = null;
let pollErrors = 0;
let cooCalls = 0;
let cooSuccesses = 0;
let running = true;
let tickInFlight = false;
let skippedBecauseBusy = 0;

const app = express();
app.get('/health', (_req, res) => {
  res.json({
    service: 'openclaw-hermes',
    status: running ? 'healthy' : 'stopping',
    dryRun: DRY_RUN,
    haltFile: fs.existsSync(HALT_FILE),
    lastPollAt,
    lastCooAt,
    pollErrors,
    cooCalls,
    cooSuccesses,
    skippedBecauseBusy,
    skippedBecausePiBusy,
    minimaxLockFresh: isMinimaxLockFresh(),
    tickInFlight,
    timestamp: new Date().toISOString(),
  });
});

// GET /metrics — Prometheus text format (no deps, hand-formatted)
app.get('/metrics', (_req, res) => {
  const now = Date.now();
  const pollAgeSec = lastPollAt ? Math.round((now - Date.parse(lastPollAt)) / 1000) : -1;
  const cooAgeSec = lastCooAt ? Math.round((now - Date.parse(lastCooAt)) / 1000) : -1;
  const lines = [
    '# HELP openclaw_hermes_coo_calls_total Total COO dispatches',
    '# TYPE openclaw_hermes_coo_calls_total counter',
    `openclaw_hermes_coo_calls_total ${cooCalls}`,
    '# HELP openclaw_hermes_coo_successes_total Successful COO responses parsed',
    '# TYPE openclaw_hermes_coo_successes_total counter',
    `openclaw_hermes_coo_successes_total ${cooSuccesses}`,
    '# HELP openclaw_hermes_poll_errors_total Failed poll/parse cycles',
    '# TYPE openclaw_hermes_poll_errors_total counter',
    `openclaw_hermes_poll_errors_total ${pollErrors}`,
    '# HELP openclaw_hermes_ticks_skipped_busy_total Ticks skipped by inflight guard',
    '# TYPE openclaw_hermes_ticks_skipped_busy_total counter',
    `openclaw_hermes_ticks_skipped_busy_total ${skippedBecauseBusy}`,
    '# HELP openclaw_hermes_poll_age_seconds Seconds since last pollEvents (-1 if never)',
    '# TYPE openclaw_hermes_poll_age_seconds gauge',
    `openclaw_hermes_poll_age_seconds ${pollAgeSec}`,
    '# HELP openclaw_hermes_coo_age_seconds Seconds since last COO turn (-1 if never)',
    '# TYPE openclaw_hermes_coo_age_seconds gauge',
    `openclaw_hermes_coo_age_seconds ${cooAgeSec}`,
    '# HELP openclaw_hermes_dry_run 1 if dry-run, else 0',
    '# TYPE openclaw_hermes_dry_run gauge',
    `openclaw_hermes_dry_run ${DRY_RUN ? 1 : 0}`,
    '',
  ].join('\n');
  res.setHeader('content-type', 'text/plain; version=0.0.4');
  res.end(lines);
});

app.listen(HEALTH_PORT, '0.0.0.0', () => {
  logger.info({ port: HEALTH_PORT, dryRun: DRY_RUN }, 'openclaw-hermes bridge ready');
});

let skippedBecausePiBusy = 0;

function isMinimaxLockFresh(): boolean {
  try {
    const st = fs.statSync(MINIMAX_BUSY_LOCK);
    return Date.now() - st.mtimeMs < MINIMAX_LOCK_STALE_MS;
  } catch { return false; }
}

async function tick() {
  if (tickInFlight) {
    skippedBecauseBusy++;
    logger.debug('tick skipped: previous COO call still in flight');
    return;
  }
  if (isMinimaxLockFresh()) {
    skippedBecausePiBusy++;
    logger.info({ lock: MINIMAX_BUSY_LOCK }, 'tick yielded: manual pi/minimax call in flight');
    return;
  }
  tickInFlight = true;
  try {
    lastPollAt = new Date().toISOString();
    const events = await pollEvents();
    const unseen = events.filter((e) => !hasSeen(e.key));

    if (unseen.length === 0) {
      logger.debug('no new events');
      tickInFlight = false; // release mutex before early-return
      return;
    }

    logger.info({ count: unseen.length }, 'dispatching events to COO');
    const compact = unseen.map((e) => ({
      source: e.source,
      summary: e.summary,
      severity: e.severity,
      payload: e.payload,
    }));
    const context = buildRollingContext();
    cooCalls++;
    const resp = await askCoo(compact, context);
    lastCooAt = new Date().toISOString();

    if (!resp) {
      logger.warn('COO returned no usable response, not marking events seen');
      pollErrors++;
      return;
    }

    cooSuccesses++;
    for (const e of unseen) markSeen(e.key, { summary: e.summary });
    logger.info({ summary: resp.summary, actions: resp.actions?.length ?? 0 }, 'COO response received');
    await handleCooResponse(resp);
    // Dead-man's-switch heartbeat: tell hermes-api we're alive + what we've been doing.
    // Fire-and-forget; never blocks the tick.
    void fetch('http://127.0.0.1:4300/api/coo/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cooCalls, cooSuccesses, pollErrors, lastPollAt, lastCooAt }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  } catch (err) {
    pollErrors++;
    logger.error({ err }, 'tick failed');
  } finally {
    tickInFlight = false;
  }
}

tick().catch(() => {});
const interval = setInterval(() => {
  tick().catch(() => {});
}, POLL_INTERVAL_MS);

// Fast path: 30s rule-based halt checks. No LLM, independent of the slow LLM tick.
fastPathTick().catch(() => {});
const fastInterval = setInterval(() => {
  fastPathTick().catch(() => {});
}, FAST_PATH_INTERVAL_MS);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    logger.info({ sig }, 'shutting down');
    running = false;
    clearInterval(interval);
    clearInterval(fastInterval);
    process.exit(0);
  });
}
