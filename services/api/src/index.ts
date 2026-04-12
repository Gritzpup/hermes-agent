import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  BrokerAccountSnapshot,
  BrokerHeat,
  CapitalAllocatorSnapshot,
  CopySleeveBacktestRequest,
  CopySleeveBacktestResult,
  CopySleevePortfolioSnapshot,
  MacroPreservationBacktestRequest,
  MacroPreservationBacktestResult,
  MacroPreservationPortfolioSnapshot,
  QuarterSimulationReport,
  ExecutionReport,
  MarketSnapshot,
  OverviewSnapshot,
  PositionSnapshot,
  AiCouncilTrace,
  AiProviderDecision,
  ResearchCandidate,
  ServiceHealth,
  StrategyReview,
  StrategySnapshot,
  StrategyGenome,
  SystemSettings,
  StrategyRoutePlan,
  TerminalSnapshot,
  TradeJournalEntry
} from '@hermes/contracts';
import { getPaperEngine } from './paper-engine.js';
import { getSignalBus } from './signal-bus.js';
import { getAiCouncil } from './ai-council.js';
import { PairsEngine } from './pairs-engine.js';
import { GridEngine } from './grid-engine.js';
import { LearningLoop } from './learning-loop.js';
import { getMarketIntel } from './market-intel.js';
import { getNewsIntel } from './news-intel.js';
import { getEventCalendar } from './event-calendar.js';
import { getReplayEngine } from './replay-engine.js';
import { buildCapitalAllocatorSnapshot } from './capital-allocator.js';
import { MakerEngine } from './maker-engine.js';
import { MakerOrderExecutor } from './maker-executor.js';
import { LaneLearningEngine } from './lane-learning.js';
import { StrategyDirector } from './strategy-director.js';
import { getInsiderRadar } from './insider-radar.js';
import { getFeatureStore } from './feature-store.js';
import { getHistoricalContext } from './historical-context.js';
import { getDerivativesIntel } from './derivatives-intel.js';

const app = express();
const port = Number(process.env.PORT ?? 4300);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const STRATEGY_LEDGER_DIR = process.env.PAPER_LEDGER_DIR ?? path.resolve(MODULE_DIR, '../.runtime/paper-ledger');
const STRATEGY_JOURNAL_PATH = path.join(STRATEGY_LEDGER_DIR, 'journal.jsonl');
const STRATEGY_EVENT_LOG_PATH = path.join(STRATEGY_LEDGER_DIR, 'events.jsonl');
const paperEngine = getPaperEngine();
const aiCouncil = getAiCouncil();
const replayEngine = getReplayEngine();
const featureStore = getFeatureStore();

const BROKER_STARTING_EQUITY = Number(process.env.BROKER_STARTING_EQUITY ?? 100_000);
const MARKET_DATA_URL = process.env.MARKET_DATA_URL ?? 'http://127.0.0.1:4302';
const RISK_ENGINE_URL = process.env.RISK_ENGINE_URL ?? 'http://127.0.0.1:4301';
const BROKER_ROUTER_URL = process.env.BROKER_ROUTER_URL ?? 'http://127.0.0.1:4303';
const REVIEW_LOOP_URL = process.env.REVIEW_LOOP_URL ?? 'http://127.0.0.1:4304';
const BACKTEST_URL = process.env.BACKTEST_URL ?? 'http://127.0.0.1:4305';
const STRATEGY_LAB_URL = process.env.STRATEGY_LAB_URL ?? 'http://127.0.0.1:4306';

interface BrokerRouterBrokerSnapshot {
  broker: 'alpaca-paper' | 'coinbase-live' | 'oanda-rest';
  venue: 'alpaca' | 'coinbase' | 'oanda';
  status: string;
  asOf: string;
  account: unknown;
  positions: unknown[];
  fills: unknown[];
  orders: unknown[];
  errors: string[];
}

interface BrokerRouterAccountResponse {
  asOf: string;
  brokers: BrokerRouterBrokerSnapshot[];
  lastSyncAt: string | null;
}

interface BrokerRouterReportRecord {
  id: string;
  orderId: string;
  broker: 'alpaca-paper' | 'coinbase-live' | 'oanda-rest';
  symbol: string;
  status: 'accepted' | 'filled' | 'rejected' | 'canceled';
  filledQty: number;
  avgFillPrice: number;
  slippageBps: number;
  latencyMs: number;
  message: string;
  timestamp: string;
  mode?: 'paper' | 'live';
  source?: 'broker' | 'simulated' | 'mock';
}

interface BrokerRouterReportsResponse {
  asOf: string;
  lastSyncAt: string | null;
  reports: BrokerRouterReportRecord[];
  brokers: BrokerRouterBrokerSnapshot[];
}

interface SidecarLaneControlState {
  strategyId: string;
  strategy: string;
  lane: 'pairs' | 'grid' | 'maker';
  symbols: string[];
  enabled: boolean;
  blockedReason: string;
  allocationMultiplier: number;
  recentTrades: number;
  recentWinRate: number;
  recentProfitFactor: number;
  lastReviewAt: string;
  lastAdjustment: string;
}

const DEFAULT_SETTINGS: SystemSettings = {
  paperBroker: 'alpaca-paper',
  liveBroker: 'coinbase-live',
  universe: ['BTC-USD', 'ETH-USD', 'SPY', 'QQQ', 'NVDA'],
  riskCaps: {
    maxTradeNotional: 5_000,
    maxDailyLoss: 1_200,
    maxStrategyExposurePct: 22,
    maxSymbolExposurePct: 12,
    maxDrawdownPct: 4,
    maxSlippageBps: 12
  },
  killSwitches: [
    'broker disconnect',
    'stale market data',
    'daily loss breach',
    'session drawdown breach',
    'excessive slippage',
    'manual operator override'
  ],
  notes: [
    'Alpaca remains paper-only.',
    'Coinbase remains the only live venue.',
    'Strategies stay paper until live-readiness gates and broker reconciliation both pass.'
  ]
};

app.use(cors());
app.use(express.json());

app.get('/api/health', async (_req, res) => {
  res.json({ timestamp: new Date().toISOString(), services: await getServiceHealthSnapshot() });
});

app.get('/api/overview', async (_req, res) => {
  // Use shared broker cache instead of direct call (prevents timeout)
  const accounts = normalizeBrokerAccounts(sharedBrokerCache?.brokers ?? []);
  const health = sharedHealthCache;
  res.json(buildOverviewSnapshot(paperEngine.getSnapshot(), accounts, health));
});

app.get('/api/positions', async (_req, res) => {
  const brokerPositions = normalizeBrokerPositions(sharedBrokerCache?.brokers ?? []);
  res.json(dedupePositions([...brokerPositions, ...paperEngine.getPositions()]));
});

app.get('/api/orders', async (_req, res) => {
  const brokerOrdersState = await fetchJson<BrokerRouterReportsResponse>(BROKER_ROUTER_URL, '/reports');
  const brokerOrders = normalizeBrokerReports(brokerOrdersState?.reports ?? []);
  const paperOrders = paperEngine.getSnapshot().fills
    .map(mapPaperFillToExecutionReport)
    .filter((report): report is ExecutionReport => report !== null);
  res.json(dedupeReports([...brokerOrders, ...paperOrders]));
});

app.get('/api/strategies', (_req, res) => {
  res.json(buildStrategySnapshots());
});

app.get('/api/research', async (_req, res) => {
  const marketData = await fetchJson<{ snapshots?: MarketSnapshot[] }>(MARKET_DATA_URL, '/snapshots');
  res.json(buildResearchCandidates(marketData?.snapshots ?? []));
});

app.get('/api/reviews', async (_req, res) => {
  const reviews = await fetchArrayJson<StrategyReview>(REVIEW_LOOP_URL, '/reviews');
  res.json(reviews);
});

app.get('/api/review-clusters', async (_req, res) => {
  const clusters = await fetchJson<Record<string, unknown>>(REVIEW_LOOP_URL, '/clusters');
  res.json(clusters ?? {});
});

app.get('/api/journal', async (_req, res) => {
  const journal = await fetchArrayJson<TradeJournalEntry>(REVIEW_LOOP_URL, '/journal');
  res.json(dedupeJournal([...paperEngine.getJournal(), ...journal]));
});

app.get('/api/feature-store/summary', (req, res) => {
  const lookbackDays = Number(req.query.lookbackDays ?? 180);
  res.json(featureStore.getSummary(Number.isFinite(lookbackDays) ? lookbackDays : 180));
});

app.get('/api/feature-store/query', (req, res) => {
  const lookbackDays = Number(req.query.lookbackDays ?? 180);
  const limit = Number(req.query.limit ?? 100);
  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
  const assetClass = typeof req.query.assetClass === 'string' ? req.query.assetClass : undefined;
  const regime = typeof req.query.regime === 'string' ? req.query.regime : undefined;
  const flowBucket = typeof req.query.flowBucket === 'string' ? req.query.flowBucket as 'bullish' | 'bearish' | 'neutral' : undefined;
  const strategyId = typeof req.query.strategyId === 'string' ? req.query.strategyId : undefined;

  const filters = {
    ...(symbol ? { symbol } : {}),
    ...(assetClass ? { assetClass } : {}),
    ...(regime ? { regime } : {}),
    ...(flowBucket ? { flowBucket } : {}),
    ...(strategyId ? { strategyId } : {}),
    lookbackDays: Number.isFinite(lookbackDays) ? lookbackDays : 180,
    limit: Number.isFinite(limit) ? limit : 100
  };

  res.json(featureStore.queryTrades(filters));
});

app.get('/api/market-snapshots', async (_req, res) => {
  const marketData = await fetchJson<{ snapshots?: MarketSnapshot[] }>(MARKET_DATA_URL, '/snapshots');
  res.json(dedupeMarketSnapshots([...(marketData?.snapshots ?? []), ...paperEngine.getMarketSnapshots()]));
});

app.get('/api/settings', async (_req, res) => {
  const [riskSettings, marketData] = await Promise.all([
    fetchJson<SystemSettings>(RISK_ENGINE_URL, '/settings'),
    fetchJson<{ universe?: string[] }>(MARKET_DATA_URL, '/snapshots')
  ]);
  const base = riskSettings ?? DEFAULT_SETTINGS;
  res.json({
    ...base,
    paperBroker: 'alpaca-paper',
    liveBroker: 'coinbase-live',
    universe: marketData?.universe?.length ? marketData.universe : base.universe
  });
});

app.get('/api/paper-desk', async (_req, res) => {
  const paperDesk = paperEngine.getSnapshot();
  try {
    const brokerState = await fetchJson<BrokerRouterAccountResponse>(BROKER_ROUTER_URL, '/account');
    if (brokerState) {
      const brokerAccts = normalizeBrokerAccounts(brokerState.brokers ?? []);
      const brokerPos = normalizeBrokerPositions(brokerState.brokers ?? []);
      // Aggregate equity across connected brokers
      const alpacaAcct = brokerAccts.find((a) => a.broker === 'alpaca-paper');
      const oandaAcct = brokerAccts.find((a) => a.broker === 'oanda-rest');
      const coinbaseAcct = brokerAccts.find((a) => a.broker === 'coinbase-live');

      // Baseline: Alpaca (real paper) + Oanda (real paper) + Coinbase (simulated paper)
      let combinedEquity = (alpacaAcct?.equity ?? 0) + (oandaAcct?.equity ?? 0);
      
      // If Coinbase is connected, treat it as a 100k simulated paper account + its agent PnL
      if (coinbaseAcct && coinbaseAcct.status === 'connected') {
        const coinbaseAgentPnl = paperDesk.agents
          .filter(a => a.broker === 'coinbase-live')
          .reduce((sum, a) => sum + a.realizedPnl, 0);
        combinedEquity += (BROKER_STARTING_EQUITY + coinbaseAgentPnl);
      }

      let openRisk = brokerPos.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
      let realRealizedPnl = 0;
      
      if (alpacaAcct && alpacaAcct.status === 'connected') {
        realRealizedPnl += (alpacaAcct.cash - BROKER_STARTING_EQUITY);
      }

      for (const broker of brokerState.brokers) {
        if (broker.broker === 'oanda-rest') {
          const acct = broker.account as Record<string, unknown> ?? {};
          openRisk += parseFloat(String(acct.unrealizedPL ?? '0')) || 0;
          realRealizedPnl += parseFloat(String(acct.pl ?? '0')) || 0;
        }
      }

      if (combinedEquity > 0) {
        paperDesk.totalEquity = round(combinedEquity, 2);
        paperDesk.startingEquity = BROKER_STARTING_EQUITY * 3;
        paperDesk.totalDayPnl = round(combinedEquity - paperDesk.startingEquity, 2);
        paperDesk.realizedPnl = round(realRealizedPnl, 2);
      }
      if (paperDesk.analytics) paperDesk.analytics.totalOpenRisk = round(openRisk, 2);
    }
  } catch { /* best-effort */ }
  res.json(paperDesk);
});

app.get('/api/weekly-report', (_req, res) => {
  const report = paperEngine.getWeeklyReport();
  if (!report) {
    res.status(404).json({ error: 'Weekly report not generated yet.' });
    return;
  }
  let content: string | null = null;
  try {
    if (fs.existsSync(report.path)) {
      content = fs.readFileSync(report.path, 'utf8');
    }
  } catch {
    content = null;
  }
  res.json({
    asOf: report.asOf,
    path: report.path,
    summary: report.summary,
    content
  });
});

app.get('/api/risk-controls', (_req, res) => {
  res.json(paperEngine.getRiskControlSnapshot());
});

app.post('/api/risk-controls/circuit-breaker/review', (req, res) => {
  const note = typeof req.body?.note === 'string' && req.body.note.trim().length > 0
    ? req.body.note.trim()
    : 'manual review complete';
  res.json(paperEngine.acknowledgeCircuitBreaker(note));
});

app.get('/api/walk-forward', (_req, res) => {
  res.json({ asOf: new Date().toISOString(), results: paperEngine.getWalkForwardSnapshot() });
});

app.get('/api/forensics/losses', (req, res) => {
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 12;
  const symbol = typeof req.query.symbol === 'string' && req.query.symbol.trim().length > 0
    ? req.query.symbol.trim().toUpperCase()
    : undefined;
  res.json({
    asOf: new Date().toISOString(),
    symbol: symbol ?? null,
    rows: paperEngine.getLossForensics(limit, symbol)
  });
});

app.get('/api/agent-configs', (_req, res) => {
  res.json(paperEngine.getAgentConfigs());
});

app.get('/api/live-readiness', (_req, res) => {
  res.json(paperEngine.getLiveReadiness());
});

app.get('/api/opportunities', (_req, res) => {
  const routePlan: StrategyRoutePlan = paperEngine.getOpportunitySnapshot();
  res.json(routePlan);
});

app.get('/api/terminals', async (_req, res) => {
  try {
    res.json(await buildTerminalSnapshot());
  } catch (error) {
    res.status(502).json(buildTerminalFallbackSnapshot(error));
  }
});

app.get('/api/copy-sleeve', async (req, res) => {
  const managerId = typeof req.query.managerId === 'string' && req.query.managerId.trim().length > 0
    ? req.query.managerId.trim()
    : 'berkshire-hathaway';
  const asOf = typeof req.query.asOf === 'string' && req.query.asOf.trim().length > 0
    ? req.query.asOf.trim()
    : new Date().toISOString();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const response = await fetch(`${BACKTEST_URL}/copy-sleeve?managerId=${encodeURIComponent(managerId)}&asOf=${encodeURIComponent(asOf)}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      res.status(response.status).json({ error: errorText || 'Copy sleeve service unavailable.' });
      return;
    }
    const snapshot = await response.json() as CopySleevePortfolioSnapshot;
    res.json(snapshot);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Copy sleeve service unavailable.' });
  }
});

app.post('/api/copy-sleeve/backtest', async (req, res) => {
  const body = req.body as Partial<CopySleeveBacktestRequest>;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const response = await fetch(`${BACKTEST_URL}/copy-sleeve/backtest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      res.status(response.status).json({ error: errorText || 'Copy sleeve backtest failed' });
      return;
    }
    const result = await response.json() as CopySleeveBacktestResult;
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Copy sleeve backtest failed' });
  }
});

app.get('/api/copy-sleeve/backtest', async (req, res) => {
  const query = new URLSearchParams();
  if (typeof req.query.managerId === 'string') query.set('managerId', req.query.managerId);
  if (typeof req.query.startDate === 'string') query.set('startDate', req.query.startDate);
  if (typeof req.query.endDate === 'string') query.set('endDate', req.query.endDate);
  if (typeof req.query.capital === 'string') query.set('capital', req.query.capital);
  if (typeof req.query.benchmarkSymbol === 'string') query.set('benchmarkSymbol', req.query.benchmarkSymbol);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const response = await fetch(`${BACKTEST_URL}/copy-sleeve/backtest?${query.toString()}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      res.status(response.status).json({ error: errorText || 'Copy sleeve backtest unavailable.' });
      return;
    }
    const result = await response.json() as CopySleeveBacktestResult;
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Copy sleeve backtest unavailable.' });
  }
});

app.get('/api/macro-preservation', async (req, res) => {
  const asOf = typeof req.query.asOf === 'string' && req.query.asOf.trim().length > 0
    ? req.query.asOf.trim()
    : new Date().toISOString();
  const query = new URLSearchParams();
  query.set('asOf', asOf);
  if (typeof req.query.benchmarkSymbol === 'string' && req.query.benchmarkSymbol.trim().length > 0) query.set('benchmarkSymbol', req.query.benchmarkSymbol.trim());
  if (typeof req.query.cashSymbol === 'string' && req.query.cashSymbol.trim().length > 0) query.set('cashSymbol', req.query.cashSymbol.trim());
  if (typeof req.query.inflationThresholdPct === 'string' && Number.isFinite(Number(req.query.inflationThresholdPct))) query.set('inflationThresholdPct', req.query.inflationThresholdPct);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const response = await fetch(`${BACKTEST_URL}/macro-preservation?${query.toString()}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      res.status(response.status).json({ error: errorText || 'Macro preservation snapshot unavailable.' });
      return;
    }
    const snapshot = await response.json() as MacroPreservationPortfolioSnapshot;
    res.json(snapshot);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Macro preservation snapshot unavailable.' });
  }
});

app.post('/api/macro-preservation/backtest', async (req, res) => {
  const body = req.body as Partial<MacroPreservationBacktestRequest>;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const response = await fetch(`${BACKTEST_URL}/macro-preservation/backtest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      res.status(response.status).json({ error: errorText || 'Macro preservation backtest failed.' });
      return;
    }
    const result = await response.json() as MacroPreservationBacktestResult;
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Macro preservation backtest failed.' });
  }
});

app.get('/api/macro-preservation/backtest', async (req, res) => {
  const query = new URLSearchParams();
  if (typeof req.query.startDate === 'string') query.set('startDate', req.query.startDate);
  if (typeof req.query.endDate === 'string') query.set('endDate', req.query.endDate);
  if (typeof req.query.capital === 'string') query.set('capital', req.query.capital);
  if (typeof req.query.benchmarkSymbol === 'string') query.set('benchmarkSymbol', req.query.benchmarkSymbol);
  if (typeof req.query.cashSymbol === 'string') query.set('cashSymbol', req.query.cashSymbol);
  if (typeof req.query.inflationThresholdPct === 'string') query.set('inflationThresholdPct', req.query.inflationThresholdPct);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const response = await fetch(`${BACKTEST_URL}/macro-preservation/backtest?${query.toString()}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      res.status(response.status).json({ error: errorText || 'Macro preservation backtest unavailable.' });
      return;
    }
    const result = await response.json() as MacroPreservationBacktestResult;
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Macro preservation backtest unavailable.' });
  }
});

app.get('/api/quarter-outlook', async (req, res) => {
  const query = new URLSearchParams();
  if (typeof req.query.asOf === 'string' && req.query.asOf.trim().length > 0) {
    query.set('asOf', req.query.asOf.trim());
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const response = await fetch(`${BACKTEST_URL}/quarter-outlook${query.toString() ? `?${query.toString()}` : ''}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      res.status(response.status).json({ error: errorText || 'Quarter outlook unavailable.' });
      return;
    }
    const report = await response.json() as QuarterSimulationReport;
    res.json(report);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Quarter outlook unavailable.' });
  }
});

app.get('/api/capital-allocation', async (req, res) => {
  try {
    const asOf = typeof req.query.asOf === 'string' && req.query.asOf.trim().length > 0
      ? req.query.asOf.trim()
      : new Date().toISOString();
    const paperDesk = paperEngine.getSnapshot();
    const capital = typeof req.query.capital === 'string' && Number.isFinite(Number(req.query.capital))
      ? Number(req.query.capital)
      : paperDesk.totalEquity;
    const [copySleeve, copyBacktest, macroSnapshot, macroBacktest] = await Promise.all([
      fetchJson<CopySleevePortfolioSnapshot>(BACKTEST_URL, `/copy-sleeve?asOf=${encodeURIComponent(asOf)}`, 5_000),
      fetchJson<CopySleeveBacktestResult>(BACKTEST_URL, `/copy-sleeve/backtest`, 5_000),
      fetchJson<MacroPreservationPortfolioSnapshot>(BACKTEST_URL, `/macro-preservation?asOf=${encodeURIComponent(asOf)}`, 5_000),
      fetchJson<MacroPreservationBacktestResult>(BACKTEST_URL, `/macro-preservation/backtest`, 5_000)
    ]);
    const snapshot: CapitalAllocatorSnapshot = buildCapitalAllocatorSnapshot({
      asOf,
      capital,
      paperDesk,
      liveReadiness: paperEngine.getLiveReadiness(),
      opportunityPlan: paperEngine.getOpportunitySnapshot(),
      strategySnapshots: buildStrategySnapshots(),
      copySleeve,
      copyBacktest,
      macroSnapshot,
      macroBacktest
    });
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Capital allocation snapshot failed' });
  }
});

// --------------- New Strategy Engines ---------------

const pairsEngine = new PairsEngine(15_000);
const makerEngine = new MakerEngine(['BTC-USD', 'ETH-USD'], 6_000);
const makerExecutor = new MakerOrderExecutor();
makerEngine.setBrokerExecutionMode(makerExecutor.getSnapshot().liveRoutingEnabled);
const btcGrid = new GridEngine('BTC-USD', 10_000, 12, 10);
const ethGrid = new GridEngine('ETH-USD', 10_000, 15, 10);
const solGrid = new GridEngine('SOL-USD', 8_000, 24, 8);
const xrpGrid = new GridEngine('XRP-USD', 7_000, 35, 8);

const marketIntel = getMarketIntel();
const newsIntel = getNewsIntel();
const eventCalendar = getEventCalendar();
const laneLearning = new LaneLearningEngine();
const sidecarLaneControls = new Map<string, SidecarLaneControlState>();
const strategyStateCache = new Map<string, string>();
const laneLearningCache = new Map<string, string>();
let strategyReplayTick = 0;
let marketFeedInFlight = false;
const lastFedMarketSnapshotFingerprint = new Map<string, string>();
const lastFedMicrostructureFingerprint = new Map<string, string>();

// Feed market data into all strategy engines
setInterval(async () => {
  if (marketFeedInFlight) {
    return;
  }
  marketFeedInFlight = true;
  try {
    const [marketData, microstructure, riskState] = await Promise.all([
      fetchJson<{ snapshots?: Array<{ symbol: string; lastPrice: number; volume?: number; spreadBps?: number; changePct?: number; updatedAt?: string }> }>(MARKET_DATA_URL, '/snapshots'),
      fetchJson<{ snapshots?: Array<{ symbol: string; bidDepth: number; askDepth: number; imbalancePct: number; queueImbalancePct?: number; tradeImbalancePct?: number; pressureImbalancePct?: number; spreadStableMs?: number; microPrice: number; bestBid: number; bestAsk: number; spread: number; spreadBps: number; updatedAt: string }> }>(MARKET_DATA_URL, '/microstructure'),
      fetchJson<{ killSwitchArmed?: boolean; blockedSymbols?: string[] }>(RISK_ENGINE_URL, '/state')
    ]);
    const snapshots = marketData?.snapshots ?? [];

    // Feed prices to market intelligence for technical indicators
    for (const snap of snapshots) {
      if (snap.lastPrice <= 0) {
        continue;
      }
      const fingerprint = fingerprintMarketSnapshot(snap);
      if (lastFedMarketSnapshotFingerprint.get(snap.symbol) === fingerprint) {
        continue;
      }
      lastFedMarketSnapshotFingerprint.set(snap.symbol, fingerprint);
      marketIntel.feedPrice(snap.symbol, snap.lastPrice, (snap as Record<string, unknown>).volume as number | undefined);
    }
    applySidecarLaneControls(snapshots, riskState ?? { killSwitchArmed: false, blockedSymbols: [] });
    const macro = newsIntel.getMacroSignal();
    for (const flow of microstructure?.snapshots ?? []) {
      const fingerprint = fingerprintMicrostructure(flow);
      if (lastFedMicrostructureFingerprint.get(flow.symbol) === fingerprint) {
        continue;
      }
      lastFedMicrostructureFingerprint.set(flow.symbol, fingerprint);
      const combinedImbalance = flow.imbalancePct * 0.45 + (flow.queueImbalancePct ?? 0) * 0.15 + (flow.tradeImbalancePct ?? 0) * 0.25 + (flow.pressureImbalancePct ?? 0) * 0.15;
      const adverseSelectionScore = Math.min(100,
        Math.abs(flow.tradeImbalancePct ?? 0) * 0.55
        + Math.abs(flow.queueImbalancePct ?? 0) * 0.2
        + Math.abs(flow.pressureImbalancePct ?? 0) * 0.15
        + ((flow.spreadStableMs ?? 0) < 2_500 ? 18 : 0)
        + flow.spreadBps * 2
      );
      marketIntel.feedOrderFlow({
        symbol: flow.symbol,
        bidDepth: flow.bidDepth,
        askDepth: flow.askDepth,
        imbalancePct: combinedImbalance,
        ...(flow.queueImbalancePct !== undefined ? { queueImbalancePct: flow.queueImbalancePct } : {}),
        ...(flow.tradeImbalancePct !== undefined ? { tradeImbalancePct: flow.tradeImbalancePct } : {}),
        ...(flow.pressureImbalancePct !== undefined ? { pressureImbalancePct: flow.pressureImbalancePct } : {}),
        ...(flow.spreadStableMs !== undefined ? { spreadStableMs: flow.spreadStableMs } : {}),
        adverseSelectionScore,
        direction: Math.abs(combinedImbalance) < 15 ? 'neutral' : combinedImbalance > 0 ? 'buy' : 'sell',
        strength: Math.abs(combinedImbalance) > 60 ? 'strong' : Math.abs(combinedImbalance) > 30 ? 'moderate' : 'weak',
        spread: flow.spread,
        spreadBps: flow.spreadBps,
        timestamp: flow.updatedAt
      });

      if (flow.symbol === 'BTC-USD' || flow.symbol === 'ETH-USD') {
        const symbolNews = newsIntel.getSignal(flow.symbol);
        const embargo = eventCalendar.getEmbargo(flow.symbol);
        const makerControl = sidecarLaneControls.get(`maker-${flow.symbol.toLowerCase()}`);
        const blocked = Boolean((riskState?.killSwitchArmed ?? false)
          || (riskState?.blockedSymbols ?? []).includes(flow.symbol)
          || macro.veto
          || symbolNews.veto
          || embargo.blocked
          || (makerControl && !makerControl.enabled));
        const reason = blocked
          ? (riskState?.killSwitchArmed
            ? 'Risk kill switch armed.'
            : symbolNews.veto
              ? 'Critical symbol news veto active.'
              : macro.veto
                ? 'Critical macro veto active.'
                : embargo.blocked
                  ? embargo.reason
                  : makerControl?.blockedReason ?? 'Maker lane blocked.')
          : 'Maker quoting enabled.';
        makerEngine.update({
          symbol: flow.symbol,
          bestBid: flow.bestBid,
          bestAsk: flow.bestAsk,
          microPrice: flow.microPrice,
          spreadBps: flow.spreadBps,
          spreadStableMs: flow.spreadStableMs ?? 0,
          queueImbalancePct: flow.queueImbalancePct ?? 0,
          tradeImbalancePct: flow.tradeImbalancePct ?? 0,
          pressureImbalancePct: flow.pressureImbalancePct ?? 0
        }, marketIntel.getCompositeSignal(flow.symbol), { blocked, reason });
      }
    }

    const btc = snapshots.find((s) => s.symbol === 'BTC-USD');
    const eth = snapshots.find((s) => s.symbol === 'ETH-USD');
    if (btc && eth && btc.lastPrice > 0 && eth.lastPrice > 0) {
      pairsEngine.update(btc.lastPrice, eth.lastPrice);
      btcGrid.update(btc.lastPrice);
      ethGrid.update(eth.lastPrice);
    }
    const sol = snapshots.find((s) => s.symbol === 'SOL-USD');
    const xrp = snapshots.find((s) => s.symbol === 'XRP-USD');
    if (sol && sol.lastPrice > 0) solGrid.update(sol.lastPrice);
    if (xrp && xrp.lastPrice > 0) xrpGrid.update(xrp.lastPrice);

    const externalMakerFills = await makerExecutor.reconcile(makerEngine.getSnapshot().states);
    for (const fill of externalMakerFills) {
      makerEngine.applyExternalFill(fill);
    }
    recordStrategyLaneJournals();
    recordStrategyLaneStates(snapshots, riskState ?? { killSwitchArmed: false, blockedSymbols: [] });
  } catch { /* non-critical */ }
  finally {
    marketFeedInFlight = false;
  }
}, 2_000);

// Learning loop
const learningLoop = new LearningLoop(
  () => {
    const desk = paperEngine.getSnapshot();
    return desk.agents.map((agent) => {
      const tuning = desk.tuning.find((t) => t.agentId === agent.id);
      return {
        agentId: agent.id,
        agentName: agent.name,
        symbol: agent.lastSymbol,
        style: tuning?.style ?? 'momentum',
        trades: agent.totalTrades,
        wins: Math.round(agent.totalTrades * agent.winRate / 100),
        realizedPnl: agent.realizedPnl,
        profitFactor: tuning?.profitFactor ?? 0,
        winRate: agent.winRate,
        currentConfig: {
          targetBps: tuning?.targetBps ?? 120,
          stopBps: tuning?.stopBps ?? 100,
          maxHoldTicks: tuning?.maxHoldTicks ?? 30,
          cooldownTicks: 8,
          sizeFraction: (tuning?.sizeFractionPct ?? 6) / 100,
          spreadLimitBps: tuning?.spreadLimitBps ?? 5,
          style: tuning?.style ?? 'momentum'
        }
      };
    });
  },
  (agentId, newConfig) => {
    const applied = paperEngine.applyAgentConfig(agentId, {
      style: newConfig.style as 'momentum' | 'mean-reversion' | 'breakout',
      targetBps: newConfig.targetBps,
      stopBps: newConfig.stopBps,
      maxHoldTicks: newConfig.maxHoldTicks,
      cooldownTicks: newConfig.cooldownTicks,
      sizeFraction: newConfig.sizeFraction,
      spreadLimitBps: newConfig.spreadLimitBps
    });
    if (applied) {
      console.log(`[learning-loop] Applied promoted config to ${agentId}`);
    }
    return applied;
  }
);
learningLoop.start();

function readSharedJournalEntries(): TradeJournalEntry[] {
  try {
    if (!fs.existsSync(STRATEGY_JOURNAL_PATH)) return [];
    return fs.readFileSync(STRATEGY_JOURNAL_PATH, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as TradeJournalEntry);
  } catch {
    return [];
  }
}

function classifyMarketRegime(symbols: string[], snapshots: Array<{ symbol: string; spreadBps?: number; changePct?: number }>): string {
  const relevant = snapshots.filter((snapshot) => symbols.includes(snapshot.symbol));
  if (relevant.length === 0) return 'unknown';
  const avgSpread = relevant.reduce((sum, snapshot) => sum + (snapshot.spreadBps ?? 0), 0) / relevant.length;
  const avgMove = relevant.reduce((sum, snapshot) => sum + Math.abs(snapshot.changePct ?? 0), 0) / relevant.length;
  if (avgSpread >= 6 || avgMove >= 2.5) return 'panic';
  if (avgMove >= 1.1) return 'trend';
  if (avgSpread <= 1.2 && avgMove <= 0.4) return 'compression';
  return 'chop';
}

function buildSidecarLaneControl(
  strategyId: string,
  strategy: string,
  lane: 'pairs' | 'grid' | 'maker',
  symbols: string[],
  riskState: { killSwitchArmed?: boolean; blockedSymbols?: string[] },
  snapshots: Array<{ symbol: string; spreadBps?: number; changePct?: number }>,
  learningDecision?: {
    enabled: boolean;
    allocationMultiplier: number;
    recentTrades: number;
    posteriorWinRate: number;
    profitFactor: number;
    reason: string;
  }
): SidecarLaneControlState {
  const macro = newsIntel.getMacroSignal();
  const blockedSymbols = riskState.blockedSymbols ?? [];
  const embargoed = symbols.some((symbol) => blockedSymbols.includes(symbol) || eventCalendar.getEmbargo(symbol).blocked);
  const newsBlocked = symbols.some((symbol) => newsIntel.getSignal(symbol).veto);

  let enabled = learningDecision?.enabled ?? true;
  let blockedReason = learningDecision?.reason ?? 'Lane enabled.';
  let allocationMultiplier = learningDecision?.allocationMultiplier ?? 1;

  if (riskState.killSwitchArmed) {
    enabled = false;
    blockedReason = 'Risk engine kill switch armed.';
  } else if (macro.veto) {
    enabled = false;
    blockedReason = 'Critical macro veto active.';
  } else if (embargoed) {
    enabled = false;
    blockedReason = 'Event embargo active on at least one leg.';
  } else if (newsBlocked) {
    enabled = false;
    blockedReason = 'Critical symbol news veto active.';
  }

  return {
    strategyId,
    strategy,
    lane,
    symbols,
    enabled,
    blockedReason,
    allocationMultiplier,
    recentTrades: learningDecision?.recentTrades ?? 0,
    recentWinRate: learningDecision?.posteriorWinRate ?? 0,
    recentProfitFactor: learningDecision?.profitFactor ?? 0,
    lastReviewAt: new Date().toISOString(),
    lastAdjustment: `${enabled ? 'enabled' : 'blocked'} / alloc ${allocationMultiplier.toFixed(2)} / regime ${classifyMarketRegime(symbols, snapshots)}`
  };
}

function applySidecarLaneControls(
  snapshots: Array<{ symbol: string; spreadBps?: number; changePct?: number }>,
  riskState: { killSwitchArmed?: boolean; blockedSymbols?: string[] }
): void {
  const journalEntries = readSharedJournalEntries();
  const learningDecisions = laneLearning.review(journalEntries);
  const learningMap = new Map(learningDecisions.map((decision) => [decision.strategyId, decision]));
  for (const decision of learningDecisions) {
    const serialized = JSON.stringify(decision);
    if (laneLearningCache.get(decision.strategyId) !== serialized) {
      laneLearningCache.set(decision.strategyId, serialized);
      appendStrategyEvent('lane-learning', decision as unknown as Record<string, unknown>);
    }
  }
  const controls: Array<{ control: SidecarLaneControlState; apply: () => void }> = [
    {
      control: buildSidecarLaneControl('pairs-btc-eth', 'BTC/ETH Dynamic Hedge Pair', 'pairs', ['BTC-USD', 'ETH-USD'], riskState, snapshots, learningMap.get('pairs-btc-eth')),
      apply: () => {
        const control = sidecarLaneControls.get('pairs-btc-eth');
        if (!control) return;
        pairsEngine.setTradingEnabled(control.enabled, control.blockedReason);
        pairsEngine.setAllocationMultiplier(control.allocationMultiplier);
      }
    },
    {
      control: buildSidecarLaneControl('grid-btc-usd', 'BTC Adaptive Grid', 'grid', ['BTC-USD'], riskState, snapshots, learningMap.get('grid-btc-usd')),
      apply: () => {
        const control = sidecarLaneControls.get('grid-btc-usd');
        if (!control) return;
        btcGrid.setTradingEnabled(control.enabled, control.blockedReason);
        btcGrid.setAllocationMultiplier(control.allocationMultiplier);
      }
    },
    {
      control: buildSidecarLaneControl('grid-eth-usd', 'ETH Adaptive Grid', 'grid', ['ETH-USD'], riskState, snapshots, learningMap.get('grid-eth-usd')),
      apply: () => {
        const control = sidecarLaneControls.get('grid-eth-usd');
        if (!control) return;
        ethGrid.setTradingEnabled(control.enabled, control.blockedReason);
        ethGrid.setAllocationMultiplier(control.allocationMultiplier);
      }
    },
    {
      control: buildSidecarLaneControl('grid-sol-usd', 'SOL Adaptive Grid', 'grid', ['SOL-USD'], riskState, snapshots, learningMap.get('grid-sol-usd')),
      apply: () => {
        const control = sidecarLaneControls.get('grid-sol-usd');
        if (!control) return;
        solGrid.setTradingEnabled(control.enabled, control.blockedReason);
        solGrid.setAllocationMultiplier(control.allocationMultiplier);
      }
    },
    {
      control: buildSidecarLaneControl('grid-xrp-usd', 'XRP Adaptive Grid', 'grid', ['XRP-USD'], riskState, snapshots, learningMap.get('grid-xrp-usd')),
      apply: () => {
        const control = sidecarLaneControls.get('grid-xrp-usd');
        if (!control) return;
        xrpGrid.setTradingEnabled(control.enabled, control.blockedReason);
        xrpGrid.setAllocationMultiplier(control.allocationMultiplier);
      }
    },
    {
      control: buildSidecarLaneControl('maker-btc-usd', 'BTC-USD Maker', 'maker', ['BTC-USD'], riskState, snapshots, learningMap.get('maker-btc-usd')),
      apply: () => {
        /* maker lane uses control state directly during guard evaluation */
      }
    },
    {
      control: buildSidecarLaneControl('maker-eth-usd', 'ETH-USD Maker', 'maker', ['ETH-USD'], riskState, snapshots, learningMap.get('maker-eth-usd')),
      apply: () => {
        /* maker lane uses control state directly during guard evaluation */
      }
    }
  ];

  for (const item of controls) {
    sidecarLaneControls.set(item.control.strategyId, item.control);
    item.apply();
  }
}

function recordStrategyLaneJournals(): void {
  for (const fill of pairsEngine.drainClosedFills()) {
    const news = newsIntel.getSignal('BTC-USD');
    const macro = newsIntel.getMacroSignal();
    const intel = marketIntel.getCompositeSignal('BTC-USD');
    appendStrategyJournal({
      id: `strategy-journal-${fill.id}`,
      symbol: 'BTC-USD',
      assetClass: 'crypto',
      broker: 'coinbase-live',
      strategy: 'BTC/ETH Dynamic Hedge Pair',
      strategyId: 'pairs-btc-eth',
      lane: 'pairs',
      thesis: `${fill.direction} pair trade with beta ${fill.hedgeRatio.toFixed(4)} and correlation ${fill.correlation.toFixed(3)}.`,
      entryAt: fill.entryAt,
      entryTimestamp: fill.entryAt,
      exitAt: fill.timestamp,
      realizedPnl: fill.pnl,
      realizedPnlPct: 0,
      slippageBps: 0.5,
      spreadBps: 0,
      holdTicks: fill.holdTicks,
      confidencePct: intel.confidence,
      regime: Math.abs(fill.zScoreAtEntry) >= 2.5 ? 'trend-dislocation' : 'mean-reverting-compression',
      newsBias: news.direction,
      orderFlowBias: intel.direction,
      macroVeto: macro.veto,
      embargoed: eventCalendar.getEmbargo('BTC-USD').blocked || eventCalendar.getEmbargo('ETH-USD').blocked,
      tags: ['pair-trade', `reason-${fill.reason}`],
      aiComment: `Pair closed on ${fill.reason}. L2 intel ${intel.direction}/${intel.confidence}%. News ${news.direction}/${news.confidence}%. Macro veto=${macro.veto}.`,
      exitReason: fill.reason,
      verdict: fill.pnl > 0 ? 'winner' : fill.pnl < 0 ? 'loser' : 'scratch',
      source: 'simulated'
    });
  }

  for (const fill of makerEngine.drainClosedFills()) {
    const news = newsIntel.getSignal(fill.symbol);
    const macro = newsIntel.getMacroSignal();
    const intel = marketIntel.getCompositeSignal(fill.symbol);
    appendStrategyJournal({
      id: `strategy-journal-${fill.id}`,
      symbol: fill.symbol,
      assetClass: 'crypto',
      broker: 'coinbase-live',
      strategy: `${fill.symbol} Maker`,
      strategyId: `maker-${fill.symbol.toLowerCase()}`,
      lane: 'maker',
      thesis: `Maker inventory round-trip on ${fill.symbol} with ${fill.widthBps.toFixed(2)} bps width.`,
      entryAt: fill.entryAt,
      entryTimestamp: fill.entryAt,
      exitAt: fill.exitAt,
      realizedPnl: fill.pnl,
      realizedPnlPct: 0,
      slippageBps: 0.1,
      spreadBps: fill.widthBps,
      confidencePct: intel.confidence,
      regime: 'maker-liquidity-provision',
      newsBias: news.direction,
      orderFlowBias: intel.direction,
      macroVeto: macro.veto,
      embargoed: eventCalendar.getEmbargo(fill.symbol).blocked,
      tags: ['maker', fill.reason],
      aiComment: `Maker exit ${fill.reason}. Width ${fill.widthBps.toFixed(2)}bps. L2 intel ${intel.direction}/${intel.confidence}%.`,
      exitReason: fill.reason,
      verdict: fill.pnl > 0 ? 'winner' : fill.pnl < 0 ? 'loser' : 'scratch',
      source: 'simulated'
    });
  }

  const gridConfigs: Array<{ strategyId: string; symbol: string; name: string; engine: GridEngine }> = [
    { strategyId: 'grid-btc-usd', symbol: 'BTC-USD', name: 'BTC Adaptive Grid', engine: btcGrid },
    { strategyId: 'grid-eth-usd', symbol: 'ETH-USD', name: 'ETH Adaptive Grid', engine: ethGrid },
    { strategyId: 'grid-sol-usd', symbol: 'SOL-USD', name: 'SOL Adaptive Grid', engine: solGrid },
    { strategyId: 'grid-xrp-usd', symbol: 'XRP-USD', name: 'XRP Adaptive Grid', engine: xrpGrid }
  ];

  for (const { strategyId, symbol, name, engine } of gridConfigs) {
    for (const fill of engine.drainClosedFills()) {
      const news = newsIntel.getSignal(symbol);
      const intel = marketIntel.getCompositeSignal(symbol);
      appendStrategyJournal({
        id: `strategy-journal-${fill.id}`,
        symbol,
        assetClass: 'crypto',
        broker: 'coinbase-live',
        strategy: name,
        strategyId,
        lane: 'grid',
        thesis: `Grid closure on ${symbol} at level ${fill.level}.`,
        entryAt: fill.entryAt ?? fill.timestamp,
        entryTimestamp: fill.entryAt ?? fill.timestamp,
        exitAt: fill.timestamp,
        realizedPnl: fill.pnl,
        realizedPnlPct: 0,
        slippageBps: 0.25,
        spreadBps: 0,
        confidencePct: intel.confidence,
        regime: fill.type === 'recenter-close' ? 'recentered-trend' : 'grid-chop',
        newsBias: news.direction,
        orderFlowBias: intel.direction,
        macroVeto: newsIntel.getMacroSignal().veto,
        embargoed: eventCalendar.getEmbargo(symbol).blocked,
        tags: ['grid', fill.type, `level-${fill.level}`],
        aiComment: `Grid fill ${fill.type}. L2 intel ${intel.direction}/${intel.confidence}%. News ${news.direction}/${news.confidence}%.`,
        exitReason: fill.type,
        verdict: fill.pnl > 0 ? 'winner' : fill.pnl < 0 ? 'loser' : 'scratch',
        source: 'simulated'
      });
    }
  }
}

function recordStrategyLaneStates(
  snapshots: Array<{ symbol: string; lastPrice: number; spreadBps?: number; changePct?: number }>,
  riskState: { killSwitchArmed?: boolean; blockedSymbols?: string[] }
): void {
  strategyReplayTick += 1;
  const btc = snapshots.find((snapshot) => snapshot.symbol === 'BTC-USD');
  const eth = snapshots.find((snapshot) => snapshot.symbol === 'ETH-USD');
  const pairsPayload = {
    strategyId: 'pairs-btc-eth',
    strategy: 'BTC/ETH Dynamic Hedge Pair',
    lane: 'pairs',
    replayTick: strategyReplayTick,
    symbols: ['BTC-USD', 'ETH-USD'],
    control: sidecarLaneControls.get('pairs-btc-eth') ?? null,
    state: pairsEngine.getState(btc?.lastPrice ?? 0, eth?.lastPrice ?? 0),
    stats: (() => {
      const stats = pairsEngine.getStats();
      return {
        realizedPnl: stats.realizedPnl,
        totalTrades: stats.totalTrades,
        winRate: stats.winRate,
        tradingEnabled: stats.tradingEnabled,
        blockedReason: stats.blockedReason,
        allocationMultiplier: stats.allocationMultiplier
      };
    })(),
    risk: riskState,
    regime: classifyMarketRegime(['BTC-USD', 'ETH-USD'], snapshots)
  };
  emitStrategyStateIfChanged('pairs-btc-eth', pairsPayload);

  const makerOrders = makerExecutor.getSnapshot().states;
  for (const state of makerEngine.getSnapshot().states) {
    emitStrategyStateIfChanged(`maker-${state.symbol.toLowerCase()}`, {
      strategyId: `maker-${state.symbol.toLowerCase()}`,
      strategy: `${state.symbol} Maker`,
      lane: 'maker',
      replayTick: strategyReplayTick,
      symbols: [state.symbol],
      state,
      orders: makerOrders.find((entry) => entry.symbol === state.symbol) ?? null,
      stats: {
        realizedPnl: state.realizedPnl,
        roundTrips: state.roundTrips,
        inventoryQty: state.inventoryQty,
        mode: state.mode,
        adverseScore: state.adverseScore,
        spreadStableMs: state.spreadStableMs,
        pressureImbalancePct: state.pressureImbalancePct
      },
      risk: riskState,
      regime: 'maker-liquidity-provision'
    });
  }

  const grids: Array<{ strategyId: string; strategy: string; symbol: string; engine: GridEngine }> = [
    { strategyId: 'grid-btc-usd', strategy: 'BTC Adaptive Grid', symbol: 'BTC-USD', engine: btcGrid },
    { strategyId: 'grid-eth-usd', strategy: 'ETH Adaptive Grid', symbol: 'ETH-USD', engine: ethGrid },
    { strategyId: 'grid-sol-usd', strategy: 'SOL Adaptive Grid', symbol: 'SOL-USD', engine: solGrid },
    { strategyId: 'grid-xrp-usd', strategy: 'XRP Adaptive Grid', symbol: 'XRP-USD', engine: xrpGrid }
  ];

  for (const grid of grids) {
    const state = grid.engine.getState();
    const stats = grid.engine.getStats();
    emitStrategyStateIfChanged(grid.strategyId, {
      strategyId: grid.strategyId,
      strategy: grid.strategy,
      lane: 'grid',
      replayTick: strategyReplayTick,
      symbols: [grid.symbol],
      control: sidecarLaneControls.get(grid.strategyId) ?? null,
      state: {
        centerPrice: state.centerPrice,
        gridSpacingBps: state.gridSpacingBps,
        completedRoundTrips: state.completedRoundTrips,
        totalPnl: state.totalPnl
      },
      stats: {
        realizedPnl: stats.realizedPnl,
        roundTrips: stats.roundTrips,
        winRate: stats.winRate,
        openPositions: stats.openPositions,
        tradingEnabled: stats.tradingEnabled,
        blockedReason: stats.blockedReason,
        allocationMultiplier: stats.allocationMultiplier
      },
      risk: riskState,
      regime: classifyMarketRegime([grid.symbol], snapshots)
    });
  }
}

function emitStrategyStateIfChanged(strategyId: string, payload: Record<string, unknown>): void {
  const serialized = JSON.stringify(payload);
  if (strategyStateCache.get(strategyId) === serialized) {
    return;
  }
  strategyStateCache.set(strategyId, serialized);
  appendStrategyEvent('strategy-state', payload);
}

function appendStrategyJournal(entry: TradeJournalEntry): void {
  try {
    fs.mkdirSync(STRATEGY_LEDGER_DIR, { recursive: true });
    fs.appendFileSync(STRATEGY_JOURNAL_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
    appendStrategyEvent('strategy-journal', entry as unknown as Record<string, unknown>);
  } catch (error) {
    console.error('[api] failed to append strategy journal', error);
  }
}

function appendStrategyEvent(type: string, payload: Record<string, unknown>): void {
  try {
    fs.mkdirSync(STRATEGY_LEDGER_DIR, { recursive: true });
    fs.appendFileSync(STRATEGY_EVENT_LOG_PATH, `${JSON.stringify({
      id: `strategy-event-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      strategyReplayTick,
      type,
      ...payload
    })}\n`, 'utf8');
  } catch (error) {
    console.error('[api] failed to append strategy event', error);
  }
}

// --------------- New API Endpoints ---------------

app.get('/api/pairs', (_req, res) => {
  const btcSnap = paperEngine.getMarketSnapshots().find((s) => s.symbol === 'BTC-USD');
  const ethSnap = paperEngine.getMarketSnapshots().find((s) => s.symbol === 'ETH-USD');
  res.json({
    control: sidecarLaneControls.get('pairs-btc-eth') ?? null,
    state: pairsEngine.getState(btcSnap?.lastPrice ?? 0, ethSnap?.lastPrice ?? 0),
    stats: pairsEngine.getStats()
  });
});

app.get('/api/grid', (_req, res) => {
  res.json({
    btc: { control: sidecarLaneControls.get('grid-btc-usd') ?? null, state: btcGrid.getState(), stats: btcGrid.getStats() },
    eth: { control: sidecarLaneControls.get('grid-eth-usd') ?? null, state: ethGrid.getState(), stats: ethGrid.getStats() },
    sol: { control: sidecarLaneControls.get('grid-sol-usd') ?? null, state: solGrid.getState(), stats: solGrid.getStats() },
    xrp: { control: sidecarLaneControls.get('grid-xrp-usd') ?? null, state: xrpGrid.getState(), stats: xrpGrid.getStats() }
  });
});

app.get('/api/maker', (_req, res) => {
  res.json({
    controls: [
      sidecarLaneControls.get('maker-btc-usd') ?? null,
      sidecarLaneControls.get('maker-eth-usd') ?? null
    ].filter(Boolean),
    quotes: makerEngine.getSnapshot(),
    orders: makerExecutor.getSnapshot()
  });
});

app.get('/api/maker/orders', (_req, res) => {
  res.json(makerExecutor.getSnapshot());
});

app.post('/api/maker/clear-blocks', (req, res) => {
  const symbol = typeof req.body?.symbol === 'string' ? req.body.symbol : undefined;
  makerExecutor.clearBlocks(symbol);
  res.json({ ok: true, symbol: symbol ?? null, snapshot: makerExecutor.getSnapshot() });
});

app.get('/api/maker/policy', (_req, res) => {
  res.json(makerExecutor.getPolicy());
});

app.get('/api/maker/readiness', (_req, res) => {
  const policy = makerExecutor.getPolicy();
  const quotes = makerEngine.getSnapshot().states;
  const orders = makerExecutor.getSnapshot().states;
  res.json({
    asOf: new Date().toISOString(),
    policy,
    symbols: quotes.map((quote) => {
      const control = sidecarLaneControls.get(`maker-${quote.symbol.toLowerCase()}`) ?? null;
      const orderState = orders.find((order) => order.symbol === quote.symbol) ?? null;
      const routeRejected = Boolean(
        orderState && [orderState.activeBid, orderState.activeAsk].some((order) => order?.status === 'rejected')
      );
      const routeRejectReason = orderState
        ? [orderState.activeBid, orderState.activeAsk].find((order) => order?.status === 'rejected')?.reason ?? ''
        : '';
      const fatalRoutePause = Boolean(orderState?.fatalErrorUntil && Date.parse(orderState.fatalErrorUntil) > Date.now());
      const credentialBlocked = Boolean(orderState?.credentialBlocked);
      const fundingBlocked = Boolean(orderState?.fundingBlocked);
      const eligibleForLive = Boolean(
        policy.liveRoutingEnabled
        && policy.liveSymbols.includes(quote.symbol)
        && control?.enabled !== false
        && quote.mode === 'maker'
        && quote.bidQuote !== null
        && !routeRejected
        && !fatalRoutePause
        && !credentialBlocked
        && !fundingBlocked
      );
      return {
        symbol: quote.symbol,
        eligibleForLive,
        control,
        quote,
        orderState,
        reason: eligibleForLive
          ? 'Eligible for canary live maker routing under current policy.'
          : fundingBlocked
            ? `Live routing blocked by funding: ${orderState?.fundingReason ?? 'insufficient quote balance'}`
            : credentialBlocked
              ? `Live routing blocked until credentials change or blocks are cleared: ${orderState?.fatalErrorReason ?? 'credential rejection'}`
              : routeRejected
                ? `Live routing rejected by broker/account constraints: ${routeRejectReason}`
                : fatalRoutePause
                  ? `Live routing cooling down after fatal broker/account rejection: ${orderState?.fatalErrorReason ?? 'unknown rejection'}`
                  : control && !control.enabled
                    ? control.blockedReason
                    : quote.mode !== 'maker'
                      ? quote.reason
                      : !policy.liveRoutingEnabled
                        ? 'Live maker routing disabled by policy.'
                        : !policy.liveSymbols.includes(quote.symbol)
                          ? `Symbol not in live allowlist (${policy.liveSymbols.join(', ')}).`
                          : 'No active quote to route.'
      };
    })
  });
});

app.get('/api/strategy-controls', (_req, res) => {
  res.json(Array.from(sidecarLaneControls.values()));
});

app.get('/api/learning', (req, res) => {
  const limit = Number.parseInt(String(req.query.limit ?? '500'), 10);
  res.json(learningLoop.getLog(Number.isFinite(limit) ? Math.min(limit, 2000) : 500));
});

app.get('/api/lane-learning', (req, res) => {
  const limit = Number.parseInt(String(req.query.limit ?? '500'), 10);
  res.json(laneLearning.getLog(Number.isFinite(limit) ? Math.min(limit, 2000) : 500));
});

app.get('/api/ai-council/traces', (req, res) => {
  const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
  res.json(aiCouncil.getTraces(Number.isFinite(limit) ? limit : 50));
});

app.get('/api/meta-labels', (_req, res) => {
  res.json(paperEngine.getMetaLabelSnapshot());
});

app.get('/api/meta-model', (_req, res) => {
  res.json(paperEngine.getMetaModelSnapshot());
});

app.get('/api/replay/events', (req, res) => {
  const limit = Number.parseInt(String(req.query.limit ?? '200'), 10);
  const strategyId = typeof req.query.strategyId === 'string' ? req.query.strategyId : undefined;
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  res.json(replayEngine.getTimeline(Number.isFinite(limit) ? limit : 200, {
    ...(strategyId ? { strategyId } : {}),
    ...(type ? { type } : {})
  }));
});

app.get('/api/replay/reconstruct', (req, res) => {
  const limit = Number.parseInt(String(req.query.limit ?? '1000'), 10);
  res.json(replayEngine.getReconstruction(Number.isFinite(limit) ? limit : 1000));
});

app.get('/api/signals', (_req, res) => {
  res.json(getSignalBus().getRecent(50));
});

app.get('/api/historical-context', (_req, res) => {
  res.json(getHistoricalContext().getSnapshot());
});

app.get('/api/derivatives', (_req, res) => {
  res.json(getDerivativesIntel().getSnapshot());
});

app.get('/api/intel', (_req, res) => {
  res.json(marketIntel.getSnapshot());
});

app.get('/api/intel/:symbol', (req, res) => {
  res.json(marketIntel.getCompositeSignal(req.params.symbol));
});

app.get('/api/news-intel', (_req, res) => {
  res.json(newsIntel.getSnapshot());
});

app.get('/api/news-intel/:symbol', (req, res) => {
  res.json(newsIntel.getSignal(req.params.symbol));
});

app.get('/api/calendar', (_req, res) => {
  res.json(eventCalendar.getSnapshot());
});

// --------------- Shared broker cache for SSE fan-out ---------------
// A single interval polls the broker router every ~1s and caches the result.
// Every connected SSE tab reads from this cache — eliminates N×polling per tab.
let sharedBrokerCache: BrokerRouterAccountResponse | null = null;
let sharedHealthCache: ServiceHealth[] = [];
let sharedBrokerCacheRefreshing = false;

setInterval(async () => {
  if (sharedBrokerCacheRefreshing) return;
  sharedBrokerCacheRefreshing = true;
  try {
    const [brokerState, health] = await Promise.all([
      fetchJson<BrokerRouterAccountResponse>(BROKER_ROUTER_URL, '/account'),
      getServiceHealthSnapshot()
    ]);
    if (brokerState) sharedBrokerCache = brokerState;
    sharedHealthCache = health;
  } catch { /* best effort */ } finally {
    sharedBrokerCacheRefreshing = false;
  }
}, 1_000);

app.get('/api/feed', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let feedTick = 0;
  const send = () => {
    const brokerState = sharedBrokerCache;
    const health = sharedHealthCache;
    const brokerAccounts = normalizeBrokerAccounts(brokerState?.brokers ?? []);
    const brokerPositions = normalizeBrokerPositions(brokerState?.brokers ?? []);
    const paperDesk = paperEngine.getSnapshot();

    // Override paper engine metrics with real broker data
    const allBrokers = brokerState?.brokers ?? [];
    const realEquity = brokerAccounts.reduce((sum, a) => sum + a.equity, 0);

    // Open risk = unrealized PnL across all brokers
    let realOpenRisk = brokerPositions.reduce((sum, pos) => sum + (pos.unrealizedPnl ?? 0), 0);
    for (const broker of allBrokers) {
      if (broker.broker === 'oanda-rest') {
        const acct = broker.account as Record<string, unknown> ?? {};
        realOpenRisk += parseFloat(String(acct.unrealizedPL ?? '0')) || 0;
      }
    }

    // Coinbase paper equity from simulated agents (not the real wallet)
    const cbPaperAgents = paperDesk.agents.filter((a: { broker: string }) => a.broker === 'coinbase-live');
    const cbPaperPnl = cbPaperAgents.reduce((s: number, a: { realizedPnl: number }) => s + a.realizedPnl, 0);
    const cbPaperEquity = BROKER_STARTING_EQUITY + cbPaperPnl;

    // Paper equity = real Alpaca + real OANDA + simulated Coinbase paper
    const paperOnlyEquity = brokerAccounts
      .filter((a) => a.broker !== 'coinbase-live')
      .reduce((sum, a) => sum + a.equity, 0) + cbPaperEquity;
    const PAPER_STARTING = BROKER_STARTING_EQUITY * 3; // 3 paper brokers

    // Override with real broker numbers + Coinbase paper sim — no hallucinated data
    if (paperOnlyEquity > 0) {
      paperDesk.totalEquity = round(paperOnlyEquity, 2);
      paperDesk.startingEquity = PAPER_STARTING;
      paperDesk.totalDayPnl = round(paperOnlyEquity - PAPER_STARTING, 2);
      paperDesk.totalReturnPct = round(((paperOnlyEquity - PAPER_STARTING) / PAPER_STARTING) * 100, 2);

      // Realized PnL from actual broker accounts + Coinbase paper agents
      let realRealizedPnl = 0;
      const alpacaAcct = brokerAccounts.find((a) => a.broker === 'alpaca-paper');
      if (alpacaAcct && alpacaAcct.status === 'connected' && alpacaAcct.cash > 0) {
        realRealizedPnl += (alpacaAcct.cash - BROKER_STARTING_EQUITY);
      }
      for (const broker of allBrokers) {
        if (broker.broker === 'oanda-rest') {
          const acct = broker.account as Record<string, unknown> ?? {};
          realRealizedPnl += parseFloat(String(acct.pl ?? '0')) || 0;
        }
      }
      // Add Coinbase paper realized PnL from simulated agents
      realRealizedPnl += cbPaperPnl;
      paperDesk.realizedPnl = round(realRealizedPnl, 2);
      paperDesk.realizedReturnPct = round((realRealizedPnl / PAPER_STARTING) * 100, 4);
    }
    if (paperDesk.analytics) {
      paperDesk.analytics.totalOpenRisk = round(realOpenRisk, 2);
    }

    // Include composite signals with new indicators for dashboard observability
    const intelSnapshot = marketIntel.getSnapshot();
    const compositeSignals = intelSnapshot.compositeSignal.map((s) => ({
      symbol: s.symbol,
      direction: s.direction,
      confidence: s.confidence,
      rsi2: s.rsi2,
      stochastic: s.stochastic,
      obiWeighted: s.obiWeighted,
      reasons: s.reasons.slice(0, 3)
    }));

    const payload = {
      overview: buildOverviewSnapshot(paperDesk, brokerAccounts, health),
      positions: dedupePositions([...brokerPositions, ...paperEngine.getPositions()]),
      paperDesk,
      marketIntel: {
        fearGreed: intelSnapshot.fearGreed,
        compositeSignals,
      }
    };

    feedTick++;
    if (feedTick % 10 === 1) {
      const o = payload.overview;
      const active = paperDesk.agents.filter((a: { status: string }) => a.status === 'in-trade').length;
      const alpaca = brokerAccounts.find((a) => a.broker === 'alpaca-paper');
      const oanda = brokerAccounts.find((a) => a.broker === 'oanda-rest');
      console.log(`[feed] NAV=$${o.nav.toFixed(2)} alpaca=$${alpaca?.equity.toFixed(2) ?? '?'} oanda=$${oanda?.equity.toFixed(2) ?? '?'} trades=${paperDesk.totalTrades} active=${active} win=${paperDesk.winRate.toFixed(1)}% pnl=$${paperDesk.realizedPnl.toFixed(2)} deskEq=$${paperDesk.totalEquity.toFixed(2)}`);
    }

    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  void send();
  const interval = setInterval(() => {
    void send();
  }, 1_000);

  _req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

// Strategy Director — AI-driven portfolio analysis
const strategyDirector = new StrategyDirector({
  getPaperEngine: () => paperEngine as any,
  getNewsIntel: () => getNewsIntel() as any,
  getMarketIntel: () => getMarketIntel() as any,
  getInsiderRadar: () => getInsiderRadar() as any,
});
strategyDirector.start();

app.get('/api/strategy-director', (req, res) => {
  const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
  res.json(strategyDirector.getLog(Number.isFinite(limit) ? Math.min(limit, 200) : 50));
});

app.get('/api/strategy-director/latest', (_req, res) => {
  const latest = strategyDirector.getLatest();
  res.json(latest ?? { status: 'no-directives-yet' });
});

app.get('/api/insider-radar', (_req, res) => {
  res.json(getInsiderRadar().getSnapshot());
});

app.post('/api/strategy-director/run', async (_req, res) => {
  try {
    const directive = await strategyDirector.runCycle();
    res.json(directive);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Director cycle failed' });
  }
});

app.get('/api/strategy-director/regime', (_req, res) => {
  res.json(strategyDirector.getRegimeSnapshot());
});

app.listen(port, '0.0.0.0', () => {
  console.log(`[hermes-api] listening on http://0.0.0.0:${port}`);
});

function gracefulShutdown(signal: string): void {
  console.log(`[hermes-api] ${signal} received. Shutting down gracefully…`);
  strategyDirector.stop();
  learningLoop.stop();
  marketIntel.stop();
  newsIntel.stop();
  eventCalendar.stop();
  getInsiderRadar().stop();
  getHistoricalContext().stop();
  getDerivativesIntel().stop();
  // Allow in-flight SSE connections and Express to drain (give 5s)
  setTimeout(() => {
    console.log('[hermes-api] Exiting.');
    process.exit(0);
  }, 5_000);
}

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });

async function getServiceHealthSnapshot(): Promise<ServiceHealth[]> {
  const checks = await Promise.all([
    pingService('market-data', 4302, MARKET_DATA_URL),
    pingService('risk-engine', 4301, RISK_ENGINE_URL),
    pingService('broker-router', 4303, BROKER_ROUTER_URL),
    pingService('review-loop', 4304, REVIEW_LOOP_URL),
    pingService('backtest', 4305, BACKTEST_URL),
    pingService('strategy-lab', 4306, STRATEGY_LAB_URL)
  ]);

  return [
    { name: 'api', port: 4300, status: 'healthy', message: 'Control plane online' },
    ...checks
  ];
}

async function pingService(name: string, portNumber: number, baseUrl: string): Promise<ServiceHealth> {
  const health = await fetchJson<Record<string, unknown>>(baseUrl, '/health', 5_000);
  if (!health) {
    return { name, port: portNumber, status: 'warning', message: 'Service unavailable or not configured' };
  }

  const status = health.status === 'healthy' ? 'healthy' : 'warning';
  const message = asString(health.message)
    ?? asString(health.detail)
    ?? (Array.isArray(health.brokers) ? `Configured brokers: ${health.brokers.length}` : 'Service responded');

  return { name, port: portNumber, status, message };
}

async function fetchJson<T>(baseUrl: string, pathname: string, timeoutMs = 5_000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${pathname}`, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return await response.json() as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchArrayJson<T>(baseUrl: string, pathname: string): Promise<T[]> {
  const value = await fetchJson<unknown>(baseUrl, pathname);
  return Array.isArray(value) ? value as T[] : [];
}

interface MarketMicrostructureSnapshot {
  symbol: string;
  spreadBps: number;
  imbalancePct: number;
  microPrice: number;
  bestBid: number;
  bestAsk: number;
  queueImbalancePct?: number;
  tradeImbalancePct?: number;
  pressureImbalancePct?: number;
  spreadStableMs?: number;
}

interface MarketMicrostructureFeed {
  connected?: boolean;
  lastMessageAt?: string | null;
  snapshots?: MarketMicrostructureSnapshot[];
}

function compactTerminalLines(lines: Array<string | null | undefined>): string[] {
  return lines.filter((line): line is string => typeof line === 'string' && line.trim().length > 0).slice(0, 6);
}

function buildTerminalPane(
  id: string,
  label: string,
  status: ServiceHealth['status'],
  summary: string,
  lines: Array<string | null | undefined>
): TerminalSnapshot['terminals'][number] {
  return {
    id,
    label,
    status,
    summary,
    lines: compactTerminalLines(lines)
  };
}

function buildTerminalFallbackSnapshot(error: unknown): TerminalSnapshot {
  return {
    asOf: new Date().toISOString(),
    terminals: [buildTerminalPane('api', 'Hermes API', 'critical', 'Terminal telemetry unavailable.', [formatError(error)])]
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : 'unknown error';
}

async function buildTerminalSnapshot(): Promise<TerminalSnapshot> {
  const [health, marketHealth, marketMicrostructure, riskSettings, brokerState, brokerReports, reviews, reviewClusters, copySleeve, macroPreservation, strategyBest, strategyHistory, strategyHealth] = await Promise.all([
    getServiceHealthSnapshot(),
    fetchJson<Record<string, unknown>>(MARKET_DATA_URL, '/health'),
    fetchJson<MarketMicrostructureFeed>(MARKET_DATA_URL, '/microstructure'),
    fetchJson<SystemSettings>(RISK_ENGINE_URL, '/settings'),
    fetchJson<BrokerRouterAccountResponse>(BROKER_ROUTER_URL, '/account'),
    fetchJson<BrokerRouterReportsResponse>(BROKER_ROUTER_URL, '/reports'),
    fetchArrayJson<StrategyReview>(REVIEW_LOOP_URL, '/reviews'),
    fetchJson<Record<string, unknown>>(REVIEW_LOOP_URL, '/clusters'),
    fetchJson<CopySleevePortfolioSnapshot>(BACKTEST_URL, '/copy-sleeve', 5_000),
    fetchJson<MacroPreservationPortfolioSnapshot>(BACKTEST_URL, '/macro-preservation', 5_000),
    fetchJson<StrategyGenome>(STRATEGY_LAB_URL, '/best'),
    fetchArrayJson<Record<string, unknown>>(STRATEGY_LAB_URL, '/history'),
    fetchJson<Record<string, unknown>>(STRATEGY_LAB_URL, '/health')
  ]);

  const healthMap = new Map(health.map((entry) => [entry.name, entry]));
  const paperDesk = paperEngine.getSnapshot();
  const liveReadiness = paperEngine.getLiveReadiness();
  const councilStatus = aiCouncil.getStatus();
  // Prefer decisions with real AI votes over rules-only fallbacks
  const sortedDecisions = [...paperDesk.aiCouncil].sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  const realVoteDecision = sortedDecisions.find((d) => d.panel?.some((v) => v.source !== 'rules') || (d.primary && d.primary.source !== 'rules'));
  const latestDecision = realVoteDecision ?? sortedDecisions[0] ?? null;
  const latestReview = [...reviews].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  const latestLearningDecision = learningLoop.getLog(5).at(-1) ?? null;
  const latestLaneLearningDecision = laneLearning.getLog(5).at(-1) ?? null;
  const learningLogCount = learningLoop.getLog(50).length;
  const laneLearningLogCount = laneLearning.getLog(50).length;
  const strategyLabHealth = strategyHealth ? asRecord(strategyHealth) : null;
  const brokerAccounts = normalizeBrokerAccounts(brokerState?.brokers ?? []);
  const brokerExecutions = normalizeBrokerReports(brokerReports?.reports ?? []).sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  const microSnapshots = marketMicrostructure?.snapshots ?? [];
  const marketLines = microSnapshots
    .slice()
    .sort((left, right) => left.spreadBps - right.spreadBps)
    .slice(0, 3)
    .map((snapshot) => {
      const extras = [
        snapshot.queueImbalancePct !== undefined ? `queue ${snapshot.queueImbalancePct.toFixed(1)}%` : null,
        snapshot.tradeImbalancePct !== undefined ? `trade ${snapshot.tradeImbalancePct.toFixed(1)}%` : null,
        snapshot.pressureImbalancePct !== undefined ? `pressure ${snapshot.pressureImbalancePct.toFixed(1)}%` : null,
        snapshot.spreadStableMs !== undefined ? `stable ${snapshot.spreadStableMs.toFixed(0)}ms` : null
      ].filter((value): value is string => Boolean(value));
      return `[${snapshot.symbol}] spread ${snapshot.spreadBps.toFixed(2)}bps · imb ${snapshot.imbalancePct.toFixed(1)}% · micro ${snapshot.microPrice.toFixed(2)}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
    });
  const voteLabel = (vote: AiProviderDecision): string => {
    if (vote.source === 'rules') return 'rules';
    return `${vote.provider}/${vote.source}`;
  };
  const hasFinalCouncilVotes = latestDecision?.status === 'complete';
  const councilVotes = !latestDecision
    ? 'no council votes yet'
    : latestDecision.status === 'queued'
      ? 'queued · waiting for final council vote'
      : latestDecision.status === 'evaluating'
        ? 'evaluating · waiting for final council vote'
        : latestDecision.status === 'error'
          ? 'error · no final council vote'
          : latestDecision.panel?.length
            ? latestDecision.panel.map((vote) => `${voteLabel(vote)}:${vote.action} ${vote.confidence}%`).join(' · ')
            : [latestDecision.primary, latestDecision.challenger].filter((vote): vote is AiProviderDecision => Boolean(vote)).map((vote) => `${voteLabel(vote)}:${vote.action} ${vote.confidence}%`).join(' · ');
  const formatVoteLine = (label: string, vote: AiProviderDecision | null | undefined): string => {
    if (!vote) {
      return `[${label}] waiting for vote`;
    }
    return `[${label}] ${voteLabel(vote)} ${vote.action} ${vote.confidence}% · ${vote.thesis} · ${vote.riskNote}`;
  };
  const latestPrimary = hasFinalCouncilVotes ? latestDecision.primary : null;
  const latestChallenger = hasFinalCouncilVotes ? latestDecision.challenger : null;
  const latestGemini = hasFinalCouncilVotes ? latestDecision.panel?.[2] ?? null : null;
  const councilTraces = aiCouncil.getTraces(12);
  const latestDecisionTrace = latestDecision ? councilTraces.find((trace) => trace.decisionId === latestDecision.id) ?? null : null;
  const latestTrace: AiCouncilTrace | null = latestDecision?.status === 'complete' ? latestDecisionTrace : null;
  const terminalTimestamp = new Date().toISOString();

  return {
    asOf: terminalTimestamp,
    terminals: [
      buildTerminalPane(
        'api',
        'Hermes API',
        healthMap.get('api')?.status ?? 'healthy',
        `${paperDesk.activeAgents} active agents · ${paperDesk.totalTrades} trades · win ${paperDesk.winRate.toFixed(1)}%`,
        [
          latestDecision
            ? `[ai-council] ${latestDecision.symbol} → ${latestDecision.finalAction} · ${councilVotes}`
            : '[ai-council] No decisions queued yet.',
          `[council] ${councilStatus.enabled ? 'enabled' : 'disabled'} · queued ${councilStatus.queued} · in flight ${councilStatus.inFlight ? 'yes' : 'no'} · recent ${councilStatus.recentDecisions}`,
          `[readiness] ${liveReadiness.summary} · blockers ${liveReadiness.blockers.slice(0, 3).join(' · ') || 'none'}`,
          `[signals] ${paperDesk.signals.length} signals · ${paperDesk.fills.length} fills · ${paperDesk.analytics.verificationNote}`,
          `[allocator] ${paperDesk.analytics.adaptiveMode}`
        ]
      ),
      buildTerminalPane(
        'ai-council',
        'AI Council',
        councilStatus.inFlight || councilStatus.queued > 0 ? 'warning' : latestDecision?.finalAction === 'reject' ? 'warning' : 'healthy',
        latestTrace
          ? `${latestTrace.role} ${latestTrace.status} · ${latestTrace.parsedAction ?? 'n/a'} ${latestTrace.parsedConfidence?.toFixed(0) ?? '0'}% · ${previewText(latestTrace.rawOutput, 120)}`
          : latestDecision
            ? `${latestDecision.symbol} · ${latestDecision.status} · ${latestDecision.finalAction} · ${latestDecision.reason}`
            : `${councilStatus.recentDecisions} recent decisions · queue idle`,
        [
          `[queue] ${councilStatus.queued} queued · ${councilStatus.inFlight ? 'evaluating now' : 'idle'}`,
          latestDecision ? `[latest] ${latestDecision.symbol} · ${latestDecision.agentName} · ${latestDecision.finalAction}` : '[latest] No council decision yet.',
          latestDecision ? `[reason] ${latestDecision.reason}` : '[reason] Waiting for a candidate.',
          latestTrace
            ? `[prompt] ${previewText(latestTrace.prompt, 90)}`
            : '[prompt] No CLI transcript yet.',
          latestChallenger ? `[panel] challenger ${latestChallenger.action} ${latestChallenger.confidence}%` : '[panel] missing challenger',
          latestDecision 
            ? `[response] output parsed` 
            : '[response] Awaiting CLI output.',
          '[votes]',
          latestPrimary ? formatVoteLine('claude', latestPrimary) : '[claude] waiting for vote',
          latestChallenger ? formatVoteLine('codex', latestChallenger) : '[codex] waiting for vote',
          latestGemini ? formatVoteLine('gemini', latestGemini) : '[gemini] waiting for vote'
        ]
      ),
      buildTerminalPane(
        'claude-terminal',
        'Claude Terminal',
        latestPrimary?.action === 'approve' ? 'healthy' : latestPrimary?.action === 'reject' ? 'critical' : 'warning',
        latestPrimary
          ? `${latestPrimary.action} ${latestPrimary.confidence}% · ${latestPrimary.thesis}`
          : 'Waiting for primary vote.',
        [
          latestPrimary ? `[thesis] ${latestPrimary.thesis}` : '[thesis] No primary vote yet.',
          latestPrimary ? `[risk] ${latestPrimary.riskNote}` : '[risk] No risk note yet.',
          latestDecision ? `[candidate] ${latestDecision.symbol} · ${latestDecision.agentName}` : '[candidate] No active candidate.',
          latestPrimary ? `[latency] ${latestPrimary.latencyMs}ms` : '[latency] n/a'
        ]
      ),
      buildTerminalPane(
        'codex-terminal',
        'Codex Terminal',
        latestChallenger?.action === 'approve' ? 'healthy' : latestChallenger?.action === 'reject' ? 'critical' : 'warning',
        latestChallenger
          ? `${latestChallenger.action} ${latestChallenger.confidence}% · ${latestChallenger.thesis}`
          : 'Waiting for challenger vote.',
        [
          latestChallenger ? `[thesis] ${latestChallenger.thesis}` : '[thesis] No challenger vote yet.',
          latestChallenger ? `[risk] ${latestChallenger.riskNote}` : '[risk] No risk note yet.',
          latestDecision ? `[candidate] ${latestDecision.symbol} · ${latestDecision.agentName}` : '[candidate] No active candidate.',
          latestChallenger ? `[latency] ${latestChallenger.latencyMs}ms` : '[latency] n/a'
        ]
      ),
      buildTerminalPane(
        'gemini-terminal',
        'Gemini Terminal',
        latestGemini?.action === 'approve' ? 'healthy' : latestGemini?.action === 'reject' ? 'critical' : 'warning',
        latestGemini
          ? `${latestGemini.action} ${latestGemini.confidence}% · ${latestGemini.thesis}`
          : 'Waiting for tertiary review.',
        [
          latestGemini ? `[thesis] ${latestGemini.thesis}` : '[thesis] No tertiary vote yet.',
          latestGemini ? `[risk] ${latestGemini.riskNote}` : '[risk] No risk note yet.',
          latestDecision ? `[candidate] ${latestDecision.symbol} · ${latestDecision.agentName}` : '[candidate] No active candidate.',
          latestGemini ? `[latency] ${latestGemini.latencyMs}ms` : '[latency] n/a'
        ]
      ),
      buildTerminalPane(
        'market-data',
        'Market Data',
        healthMap.get('market-data')?.status ?? 'warning',
        `${microSnapshots.length} live microstructure feeds · ${asString(marketHealth?.message) ?? 'market polling current'}`,
        [
          `[feed] ${marketMicrostructure?.connected ? 'connected' : 'disconnected'} · last message ${marketMicrostructure?.lastMessageAt ?? 'n/a'}`,
          ...marketLines,
          marketHealth?.sources ? '[sources] source metadata available' : '[sources] source metadata unavailable'
        ]
      ),
      buildTerminalPane(
        'risk-engine',
        'Risk Engine',
        healthMap.get('risk-engine')?.status ?? 'warning',
        `Trade cap ${riskSettings ? `$${riskSettings.riskCaps.maxTradeNotional.toFixed(0)}` : 'n/a'} · drawdown gate ${riskSettings ? `${riskSettings.riskCaps.maxDrawdownPct.toFixed(1)}%` : 'n/a'}`,
        [
          riskSettings
            ? `[caps] daily loss $${riskSettings.riskCaps.maxDailyLoss.toFixed(0)} · max strategy ${riskSettings.riskCaps.maxStrategyExposurePct.toFixed(1)}% · max symbol ${riskSettings.riskCaps.maxSymbolExposurePct.toFixed(1)}% · slippage ${riskSettings.riskCaps.maxSlippageBps.toFixed(1)}bps`
            : '[caps] risk settings unavailable.',
          riskSettings ? `[universe] ${riskSettings.universe.slice(0, 5).join(', ')}` : '[universe] unavailable',
          riskSettings ? `[kill switches] ${riskSettings.killSwitches.slice(0, 4).join(' · ')}` : '[kill switches] unavailable',
          `[readiness] ${liveReadiness.overallEligible ? 'eligible' : 'blocked'} · ${liveReadiness.blockers.slice(0, 2).join(' · ') || 'no blockers'}`
        ]
      ),
      buildTerminalPane(
        'broker-router',
        'Broker Router',
        healthMap.get('broker-router')?.status ?? 'warning',
        `${brokerAccounts.length} account snapshots · ${brokerExecutions.length} execution reports`,
        [
          ...brokerAccounts.map((account) => `[${account.broker}] equity $${account.equity.toFixed(2)} · cash $${account.cash.toFixed(2)} · buying power $${account.buyingPower.toFixed(2)} · ${account.status}`),
          brokerExecutions[0]
            ? `[latest] ${brokerExecutions[0].broker} ${brokerExecutions[0].symbol} ${brokerExecutions[0].status} · ${brokerExecutions[0].message}`
            : '[latest] No recent execution reports.',
          brokerState?.lastSyncAt ? `[sync] last sync ${brokerState.lastSyncAt}` : '[sync] no sync timestamp yet'
        ]
      ),
      buildTerminalPane(
        'review-loop',
        'Review Loop',
        healthMap.get('review-loop')?.status ?? 'warning',
        `${reviews.length} reviews · ${paperEngine.getJournal().length} journal entries · ${learningLogCount} learning logs · ${laneLearningLogCount} lane logs`,
        [
          latestReview
            ? `[latest review] ${latestReview.strategy} → ${latestReview.recommendation} · PF ${latestReview.pnl30d.toFixed(2)} · WR ${latestReview.winRate.toFixed(1)}%`
            : '[latest review] No reviews yet.',
          latestLearningDecision
            ? `[learning] ${latestLearningDecision.action} · ${latestLearningDecision.agentName} · PF ${latestLearningDecision.currentPF.toFixed(2)} · WR ${latestLearningDecision.currentWinRate.toFixed(1)}%`
            : '[learning] No self-learning log yet.',
          latestLaneLearningDecision
            ? `[lane] ${latestLaneLearningDecision.action} · ${latestLaneLearningDecision.strategy} · alloc ${latestLaneLearningDecision.allocationMultiplier.toFixed(2)}x`
            : '[lane] No lane-learning log yet.',
          reviewClusters ? `[clusters] ${Object.keys(reviewClusters).slice(0, 4).join(', ') || 'none'}` : '[clusters] unavailable',
          `[journal] ${paperEngine.getJournal().length} live entries · ${paperDesk.fills.length} fills`
        ]
      ),
      buildTerminalPane(
        'backtest',
        'Backtest Service',
        healthMap.get('backtest')?.status ?? 'warning',
        `${copySleeve ? copySleeve.managerName : 'Copy sleeve'} · ${macroPreservation ? macroPreservation.regime : 'macro snapshot unavailable'}`,
        [
          copySleeve
            ? `[copy] ${copySleeve.managerName} latest filing ${copySleeve.latestFiling ? `${copySleeve.latestFiling.holdings.length} holdings · resolved ${copySleeve.latestFiling.resolvedWeightPct.toFixed(1)}%` : 'no filing'} · benchmark ${copySleeve.benchmarkSymbol}`
            : '[copy] copy sleeve unavailable.',
          copySleeve?.notes?.[0] ? `[copy] ${copySleeve.notes[0]}` : '[copy] no copy notes yet.',
          macroPreservation
            ? `[macro] regime ${macroPreservation.regime} · CPI ${macroPreservation.latestObservation ? `${macroPreservation.latestObservation.yoyPct.toFixed(2)}% y/y` : 'n/a'} · ${macroPreservation.inflationHot ? 'inflation-hot' : 'cash-first'}`
            : '[macro] macro sleeve unavailable.',
          macroPreservation?.notes?.[0] ? `[macro] ${macroPreservation.notes[0]}` : '[macro] no macro notes yet.'
        ]
      ),
      buildTerminalPane(
        'strategy-lab',
        'Strategy Lab',
        healthMap.get('strategy-lab')?.status ?? 'warning',
        `${asString(strategyHealth?.status) ?? 'ready'} · ${strategyHistory.length} history entries`,
        [
          strategyBest
            ? `[best genome] ${strategyBest.id} · ${strategyBest.style} · fitness ${strategyBest.fitness?.toFixed(2) ?? 'n/a'}`
            : '[best genome] none yet.',
          `[population] ${typeof strategyLabHealth?.populationSize === 'number' ? strategyLabHealth.populationSize : 'n/a'} genomes · current run ${strategyLabHealth?.currentRun ? 'running' : 'idle'}`,
          strategyHistory[0]
            ? `[history] latest entry ${asString(strategyHistory[0]?.status) ?? 'recorded'}`
            : '[history] no evolution history yet.'
        ]
      ),
      (() => {
        const latest = strategyDirector.getLatest();
        const regime = strategyDirector.getRegimeSnapshot();
        const rp = latest?.riskPosture;
        const adjCount = latest?.agentAdjustments?.length ?? 0;
        const symCount = latest?.symbolChanges?.length ?? 0;
        const playbookCount = latest?.playbookApplications?.length ?? 0;
        const status = !latest ? 'warning' : latest.error ? 'critical' : 'healthy';
        return buildTerminalPane(
          'strategy-director',
          'Strategy Director',
          status,
          latest
            ? `regime:${regime.regime} · ${rp?.posture ?? 'normal'} posture · ${playbookCount} playbook switches · ${adjCount} fine-tunes · ${latest.latencyMs ? `${(latest.latencyMs / 1000).toFixed(0)}s` : 'pending'}`
            : 'Waiting for first cycle (2 min warmup).',
          [
            `[regime] ${regime.regime} · ${regime.agentTemplates.length} agents on playbook templates`,
            latest
              ? `[posture] ${rp?.posture ?? 'normal'} — ${rp?.reason?.slice(0, 100) ?? 'no posture change'}`
              : '[posture] waiting for first analysis.',
            latest
              ? `[reasoning] ${latest.reasoning?.slice(0, 140) ?? 'no reasoning'}`
              : '[reasoning] pending.',
            ...(latest?.playbookApplications?.slice(0, 3).map((p) =>
              `[playbook] ${p.agentId} → '${p.templateName}' (${p.regime})`
            ) ?? []),
            ...(latest?.agentAdjustments?.slice(0, 3).map((a) =>
              `[fine-tune] ${a.agentId}.${a.field}: ${a.oldValue} → ${a.newValue} — ${a.reason?.slice(0, 50) ?? ''}`
            ) ?? []),
            ...(latest?.symbolChanges?.slice(0, 2).map((s) =>
              `[symbol] ${s.action} ${s.symbol} on ${s.broker} — ${s.reason?.slice(0, 50) ?? ''}`
            ) ?? []),
            latest
              ? `[cycle] ${new Date(latest.timestamp).toLocaleTimeString()} · ${latest.runId?.slice(0, 8)} · ${latest.error ? `ERROR: ${latest.error.slice(0, 60)}` : `${playbookCount} playbook, ${adjCount} adj, ${symCount} sym`}`
              : '[cycle] not started.'
          ]
        );
      })()
    ]
  };
}

function fingerprintMarketSnapshot(snapshot: { symbol: string; lastPrice: number; volume?: number; spreadBps?: number; changePct?: number }): string {
  return createHash('sha256').update(JSON.stringify([
    snapshot.symbol,
    snapshot.lastPrice,
    snapshot.volume ?? null,
    snapshot.spreadBps ?? null,
    snapshot.changePct ?? null
  ])).digest('hex');
}

function fingerprintMicrostructure(snapshot: { symbol: string; bidDepth: number; askDepth: number; imbalancePct: number; queueImbalancePct?: number; tradeImbalancePct?: number; pressureImbalancePct?: number; spreadStableMs?: number; microPrice: number; bestBid: number; bestAsk: number; spread: number; spreadBps: number; updatedAt: string }): string {
  return createHash('sha256').update(JSON.stringify([
    snapshot.symbol,
    snapshot.bidDepth,
    snapshot.askDepth,
    snapshot.imbalancePct,
    snapshot.queueImbalancePct ?? null,
    snapshot.tradeImbalancePct ?? null,
    snapshot.pressureImbalancePct ?? null,
    snapshot.spreadStableMs ?? null,
    snapshot.microPrice,
    snapshot.bestBid,
    snapshot.bestAsk,
    snapshot.spread,
    snapshot.spreadBps
  ])).digest('hex');
}

function normalizeBrokerAccounts(snapshots: BrokerRouterBrokerSnapshot[]): BrokerAccountSnapshot[] {
  return snapshots.map((snapshot) => {
    const brokerId = snapshot.broker as BrokerAccountSnapshot['broker'];
    const account = asRecord(snapshot.account);
    const positions = normalizeBrokerPositions([snapshot]);
    const cash = brokerId === 'coinbase-live'
      ? sumCoinbaseCash(account)
      : numberField(account, ['cash', 'buying_power', 'portfolio_cash', 'balance']) ?? 0;
    const equity = brokerId === 'coinbase-live'
      ? round(cash + positions.reduce((sum, position) => sum + position.markPrice * position.quantity, 0), 2)
      : numberField(account, ['equity', 'portfolio_value', 'NAV', 'last_equity', 'value', 'balance']) ?? cash;
    const buyingPower = brokerId === 'coinbase-live'
      ? cash
      : numberField(account, ['buying_power', 'buyingPower', 'cash']) ?? cash;

    const accountMode: BrokerAccountSnapshot['mode'] = brokerId === 'alpaca-paper'
      ? 'paper'
      : brokerId === 'oanda-rest'
        ? 'paper'
        : 'live';

    return {
      broker: brokerId,
      mode: accountMode,
      accountId: textField(account, ['id', 'account_number', 'uuid']) ?? brokerId,
      currency: brokerId === 'coinbase-live'
        ? 'USD'
        : textField(account, ['currency']) ?? 'USD',
      cash: round(cash, 2),
      buyingPower: round(buyingPower, 2),
      equity: round(equity, 2),
      status: mapBrokerStatus(snapshot.status),
      source: 'broker',
      updatedAt: snapshot.asOf,
      availableToTrade: round(buyingPower, 2)
    };
  });
}

function normalizeBrokerPositions(snapshots: BrokerRouterBrokerSnapshot[]): PositionSnapshot[] {
  return snapshots.flatMap((snapshot) =>
    snapshot.positions
      .map((position) => normalizeBrokerPosition(snapshot, position))
      .filter((value): value is PositionSnapshot => value !== null)
  );
}

function normalizeBrokerPosition(snapshot: BrokerRouterBrokerSnapshot, position: unknown): PositionSnapshot | null {
  const record = asRecord(position);
  const existingBroker = textField(record, ['broker']);
  const existingSymbol = textField(record, ['symbol']);
  const existingAssetClass = textField(record, ['assetClass']);
  const existingQty = numberField(record, ['quantity']);
  const existingAvgEntry = numberField(record, ['avgEntry']);
  const existingMark = numberField(record, ['markPrice']);

  if (existingBroker && existingSymbol && existingAssetClass && existingQty !== null && existingAvgEntry !== null && existingMark !== null) {
    return {
      id: textField(record, ['id']) ?? `${existingBroker}:${existingSymbol}`,
      broker: existingBroker as PositionSnapshot['broker'],
      symbol: existingSymbol,
      strategy: textField(record, ['strategy']) ?? 'broker-position',
      assetClass: existingAssetClass as PositionSnapshot['assetClass'],
      quantity: existingQty,
      avgEntry: existingAvgEntry,
      markPrice: existingMark,
      unrealizedPnl: numberField(record, ['unrealizedPnl']) ?? 0,
      unrealizedPnlPct: numberField(record, ['unrealizedPnlPct']) ?? 0,
      thesis: textField(record, ['thesis']) ?? 'Imported from broker snapshot.',
      openedAt: textField(record, ['openedAt']) ?? snapshot.asOf,
      source: 'broker'
    };
  }

  const symbol = textField(record, ['symbol']);
  const quantity = Math.abs(numberField(record, ['qty', 'quantity']) ?? 0);
  if (!symbol || quantity <= 0) {
    return null;
  }

  const avgEntry = numberField(record, ['avg_entry_price', 'avgEntry']) ?? 0;
  const markPrice = numberField(record, ['current_price', 'mark_price', 'markPrice']) ?? avgEntry;
  const unrealizedPnl = numberField(record, ['unrealized_pl', 'unrealizedPnl']) ?? 0;
  const rawPct = numberField(record, ['unrealized_plpc', 'unrealizedPnlPct']) ?? 0;
  const unrealizedPnlPct = Math.abs(rawPct) <= 1 ? rawPct * 100 : rawPct;
  const assetClassValue = (textField(record, ['asset_class', 'assetClass']) ?? 'equity').toLowerCase();

  return {
    id: textField(record, ['asset_id', 'id']) ?? `${snapshot.broker}:${symbol}`,
    broker: snapshot.broker,
    symbol,
    strategy: 'broker-position',
    assetClass: assetClassValue.includes('crypto') ? 'crypto' : 'equity',
    quantity,
    avgEntry,
    markPrice,
    unrealizedPnl,
    unrealizedPnlPct,
    thesis: 'Imported from broker snapshot.',
    openedAt: textField(record, ['opened_at', 'openedAt']) ?? snapshot.asOf,
    source: 'broker'
  };
}

function normalizeBrokerReports(reports: BrokerRouterReportRecord[]): ExecutionReport[] {
  return reports.map((report) => ({
    id: report.id,
    orderId: report.orderId,
    broker: report.broker,
    symbol: report.symbol,
    status: report.status,
    filledQty: report.filledQty,
    avgFillPrice: report.avgFillPrice,
    slippageBps: report.slippageBps,
    latencyMs: report.latencyMs,
    message: report.message,
    timestamp: report.timestamp,
    ...(report.mode ? { mode: report.mode } : {}),
    ...(report.source ? { source: report.source } : {})
  }));
}

function mapBrokerStatus(status: string): BrokerAccountSnapshot['status'] {
  switch (status) {
    case 'healthy':
      return 'connected';
    case 'degraded':
    case 'error':
      return 'degraded';
    default:
      return 'disconnected';
  }
}

function sumCoinbaseCash(account: Record<string, unknown>): number {
  const entries = normalizeArray(account.accounts ?? account);
  return entries.reduce<number>((sum, entry) => {
      const record = asRecord(entry);
      const currency = textField(record, ['currency']);
      if (currency !== 'USD' && currency !== 'USDC') {
        return sum;
      }
      const value = numberField(record, ['available_balance.value', 'available_balance', 'balance.value', 'balance', 'value']) ?? 0;
      return sum + value;
    }, 0);
}

function buildOverviewSnapshot(
  paperDesk: ReturnType<typeof paperEngine.getSnapshot>,
  accounts: BrokerAccountSnapshot[],
  serviceHealth: ServiceHealth[]
): OverviewSnapshot {
  const heatByBroker = buildHeat(accounts, paperDesk.totalEquity, paperDesk.realizedPnl);
  const nav = heatByBroker.reduce((sum, entry) => sum + entry.equity, 0) || paperDesk.totalEquity;
  const maxDeskEquity = peak(paperDesk.deskCurve);
  const drawdownPct = maxDeskEquity > 0
    ? round(Math.max(0, ((maxDeskEquity - paperDesk.totalEquity) / maxDeskEquity) * 100), 2)
    : 0;

  return {
    asOf: new Date().toISOString(),
    nav,
    dailyPnl: round(paperDesk.totalDayPnl, 2),
    dailyPnlPct: round(paperDesk.totalReturnPct, 2),
    drawdownPct,
    activeRiskBudgetPct: round((paperDesk.analytics.totalOpenRisk / Math.max(nav, 1)) * 100, 2),
    realizedPnl30d: round(paperDesk.realizedPnl, 2),
    winRate30d: round(paperDesk.winRate, 1),
    expectancyR: round(paperDesk.analytics.avgLoser > 0 ? paperDesk.analytics.avgWinner / paperDesk.analytics.avgLoser : 0, 2),
    navSparkline: paperDesk.deskCurve,
    drawdownSparkline: paperDesk.deskCurve.map((value) => round(((maxDeskEquity - value) / Math.max(maxDeskEquity, 1)) * 100, 2)),
    heatByBroker,
    brokerAccounts: accounts,
    serviceHealth
  };
}

function buildHeat(accounts: BrokerAccountSnapshot[], paperEquity: number, paperRealizedPnl: number): BrokerHeat[] {
  const connectedAccounts = accounts.filter((account) => account.status === 'connected' || account.equity > 0);
  const now = new Date().toISOString();

  // Use actual broker account balances for each venue
  const alpacaAccount = connectedAccounts.find((account) => account.broker === 'alpaca-paper');
  const alpacaEquity = alpacaAccount?.equity ?? 0;
  const alpacaCash = alpacaAccount?.cash ?? 0;

  const entries: Array<{ broker: BrokerHeat['broker']; equity: number; cash: number; realizedPnl: number; status: string; mode: 'paper' | 'live'; updatedAt: string }> = [
    {
      broker: 'alpaca-paper',
      equity: alpacaEquity > 0 ? alpacaEquity : paperEquity,
      cash: alpacaCash,
      realizedPnl: round(alpacaEquity > 0 ? alpacaEquity - alpacaCash : paperRealizedPnl, 2),
      status: alpacaAccount?.status ?? 'connected',
      mode: 'paper',
      updatedAt: alpacaAccount?.updatedAt ?? now
    },
    ...connectedAccounts
      .filter((account) => account.broker !== 'alpaca-paper')
      .map((account) => ({
        broker: account.broker,
        equity: account.equity,
        cash: account.cash,
        realizedPnl: round(account.equity - account.cash, 2),
        status: account.status,
        mode: account.mode,
        updatedAt: account.updatedAt
      }))
  ];

  const totalEquity = entries.reduce((sum, entry) => sum + entry.equity, 0) || 1;
  return entries.map((entry) => ({
    broker: entry.broker,
    equity: round(entry.equity, 2),
    cash: round(entry.cash, 2),
    allocatedPct: round((entry.equity / totalEquity) * 100, 2),
    realizedPnl: entry.realizedPnl,
    status: entry.status,
    mode: entry.mode,
    updatedAt: entry.updatedAt
  }));
}

function mapPaperFillToExecutionReport(fill: ReturnType<typeof paperEngine.getSnapshot>['fills'][number]): ExecutionReport | null {
  if (fill.source === 'broker') {
    return null;
  }

  return {
    id: fill.id,
    orderId: fill.orderId ?? fill.id,
    broker: 'alpaca-paper',
    symbol: fill.symbol,
    status: fill.status,
    filledQty: 1,
    avgFillPrice: fill.price,
    slippageBps: 0,
    latencyMs: 0,
    message: fill.note,
    timestamp: fill.timestamp,
    mode: 'paper',
    source: fill.source ?? 'simulated'
  };
}

function buildStrategySnapshots(): StrategySnapshot[] {
  const paperDesk = paperEngine.getSnapshot();
  const readiness = paperEngine.getLiveReadiness();

  const scalpers: StrategySnapshot[] = readiness.agents.map((agent): StrategySnapshot => {
    const paperAgent = paperDesk.agents.find((candidate) => candidate.id === agent.agentId);
    const failedGates = agent.gates.filter((gate) => !gate.passed);

    return {
      id: agent.agentId,
      name: `${agent.agentName} / ${agent.symbol}`,
      lane: 'scalping',
      stage: failedGates.length === 0 && agent.symbol.endsWith('-USD') ? 'shadow-live' : 'paper',
      mode: 'paper',
      broker: agent.symbol.endsWith('-USD') ? 'coinbase-live' : 'alpaca-paper',
      symbols: [agent.symbol],
      status: agent.mode === 'blocked' ? 'blocked' : paperAgent?.status === 'watching' ? 'warming' : 'active',
      dailyPnl: paperAgent?.dayPnl ?? agent.realizedPnl,
      lastReviewAt: new Date().toISOString(),
      summary: failedGates.map((gate) => `${gate.name}: ${gate.actual}`).join(' | ') || 'Cleared current readiness gates.'
    };
  });

  const pairsState = pairsEngine.getState(
    paperEngine.getMarketSnapshots().find((snapshot) => snapshot.symbol === 'BTC-USD')?.lastPrice ?? 0,
    paperEngine.getMarketSnapshots().find((snapshot) => snapshot.symbol === 'ETH-USD')?.lastPrice ?? 0
  );
  const pairsStats = pairsEngine.getStats();
  const pairsControl = sidecarLaneControls.get('pairs-btc-eth');
  const pairsSnapshot: StrategySnapshot = {
    id: 'pairs-btc-eth',
    name: 'BTC/ETH Dynamic Hedge Pair',
    lane: 'pairs',
    stage: 'paper',
    mode: 'paper',
    broker: 'coinbase-live',
    symbols: ['BTC-USD', 'ETH-USD'],
    status: pairsControl && !pairsControl.enabled ? 'blocked' : pairsState.position === 'flat' ? 'warming' : 'active',
    dailyPnl: pairsStats.realizedPnl,
    lastReviewAt: pairsControl?.lastReviewAt ?? new Date().toISOString(),
    summary: pairsControl && !pairsControl.enabled
      ? `${pairsControl.blockedReason} Correlation ${pairsState.correlation?.toFixed(2) ?? '0.00'}, beta ${pairsState.hedgeRatio?.toFixed(2) ?? '1.00'}, z-score ${pairsState.zScore.toFixed(2)}.`
      : `Correlation ${pairsState.correlation?.toFixed(2) ?? '0.00'}, beta ${pairsState.hedgeRatio?.toFixed(2) ?? '1.00'}, z-score ${pairsState.zScore.toFixed(2)}. Alloc ${pairsStats.allocationMultiplier.toFixed(2)}, PF ${pairsControl?.recentProfitFactor?.toFixed(2) ?? '0.00'}.`
  };

  const gridEngines: Array<{ grid: GridEngine; symbol: string }> = [
    { grid: btcGrid, symbol: 'BTC-USD' },
    { grid: ethGrid, symbol: 'ETH-USD' },
    { grid: solGrid, symbol: 'SOL-USD' },
    { grid: xrpGrid, symbol: 'XRP-USD' }
  ];
  const gridSnapshots: StrategySnapshot[] = gridEngines.map(({ grid, symbol }) => {
    const stats = grid.getStats();
    const control = sidecarLaneControls.get(`grid-${symbol.toLowerCase()}`);
    return {
      id: `grid-${symbol.toLowerCase()}`,
      name: `${symbol} Adaptive Grid`,
      lane: 'grid',
      stage: 'paper',
      mode: 'paper',
      broker: 'coinbase-live',
      symbols: [symbol],
      status: control && !control.enabled ? 'blocked' : stats.openPositions > 0 ? 'active' : 'warming',
      dailyPnl: stats.realizedPnl,
      lastReviewAt: control?.lastReviewAt ?? new Date().toISOString(),
      summary: control && !control.enabled
        ? `${control.blockedReason} Round trips ${stats.roundTrips}, win rate ${stats.winRate.toFixed(1)}%, open positions ${stats.openPositions}.`
        : `Round trips ${stats.roundTrips}, win rate ${stats.winRate.toFixed(1)}%, open positions ${stats.openPositions}, alloc ${stats.allocationMultiplier.toFixed(2)}.`
    };
  });

  const makerSnapshots: StrategySnapshot[] = makerEngine.getSnapshot().states.map((state) => {
    const control = sidecarLaneControls.get(`maker-${state.symbol.toLowerCase()}`);
    return {
      id: `maker-${state.symbol.toLowerCase()}`,
      name: `${state.symbol} Maker`,
      lane: 'maker',
      stage: 'paper',
      mode: 'paper',
      broker: 'coinbase-live',
      symbols: [state.symbol],
      status: control && !control.enabled ? 'blocked' : state.mode === 'paused' ? 'blocked' : state.inventoryQty > 0 ? 'active' : 'warming',
      dailyPnl: state.realizedPnl,
      lastReviewAt: control?.lastReviewAt ?? state.updatedAt,
      summary: control && !control.enabled
        ? `${control.blockedReason} Width ${state.widthBps.toFixed(2)}bps, inventory ${state.inventoryQty.toFixed(6)}, adverse ${state.adverseScore.toFixed(1)}.`
        : `${state.reason} Width ${state.widthBps.toFixed(2)}bps, inventory ${state.inventoryQty.toFixed(6)}, adverse ${state.adverseScore.toFixed(1)}.`
    };
  });

  return [...scalpers, pairsSnapshot, ...gridSnapshots, ...makerSnapshots];
}

function buildResearchCandidates(snapshots: MarketSnapshot[]): ResearchCandidate[] {
  return snapshots
    .filter((snapshot) => snapshot.status === 'live' && snapshot.source !== 'mock' && snapshot.source !== 'simulated')
    .slice()
    .sort((left, right) => researchPriority(right) - researchPriority(left) || (right.liquidityScore - left.liquidityScore) || (left.spreadBps - right.spreadBps))
    .slice(0, 8)
    .map((snapshot, index) => {
      const live = snapshot.status === 'live' && snapshot.source !== 'mock' && snapshot.source !== 'simulated';
      const session = snapshot.session ?? (snapshot.assetClass === 'equity' ? 'unknown' : 'regular');
      const tradable = live && snapshot.tradable !== false && (snapshot.assetClass !== 'equity' || session === 'regular');
      const derivedScore = Math.max(0, snapshot.liquidityScore - snapshot.spreadBps * 6 + Math.abs(snapshot.changePct) * 10);
      const statusLabel = live ? 'Live' : snapshot.status === 'delayed' ? 'Delayed' : 'Stale';
      const sourceLabel = snapshot.source === 'mock'
        ? 'fallback'
        : snapshot.source === 'simulated'
          ? 'simulated'
          : 'service';
      const sessionLabel = snapshot.assetClass === 'equity' ? `${session} session` : 'continuous session';

      return {
        id: `research-${snapshot.symbol}-${index}`,
        symbol: snapshot.symbol,
        strategy: snapshot.symbol.endsWith('-USD') ? 'Crypto Tape Scan' : 'Equity Momentum Scan',
        score: round(derivedScore, 1),
        expectedEdgeBps: round(Math.max(0, snapshot.liquidityScore / 8 - snapshot.spreadBps), 1),
        catalyst: `${statusLabel} ${sourceLabel} data, ${sessionLabel}, ${snapshot.changePct.toFixed(2)}% move, ${snapshot.spreadBps.toFixed(2)} bps spread.`,
        aiVerdict: tradable
          ? 'Derived from live market-data snapshots and eligible for paper monitoring.'
          : live
            ? `Broker-fed tape is visible, but autonomous trading is blocked by ${snapshot.qualityFlags?.join(', ') || `${sessionLabel} rules`}.`
            : 'Derived from delayed or fallback data. Keep visible for context, but do not trust it for autonomous promotion.',
        riskStatus: tradable && snapshot.spreadBps <= 5 && snapshot.liquidityScore >= 85
          ? 'approved'
          : live
            ? 'review'
            : 'blocked',
        broker: snapshot.symbol.endsWith('-USD') ? 'coinbase-live' : 'alpaca-paper'
      };
    });
}

function dedupePositions(positions: PositionSnapshot[]): PositionSnapshot[] {
  const seen = new Set<string>();
  return positions.filter((position) => {
    const key = `${position.broker}:${position.id}:${position.symbol}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeReports(reports: ExecutionReport[]): ExecutionReport[] {
  const byId = new Map<string, ExecutionReport>();
  for (const report of reports) {
    byId.set(`${report.broker}:${report.id}`, report);
  }
  return Array.from(byId.values()).sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

function dedupeJournal(entries: TradeJournalEntry[]): TradeJournalEntry[] {
  const byId = new Map<string, TradeJournalEntry>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }
  return Array.from(byId.values()).sort((left, right) => right.exitAt.localeCompare(left.exitAt));
}

function dedupeMarketSnapshots(snapshots: MarketSnapshot[]): MarketSnapshot[] {
  const bySymbol = new Map<string, MarketSnapshot>();
  for (const snapshot of snapshots) {
    const existing = bySymbol.get(snapshot.symbol);
    if (!existing || existing.source === 'simulated' || existing.source === 'mock') {
      bySymbol.set(snapshot.symbol, snapshot);
    }
  }
  return Array.from(bySymbol.values()).sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function researchPriority(snapshot: MarketSnapshot): number {
  const liveBonus = snapshot.status === 'live' && snapshot.source !== 'mock' && snapshot.source !== 'simulated' ? 1_000 : 0;
  const tradableBonus = snapshot.tradable ? 300 : 0;
  const delayedPenalty = snapshot.status === 'delayed' ? -100 : snapshot.status === 'stale' ? -200 : 0;
  const mockPenalty = snapshot.source === 'mock' || snapshot.source === 'simulated' ? -300 : 0;
  const sessionPenalty = snapshot.assetClass === 'equity' && snapshot.session && snapshot.session !== 'regular' ? -250 : 0;
  return liveBonus + tradableBonus + delayedPenalty + mockPenalty + sessionPenalty + snapshot.liquidityScore;
}

function peak(values: number[]): number {
  return values.reduce((max, value) => Math.max(max, value), values[0] ?? 1);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function previewText(value: string | undefined, limit = 120): string {
  if (!value) return 'n/a';
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

function normalizeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['data', 'items', 'accounts', 'positions', 'fills', 'orders', 'results']) {
      const candidate = record[key];
      if (Array.isArray(candidate)) return candidate;
    }
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function textField(source: unknown, paths: string[]): string | null {
  const record = asRecord(source);
  for (const pathName of paths) {
    const value = deepGet(record, pathName);
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function numberField(source: unknown, paths: string[]): number | null {
  const record = asRecord(source);
  for (const pathName of paths) {
    const value = deepGet(record, pathName);
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function deepGet(source: Record<string, unknown>, pathName: string): unknown {
  const segments = pathName.split('.');
  let current: unknown = source;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}
