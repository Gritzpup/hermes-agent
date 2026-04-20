import fs from 'node:fs';
import { HERMES_API, DRY_RUN, HALT_FILE, DIRECTIVES_FILE, ACTIONS_LOG, FIRM_EVENTS_FILE } from './config.js';
import { appendJsonl } from './state.js';
import { logger } from '@hermes/logger';
import type { CooAction, CooResponse } from './openclaw-client.js';

function isHalted(): boolean {
  return fs.existsSync(HALT_FILE);
}

async function post(p: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${HERMES_API}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch (err) {
    logger.error({ err, path: p }, 'hermes POST failed');
    return false;
  }
}

function writeFirmEvent(type: string, body: Record<string, unknown>): boolean {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      source: 'openclaw-coo',
      ...body,
    };
    fs.appendFileSync(FIRM_EVENTS_FILE, JSON.stringify(entry) + '\n');
    return true;
  } catch (err) {
    logger.error({ err }, 'failed to write to firm events.jsonl');
    return false;
  }
}

async function enact(action: CooAction, cooSummary: string): Promise<void> {
  const entry = {
    action,
    cooSummary,
    dryRun: DRY_RUN,
    halted: isHalted(),
    enactedAt: new Date().toISOString(),
  };
  fs.appendFileSync(ACTIONS_LOG, JSON.stringify(entry) + '\n');

  if (DRY_RUN || isHalted()) {
    logger.info({ action }, `NOT enacting (${DRY_RUN ? 'dry-run' : 'halt-file'})`);
    return;
  }

  switch (action.type) {
    case 'halt':
      await post('/api/emergency-halt', { operator: 'openclaw-coo', reason: action.reason });
      writeFirmEvent('coo-halt', { reason: action.reason, cooSummary });
      logger.warn({ reason: action.reason }, 'emergency halt triggered by COO');
      break;
    case 'clear-halt':
      await post('/api/emergency-halt/clear', { operator: 'openclaw-coo' });
      writeFirmEvent('coo-halt-clear', { reason: action.reason, cooSummary });
      logger.info({ reason: action.reason }, 'emergency halt cleared by COO');
      break;
    case 'directive':
      appendJsonl(DIRECTIVES_FILE, { directive: action.text, priority: action.priority ?? 'normal', cooSummary });
      await post('/api/coo/directive', { text: action.text, priority: action.priority ?? 'normal', rationale: cooSummary });
      logger.info({ directive: action.text }, 'COO directive sent to firm');
      break;
    case 'note':
      appendJsonl(DIRECTIVES_FILE, { note: action.text, cooSummary });
      await post('/api/coo/note', { text: action.text });
      break;
    case 'pause-strategy':
      appendJsonl(DIRECTIVES_FILE, { pauseStrategy: action.strategy, reason: action.reason, cooSummary });
      await post('/api/coo/pause-strategy', { strategy: action.strategy, reason: action.reason });
      logger.warn({ strategy: action.strategy, reason: action.reason }, 'COO paused strategy');
      break;
    case 'amplify-strategy':
      appendJsonl(DIRECTIVES_FILE, { amplifyStrategy: action.strategy, reason: action.reason, factor: action.factor, cooSummary });
      await post('/api/coo/amplify-strategy', { strategy: action.strategy, reason: action.reason, factor: action.factor });
      logger.info({ strategy: action.strategy, factor: action.factor }, 'COO amplified strategy');
      break;
    case 'write-event':
      writeFirmEvent(action.eventType, { ...(action.body ?? {}), cooSummary });
      logger.info({ eventType: action.eventType }, 'COO wrote event to firm stream');
      break;
    case 'noop':
      break;
  }
}

export async function handleCooResponse(resp: CooResponse): Promise<void> {
  for (const action of resp.actions ?? []) {
    await enact(action, resp.summary);
  }
}
