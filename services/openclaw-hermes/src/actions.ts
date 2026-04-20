import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { HERMES_API, DRY_RUN, HALT_FILE, DIRECTIVES_FILE, ACTIONS_LOG, FIRM_EVENTS_FILE, OUTCOMES_LOG } from './config.js';
import { appendJsonl } from './state.js';
import { logger } from '@hermes/logger';
import type { CooAction, CooResponse } from './openclaw-client.js';

// Closed-loop learning: snapshot firm P&L at the moment of each consequential action,
// so later ticks can measure whether the decision helped. Stored as JSONL; read by
// the poller's rolling-context builder so the COO sees outcomes of its past decisions.
async function snapshotOutcome(action: CooAction, cooSummary: string): Promise<void> {
  try {
    const res = await fetch(`${HERMES_API}/api/pnl-attribution`, { signal: AbortSignal.timeout(5000) });
    const pnl = res.ok ? (await res.json()) as Record<string, unknown> : null;
    const entry = {
      enactedAt: new Date().toISOString(),
      action,
      cooSummary,
      firmSnapshot: pnl ? { totalTrades: pnl.totalTrades, byStrategy: pnl.byStrategy } : null,
    };
    fs.appendFileSync(OUTCOMES_LOG, JSON.stringify(entry) + '\n');
  } catch (err) {
    logger.warn({ err: String(err) }, 'outcome snapshot failed (non-fatal)');
  }
}

// User-authorized: open a GitHub issue on critical COO actions so the user sees
// consequential decisions in their GitHub inbox. Uses `gh` CLI with the user's
// stored token. Silent no-op if `gh` is missing or auth fails — never blocks enactment.
//
// Rate-limit: at most one issue per (label-set + title-prefix) per 30 min, to keep
// rapid COO escalation from spamming the GitHub inbox.
const GH_ISSUE_RATELIMIT_MS = 30 * 60 * 1000;
const recentGhIssues = new Map<string, number>();

function openGhIssue(title: string, body: string, labels: string[]): void {
  const key = labels.slice().sort().join(',') + ':' + title.slice(0, 60);
  const lastAt = recentGhIssues.get(key) ?? 0;
  const now = Date.now();
  if (now - lastAt < GH_ISSUE_RATELIMIT_MS) {
    logger.debug({ title, skippedMinsAgo: Math.round((now - lastAt) / 60000) }, 'gh issue rate-limited');
    return;
  }
  recentGhIssues.set(key, now);
  const args = ['issue', 'create', '--title', title.slice(0, 200), '--body', body];
  for (const l of labels) { args.push('--label', l); }
  const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));
  child.on('close', (code) => {
    if (code === 0) logger.info({ title }, 'COO opened GitHub issue');
    else logger.warn({ title, code, stderr: stderr.slice(0, 200) }, 'gh issue create failed (non-fatal)');
  });
  child.on('error', (err) => logger.warn({ err: String(err) }, 'gh binary unavailable — skipping issue'));
}

// Halt rate-limit: after a halt fires, refuse to fire another within 5 min.
// Defense-in-depth against COO whiplash if inputs destabilize.
const HALT_COOLDOWN_MS = 5 * 60 * 1000;
let lastHaltAt = 0;

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

  // Closed-loop learning: snapshot firm state at moment of any consequential action,
  // so the COO (via rolling context) can later see whether its decisions worked.
  if (action.type === 'halt' || action.type === 'clear-halt' || action.type === 'pause-strategy' || action.type === 'amplify-strategy') {
    await snapshotOutcome(action, cooSummary);
  }

  switch (action.type) {
    case 'halt':
      if (Date.now() - lastHaltAt < HALT_COOLDOWN_MS) {
        logger.warn({ reason: action.reason, cooldownMsLeft: HALT_COOLDOWN_MS - (Date.now() - lastHaltAt) }, 'halt suppressed by cooldown — COO asked again within 5 min');
        break;
      }
      lastHaltAt = Date.now();
      await post('/api/emergency-halt', { operator: 'openclaw-coo', reason: action.reason });
      writeFirmEvent('coo-halt', { reason: action.reason, cooSummary });
      openGhIssue(
        `[COO HALT] ${action.reason}`,
        `The COO triggered an emergency halt at ${new Date().toISOString()}.\n\n**Reason:** ${action.reason}\n\n**COO summary:** ${cooSummary}\n\nRaw actions log: \`services/openclaw-hermes/.runtime/coo-actions.log\`\nFirm event stream: \`services/api/.runtime/paper-ledger/events.jsonl\``,
        ['coo', 'halt', 'critical']
      );
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
      openGhIssue(
        `[COO PAUSE] ${action.strategy}`,
        `The COO recommended pausing strategy **${action.strategy}**.\n\n**Reason:** ${action.reason}\n\n**COO summary:** ${cooSummary}\n\nThis was written to the firm's event stream as type \`coo-pause-strategy\`. Other services (strategy-director, review-loop) should consume it from \`/api/coo/directives\` or \`events.jsonl\`.`,
        ['coo', 'pause-strategy']
      );
      logger.warn({ strategy: action.strategy, reason: action.reason }, 'COO paused strategy');
      break;
    case 'amplify-strategy':
      appendJsonl(DIRECTIVES_FILE, { amplifyStrategy: action.strategy, reason: action.reason, factor: action.factor, cooSummary });
      await post('/api/coo/amplify-strategy', { strategy: action.strategy, reason: action.reason, factor: action.factor });
      logger.info({ strategy: action.strategy, factor: action.factor }, 'COO amplified strategy');
      break;
    case 'force-close-symbol':
      appendJsonl(DIRECTIVES_FILE, { forceCloseSymbol: action.symbol, reason: action.reason, cooSummary });
      await post('/api/coo/force-close-symbol', { symbol: action.symbol, reason: action.reason });
      logger.warn({ symbol: action.symbol, reason: action.reason }, 'COO force-close-symbol');
      break;
    case 'set-max-positions':
      appendJsonl(DIRECTIVES_FILE, { setMaxPositions: { scope: action.scope, strategy: action.strategy, max: action.max }, reason: action.reason, cooSummary });
      await post('/api/coo/set-max-positions', { scope: action.scope, strategy: action.strategy, max: action.max, reason: action.reason });
      logger.info({ scope: action.scope, max: action.max }, 'COO set-max-positions');
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
