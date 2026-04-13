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
import { GridEngine } from './grid-engine.js';
import { LearningLoop } from './learning-loop.js';
import { LaneLearningEngine } from './lane-learning.js';
import { StrategyDirector } from './strategy-director.js';
import { MakerEngine } from './maker-engine.js';
import { MakerOrderExecutor } from './maker-executor.js';
import { getInsiderRadar } from './insider-radar.js';
import { getHistoricalContext } from './historical-context.js';
import { getDerivativesIntel } from './derivatives-intel.js';

import { createCoreRouter } from './routes/router-core.js';
import { createPaperRouter } from './routes/router-paper.js';
import { createStrategyRouter } from './routes/router-strategies.js';
import { createIntelRouter } from './routes/router-intel.js';
import { createDirectorRouter } from './routes/router-director.js';

import { MarketFeedService } from './services/market-feed.js';
import { TelemetrySSEService } from './services/telemetry-sse.js';

const app = express();
const port = Number(process.env.PORT ?? 4300);
const BROKER_STARTING_EQUITY = Number(process.env.BROKER_STARTING_EQUITY ?? 100_000);

// 1. Initialize Engines
const paperEngine = getPaperEngine();
const aiCouncil = getAiCouncil();
const marketIntel = getMarketIntel();
const newsIntel = getNewsIntel();
const eventCalendar = getEventCalendar();
const featureStore = getFeatureStore();

const learningLoop = new LearningLoop(
  () => paperEngine.getSnapshot().agents as any,
  (agentId: string, config: any) => paperEngine.applyAgentConfig(agentId, config)
);
const laneLearning = new LaneLearningEngine();

const pairsEngine = new PairsEngine(BROKER_STARTING_EQUITY);
const btcGrid = new GridEngine('BTC-USD', BROKER_STARTING_EQUITY);
const ethGrid = new GridEngine('ETH-USD', BROKER_STARTING_EQUITY);
const solGrid = new GridEngine('SOL-USD', BROKER_STARTING_EQUITY / 2);
const xrpGrid = new GridEngine('XRP-USD', BROKER_STARTING_EQUITY / 2);

const makerEngine = new MakerEngine(['BTC-USD', 'ETH-USD', 'SOL-USD']);
const makerExecutor = new MakerOrderExecutor();

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
  btcGrid,
  ethGrid,
  solGrid,
  xrpGrid,
  emitStrategyState: (_id, _payload) => {
    // Optional strategy state emission logic
  }
});

// 3. Configure Express
app.use(cors());
app.use(compression({
  filter: (req, res) => {
    // Don't compress SSE streams — breaks EventSource and proxies
    if (req.headers.accept === 'text/event-stream') return false;
    if (res.getHeader('Content-Type')?.toString().includes('text/event-stream')) return false;
    return compression.filter(req, res);
  }
}));
app.use(express.json());

// 4. Mount Routers
app.use('/api', createCoreRouter(terminalDeps));
app.use('/api', createPaperRouter({ paperEngine }));
app.use('/api', createStrategyRouter({
  paperEngine,
  pairsEngine,
  btcGrid,
  ethGrid,
  solGrid,
  xrpGrid,
  makerEngine,
  makerExecutor,
  marketFeed
}));
app.use('/api', createIntelRouter({
  marketIntel,
  newsIntel,
  eventCalendar,
  featureStore
}));
app.use('/api/strategy-director', createDirectorRouter({ strategyDirector }));

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
app.get('/api/event-calendar', (_req, res) => {
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
app.get('/api/copy-sleeve', async (req, res) => {
  try {
    const qs = req.query.managerId ? `?managerId=${req.query.managerId}` : '';
    const response = await fetch(`http://127.0.0.1:4305/copy-sleeve${qs}`, { signal: AbortSignal.timeout(5000) });
    if (response.ok) { res.json(await response.json()); return; }
    res.json({ managerName: null, status: 'backtest service unavailable' });
  } catch { res.json({ managerName: null, status: 'backtest service unavailable' }); }
});
app.get('/api/copy-sleeve/backtest', async (req, res) => {
  try {
    const qs = req.query.managerId ? `?managerId=${req.query.managerId}` : '';
    const response = await fetch(`http://127.0.0.1:4305/copy-sleeve/backtest${qs}`, { signal: AbortSignal.timeout(5000) });
    if (response.ok) { res.json(await response.json()); return; }
    res.json({ status: 'backtest service unavailable' });
  } catch { res.json({ status: 'backtest service unavailable' }); }
});
app.get('/api/macro-preservation/backtest', async (req, res) => {
  try {
    const qs = req.query.startDate ? `?startDate=${req.query.startDate}` : '';
    const response = await fetch(`http://127.0.0.1:4305/macro-preservation/backtest${qs}`, { signal: AbortSignal.timeout(5000) });
    if (response.ok) { res.json(await response.json()); return; }
    res.json({ status: 'backtest service unavailable' });
  } catch { res.json({ status: 'backtest service unavailable' }); }
});
app.get('/api/macro-preservation', async (_req, res) => {
  try {
    const response = await fetch('http://127.0.0.1:4305/macro-preservation', { signal: AbortSignal.timeout(5000) });
    if (response.ok) { res.json(await response.json()); return; }
    res.json({ regime: null, status: 'backtest service unavailable' });
  } catch { res.json({ regime: null, status: 'backtest service unavailable' }); }
});

// 6. Start Lifecycle
marketFeed.start();
strategyDirector.start();

app.listen(port, '0.0.0.0', () => {
  console.log(`[hermes-api] Hyper-Modular entry point online at http://0.0.0.0:${port}`);
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
function gracefulShutdown(signal: string): void {
  console.log(`[hermes-api] ${signal} received. Shutting down...`);
  strategyDirector.stop();
  learningLoop.stop();
  marketIntel.stop();
  newsIntel.stop();
  eventCalendar.stop();
  getInsiderRadar().stop();
  getHistoricalContext().stop();
  getDerivativesIntel().stop();
  
  setTimeout(() => {
    console.log('[hermes-api] Goodbye.');
    process.exit(0);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
