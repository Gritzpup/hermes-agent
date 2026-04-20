import fs from 'node:fs';
import express from 'express';
import { logger } from '@hermes/logger';
import { HEALTH_PORT, POLL_INTERVAL_MS, DRY_RUN, HALT_FILE } from './config.js';
import { ensureRuntimeDir, hasSeen, markSeen } from './state.js';
import { pollEvents, buildRollingContext } from './hermes-poller.js';
import { askCoo } from './openclaw-client.js';
import { handleCooResponse } from './actions.js';

ensureRuntimeDir();

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
    tickInFlight,
    timestamp: new Date().toISOString(),
  });
});

app.listen(HEALTH_PORT, '0.0.0.0', () => {
  logger.info({ port: HEALTH_PORT, dryRun: DRY_RUN }, 'openclaw-hermes bridge ready');
});

async function tick() {
  if (tickInFlight) {
    skippedBecauseBusy++;
    logger.debug('tick skipped: previous COO call still in flight');
    return;
  }
  tickInFlight = true;
  try {
    lastPollAt = new Date().toISOString();
    const events = await pollEvents();
    const unseen = events.filter((e) => !hasSeen(e.key));

    if (unseen.length === 0) {
      logger.debug('no new events');
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

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    logger.info({ sig }, 'shutting down');
    running = false;
    clearInterval(interval);
    process.exit(0);
  });
}
