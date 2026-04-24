import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';

// Load .env from repo root — dotenv/config defaults to cwd/.env which varies
// depending on whether tilt or tsx starts the process
dotenvConfig({ path: '/mnt/Storage/github/hermes-trading-firm/.env' });

import express from 'express';
import { logger, setupErrorEmitter } from '@hermes/logger';
import { redis } from '@hermes/infra';
import { fastPathTick } from './fast-path.js';
import { ensureRuntimeDir, hasSeen, markSeen } from './state.js';
import { pollEvents, buildRollingContext, coldStartSeedSeen } from './hermes-poller.js';
import { RUNTIME_DIR, CFO_URL } from './config.js';
import { HEALTH_PORT, POLL_INTERVAL_MS, DRY_RUN, HALT_FILE, FAST_PATH_INTERVAL_MS } from './config.js';
import { askCoo } from './openclaw-client.js';
import { handleCooResponse } from './actions.js';
import { fetchCfoAlerts } from './cfo-client.js';
import { SelfHealOrchestrator } from './self-heal.js';

ensureRuntimeDir();
setupErrorEmitter(logger);

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
let cfoLastOkAt: string | null = null;
let cfoLastFailAt: string | null = null;
let cfoConsecutiveErrors = 0;

const selfHeal = new SelfHealOrchestrator();

const app = express();
app.use(express.json());

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
    tickInFlight,
    selfHeal: selfHeal.status(),
    // CFO connectivity — refreshed on every tick; if CFO is down, this will be stale
    cfo: {
      url: CFO_URL,
      lastOk: cfoLastOkAt,
      lastFail: cfoLastFailAt,
      consecutiveErrors: cfoConsecutiveErrors,
      status: cfoConsecutiveErrors === 0 ? 'ok' : cfoConsecutiveErrors < 3 ? 'degraded' : 'unreachable',
    },
    timestamp: new Date().toISOString(),
  });
});

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

// CFO → COO webhook: receive critical alerts immediately instead of waiting for next poll
app.post('/webhook/cfo-alert', async (req, res) => {
  try {
    const alert = req.body;
    logger.warn({ alert }, 'CFO critical alert received via webhook');

    // Idempotency: dedupe by alert ID + received-at (sliding 10-min window).
    // If the same alert has already triggered within 10 min, skip it.
    const alertKey = alert?.alertId ?? alert?.id ?? JSON.stringify(alert).slice(0, 80);
    const now = Date.now();
    const idemKey = `cfo:webhook:seen:${alertKey}`;
    try {
      const prior = await redis.get(idemKey);
      if (prior) {
        // Already received within the dedup window — acknowledge but don't retrigger
        logger.info({ alertKey }, 'CFO webhook idempotency: already seen, skipping');
        res.json({ received: true, deduplicated: true });
        return;
      }
      await redis.setex(idemKey, 600, now.toString()); // 10-min dedup window
    } catch { /* redis unavailable — proceed */ }

    // Write to the alerts file so buildRollingContext picks it up if HTTP CFO fetch fails
    try {
      const { readFileSync, writeFileSync } = await import('node:fs');
      const existing = JSON.parse(readFileSync('/tmp/cfo-alerts.json', 'utf8') as string) as { alerts?: unknown[] };
      const alerts = Array.isArray(existing?.alerts) ? existing.alerts : [];
      if (alert?.alerts?.length) {
        // Merge new webhook alerts, dedup by metric, keep last 20
        const newAlerts = [...alerts, ...alert.alerts].slice(-20);
        writeFileSync('/tmp/cfo-alerts.json', JSON.stringify({ alerts: newAlerts, updatedAt: new Date().toISOString() }));
      }
    } catch { /* non-fatal */ }
    // Immediately trigger a COO tick if not already in flight
    if (!tickInFlight) {
      void tick(true);
    }
    res.json({ received: true, deduplicated: false });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.listen(HEALTH_PORT, '0.0.0.0', () => {
  logger.info({ port: HEALTH_PORT, dryRun: DRY_RUN }, 'openclaw-hermes bridge ready (Ollama Bonsai COO + MiniMax CFO)');
});

async function tick(force = false) {
  if (tickInFlight) {
    skippedBecauseBusy++;
    logger.debug('tick skipped: previous COO call still in flight');
    return;
  }
  tickInFlight = true;
  try {
    const events = await pollEvents();
    lastPollAt = new Date().toISOString();
    const unseen = events.filter((e) => !hasSeen(e.key));

    if (unseen.length === 0 && !force) {
      tickInFlight = false;
      return;
    }

    logger.info({ count: unseen.length, forced: force }, 'dispatching events to COO');
    const compact = unseen.map((e) => ({
      source: e.source,
      summary: e.summary,
      severity: e.severity,
      payload: e.payload,
    }));
    const context = buildRollingContext();

    // Enrich context with live CFO alerts
    try {
      const cfoAlerts = await fetchCfoAlerts();
      (context as Record<string, unknown>).cfoAlerts = cfoAlerts;
      cfoConsecutiveErrors = 0;
      cfoLastOkAt = new Date().toISOString();
    } catch (err) {
      cfoConsecutiveErrors++;
      cfoLastFailAt = new Date().toISOString();
      logger.warn({ err: String(err), consecutiveErrors: cfoConsecutiveErrors }, 'CFO fetch failed, continuing without alerts');
    }

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

    // Self-heal: attempt any deferred recoveries
    await selfHeal.runDeferred();

    void fetch('http://127.0.0.1:4300/api/coo/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cooCalls, cooSuccesses, pollErrors, lastPollAt, lastCooAt }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  } catch (err) {
    pollErrors++;
    logger.error({ err }, 'tick failed');
    selfHeal.recordError('openclaw-hermes:tick', String(err), 'restart:openclaw-hermes');
  } finally {
    tickInFlight = false;
  }
}

tick().catch(() => {});
const interval = setInterval(() => {
  tick().catch(() => {});
}, POLL_INTERVAL_MS);

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