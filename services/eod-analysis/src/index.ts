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
const REGIME_LOG_PATH = process.env.REGIME_LOG_PATH
  ?? path.resolve(MODULE_DIR, '../../api/.runtime/regime-log/regime-events.jsonl');

function round(v: number, decimals = 2): number {
  return Math.round(v * 10 ** decimals) / 10 ** decimals;
}

interface TradeEntry {
  symbol?: string;
  lane?: string;
  strategy?: string;
  realizedPnl?: number | null;
  spreadBps?: number | null;
  slippageBps?: number | null;
  regime?: string | null;
  entryRegime?: string | null;
  entryAt?: string;
  exitAt?: string;
  verdict?: string;
  source?: string;
}

function loadJournal(): TradeEntry[] {
  if (!fs.existsSync(PAPER_LEDGER_PATH)) return [];
  return fs.readFileSync(PAPER_LEDGER_PATH, 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l.length > 0)
    .map(l => { try { return JSON.parse(l) as TradeEntry; } catch { return null; } })
    .filter((e): e is TradeEntry => e !== null);
}

function laneStats(entries: TradeEntry[]) {
  const pnl = round(entries.reduce((s, e) => s + (e.realizedPnl ?? 0), 0));
  const wr = entries.length > 0
    ? round((entries.filter(e => (e.realizedPnl ?? 0) > 0).length / entries.length) * 100, 1) : 0;
  const avg = entries.length > 0 ? round(pnl / entries.length) : 0;
  return { trades: entries.length, wr, pnl, avg };
}

function todayEntries(journal: TradeEntry[]) {
  const now = new Date();
  const nyMs = now.getTime() - (now.getTimezoneOffset() * 60000) - (5 * 3600 * 1000);
  const todayStart = new Date(nyMs).setHours(0, 0, 0, 0);
  return journal.filter(e => {
    const ts = e.exitAt ? new Date(e.exitAt).getTime() : 0;
    return ts >= todayStart;
  });
}

function detectRegimeChanges(allEntries: TradeEntry[]) {
  fs.mkdirSync(path.dirname(REGIME_LOG_PATH), { recursive: true });
  const lastEventPath = REGIME_LOG_PATH.replace('.jsonl', '-last.json');
  let lastRegime = 'unknown';
  if (fs.existsSync(lastEventPath)) {
    try { lastRegime = JSON.parse(fs.readFileSync(lastEventPath, 'utf8')).regime; } catch { /* ignore */ }
  }
  const now = Date.now();
  const windowStart = now - 2 * 3600 * 1000;
  const recent = allEntries.filter(e => {
    const ts = e.exitAt ? new Date(e.exitAt).getTime() : 0;
    return ts >= windowStart;
  });
  const regimeCounts: Record<string, number> = {};
  for (const e of recent) {
    const r = e.regime ?? e.entryRegime ?? 'unknown';
    regimeCounts[r] = (regimeCounts[r] ?? 0) + 1;
  }
  const dominantRegime = Object.entries(regimeCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
  if (dominantRegime !== lastRegime && dominantRegime !== 'unknown') {
    const event = {
      timestamp: new Date().toISOString(),
      regime: dominantRegime,
      tradeCount: recent.length,
      regimeBreakdown: regimeCounts,
      note: `Regime shifted ${lastRegime} → ${dominantRegime} (${recent.length} trades in last 2h)`
    };
    fs.appendFileSync(REGIME_LOG_PATH, JSON.stringify(event) + '\n');
    fs.writeFileSync(lastEventPath, JSON.stringify(event));
    logger.info(`[eod-analysis] Regime event: ${lastRegime} → ${dominantRegime}`);
    return { event, previous: lastRegime, current: dominantRegime };
  }
  return { event: null, previous: lastRegime, current: dominantRegime };
}

function computeStats(journal: TradeEntry[]) {
  const today = todayEntries(journal);
  const byLane = new Map<string, TradeEntry[]>();
  for (const e of journal) {
    const lane = e.lane ?? 'unknown';
    if (!byLane.has(lane)) byLane.set(lane, []);
    byLane.get(lane)!.push(e);
  }
  const totalPnl = round(journal.reduce((s, e) => s + (e.realizedPnl ?? 0), 0));
  const totalWr = journal.length > 0
    ? round((journal.filter(e => (e.realizedPnl ?? 0) > 0).length / journal.length) * 100, 1) : 0;
  const todayPnl = round(today.reduce((s, e) => s + (e.realizedPnl ?? 0), 0));
  const todayWr = today.length > 0
    ? round((today.filter(e => (e.realizedPnl ?? 0) > 0).length / today.length) * 100, 1) : 0;
  const gridEntries = journal.filter(e => e.lane === 'grid');
  const xrpEntries = gridEntries.filter(e => e.symbol === 'XRP-USD');
  const gridPnl = gridEntries.reduce((s, e) => s + (e.realizedPnl ?? 0), 0);
  const xrpPnl = xrpEntries.reduce((s, e) => s + (e.realizedPnl ?? 0), 0);
  const xrpConcentration = gridPnl !== 0 ? round((xrpPnl / gridPnl) * 100, 1) : 0;
  const synthetic = journal.filter(e =>
    (e.source === 'repatriated' && ['EUR_USD', 'USD_JPY'].includes(e.symbol ?? '')) || e.source === 'synthetic'
  );
  const todaySynthetic = today.filter(e =>
    (e.source === 'repatriated' && ['EUR_USD', 'USD_JPY'].includes(e.symbol ?? '')) || e.source === 'synthetic'
  );
  const { event: regimeEvent, currentRegime } = (() => {
    const result = detectRegimeChanges(journal);
    return { event: result.event, currentRegime: result.current };
  })();
  const highSlippage = journal.filter(e => (e.slippageBps ?? 0) > 50);
  const alerts: string[] = [];
  if (xrpConcentration > 75) alerts.push(`🚨 HARD STOP RECOMMENDED: XRP is ${xrpConcentration}% of grid P&L (>75% threshold). Reduce XRP allocationMultiplier to below 2.0 and grow BTC/ETH/SOL volume.`);
  else if (xrpConcentration > 70) alerts.push(`⚠️ CRITICAL: XRP is ${xrpConcentration}% of grid P&L (>70% threshold). Recommend reducing XRP allocationMultiplier to 1.5x and increasing BTC/ETH/SOL allocation.`);
  else if (xrpConcentration > 50) alerts.push(`⚠️ WARNING: XRP is ${xrpConcentration}% of grid P&L (max safe: 50%)`);
  if (todayPnl < -500) alerts.push(`ALERT: Firm P&L today is $${todayPnl} (threshold: -$500)`);
  if (todaySynthetic.length > 0) alerts.push(`CRITICAL: ${todaySynthetic.length} synthetic trades detected`);
  if (totalWr > 0 && totalWr < 55) alerts.push(`WARNING: Firm WR is ${totalWr}% (below 55%)`);
  const lanes: Record<string, { trades: number; wr: number; pnl: number; avg: number }> = {};
  for (const [lane, entries] of byLane) lanes[lane] = laneStats(entries);
  return {
    totalTrades: journal.length, todayTrades: today.length, totalPnl, todayPnl,
    totalWr, todayWr, xrpConcentration, currentRegime, regimeEvent,
    lanes, alerts,
    anomalies: { syntheticCount: synthetic.length, todaySyntheticCount: todaySynthetic.length, highSlippageCount: highSlippage.length }
  };
}

app.get('/health', (_req, res) => res.json({ service: 'eod-analysis', status: 'healthy', timestamp: new Date().toISOString() }));
app.get('/stats', (_req, res) => { const journal = loadJournal(); res.json(computeStats(journal)); });
app.get('/stats/today', (_req, res) => { const journal = loadJournal(); const t = todayEntries(journal); res.json({ ...laneStats(t), trades: t.length }); });
app.get('/regime', (_req, res) => { const journal = loadJournal(); const r = detectRegimeChanges(journal); res.json({ currentRegime: r.current, lastEvent: r.event }); });
app.get('/report', (_req, res) => {
  const journal = loadJournal();
  const stats = computeStats(journal);
  const dateStr = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(EOD_OUTPUT_DIR, { recursive: true });
  const outPath = path.join(EOD_OUTPUT_DIR, `${dateStr}.json`);
  fs.writeFileSync(outPath, JSON.stringify(stats, null, 2));
  res.json({ path: outPath, stats });
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`[eod-analysis] listening on http://0.0.0.0:${PORT}`);
  const journal = loadJournal();
  const stats = computeStats(journal);
  logger.info(`[eod-analysis] P&L=$${stats.totalPnl}, WR=${stats.totalWr}%, XRP conc=${stats.xrpConcentration}%, regime=${stats.currentRegime}`);
});
