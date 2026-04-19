import './load-env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { logger } from '@hermes/logger';

const app = express();
const PORT = Number(process.env.PORT ?? 4305);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PAPER_LEDGER_PATH = process.env.PAPER_LEDGER_PATH
  ?? path.resolve(MODULE_DIR, '../../api/.runtime/paper-ledger/journal.jsonl');
const EOD_OUTPUT_DIR = process.env.EOD_OUTPUT_DIR
  ?? path.resolve(MODULE_DIR, '../../api/.runtime/eod-reports');

// ── Helpers ─────────────────────────────────────────────────────────────────────

function round(v: number, decimals = 2): number {
  return Math.round(v * 10 ** decimals) / 10 ** decimals;
}

interface TradeEntry {
  symbol?: string;
  lane?: string;
  strategy?: string;
  realizedPnl?: number | null;
  realizedPnlPct?: number | null;
  spreadBps?: number | null;
  slippageBps?: number | null;
  regime?: string | null;
  entryRegime?: string | null;
  entryAt?: string;
  exitAt?: string;
  verdict?: string;
  source?: string;
  entryPrice?: number | null;
  exitPrice?: number | null;
}

function loadJournal(): TradeEntry[] {
  if (!fs.existsSync(PAPER_LEDGER_PATH)) return [];
  return fs.readFileSync(PAPER_LEDGER_PATH, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => {
      try { return JSON.parse(l) as TradeEntry; }
      catch { return null; }
    })
    .filter((e): e is TradeEntry => e !== null);
}

function laneStats(entries: TradeEntry[]) {
  const pnl = round(entries.reduce((s, e) => s + (e.realizedPnl ?? 0), 0));
  const wr = entries.length > 0
    ? round((entries.filter(e => (e.realizedPnl ?? 0) > 0).length / entries.length) * 100, 1)
    : 0;
  const avg = entries.length > 0 ? round(pnl / entries.length) : 0;
  return { trades: entries.length, wr, pnl, avg };
}

function todayEntries(journal: TradeEntry[], cutoffSec = 16 * 3600): TradeEntry[] {
  const now = new Date();
  const nyOffset = 5 * 3600 * 1000; // EST/EDT offset
  const nyMs = now.getTime() - (now.getTimezoneOffset() * 60000) - nyOffset;
  const todayStart = new Date(nyMs).setHours(0, 0, 0, 0);
  return journal.filter(e => {
    const ts = e.exitAt ? new Date(e.exitAt).getTime() : 0;
    return ts >= todayStart && ts <= todayStart + cutoffSec * 1000;
  });
}

function computeStats(journal: TradeEntry[]) {
  const today = todayEntries(journal);
  const byLane = new Map<string, TradeEntry[]>();
  for (const e of journal) {
    const lane = e.lane ?? 'unknown';
    if (!byLane.has(lane)) byLane.set(lane, []);
    byLane.get(lane)!.push(e);
  }
  const byToday = new Map<string, TradeEntry[]>();
  for (const e of today) {
    const lane = e.lane ?? 'unknown';
    if (!byToday.has(lane)) byToday.set(lane, []);
    byToday.get(lane)!.push(e);
  }

  const totalPnl = round(journal.reduce((s, e) => s + (e.realizedPnl ?? 0), 0));
  const totalWr = journal.length > 0
    ? round((journal.filter(e => (e.realizedPnl ?? 0) > 0).length / journal.length) * 100, 1)
    : 0;
  const todayPnl = round(today.reduce((s, e) => s + (e.realizedPnl ?? 0), 0));
  const todayWr = today.length > 0
    ? round((today.filter(e => (e.realizedPnl ?? 0) > 0).length / today.length) * 100, 1)
    : 0;

  // XRP concentration
  const gridEntries = journal.filter(e => e.lane === 'grid');
  const xrpEntries = gridEntries.filter(e => e.symbol === 'XRP-USD');
  const gridPnl = gridEntries.reduce((s, e) => s + (e.realizedPnl ?? 0), 0);
  const xrpPnl = xrpEntries.reduce((s, e) => s + (e.realizedPnl ?? 0), 0);
  const xrpConcentration = gridPnl !== 0 ? round((xrpPnl / gridPnl) * 100, 1) : 0;

  // Synthetic trade check
  // Synthetic trade check: Phase H guard should prevent any entries without entryMeta/entryPrice>0
  // being journaled. Check for entries with source=repatriated AND symbol=forex (EUR/USD,
  // USD_JPY were the synthetic ones removed Apr 19). GBP/USD repatriated trades are real broker
  // flatten events — keep them. Only flag EUR/USD or USD_JPY repatriated as synthetic.
  const synthetic = journal.filter(e =>
    (e.source === 'repatriated' && ['EUR_USD', 'USD_JPY'].includes(e.symbol ?? ''))
    || e.source === 'synthetic'
  );
  const todaySynthetic = today.filter(e =>
    (e.source === 'repatriated' && ['EUR_USD', 'USD_JPY'].includes(e.symbol ?? ''))
    || e.source === 'synthetic'
  );

  // Regime breakdown
  const regimes: Record<string, number> = {};
  for (const e of journal) {
    const r = e.regime ?? e.entryRegime ?? 'unknown';
    regimes[r] = (regimes[r] ?? 0) + 1;
  }

  // Anomalies: slippage > 50bps
  const highSlippage = journal.filter(e => (e.slippageBps ?? 0) > 50);

  const alerts: string[] = [];
  if (xrpConcentration > 50) alerts.push(`CRITICAL: XRP is ${xrpConcentration}% of grid P&L (max safe: 50%)`);
  if (todayPnl < -500) alerts.push(`ALERT: Firm P&L today is $${todayPnl} (threshold: -$500)`);
  if (todaySynthetic.length > 0) alerts.push(`CRITICAL: ${todaySynthetic.length} synthetic trades detected — Phase H guard may have failed`);
  if (totalWr > 0 && totalWr < 55) alerts.push(`WARNING: Firm WR is ${totalWr}% (below 55% threshold)`);

  const lanes: Record<string, { trades: number; wr: number; pnl: number; avg: number }> = {};
  for (const [lane, entries] of byLane) {
    lanes[lane] = laneStats(entries);
  }

  return {
    totalTrades: journal.length,
    todayTrades: today.length,
    totalPnl,
    todayPnl,
    totalWr,
    todayWr,
    xrpConcentration,
    lanes,
    regimes,
    alerts,
    anomalies: {
      syntheticCount: synthetic.length,
      todaySyntheticCount: todaySynthetic.length,
      highSlippageCount: highSlippage.length
    }
  };
}

function saveEodReport(stats: ReturnType<typeof computeStats>, dateStr: string) {
  fs.mkdirSync(EOD_OUTPUT_DIR, { recursive: true });
  const outPath = path.join(EOD_OUTPUT_DIR, `${dateStr}.json`);
  fs.writeFileSync(outPath, JSON.stringify(stats, null, 2));
  logger.info(`[eod-analysis] EOD report saved: ${outPath}`);
  return outPath;
}

// ── Routes ─────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ service: 'eod-analysis', status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/stats', (_req, res) => {
  const journal = loadJournal();
  const stats = computeStats(journal);
  res.json(stats);
});

app.get('/stats/today', (_req, res) => {
  const journal = loadJournal();
  const stats = computeStats(journal);
  const today = todayEntries(journal);
  const todayStats = {
    ...computeStats(today),
    trades: today.length,
    pnl: round(today.reduce((s, e) => s + (e.realizedPnl ?? 0), 0))
  };
  res.json(todayStats);
});

app.get('/report', (_req, res) => {
  const journal = loadJournal();
  const stats = computeStats(journal);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const outPath = saveEodReport(stats, dateStr);
  res.json({ path: outPath, stats });
});

// ── Boot ───────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`[eod-analysis] listening on http://0.0.0.0:${PORT}`);
  logger.info(`[eod-analysis] ledger: ${PAPER_LEDGER_PATH}`);
  logger.info(`[eod-analysis] output: ${EOD_OUTPUT_DIR}`);

  // Run initial analysis on startup
  const journal = loadJournal();
  const stats = computeStats(journal);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  saveEodReport(stats, dateStr);
  logger.info(`[eod-analysis] initial stats: P&L=$${stats.totalPnl}, WR=${stats.totalWr}%, XRP conc=${stats.xrpConcentration}%, alerts=${stats.alerts.length}`);
});
