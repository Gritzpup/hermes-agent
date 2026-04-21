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

  // ── Regime-change detection (profit lever #2) ──────────────────────────
  // Grids bleed in trending regimes and profit in chop. Escalating the event
  // severity on regime transition lets the COO pre-emptively pause grids
  // before losses accumulate.
  const regimeSnapshot = await safeGet<{ perSymbol?: Record<string, { regime?: string }> }>('/api/eod-analysis/regime');
  if (regimeSnapshot?.perSymbol) {
    for (const [sym, info] of Object.entries(regimeSnapshot.perSymbol)) {
      const r = info?.regime;
      if (r === 'trending' || r === 'trending-up' || r === 'trending-down') {
        out.push({
          key: `regime-trending:${sym}:${r}`,
          source: '/api/eod-analysis/regime',
          summary: `${sym} regime=${r} — grids bleed in trends; consider pausing grid-${sym.toLowerCase().replace(/[^a-z]/g, '-')}`,
          payload: { symbol: sym, regime: r, fullSnapshot: info },
          severity: 'warn',
        });
      }
    }
  }

  // ── Correlation / cascade detection (profit lever #3) ──────────────────
  // If 3+ grid strategies simultaneously have 3+ consecutive losses in the
  // recent journal, that's a correlated-drawdown signal — crypto beta
  // likely turned negative. COO should pause the weakest grid.
  const rawJournal = tailJournal(JOURNAL_TAIL_COUNT);
  const gridStrategies = ['grid-btc-usd', 'grid-eth-usd', 'grid-sol-usd', 'grid-xrp-usd'];
  const bleedingGrids: string[] = [];
  for (const g of gridStrategies) {
    const gRows = rawJournal.filter((r) => (r as { strategyId?: string }).strategyId === g);
    const last3 = gRows.slice(-3);
    if (last3.length === 3 && last3.every((r) => Number((r as { realizedPnl?: number }).realizedPnl ?? 0) < 0)) {
      bleedingGrids.push(g);
    }
  }
  if (bleedingGrids.length >= 3) {
    out.push({
      key: `cascade-risk:${bleedingGrids.sort().join(',')}`,
      source: 'correlation-monitor',
      summary: `CASCADE RISK: ${bleedingGrids.length}/4 grids bleeding (3+ consecutive losses each): ${bleedingGrids.join(', ')} — consider pausing the weakest`,
      payload: { bleedingGrids, totalGrids: gridStrategies.length, threshold: 3 },
      severity: 'critical',
    });
  }

  const journalEntries = rawJournal;
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

// Byte-based tail for large JSONL files.  Used for events.jsonl (300K+ lines).
// Drop partial first line if we seeked into the middle of a record.
function tailErrorBytes(file: string, bytes: number): string {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text;
  } catch { return ''; }
}

const ERROR_TAIL_BYTES = Number(process.env.OPENCLAW_HERMES_ERROR_TAIL_BYTES ?? 200_000);

function tailErrorEvents(n: number): Array<Record<string, unknown>> {
  const EVENTS_FILE = '/mnt/Storage/github/hermes-trading-firm/services/api/.runtime/paper-ledger/events.jsonl';
  try {
    if (!fs.existsSync(EVENTS_FILE)) return [];
    const text = tailErrorBytes(EVENTS_FILE, ERROR_TAIL_BYTES);
    const lines = text.split('\n').filter(Boolean);
    const errorEvents = lines
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter((x): x is Record<string, unknown> => x !== null && (x as Record<string, unknown>).source === 'error-event');
    return errorEvents.slice(-n);
  } catch (err) {
    logger.debug({ err }, 'tailErrorEvents failed');
    return [];
  }
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

  // Recent errors: last 200 error-event entries, filter to last 60 minutes, bucket by service:errorHash.
  // Each distinct error (different errorHash) gets its own slot so the COO sees all error types,
  // not just the first one per service (fixes collapsing in the 60-min rolling window).
  const recentErrors: Record<string, { count: number; firstSeen: string; lastSeen: string; errorType: string; message: string; scriptKeyHint: string }> = {};
  const now = Date.now();
  const sixtyMinutesAgo = now - 60 * 60 * 1000;
  const errorEvents = tailErrorEvents(200);
  for (const e of errorEvents) {
    const ts = (e as { timestamp?: string }).timestamp ?? '';
    const ms = ts ? new Date(ts).getTime() : 0;
    if (ms < sixtyMinutesAgo) continue;
    const service = String((e as { service?: string }).service ?? 'unknown');
    const errorType = String((e as { errorType?: string }).errorType ?? 'unknown');
    const message = String((e as { message?: string }).message ?? '');
    const scriptKeyHint = String((e as { scriptKeyHint?: string }).scriptKeyHint ?? '');
    const errorHash = String((e as { errorHash?: string }).errorHash ?? errorType);
    const key = `${service}:${errorHash}`;
    if (!recentErrors[key]) {
      recentErrors[key] = { count: 0, firstSeen: ts, lastSeen: ts, errorType, message, scriptKeyHint };
    }
    recentErrors[key].count++;
    if (ms > new Date(recentErrors[key].lastSeen).getTime()) {
      recentErrors[key].lastSeen = ts;
    }
    if (ms < new Date(recentErrors[key].firstSeen).getTime()) {
      recentErrors[key].firstSeen = ts;
    }
  }

  // Pull CFO alerts synchronously-from-cache so the COO sees profitability
  // guidance alongside errors. The CFO writes /tmp/cfo-alerts.json on each of
  // its 6h cycles; we just read the file (no HTTP) so this can't delay the tick.
  let cfoAlerts: unknown[] = [];
  try {
    const raw = fs.readFileSync('/tmp/cfo-alerts.json', 'utf8');
    const parsed = JSON.parse(raw) as { alerts?: unknown[] };
    if (Array.isArray(parsed.alerts)) {
      // Trim each alert to a single line payload to keep rolling-context lean.
      cfoAlerts = parsed.alerts.slice(-20);
    }
  } catch {}

  return {
    journalSize: journal.length,
    totalRealizedPnl: Number(totalPnl.toFixed(2)),
    byStrategy,
    recent10: recent,
    priorDecisions,
    recentErrors,
    cfoAlerts,
  };
}
