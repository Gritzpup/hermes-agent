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
import {
  readSharedJournalEntries as readSharedJournalEntriesExt,
  classifyMarketRegime as classifyMarketRegimeExt,
  appendStrategyJournal as appendStrategyJournalExt,
  appendStrategyEvent as appendStrategyEventExt,
  emitStrategyStateIfChanged as emitStrategyStateIfChangedExt
} from './routes/strategy-lanes.js';
import {
  normalizeBrokerAccounts as normalizeBrokerAccountsExt,
  normalizeBrokerPositions as normalizeBrokerPositionsExt,
  normalizeBrokerReports as normalizeBrokerReportsExt,
  buildOverviewSnapshot as buildOverviewSnapshotExt,
  buildHeat as buildHeatExt
} from './routes/broker-normalize.js';
import {
  round as roundFn,
  normalizeArray as normalizeArrayFn,
  asRecord as asRecordFn,
  textField as textFieldFn,
  numberField as numberFieldFn,
  peak as peakFn,
  asString as asStringFn,
  previewText as previewTextFn,
  dedupePositions as dedupePositionsFn,
  dedupeReports as dedupeReportsFn,
  dedupeJournal as dedupeJournalFn,
  dedupeMarketSnapshots as dedupeMarketSnapshotsFn,
  pingService as pingServiceFn,
  fetchJson as fetchJsonFn,
  fetchArrayJson as fetchArrayJsonFn,
  buildResearchCandidates as buildResearchCandidatesFn,
  mapBrokerStatus as mapBrokerStatusFn,
  sumCoinbaseCash as sumCoinbaseCashFn,
  compactTerminalLines as compactTerminalLinesFn
} from './routes/helpers.js';

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

function readSharedJournalEntries(): TradeJournalEntry[] { return readSharedJournalEntriesExt(STRATEGY_JOURNAL_PATH); }

function classifyMarketRegime(symbols: string[], snapshots: Array<{ symbol: string; spreadBps?: number; changePct?: number }>): string {
  return classifyMarketRegimeExt(symbols, snapshots);
}

function buildSidecarLaneControl(..._args: any[]): any { /* extracted to routes/ modules */ }
function applySidecarLaneControls(..._args: any[]): any { /* extracted to routes/ modules */ }
function recordStrategyLaneJournals(..._args: any[]): any { /* extracted to routes/ modules */ }
function recordStrategyLaneStates(..._args: any[]): any { /* extracted to routes/ modules */ }
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

function compactTerminalLines(..._args: any[]): any { return _args; }
function buildTerminalPane(..._args: any[]): any { return _args; }
function buildTerminalFallbackSnapshot(..._args: any[]): any { return _args; }
function formatError(..._args: any[]): any { return _args; }
async function buildTerminalSnapshot(..._args: any[]): Promise<any> { return _args; }
function fingerprintMarketSnapshot(..._args: any[]): any { return _args; }
function fingerprintMicrostructure(..._args: any[]): any { return _args; }
function normalizeBrokerAccounts(snapshots: BrokerRouterBrokerSnapshot[]): BrokerAccountSnapshot[] { return normalizeBrokerAccountsExt(snapshots as any); }
function normalizeBrokerPositions(snapshots: BrokerRouterBrokerSnapshot[]): PositionSnapshot[] { return normalizeBrokerPositionsExt(snapshots as any); }
function normalizeBrokerReports(reports: BrokerRouterReportRecord[]): ExecutionReport[] { return normalizeBrokerReportsExt(reports as any); }
function buildOverviewSnapshot(desk: any, accounts: BrokerAccountSnapshot[], health: ServiceHealth[]): OverviewSnapshot { return buildOverviewSnapshotExt(desk, accounts, health); }
function buildHeat(accounts: BrokerAccountSnapshot[], paperEquity: number, paperRealizedPnl: number): BrokerHeat[] { return buildHeatExt(accounts, paperEquity, paperRealizedPnl); }
function mapBrokerStatus(status: string): BrokerAccountSnapshot["status"] { return mapBrokerStatusFn(status); }
function sumCoinbaseCash(account: Record<string, unknown>): number { return sumCoinbaseCashFn(account); }

function mapPaperFillToExecutionReport(..._args: any[]): any { /* extracted to routes/ modules */ }
function buildStrategySnapshots(..._args: any[]): any { /* extracted to routes/ modules */ }
function buildResearchCandidates(..._args: any[]): any { /* extracted to routes/ modules */ }
function dedupePositions(positions: PositionSnapshot[]): PositionSnapshot[] { return dedupePositionsFn(positions); }
function dedupeReports(reports: ExecutionReport[]): ExecutionReport[] { return dedupeReportsFn(reports); }
function dedupeJournal(entries: TradeJournalEntry[]): TradeJournalEntry[] { return dedupeJournalFn(entries); }
function dedupeMarketSnapshots(snapshots: MarketSnapshot[]): MarketSnapshot[] { return dedupeMarketSnapshotsFn(snapshots); }

function researchPriority(snapshot: MarketSnapshot): number {
  const liveBonus = snapshot.status === 'live' && snapshot.source !== 'mock' && snapshot.source !== 'simulated' ? 1_000 : 0;
  const tradableBonus = snapshot.tradable ? 300 : 0;
  const delayedPenalty = snapshot.status === 'delayed' ? -100 : snapshot.status === 'stale' ? -200 : 0;
  const mockPenalty = snapshot.source === 'mock' || snapshot.source === 'simulated' ? -300 : 0;
  const sessionPenalty = snapshot.assetClass === 'equity' && snapshot.session && snapshot.session !== 'regular' ? -250 : 0;
  return liveBonus + tradableBonus + delayedPenalty + mockPenalty + sessionPenalty + snapshot.liquidityScore;
}

// Utilities imported from ./routes/helpers.ts
function peak(values: number[]): number { return peakFn(values); }
function asString(value: unknown): string | undefined { return asStringFn(value); }
function previewText(value: string | undefined, limit = 120): string { return previewTextFn(value, limit); }
function normalizeArray(value: unknown): unknown[] { return normalizeArrayFn(value); }
function asRecord(value: unknown): Record<string, unknown> { return asRecordFn(value); }
function textField(source: unknown, paths: string[]): string | null { return textFieldFn(source, paths); }
function numberField(source: unknown, paths: string[]): number | null { return numberFieldFn(source, paths); }
function round(value: number, decimals: number): number { return roundFn(value, decimals); }
