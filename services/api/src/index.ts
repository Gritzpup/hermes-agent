import './load-env.js';
import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import compression from 'compression';
import express from 'express';
import { getPaperEngine } from './paper-engine.js';
import { getAiCouncil } from './ai-council.js';
import { getMarketIntel } from './market-intel.js';
import { getNewsIntel } from './news-intel.js';
import { getEventCalendar } from './event-calendar.js';
import { getFeatureStore } from './feature-store.js';
import { PairsEngine } from './pairs-engine.js';
import { PairsXauBtcEngine } from './pairs-xau-btc-engine.js';
import { JOURNAL_LEDGER_PATH } from './paper-engine/types.js';
import { GridEngine } from './grid-engine.js';
import { LearningLoop } from './learning-loop.js';
import { LaneLearningEngine } from './lane-learning.js';
import { StrategyDirector } from './strategy-director.js';
import { MakerEngine } from './maker-engine.js';
import { MakerOrderExecutor } from './maker-executor.js';
import { getInsiderRadar } from './insider-radar.js';
import { startFeeTierMonitor, getCurrentCoinbaseFeeTier, isMakerStrategiesBlocked, getCoinbaseRateUtilization } from '@hermes/broker-router';
import { getSecEdgarIntel } from './sec-edgar.js';
import { QUARANTINED_EXIT_REASONS } from '@hermes/contracts';
import type { TradeJournalEntry } from '@hermes/contracts';
import { getHistoricalContext } from './historical-context.js';
import { getDerivativesIntel } from './derivatives-intel.js';
import { startVenueSanity, stopVenueSanity } from './venue-sanity.js';
import { reconcileFees, getLatestReport, runFeeReconciliationOnStartup } from './fee-reconciliation.js';
import { pauseStrategy as cooPauseStrategy, amplifyStrategy as cooAmplifyStrategy, listGates as cooListGates, seedFromDirectivesFile as cooSeedGates, DEFAULT_DIRECTIVES_PATH as COO_DEFAULT_DIR_PATH, requestForceCloseSymbol as cooRequestForceClose, setMaxPositions as cooSetMaxPositions, clearPendingForceClose as cooClearForceClose, clearMaxPositions as cooClearMaxPositions, resumeStrategy as cooResumeStrategy } from './coo-gates.js';
// (venue sanity + pairs xau-btc restored — files exist, earlier agent mis-flagged them)

import { createCoreRouter } from './routes/router-core.js';
import { createPaperRouter } from './routes/router-paper.js';
import { createStrategyRouter } from './routes/router-strategies.js';
import { createIntelRouter } from './routes/router-intel.js';
import { createDirectorRouter } from './routes/router-director.js';
import { createAdminRouter } from './routes/router-admin.js';
import { getLiveCapitalSafety } from './paper-engine/live-capital-safety.js';
import { flushWriteQueue } from './paper-engine/write-queue.js';
import { readSharedJournalEntries } from './lib/persistence-helpers.js';
import { round } from './paper-engine-utils.js';
import { rotateLogs } from './paper-engine/log-rotation.js';

import { getRecentOllamaActivity } from './services/ollama-activity.js';
import { MarketFeedService } from './services/market-feed.js';
import { getMetaLabelModel } from './services/meta-label-model.js';
import { TelemetrySSEService } from './services/telemetry-sse.js';
import fs from 'node:fs';
import path from 'node:path';

// ── Emergency Halt Runtime ──────────────────────────────────────────────────
const RUNTIME_DIR = '/mnt/Storage/github/hermes-trading-firm/services/api/.runtime';
const EMERGENCY_HALT_FILE = path.join(RUNTIME_DIR, 'emergency-halt.json');

function ensureRuntimeDir(): void {
  if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

const app = express();

// Request ID middleware — assign or propagate x-request-id
app.use((req, res, next) => {
  const id = String(req.headers['x-request-id'] ?? randomUUID());
  (req as any).id = id;
  res.setHeader('X-Request-ID', id);
  next();
});
const port = Number(process.env.PORT ?? 4300);
const BROKER_STARTING_EQUITY = Number(process.env.BROKER_STARTING_EQUITY ?? 100_000);

// 1. Initialize Engines
// ── Coinbase Fee Tier Monitor ─────────────────────────────────────────────────
// Start the broker-router fee tier monitor (fetches immediately + every 6 hours).
// This detects account downgrades that would eliminate maker rebates.
startFeeTierMonitor();

const paperEngine = getPaperEngine();
const aiCouncil = getAiCouncil();
const marketIntel = getMarketIntel();
startVenueSanity();
const newsIntel = getNewsIntel();
const eventCalendar = getEventCalendar();
const featureStore = getFeatureStore();

const learningLoop = new LearningLoop(
  () => paperEngine.getSnapshot().agents as any,
  (agentId: string, config: any) => paperEngine.applyAgentConfig(agentId, config)
);
const laneLearning = new LaneLearningEngine();

const pairsEngine = new PairsEngine(BROKER_STARTING_EQUITY, JOURNAL_LEDGER_PATH);
const pairsXauBtcEngine = new PairsXauBtcEngine(BROKER_STARTING_EQUITY, JOURNAL_LEDGER_PATH);
const btcGrid = new GridEngine('BTC-USD', BROKER_STARTING_EQUITY);
const ethGrid = new GridEngine('ETH-USD', BROKER_STARTING_EQUITY);
const solGrid = new GridEngine('SOL-USD', BROKER_STARTING_EQUITY / 2);
// BOOST: XRP grid — 468 trades, 73% WR, $2.14/trade. Tighter spacing + more levels
// to capture chop while capping drawdown. Adaptive spacing still active.
const xrpGrid = new GridEngine('XRP-USD', BROKER_STARTING_EQUITY / 2, 12, 10);

const makerEngine = new MakerEngine(['BTC-USD', 'ETH-USD', 'SOL-USD']);
const makerExecutor = new MakerOrderExecutor();

// ── Coinbase fee tier startup check ─────────────────────────────────────────
// If fee tier has never been fetched (or is downgraded), block maker strategies.
function syncMakerBlockedState(): void {
  const blocked = isMakerStrategiesBlocked();
  const tier = getCurrentCoinbaseFeeTier();
  makerEngine.setMakerBlocked(blocked,
    blocked
      ? `Coinbase fee tier downgraded to "${tier.tierName}" — Maker: ${tier.makerBps}bps | Taker: ${tier.takerBps}bps. Maker strategies blocked.`
      : ''
  );
}
// Sync immediately on startup (may fire before first fetch — use defaults)
syncMakerBlockedState();
// Re-check every minute in case the 6-hour refresh updated the cached tier
setInterval(syncMakerBlockedState, 60_000);

const strategyDirector = new StrategyDirector({
  getPaperEngine: () => paperEngine,
  getMarketIntel: () => marketIntel,
  getNewsIntel: () => newsIntel,
  getInsiderRadar: () => getInsiderRadar()
});

// 2. Initialize Services (Dynamic Dependencies)
const terminalDeps = {
  paperEngine,
  marketIntel,
  newsIntel,
  eventCalendar,
  aiCouncil,
  laneLearning,
  learningLoop,
  strategyDirector,
  makerEngine,
  makerExecutor,
  btcGrid
};

const telemetrySSE = new TelemetrySSEService(terminalDeps);

const marketFeed = new MarketFeedService({
  marketIntel,
  newsIntel,
  eventCalendar,
  laneLearning,
  paperEngine,
  makerEngine,
  makerExecutor,
  pairsEngine,
  pairsXauBtcEngine,
  btcGrid,
  ethGrid,
  solGrid,
  xrpGrid,
  emitStrategyState: (_id, _payload) => {
    // Optional strategy state emission logic
  }
});

// 3. Configure Express (minimal for debug)
// app.use(cors());
// app.use(compression({ filter: () => false }));
// app.use(express.json());
// app.use('/api/', rateLimit({ windowMs: 60_000, max: 600, skip: () => true }));

// Simple health — no router deps
app.get('/health', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end('{"ok":true}');
});
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end('{"ok":true}');
});

// 4. Mount Routers (deferred until after basic health check)
setTimeout(() => {
  console.log('[hermes-api] Installing full router stack...');
  app.use(cors());
  app.use(express.json());
  app.use('/api/', rateLimit({ windowMs: 60_000, max: 600, skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1' }));
  app.use('/api', createCoreRouter(terminalDeps));
  app.use('/api', createPaperRouter({ paperEngine }));
  app.use('/api', createStrategyRouter({ paperEngine, pairsEngine, btcGrid, ethGrid, solGrid, xrpGrid, makerEngine, makerExecutor, marketFeed }));
  app.use('/api', createIntelRouter({ marketIntel, newsIntel, eventCalendar, featureStore }));
  app.use('/api/strategy-director', createDirectorRouter({ strategyDirector }));
  app.use('/api/admin', createAdminRouter({ paperEngine }));
  console.log('[hermes-api] Full router stack installed');
}, 5000);

// 5. SSE Endpoints
app.get('/api/feed', (req, res) => {
  telemetrySSE.addSubscriber(res);
});

// Live log SSE — streams individual log lines as they happen
import { onLogEntry, getRecentLog } from './services/live-log.js';
app.get('/api/live-log', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Send recent history first
  for (const entry of getRecentLog(60)) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  // Stream new entries as they arrive
  const unsub = onLogEntry((entry) => {
    try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch { unsub(); }
  });
  res.on('close', unsub);
});

// 5b. Additional API routes (restored from pre-refactor)
app.get('/api/insider-radar', (_req, res) => {
  try { res.json(getInsiderRadar().getSnapshot()); }
  catch { res.json({ signals: [], filings: [], lastPollAt: null }); }
});
app.get('/api/derivatives-intel', (_req, res) => {
  try { res.json(getDerivativesIntel().getSnapshot()); }
  catch { res.json({ funding: [], oiSnapshots: [] }); }
});
app.get('/api/historical-context', (_req, res) => {
  try { res.json(getHistoricalContext().getSnapshot()); }
  catch { res.json({ macro: {}, fearGreedHistory: [], regimeChanges: [] }); }
});
app.get('/api/market-intel', (_req, res) => {
  res.json(marketIntel.getSnapshot());
});
// ── Phase 4 live-capital safety snapshot (public read) ───────────────
app.get('/api/live-safety', (_req, res) => {
  res.json(getLiveCapitalSafety().getSnapshot());
});
// ── Broker Health: Coinbase rate-limit utilization ───────────────────────────
app.get('/api/broker-health', (_req, res) => {
  const rateUtil = getCoinbaseRateUtilization();
  res.json({
    coinbase: {
      rateLimitPct: {
        public: Math.round(rateUtil.public),
        private: Math.round(rateUtil.private)
      }
    }
  });
});
app.get('/api/event-calendar', (_req, res) => {
  res.json(eventCalendar.getSnapshot());
});
// Alias — same data, includes upcomingMacro
app.get('/api/calendar', (_req, res) => {
  res.json(eventCalendar.getSnapshot());
});
app.get('/api/learning', (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  res.json(learningLoop.getLog(limit));
});
app.get('/api/lane-learning', (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  res.json(laneLearning.getLog(limit));
});
app.get('/api/ai-council/traces', (req, res) => {
  const limit = Number(req.query.limit ?? 40);
  res.json(aiCouncil.getTraces(limit));
});
app.get('/api/quarter-outlook', async (_req, res) => {
  try {
    const response = await fetch('http://127.0.0.1:4305/quarter-outlook', { signal: AbortSignal.timeout(5000) });
    if (response.ok) { res.json(await response.json()); return; }
  } catch { /* backtest service down */ }
  // Fallback: build from strategy director
  try {
    const director = strategyDirector.getLatest();
    const regime = strategyDirector.getRegimeSnapshot();
    res.json({
      regime: regime?.regime ?? 'unknown',
      posture: director?.riskPosture?.posture ?? 'defensive',
      reasoning: director?.reasoning ?? 'No analysis available yet.',
      timestamp: director?.timestamp ?? new Date().toISOString(),
      fearGreed: marketIntel.getSnapshot().fearGreed,
    });
  } catch { res.json({ regime: 'unknown', posture: 'defensive', reasoning: 'Unavailable.' }); }
});
app.get('/api/capital-allocation', (_req, res) => {
  try {
    const desk = paperEngine.getSnapshot();
    const agents = desk.agents ?? [];
    const totalEquity = desk.totalEquity ?? 0;
    const sleeves = [
      { name: 'Paper Scalping', kind: 'scalping', status: 'active', targetWeightPct: 100,
        score: desk.winRate / 100, kpiRatio: desk.winRate / 50,
        expectedNetEdgeBps: desk.realizedPnl > 0 ? 5 : -2,
        reason: `${agents.length} agents, ${desk.totalTrades} trades`,
        notes: [], liveEligible: true, staged: false, assetClass: 'multi', symbols: [] }
    ];
    res.json({
      capital: totalEquity,
      deployablePct: 100,
      reservePct: 0,
      firmKpiRatio: desk.winRate / 50,
      asOf: desk.asOf,
      sleeves,
      notes: ['Single-sleeve paper mode. All capital deployed to scalping agents.']
    });
  } catch { res.json({ capital: 0, sleeves: [], notes: ['Error building allocation snapshot.'] }); }
});
app.get('/api/strategy-director/latest', (_req, res) => {
  const latest = strategyDirector.getLatest();
  res.json(latest ?? { error: 'No director cycle has run yet.' });
});
app.get('/api/ollama-activity', (_req, res) => {
  res.json({ events: getRecentOllamaActivity(40), asOf: new Date().toISOString() });
});
app.get('/api/copy-sleeve', (_req, res) => {
  const snap = getSecEdgarIntel().getSnapshot();
  res.json({ ...snap, status: snap.errors.length === 0 ? 'ok' : 'partial', timestamp: new Date().toISOString() });
});
app.get('/api/copy-sleeve/backtest', async (req, res) => {
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 10000);
    const qs = req.query.managerId ? `?managerId=${req.query.managerId}` : '';
    const response = await fetch(`http://127.0.0.1:4308/copy-sleeve/backtest${qs}`, { signal: ac.signal });
    clearTimeout(to);
    if (response.ok) { res.json(await response.json()); return; }
  } catch {
    console.warn('[hermes-api] /api/copy-sleeve/backtest degraded: backtest service offline');
  }
  res.json({ status: 'degraded', reason: 'backtest service offline', timestamp: new Date().toISOString(), data: null });
});
app.get('/api/macro-preservation/backtest', async (req, res) => {
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 10000);
    const qs = req.query.startDate ? `?startDate=${req.query.startDate}` : '';
    const response = await fetch(`http://127.0.0.1:4308/macro-preservation/backtest${qs}`, { signal: ac.signal });
    clearTimeout(to);
    if (response.ok) { res.json(await response.json()); return; }
  } catch {
    console.warn('[hermes-api] /api/macro-preservation/backtest degraded: backtest service offline');
  }
  res.json({ status: 'degraded', reason: 'backtest service offline', timestamp: new Date().toISOString(), data: null });
});
app.get('/api/macro-preservation', async (_req, res) => {
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 10000);
    const response = await fetch('http://127.0.0.1:4305/macro-preservation', { signal: ac.signal });
    clearTimeout(to);
    if (response.ok) { res.json(await response.json()); return; }
  } catch {
    console.warn('[hermes-api] /api/macro-preservation degraded: backtest service offline');
  }
  res.json({ status: 'degraded', reason: 'backtest service offline', timestamp: new Date().toISOString(), data: null });
});

// Simple health check — no dependencies, always responds
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});
app.get('/', (_req, res) => {
  res.json({ ok: true });
});

// 6. Start Lifecycle
marketFeed.start();
strategyDirector.start();

// 6b. Nightly meta-label model training (24h interval)
const BACKTEST_URL = process.env.BACKTEST_URL ?? 'http://127.0.0.1:4305';
const metaLabelModel = getMetaLabelModel();

async function triggerNightlyTraining(): Promise<void> {
  try {
    const response = await fetch(`${BACKTEST_URL}/labels/train`, { method: 'POST', signal: AbortSignal.timeout(60_000) });
    if (response.ok) {
      const result = await response.json();
      console.log(`[meta-label] nightly train: trained=${result.modelTrained} samples=${result.samples} accuracy=${result.accuracy}`);
      // Reload model so it picks up the new weights
      if (result.modelTrained) await metaLabelModel.load();
    }
  } catch (error) {
    console.warn('[meta-label] nightly train failed:', error instanceof Error ? error.message : error);
  }
}

// Run once at startup if model doesn't exist
const MODEL_PATH = process.env.META_LABEL_MODEL_PATH
  ?? '/mnt/Storage/github/hermes-trading-firm/services/api/.runtime/paper-ledger/meta-label-model.json';
if (!fs.existsSync(MODEL_PATH)) {
  console.log('[meta-label] model not found at startup, triggering initial training...');
  void triggerNightlyTraining();
}

// Schedule nightly training
setInterval(() => {
  void triggerNightlyTraining();
}, 24 * 60 * 60 * 1000);

// ── Log Rotation ────────────────────────────────────────────────────────────
const PAPER_LEDGER_DIR = '/mnt/Storage/github/hermes-trading-firm/services/api/.runtime/paper-ledger';

function scheduleLogRotation(): void {
  // Ensure ledger dir exists
  if (!fs.existsSync(PAPER_LEDGER_DIR)) fs.mkdirSync(PAPER_LEDGER_DIR, { recursive: true });

  // Run once at startup
  const result = rotateLogs(PAPER_LEDGER_DIR);
  console.info(`[log-rotation] startup: rotated=${result.rotated.length} purged=${result.purged.length}`);

  // Re-run every 6 hours
  setInterval(() => {
    const res = rotateLogs(PAPER_LEDGER_DIR);
    console.info(`[log-rotation] 6h sweep: rotated=${res.rotated.length} purged=${res.purged.length}`);
  }, 6 * 60 * 60 * 1000);
}

scheduleLogRotation();

// ── PnL Reconciliation Endpoint ─────────────────────────────────────────────

interface PnlReconciliationResponse {
  asOf: string;
  journalTotalPnl: number;
  dashboardTotalPnl: number;
  delta: number;
  withinTolerance: boolean;
  bySymbol: Array<{ symbol: string; journal: number; dashboard: number; delta: number }>;
  byLane?: Array<{ lane: string; journal: number }>;
  warnings: string[];
}

function computeJournalAggregates(entries: ReturnType<typeof readSharedJournalEntries>) {
  const totalPnl = entries.reduce((sum, e) => sum + e.realizedPnl, 0);

  const bySymbol = new Map<string, number>();
  for (const e of entries) {
    bySymbol.set(e.symbol, (bySymbol.get(e.symbol) ?? 0) + e.realizedPnl);
  }

  const byLane = new Map<string, number>();
  for (const e of entries) {
    const lane = e.lane ?? 'scalping';
    byLane.set(lane, (byLane.get(lane) ?? 0) + e.realizedPnl);
  }

  return { totalPnl, bySymbol, byLane };
}

function getDashboardPnL(desk: ReturnType<typeof paperEngine.getSnapshot>) {
  // Total PnL as reported by the dashboard (in-memory agent realizedPnl sum).
  // Note: this resets to $0 on engine restart; the journal is the authoritative record.
  const totalPnl = desk.realizedPnl;

  // Per-symbol PnL: agent snapshots carry lastSymbol (actual ticker, e.g. "BTC-USD")
  const bySymbol = new Map<string, number>();
  for (const agent of desk.agents ?? []) {
    const raw = agent.lastSymbol ?? agent.focus ?? 'UNKNOWN';
    const sym = raw.includes('-') || raw.length <= 10 ? raw : 'UNKNOWN';
    bySymbol.set(sym, (bySymbol.get(sym) ?? 0) + agent.realizedPnl);
  }

  return { totalPnl, bySymbol };
}

app.get('/api/pnl-reconciliation', (_req, res) => {
  try {
    const now = new Date().toISOString();

    // 1. Read & filter journal entries (same quarantine logic as Phase I)
    const journalEntries = readSharedJournalEntries();
    const journal = computeJournalAggregates(journalEntries);

    // 2. Fetch current paperDesk snapshot
    const desk = paperEngine.getSnapshot();
    const dash = getDashboardPnL(desk);

    // 3. Top-level totals
    const delta = round(journal.totalPnl - dash.totalPnl, 4);
    const TOLERANCE = 0.01;
    const withinTolerance = Math.abs(delta) < TOLERANCE;

    // 4. Per-symbol reconciliation
    const allSymbols = new Set([...journal.bySymbol.keys(), ...dash.bySymbol.keys()]);
    const bySymbol: PnlReconciliationResponse['bySymbol'] = [];
    const warnings: string[] = [];

    for (const symbol of [...allSymbols].sort()) {
      const jPnL = journal.bySymbol.get(symbol) ?? 0;
      const dPnL = dash.bySymbol.get(symbol) ?? 0;
      const symDelta = round(jPnL - dPnL, 4);
      bySymbol.push({ symbol, journal: round(jPnL, 2), dashboard: round(dPnL, 2), delta: symDelta });
      if (Math.abs(symDelta) >= TOLERANCE) {
        warnings.push(`${symbol}: journal=${round(jPnL, 2)} dashboard=${round(dPnL, 2)} delta=${symDelta}`);
      }
    }

    // 5. Lane rollup from journal
    const byLane: PnlReconciliationResponse['byLane'] = [];
    for (const [lane, pnl] of [...journal.byLane.entries()].sort()) {
      byLane.push({ lane, journal: round(pnl, 2) });
    }

    const response: PnlReconciliationResponse = {
      asOf: now,
      journalTotalPnl: round(journal.totalPnl, 2),
      dashboardTotalPnl: round(dash.totalPnl, 2),
      delta,
      withinTolerance,
      bySymbol,
      byLane,
      warnings
    };

    console.log(`[pnl-reconciliation] journal=${journal.totalPnl} dashboard=${dash.totalPnl} delta=${delta} withinTolerance=${withinTolerance}`);
    res.json(response);
  } catch (err) {
    console.error('[pnl-reconciliation] error:', err);
    res.status(500).json({ error: 'PnL reconciliation failed', detail: String(err) });
  }
});

// ── PnL Attribution Endpoint ───────────────────────────────────────────────

interface AttributionBucket {
  key: string;
  count: number;
  pnl: number;
  wins: number;
  losses: number;
  scratches: number;
  avgWinner: number;
  avgLoser: number;
  profitFactor: number;
  expectancy: number;
}

function buildBucket(entries: TradeJournalEntry[], getKey: (e: TradeJournalEntry) => string): AttributionBucket[] {
  const groups = new Map<string, TradeJournalEntry[]>();
  for (const e of entries) groups.set(getKey(e), [...(groups.get(getKey(e)) ?? []), e]);

  const buckets: AttributionBucket[] = [];
  for (const [key, rows] of groups) {
    const pnl = rows.reduce((s, e) => s + e.realizedPnl, 0);
    const winners = rows.filter((e) => e.verdict === 'winner');
    const losers = rows.filter((e) => e.verdict === 'loser');
    const scratches = rows.filter((e) => e.verdict === 'scratch');
    const grossWins = winners.reduce((s, e) => s + e.realizedPnl, 0);
    const grossLosses = losers.reduce((s, e) => s + e.realizedPnl, 0);
    buckets.push({
      key,
      count: rows.length,
      pnl: round(pnl, 2),
      wins: winners.length,
      losses: losers.length,
      scratches: scratches.length,
      avgWinner: winners.length ? round(grossWins / winners.length, 4) : 0,
      avgLoser: losers.length ? round(grossLosses / losers.length, 4) : 0,
      profitFactor: grossLosses !== 0 ? round(grossWins / Math.abs(grossLosses), 4) : grossWins > 0 ? Infinity : 0,
      expectancy: rows.length
        ? round(pnl / rows.length, 4)
        : 0,
    });
  }
  return buckets;
}

app.get('/api/pnl-attribution', (_req, res) => {
  try {
    const asOf = new Date().toISOString();
    const entries = readSharedJournalEntries();

    const byLane = buildBucket(entries, (e) => e.lane ?? 'scalping');
    const byStrategy = buildBucket(entries, (e) => e.strategyId ?? e.strategy ?? 'unknown');
    const bySymbol = buildBucket(entries, (e) => e.symbol);

    const allBuckets = [...byLane, ...byStrategy, ...bySymbol];
    const sorted = allBuckets.sort((a, b) => b.pnl - a.pnl);
    const top5Winners = sorted.filter((b) => b.pnl > 0).slice(0, 5);
    const top5Losers = sorted.filter((b) => b.pnl < 0).slice(-5).reverse();

    // Win-rate shorthand per bucket
    const addWinRate = (b: AttributionBucket): AttributionBucket & { winRate: number } => ({
      ...b,
      winRate: b.count > 0 ? round((b.wins / b.count) * 100, 2) : 0,
    });

    res.json({
      asOf,
      totalTrades: entries.length,
      byLane: byLane.sort((a, b) => b.pnl - a.pnl).map(addWinRate),
      byStrategy: byStrategy.sort((a, b) => b.pnl - a.pnl).map(addWinRate),
      bySymbol: bySymbol.sort((a, b) => b.pnl - a.pnl).map(addWinRate),
      top5Winners: top5Winners.map(addWinRate),
      top5Losers: top5Losers.map(addWinRate),
    });
  } catch (err) {
    console.error('[pnl-attribution] error:', err);
    res.status(500).json({ error: 'PnL attribution failed', detail: String(err) });
  }
});

// ── Fee Calibration Endpoint ───────────────────────────────────────────────
app.get('/api/fee-calibration', (_req, res) => {
  try {
    const latestReport = getLatestReport();
    if (!latestReport) {
      res.json({
        status: 'no-report',
        message: 'No calibration report found. Run reconciliation on startup or call /api/fee-calibration/run.',
        timestamp: new Date().toISOString()
      });
      return;
    }
    res.json({
      status: 'ok',
      asOf: latestReport.asOf,
      warningCount: latestReport.warnings.length,
      warnings: latestReport.warnings
    });
  } catch (err) {
    console.error('[fee-calibration] error:', err);
    res.status(500).json({ error: 'Fee calibration check failed', detail: String(err) });
  }
});

// POST /api/fee-calibration/run — trigger reconciliation on demand
app.post('/api/fee-calibration/run', (req, res) => {
  try {
    const lookbackDays = Number(req.query.lookbackDays ?? 7);
    const result = reconcileFees(lookbackDays);
    res.json({
      status: 'ok',
      summary: result.summary,
      bucketsCount: result.buckets.length,
      warningsCount: result.warnings.length,
      reportWritten: result.warnings.length > 0
    });
  } catch (err) {
    console.error('[fee-calibration] run error:', err);
    res.status(500).json({ error: 'Fee calibration run failed', detail: String(err) });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`[hermes-api] Hyper-Modular entry point online at http://0.0.0.0:${port}`);
  // Run fee reconciliation on startup (non-blocking)
  runFeeReconciliationOnStartup();
  // Replay COO gate state from persisted directives so pauses survive api restart
  cooSeedGates(COO_DEFAULT_DIR_PATH);
  const gates = cooListGates();
  if (gates.paused.length || gates.amplified.length) {
    console.log('[hermes-api] COO gates seeded:', JSON.stringify(gates));
  }
});

// ── Emergency Halt Endpoints ───────────────────────────────────────────────

// POST /api/emergency-halt  — write halt file (no restart required)
app.post('/api/emergency-halt', express.json(), (req, res) => {
  const { operator, reason } = req.body as { operator?: string; reason?: string };
  if (!operator || !reason) {
    res.status(400).json({ error: 'body requires { operator: string, reason: string }' });
    return;
  }
  try {
    ensureRuntimeDir();
    const payload = JSON.stringify({ operator, reason, haltedAt: new Date().toISOString() }, null, 2);
    fs.writeFileSync(EMERGENCY_HALT_FILE, payload, 'utf8');
    console.warn(`[emergency-halt] ACTIVATED by ${operator}: ${reason}`);
    res.json({ status: 'active', haltedAt: new Date().toISOString(), operator, reason });
  } catch (err) {
    res.status(500).json({ error: 'failed to write halt file', detail: String(err) });
  }
});

// POST /api/emergency-halt/clear  — delete halt file (requires operator confirmation)
app.post('/api/emergency-halt/clear', express.json(), (req, res) => {
  const { operator } = req.body as { operator?: string };
  if (!operator) {
    res.status(400).json({ error: 'body requires { operator: string }' });
    return;
  }
  if (!fs.existsSync(EMERGENCY_HALT_FILE)) {
    res.json({ status: 'already-clear', operator });
    return;
  }
  try {
    fs.unlinkSync(EMERGENCY_HALT_FILE);
    console.warn(`[emergency-halt] CLEARED by ${operator}`);
    res.json({ status: 'cleared', clearedBy: operator, clearedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'failed to clear halt file', detail: String(err) });
  }
});

// GET /api/emergency-halt  — read status (dashboard polling)
app.get('/api/emergency-halt', (_req, res) => {
  if (fs.existsSync(EMERGENCY_HALT_FILE)) {
    try { res.json({ active: true, ...JSON.parse(fs.readFileSync(EMERGENCY_HALT_FILE, 'utf8')) }); }
    catch { res.json({ active: true, error: 'parse error' }); }
  } else {
    res.json({ active: false });
  }
});

// ── COO (openclaw-hermes bridge) Endpoints ────────────────────────────────
// These accept COO decisions from the bridge and persist them into the firm's
// event stream (services/api/.runtime/paper-ledger/events.jsonl), where
// review-loop and strategy-director can consume them.

const COO_EVENTS_PATH = path.join(RUNTIME_DIR, 'paper-ledger/events.jsonl');
const COO_DIRECTIVES_PATH = path.join(RUNTIME_DIR, 'paper-ledger/coo-directives.jsonl');

function writeCooEvent(type: string, body: Record<string, unknown>): void {
  ensureRuntimeDir();
  const dir = path.dirname(COO_EVENTS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const entry = { timestamp: new Date().toISOString(), type, source: 'openclaw-coo', ...body };
  fs.appendFileSync(COO_EVENTS_PATH, JSON.stringify(entry) + '\n');
  fs.appendFileSync(COO_DIRECTIVES_PATH, JSON.stringify(entry) + '\n');
}

// Per-route json middleware: the global express.json() is installed inside a
// setTimeout(5000) above, which happens AFTER these routes are registered at
// module-load time — so they need their own json parser.
const cooJsonParser = express.json();

// POST /api/coo/directive  — COO-issued directive consumed by review-loop/strategy-director
app.post('/api/coo/directive', cooJsonParser, (req, res) => {
  const { text, priority, rationale } = req.body as { text?: string; priority?: 'low'|'normal'|'high'; rationale?: string };
  if (!text) { res.status(400).json({ error: 'body requires { text: string, priority?, rationale? }' }); return; }
  try {
    writeCooEvent('coo-directive', { text, priority: priority ?? 'normal', rationale });
    res.json({ status: 'accepted', type: 'coo-directive' });
  } catch (err) {
    res.status(500).json({ error: 'failed to persist directive', detail: String(err) });
  }
});

// POST /api/coo/note  — COO observation, no action expected
app.post('/api/coo/note', cooJsonParser, (req, res) => {
  const { text } = req.body as { text?: string };
  if (!text) { res.status(400).json({ error: 'body requires { text: string }' }); return; }
  try {
    writeCooEvent('coo-note', { text });
    res.json({ status: 'accepted', type: 'coo-note' });
  } catch (err) {
    res.status(500).json({ error: 'failed to persist note', detail: String(err) });
  }
});

// POST /api/coo/pause-strategy  — COO recommends pausing a losing strategy
app.post('/api/coo/pause-strategy', cooJsonParser, (req, res) => {
  const { strategy, reason } = req.body as { strategy?: string; reason?: string };
  if (!strategy || !reason) { res.status(400).json({ error: 'body requires { strategy: string, reason: string }' }); return; }
  try {
    writeCooEvent('coo-pause-strategy', { strategy, reason });
    cooPauseStrategy(strategy);
    res.json({ status: 'accepted', type: 'coo-pause-strategy', strategy, gatesNow: cooListGates() });
  } catch (err) {
    res.status(500).json({ error: 'failed to persist pause-strategy', detail: String(err) });
  }
});

// POST /api/coo/amplify-strategy  — COO recommends increasing capital to a winning strategy
app.post('/api/coo/amplify-strategy', cooJsonParser, (req, res) => {
  const { strategy, reason, factor } = req.body as { strategy?: string; reason?: string; factor?: number };
  if (!strategy || !reason) { res.status(400).json({ error: 'body requires { strategy: string, reason: string, factor?: number }' }); return; }
  try {
    writeCooEvent('coo-amplify-strategy', { strategy, reason, factor: factor ?? 1.25 });
    cooAmplifyStrategy(strategy, factor ?? 1.25);
    res.json({ status: 'accepted', type: 'coo-amplify-strategy', strategy, gatesNow: cooListGates() });
  } catch (err) {
    res.status(500).json({ error: 'failed to persist amplify-strategy', detail: String(err) });
  }
});

// POST /api/coo/force-close-symbol  — COO wants to flatten all positions in a symbol
app.post('/api/coo/force-close-symbol', cooJsonParser, (req, res) => {
  const { symbol, reason } = req.body as { symbol?: string; reason?: string };
  if (!symbol || !reason) { res.status(400).json({ error: 'body requires { symbol: string, reason: string }' }); return; }
  try {
    writeCooEvent('coo-force-close-symbol', { symbol, reason });
    cooRequestForceClose(symbol);
    res.json({ status: 'accepted', type: 'coo-force-close-symbol', symbol, gatesNow: cooListGates() });
  } catch (err) {
    res.status(500).json({ error: 'failed to persist force-close', detail: String(err) });
  }
});

// POST /api/coo/set-max-positions  — COO wants to cap open-position count (firm-wide or per-strategy)
app.post('/api/coo/set-max-positions', cooJsonParser, (req, res) => {
  const { scope, strategy, max, reason } = req.body as { scope?: 'firm' | 'strategy'; strategy?: string; max?: number; reason?: string };
  if (!scope || typeof max !== 'number' || max < 0) {
    res.status(400).json({ error: 'body requires { scope: "firm"|"strategy", strategy?: string, max: number >= 0, reason? }' });
    return;
  }
  try {
    writeCooEvent('coo-set-max-positions', { scope, strategy: strategy ?? null, max, reason: reason ?? null });
    cooSetMaxPositions(scope, strategy ?? null, max);
    res.json({ status: 'accepted', type: 'coo-set-max-positions', scope, strategy, max, gatesNow: cooListGates() });
  } catch (err) {
    res.status(500).json({ error: 'failed to persist max-positions', detail: String(err) });
  }
});

// GET /api/coo/gates  — current pause/amplify/force-close/max-positions state
app.get('/api/coo/gates', (_req, res) => {
  res.json(cooListGates());
});

// DELETE /api/coo/gates/force-close  — operator cleanup of stale force-close entries.
// Body optional: { symbol?: "XRP-USD" } — omit to clear ALL pending.
app.delete('/api/coo/gates/force-close', express.json(), (req, res) => {
  const { symbol } = (req.body ?? {}) as { symbol?: string };
  const cleared = cooClearForceClose(symbol);
  res.json({ status: 'ok', cleared, gatesNow: cooListGates() });
});

// DELETE /api/coo/gates/max-positions  — clear max-position caps.
// Body optional: { scope: "firm"|"strategy", strategy?: string }.
app.delete('/api/coo/gates/max-positions', express.json(), (req, res) => {
  const { scope, strategy } = (req.body ?? {}) as { scope?: 'firm' | 'strategy'; strategy?: string };
  const cleared = cooClearMaxPositions(scope, strategy);
  res.json({ status: 'ok', cleared, gatesNow: cooListGates() });
});

// DELETE /api/coo/gates/pause  — operator resumes a paused strategy (bypasses COO amplify).
app.delete('/api/coo/gates/pause', express.json(), (req, res) => {
  const { strategy } = (req.body ?? {}) as { strategy?: string };
  if (!strategy) { res.status(400).json({ error: 'body requires { strategy: string }' }); return; }
  cooResumeStrategy(strategy);
  res.json({ status: 'ok', strategy, gatesNow: cooListGates() });
});

// GET /coo-dashboard  — simple HTML page for humans
app.get('/coo-dashboard', (_req, res) => {
  try {
    const gates = cooListGates();
    const directivesFile = path.join(RUNTIME_DIR, 'paper-ledger/coo-directives.jsonl');
    let directives: Array<Record<string, unknown>> = [];
    if (fs.existsSync(directivesFile)) {
      const lines = fs.readFileSync(directivesFile, 'utf8').split('\n').filter(Boolean);
      directives = lines.slice(-30).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter((x): x is Record<string, unknown> => x !== null);
    }
    const rowsHtml = directives.map(d => {
      const ts = String(d.timestamp ?? '').slice(0, 19);
      const type = String(d.type ?? '?');
      const text = String(d.text ?? d.reason ?? d.cooSummary ?? JSON.stringify(d).slice(0, 160));
      const cls = type.includes('halt') ? 'critical' : type.includes('pause') ? 'warn' : 'info';
      return `<tr class="${cls}"><td>${ts}</td><td>${type}</td><td>${text.replace(/</g, '&lt;').slice(0, 400)}</td></tr>`;
    }).join('\n');
    const pausedHtml = gates.paused.length ? gates.paused.map(s => `<li><code>${s}</code></li>`).join('') : '<li><em>none</em></li>';
    const amplifiedHtml = gates.amplified.length ? gates.amplified.map(a => `<li><code>${a.id}</code> × ${a.factor}</li>`).join('') : '<li><em>none</em></li>';
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!DOCTYPE html><html><head><title>COO Dashboard</title><style>
      body{font:14px -apple-system,sans-serif;max-width:1200px;margin:20px auto;padding:0 20px;color:#eee;background:#1a1a1a}
      h1,h2{color:#fff} h2{border-bottom:1px solid #444;padding-bottom:4px;margin-top:28px}
      table{border-collapse:collapse;width:100%} th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #333;vertical-align:top}
      th{color:#aaa;font-weight:normal;font-size:12px;text-transform:uppercase}
      tr.critical{background:#3a1a1a} tr.warn{background:#3a3a1a} tr.info{background:#1a1a1a}
      code{background:#333;padding:2px 6px;border-radius:3px}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:20px} ul{margin:6px 0;padding-left:20px}
      .meta{color:#888;font-size:12px}
    </style></head><body>
    <h1>🦞 COO Dashboard <span class="meta">(auto-refresh in 30s)</span></h1>
    <div class="grid">
      <div><h2>Paused Strategies</h2><ul>${pausedHtml}</ul></div>
      <div><h2>Amplified Strategies</h2><ul>${amplifiedHtml}</ul></div>
    </div>
    <h2>Recent Directives (most recent first, capped at 30)</h2>
    <table><thead><tr><th>Time</th><th>Type</th><th>Content</th></tr></thead><tbody>${rowsHtml}</tbody></table>
    <p class="meta">Live at ${new Date().toISOString()}. Sources: \`/api/coo/directives\`, \`/api/coo/gates\`.</p>
    <script>setTimeout(()=>location.reload(),30000)</script>
    </body></html>`);
  } catch (err) {
    res.status(500).send('<pre>dashboard error: ' + String(err) + '</pre>');
  }
});

// GET /api/coo/directives  — read the rolling COO directive log (for dashboards / review-loop)
app.get('/api/coo/directives', (_req, res) => {
  try {
    if (!fs.existsSync(COO_DIRECTIVES_PATH)) { res.json([]); return; }
    const lines = fs.readFileSync(COO_DIRECTIVES_PATH, 'utf8').split('\n').filter(Boolean);
    const entries = lines.slice(-200).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: 'failed to read directives', detail: String(err) });
  }
});

// 6b. Process Stability — catch crashes and log heartbeat
process.on('uncaughtException', (err) => {
  console.error('[hermes-api] UNCAUGHT EXCEPTION:', err.message, err.stack);
  // Don't exit — let the engine keep running
});

process.on('unhandledRejection', (reason) => {
  console.error('[hermes-api] UNHANDLED REJECTION:', reason);
});

setInterval(() => {
  const mem = process.memoryUsage();
  console.log(`[hermes-api] heartbeat: rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB uptime=${(process.uptime() / 60).toFixed(0)}min`);
}, 300_000);

// 7. Graceful Shutdown
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[hermes-api] ${signal} received. Shutting down...`);
  strategyDirector.stop();
  learningLoop.stop();
  marketIntel.stop();
  // stopVenueSanity(); // removed
  newsIntel.stop();
  eventCalendar.stop();
  getInsiderRadar().stop();
  getHistoricalContext().stop();
  getDerivativesIntel().stop();
  getSecEdgarIntel().stop();
  
  await flushWriteQueue();
  setTimeout(() => {
    console.log('[hermes-api] Goodbye.');
    process.exit(0);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
