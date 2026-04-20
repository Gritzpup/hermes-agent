// Fast path: rule-based halt checks that do NOT spawn an LLM.
//
// Runs every FAST_PATH_INTERVAL_MS (default 30s). The slow LLM path (10 min)
// handles strategic judgment — pausing strategies, amplifying winners, writing
// directives. Anything that needs sub-minute reaction lives here.
//
// Current rules:
//   1. Realized drawdown — sum realizedPnl for journal entries with
//      exitAt within the last FAST_PATH_WINDOW_MS. If the sum is worse than
//      -FAST_PATH_DRAWDOWN_USD, POST /api/emergency-halt.
//   2. Systemic broker outage — count distinct brokers with the most recent
//      broker-health event marked unhealthy/degraded/offline within the last
//      10 min. If >= FAST_PATH_MIN_UNHEALTHY_BROKERS, halt.
//
// Throttle: skip if the firm's halt file already exists (hermes-api writes it).
// On halt, we just POST the endpoint; hermes-api persists + logs + emits event.

import fs from 'node:fs';
import {
  HERMES_API,
  FIRM_JOURNAL_FILE,
  FIRM_EVENTS_FILE,
  FAST_PATH_DRAWDOWN_USD,
  FAST_PATH_WINDOW_MS,
  FAST_PATH_MIN_UNHEALTHY_BROKERS,
  DRY_RUN,
} from './config.js';
import { logger } from '@hermes/logger';

type JournalEntry = {
  exitAt?: string;
  realizedPnl?: number;
  broker?: string;
  strategy?: string;
};

type EventEntry = {
  timestamp?: string;
  source?: string;
  summary?: string;
  payload?: Record<string, unknown>;
};

// Read last ~N bytes of a file efficiently. journal.jsonl grows; we don't need the whole thing.
function tailBytes(file: string, bytes: number): string {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let text = buf.toString('utf8');
    // Drop the first (likely partial) line if we seeked into the middle.
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text;
  } catch { return ''; }
}

function parseLines<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s) as T); } catch { /* skip corrupt line */ }
  }
  return out;
}

function haltFileExists(): boolean {
  // hermes-api writes to its own runtime emergency-halt.json; we check via health
  // for simplicity, but also accept a local cached check. For now use the health probe.
  return false; // Always re-check via API — the POST itself is idempotent enough; hermes-api no-ops if already halted.
}

let lastHaltAt = 0;
const RE_HALT_COOLDOWN_MS = 15 * 60_000;  // don't re-trigger halt within 15 min

async function postHalt(reason: string): Promise<void> {
  if (DRY_RUN) {
    logger.warn({ reason }, 'fast-path: DRY_RUN — would halt');
    return;
  }
  if (Date.now() - lastHaltAt < RE_HALT_COOLDOWN_MS) {
    logger.info({ reason }, 'fast-path: within re-halt cooldown, skipping POST');
    return;
  }
  lastHaltAt = Date.now();
  try {
    const res = await fetch(`${HERMES_API}/api/emergency-halt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operator: 'fast-path', reason }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.error({ status: res.status, reason }, 'fast-path: halt POST returned non-ok');
      return;
    }
    logger.warn({ reason }, 'fast-path: EMERGENCY HALT triggered');
  } catch (err) {
    logger.error({ err: String(err), reason }, 'fast-path: halt POST failed');
  }
}

function checkDrawdown(): string | null {
  // Only read the last ~2MB of journal — plenty for a 60-min window even on a busy day.
  const text = tailBytes(FIRM_JOURNAL_FILE, 2 * 1024 * 1024);
  if (!text) return null;
  const now = Date.now();
  const cutoff = now - FAST_PATH_WINDOW_MS;
  const rows = parseLines<JournalEntry>(text);
  let sum = 0;
  let count = 0;
  for (const r of rows) {
    const t = r.exitAt ? Date.parse(r.exitAt) : NaN;
    if (!Number.isFinite(t) || t < cutoff) continue;
    const pnl = typeof r.realizedPnl === 'number' ? r.realizedPnl : 0;
    sum += pnl;
    count++;
  }
  if (sum <= -FAST_PATH_DRAWDOWN_USD) {
    return `realized drawdown $${sum.toFixed(2)} across ${count} trades in last ${Math.round(FAST_PATH_WINDOW_MS / 60_000)}m exceeds threshold $${FAST_PATH_DRAWDOWN_USD}`;
  }
  return null;
}

function checkBrokerOutage(): string | null {
  const text = tailBytes(FIRM_EVENTS_FILE, 512 * 1024);
  if (!text) return null;
  const cutoff = Date.now() - 10 * 60_000;
  const rows = parseLines<EventEntry>(text);
  const latestByBroker = new Map<string, { ts: number; status: string }>();
  for (const r of rows) {
    if (r.source !== 'broker-health') continue;
    const t = r.timestamp ? Date.parse(r.timestamp) : NaN;
    if (!Number.isFinite(t) || t < cutoff) continue;
    const p = r.payload ?? {};
    const broker = typeof p.broker === 'string' ? p.broker : typeof p.name === 'string' ? p.name : null;
    const status = typeof p.status === 'string' ? p.status : typeof p.state === 'string' ? p.state : '';
    if (!broker) continue;
    const prev = latestByBroker.get(broker);
    if (!prev || t > prev.ts) latestByBroker.set(broker, { ts: t, status });
  }
  const unhealthy = [...latestByBroker.entries()].filter(
    ([, v]) => /degraded|offline|unhealthy|down/i.test(v.status),
  );
  if (unhealthy.length >= FAST_PATH_MIN_UNHEALTHY_BROKERS) {
    const names = unhealthy.map(([b]) => b).join(', ');
    return `${unhealthy.length} brokers unhealthy in last 10m: ${names}`;
  }
  return null;
}

export async function fastPathTick(): Promise<void> {
  try {
    if (haltFileExists()) return;
    const ddReason = checkDrawdown();
    if (ddReason) { await postHalt(`fast-path: ${ddReason}`); return; }
    const brokerReason = checkBrokerOutage();
    if (brokerReason) { await postHalt(`fast-path: ${brokerReason}`); return; }
  } catch (err) {
    logger.error({ err: String(err) }, 'fast-path tick failed');
  }
}
