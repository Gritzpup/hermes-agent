import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HERMES_API, FIRM_JOURNAL_FILE, JOURNAL_TAIL_COUNT, OUTCOMES_LOG } from './config.js';
import { logger } from '@hermes/logger';

export type HermesEvent = {
  key: string;
  source: string;
  summary: string;
  payload: unknown;
  severity: 'info' | 'warn' | 'critical';
};

function hashPayload(payload: unknown): string {
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
}

async function safeGet<T = unknown>(p: string): Promise<T | null> {
  try {
    const res = await fetch(`${HERMES_API}${p}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    logger.debug({ err, path: p }, 'hermes poll failed');
    return null;
  }
}

// Cold-start guard: on first run with no seen-events.jsonl, silently mark current
// journal+event keys as seen so the COO doesn't panic-dispatch 50 historical events
// as "new." Called once at startup from buildRollingContext (idempotent after first run).
export function coldStartSeedSeen(seenDir: string, pollOnceKeys: string[]): void {
  try {
    const seenPath = `${seenDir}/seen-events.jsonl`;
    if (fs.existsSync(seenPath) && fs.statSync(seenPath).size > 0) return;
    fs.mkdirSync(seenDir, { recursive: true });
    const ts = new Date().toISOString();
    const lines = pollOnceKeys.map(k => JSON.stringify({ key: k, seenAt: ts, coldStart: true }));
    fs.writeFileSync(seenPath, lines.join('\n') + (lines.length ? '\n' : ''));
    logger.info({ seeded: lines.length }, 'cold-start: seeded seen-events to suppress history dispatch');
  } catch (err) {
    logger.warn({ err: String(err) }, 'cold-start seed failed (non-fatal)');
  }
}

function tailJournal(n: number): Array<Record<string, unknown>> {
  try {
    if (!fs.existsSync(FIRM_JOURNAL_FILE)) return [];
    const data = fs.readFileSync(FIRM_JOURNAL_FILE, 'utf8');
    const lines = data.split('\n').filter(Boolean);
    return lines
      .slice(-n)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter((x): x is Record<string, unknown> => x !== null);
  } catch (err) {
    logger.debug({ err }, 'journal tail failed');
    return [];
  }
}

export async function pollEvents(): Promise<HermesEvent[]> {
  const out: HermesEvent[] = [];

  const brokerHealth = await safeGet<{ brokers?: Array<{ broker: string; status: string; asOf?: string }> }>('/api/broker-health');
  if (brokerHealth?.brokers) {
    for (const b of brokerHealth.brokers) {
      if (b.status !== 'healthy') {
        out.push({
          key: `broker-unhealthy:${b.broker}:${hashPayload(b)}`,
          source: '/api/broker-health',
          summary: `Broker ${b.broker} is ${b.status}`,
          payload: b,
          severity: 'warn',
        });
      }
    }
  }

  const halt = await safeGet<{ halted?: boolean; reason?: string }>('/api/emergency-halt');
  if (halt?.halted) {
    out.push({
      key: `emergency-halt:${hashPayload(halt)}`,
      source: '/api/emergency-halt',
      summary: `Emergency halt active: ${halt.reason ?? 'unknown'}`,
      payload: halt,
      severity: 'critical',
    });
  }

  const safety = await safeGet<unknown>('/api/live-safety');
  if (safety) {
    out.push({
      key: `live-safety:${hashPayload(safety)}`,
      source: '/api/live-safety',
      summary: 'Live safety snapshot',
      payload: safety,
      severity: 'info',
    });
  }

  const liveLog = await safeGet<unknown[]>('/api/live-log');
  if (Array.isArray(liveLog)) {
    for (const entry of liveLog.slice(-10)) {
      const e = entry as Record<string, unknown>;
      out.push({
        key: `live-log:${hashPayload(entry)}`,
        source: '/api/live-log',
        summary: String(e.msg ?? e.message ?? 'live log entry'),
        payload: entry,
        severity: 'info',
      });
    }
  }

  const director = await safeGet<unknown>('/api/strategy-director/latest');
  if (director) {
    out.push({
      key: `strategy-director:${hashPayload(director)}`,
      source: '/api/strategy-director/latest',
      summary: 'Strategy director update',
      payload: director,
      severity: 'info',
    });
  }

  const capital = await safeGet<unknown>('/api/capital-allocation');
  if (capital) {
    out.push({
      key: `capital:${hashPayload(capital)}`,
      source: '/api/capital-allocation',
      summary: 'Capital allocation update',
      payload: capital,
      severity: 'info',
    });
  }

  const learning = await safeGet<unknown>('/api/learning');
  if (learning) {
    out.push({
      key: `learning:${hashPayload(learning)}`,
      source: '/api/learning',
      summary: 'Learning loop update',
      payload: learning,
      severity: 'info',
    });
  }

  const pnl = await safeGet<unknown>('/api/pnl-attribution');
  if (pnl) {
    out.push({
      key: `pnl:${hashPayload(pnl)}`,
      source: '/api/pnl-attribution',
      summary: 'PnL attribution snapshot',
      payload: pnl,
      severity: 'info',
    });
  }

  const recon = await safeGet<unknown>('/api/pnl-reconciliation');
  if (recon) {
    out.push({
      key: `pnl-recon:${hashPayload(recon)}`,
      source: '/api/pnl-reconciliation',
      summary: 'PnL reconciliation snapshot',
      payload: recon,
      severity: 'info',
    });
  }

  const histctx = await safeGet<unknown>('/api/historical-context');
  if (histctx) {
    out.push({
      key: `histctx:${hashPayload(histctx)}`,
      source: '/api/historical-context',
      summary: 'Historical context snapshot',
      payload: histctx,
      severity: 'info',
    });
  }

  const calendar = await safeGet<unknown[]>('/api/calendar');
  if (Array.isArray(calendar) && calendar.length > 0) {
    out.push({
      key: `calendar:${hashPayload(calendar)}`,
      source: '/api/calendar',
      summary: `Calendar with ${calendar.length} upcoming events`,
      payload: calendar,
      severity: 'info',
    });
  }

  const journalEntries = tailJournal(JOURNAL_TAIL_COUNT);
  for (const entry of journalEntries) {
    const id = (entry as { id?: string }).id;
    if (!id) continue;
    const pnl = Number((entry as { realizedPnl?: number }).realizedPnl ?? 0);
    const severity: 'info' | 'warn' | 'critical' =
      pnl < -50 ? 'critical' : pnl < 0 ? 'warn' : 'info';
    out.push({
      key: `journal:${id}`,
      source: 'journal.jsonl',
      summary: `${(entry as { strategy?: string }).strategy ?? '?'} ${(entry as { symbol?: string }).symbol ?? '?'} closed: pnl=${pnl.toFixed(2)}`,
      payload: entry,
      severity,
    });
  }

  return out;
}

function tailOutcomes(n: number): Array<Record<string, unknown>> {
  try {
    if (!fs.existsSync(OUTCOMES_LOG)) return [];
    const lines = fs.readFileSync(OUTCOMES_LOG, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x): x is Record<string, unknown> => x !== null);
  } catch { return []; }
}

export function buildRollingContext(): Record<string, unknown> {
  const journal = tailJournal(JOURNAL_TAIL_COUNT);
  const totalPnl = journal.reduce((s, e) => s + Number((e as { realizedPnl?: number }).realizedPnl ?? 0), 0);
  const byStrategy: Record<string, { count: number; pnl: number; wins: number; losses: number }> = {};
  for (const e of journal) {
    const s = String((e as { strategy?: string }).strategy ?? 'unknown');
    const p = Number((e as { realizedPnl?: number }).realizedPnl ?? 0);
    byStrategy[s] ??= { count: 0, pnl: 0, wins: 0, losses: 0 };
    byStrategy[s].count++;
    byStrategy[s].pnl += p;
    if (p > 0) byStrategy[s].wins++;
    if (p < 0) byStrategy[s].losses++;
  }
  const recent = journal.slice(-10).map((e) => ({
    strategy: (e as { strategy?: string }).strategy,
    symbol: (e as { symbol?: string }).symbol,
    pnl: Number((e as { realizedPnl?: number }).realizedPnl ?? 0),
  }));
  // Include last 5 past-decision outcomes so the COO can see whether
  // its prior halts/pauses/amplifies correlated with P&L improvements.
  const priorDecisions = tailOutcomes(5).map((o) => ({
    enactedAt: o.enactedAt,
    action: o.action,
    summaryAtAction: o.cooSummary,
    pnlAtAction: ((o.firmSnapshot as Record<string, unknown>) ?? {}).byStrategy,
  }));
  return {
    journalSize: journal.length,
    totalRealizedPnl: Number(totalPnl.toFixed(2)),
    byStrategy,
    recent10: recent,
    priorDecisions,
  };
}
