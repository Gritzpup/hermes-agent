// @ts-nocheck
import type { TradeJournalEntry } from '@hermes/contracts';
import { predictWithModel, type MetaLabelCandidate } from '../meta-label-model.js';
import {
  average,
  clamp,
  pickLast,
  round
} from '../paper-engine-utils.js';
import {
  estimateExpectedGrossEdgeBps,
  estimateRoundTripCostBps
} from '../fee-model.js';

export function getMetaLabelDecision(
  engine: any,
  agent: any,
  symbol: any,
  score: number,
  intel: {
    direction: 'strong-buy' | 'buy' | 'neutral' | 'sell' | 'strong-sell';
    confidence: number;
    tradeable: boolean;
    adverseSelectionRisk?: number;
    quoteStabilityMs?: number;
  }
): {
  approve: boolean;
  probability: number;
  reason: string;
  heuristicProbability: number;
  contextualProbability: number;
  trainedProbability: number;
  contextualReason: string;
  trainedReason: string;
  sampleCount: number;
  support: number;
  expectedGrossEdgeBps: number;
  estimatedCostBps: number;
  expectedNetEdgeBps: number;
} {
  const recent = pickLast(agent.recentOutcomes, 8);
  const wins = recent.filter((value) => value > 0).length;
  const losses = recent.filter((value) => value < 0).length;
  const posteriorWinRate = (wins + 1) / Math.max(wins + losses + 2, 1);
  const grossWins = recent.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLosses = Math.abs(recent.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 1.5 : 1;
  const safeScore = Number.isFinite(score) ? score : 0;
  const scoreQuality = clamp((safeScore - engine.entryThreshold(agent.config.style)) / Math.max(engine.fastPathThreshold(agent.config.style) - engine.entryThreshold(agent.config.style), 1), 0, 1);
  const spreadQuality = clamp(1 - (symbol.spreadBps / Math.max(agent.config.spreadLimitBps, 0.1)), 0, 1);
  const intelBonus = intel.tradeable ? clamp(intel.confidence / 100, 0, 1) * 0.15 : 0.05;
  const heuristicProbability = clamp(
    0.18
      + posteriorWinRate * 0.32
      + clamp(profitFactor / 3, 0, 0.2)
      + scoreQuality * 0.18
      + spreadQuality * 0.12
      + intelBonus,
    0,
    0.99
  );

  const contextual = getContextualMetaSignal(engine, agent, symbol, intel);
  engine.getMetaJournalEntries(); // Ensure caches are warm
  const trained = engine.metaModelCache
    ? predictWithModel(engine.metaModelCache, buildMetaCandidate(engine, agent, symbol, intel))
    : { posterior: 0.5, support: 0, sampleCount: engine.metaJournalCache.length, matchedTokens: [], reason: 'Insufficient trained samples.' };
  const contextualWeight = clamp(contextual.support / 24, 0, 0.28);
  const trainedReadiness = clamp((trained.sampleCount - 7) / 24, 0, 1);
  const trainedWeight = (clamp(trained.sampleCount / 30, 0, 0.22) + clamp(trained.support / 30, 0, 0.18)) * trainedReadiness;
  const heuristicWeight = Math.max(0.2, 1 - contextualWeight - trainedWeight);
  const weightSum = heuristicWeight + contextualWeight + trainedWeight;
  let probability = (
    heuristicProbability * heuristicWeight
    + contextual.posterior * contextualWeight
    + trained.posterior * trainedWeight
  ) / Math.max(weightSum, Number.EPSILON);

  if ((intel.adverseSelectionRisk ?? 0) >= 70) {
    probability *= 0.78;
  }
  if ((intel.quoteStabilityMs ?? 9_999) < 1_500) {
    probability *= 0.84;
  }
  if (trained.sampleCount >= 12 && trained.posterior < 0.45) {
    probability *= 0.9;
  }

  // Cold-start exception: agents with < 10 completed trades lack a meaningful sample
  // window. The trained model was fit on a different asset mix (Alpaca crypto's ~27%
  // win rate) and unfairly penalises new agents — especially Coinbase paper agents
  // that have never traded.  For these agents we floor the probability at the
  // heuristic value so the meta-label veto doesn't block every single entry while
  // the agent is still building its initial sample window.
  const completedTrades: number = agent.trades ?? 0;
  if (completedTrades < 10) {
    probability = Math.max(probability, heuristicProbability);
  }

  // Contrarian fear-greed override: when F&G < 20 (Extreme Fear) and the composite
  // signal is bullish for crypto, the meta-label model's veto is based on poor past
  // crypto performance — creating a negative feedback loop that blocks every dip-buy.
  // Boost the entry probability by 1.3x so the engine is MORE willing to enter long
  // crypto during capitulation, not less.
  const fng = engine.marketIntel.getFearGreedValue();
  const isCryptoLong = symbol.assetClass === 'crypto'
    && (intel.direction === 'buy' || intel.direction === 'strong-buy');
  if (fng !== null && fng < 20 && isCryptoLong) {
    const preFearProb = probability;
    probability *= 1.3;
    engine.log?.(`[contrarian] F&G=${fng} crypto long boost: probability ${(preFearProb * 100).toFixed(1)}% -> ${(probability * 100).toFixed(1)}% for ${symbol.symbol}`);
  }

  probability = clamp(probability, 0, 0.99);

  const expectedGrossEdgeBps = estimateExpectedGrossEdgeBps(probability * 100, agent.config.targetBps, agent.config.stopBps);
  const estimatedCostBps = estimateRoundTripCostBps({
    assetClass: symbol.assetClass,
    broker: agent.config.broker,
    spreadBps: symbol.spreadBps,
    orderType: 'market',
    adverseSelectionRisk: intel.adverseSelectionRisk,
    quoteStabilityMs: intel.quoteStabilityMs,
    postOnly: false,
    shortSide: false
  });
  const expectedNetEdgeBps = expectedGrossEdgeBps - estimatedCostBps;

  const netPositive = expectedNetEdgeBps > 0;
  if (!netPositive) {
    probability *= 0.75;
  }

  // Paper mode: low floor to maximize data collection. Tighten for live.
  // Cold-start agents (< 10 trades) get an even lower floor so they can begin
  // collecting the sample window the trained model needs to become useful.
  const approvalFloor = agent.config.executionMode === 'broker-paper'
    ? (completedTrades < 10 ? 0.20 : 0.30)
    : 0.6;
  const approve = probability >= approvalFloor;
  const reasonPrefix = `precision ${round(probability * 100, 1)}% (heuristic ${round(heuristicProbability * 100, 1)}%, contextual ${round(contextual.posterior * 100, 1)}%, trained ${round(trained.posterior * 100, 1)}%, gross ${round(expectedGrossEdgeBps, 1)}bps, cost ${round(estimatedCostBps, 1)}bps, net ${round(expectedNetEdgeBps, 1)}bps)`;
  return {
    approve,
    probability: round(probability * 100, 1),
    reason: approve
      ? `${reasonPrefix}. ${contextual.reason} ${trained.reason}`
      : `${reasonPrefix}. ${contextual.reason} ${trained.reason} Need stronger edge or cleaner tape.`,
    heuristicProbability: round(heuristicProbability * 100, 1),
    contextualProbability: round(contextual.posterior * 100, 1),
    trainedProbability: round(trained.posterior * 100, 1),
    contextualReason: contextual.reason,
    trainedReason: trained.reason,
    sampleCount: trained.sampleCount,
    support: contextual.support,
    expectedGrossEdgeBps,
    estimatedCostBps,
    expectedNetEdgeBps
  };
}

export function getContextualMetaSignal(
  engine: any,
  agent: any,
  symbol: any,
  intel: {
    direction: 'strong-buy' | 'buy' | 'neutral' | 'sell' | 'strong-sell';
    confidence: number;
  }
): { posterior: number; support: number; reason: string } {
  const entries = engine.getMetaJournalEntries();
  if (entries.length === 0) {
    return { posterior: 0.5, support: 0, reason: 'No historical journal support.' };
  }

  const strategyName = `${agent.config.name} / scalping`;
  const regime = engine.classifySymbolRegime(symbol);
  const flowBucket = engine.normalizeFlowBucket(intel.direction);
  const confidenceBucket = engine.getConfidenceBucket(intel.confidence);
  const spreadBucket = engine.getSpreadBucket(symbol.spreadBps, agent.config.spreadLimitBps);

  // Use durable feature-store history first (indexed SQLite), then fall back to in-memory journaling.
  const sqliteSnapshot = engine.featureStore.getPosteriorSnapshot({
    strategyId: agent.config.id,
    strategy: strategyName,
    symbol: symbol.symbol,
    regime,
    flowBucket,
    confidenceBucket,
    spreadBucket
  });
  if (sqliteSnapshot.support >= 4) {
    return sqliteSnapshot;
  }

  const exact = entries.filter((entry) => (entry.strategyId === agent.config.id || entry.strategy === strategyName));
  const symbolMatches = entries.filter((entry) => entry.symbol === symbol.symbol);
  const contextMatches = entries.filter((entry) =>
    entry.symbol === symbol.symbol
    && (entry.regime ?? 'unknown') === regime
    && engine.normalizeFlowBucket(entry.orderFlowBias ?? 'neutral') === flowBucket
    && engine.getConfidenceBucket(entry.confidencePct ?? 0) === confidenceBucket
    && engine.getSpreadBucket(entry.spreadBps, agent.config.spreadLimitBps) === spreadBucket
  );
  const regimeMatches = entries.filter((entry) =>
    (entry.regime ?? 'unknown') === regime
    && engine.normalizeFlowBucket(entry.orderFlowBias ?? 'neutral') === flowBucket
  );

  const summarize = (group: TradeJournalEntry[], priorWins: number, priorLosses: number) => {
    const winsLocal = group.filter((entry) => entry.realizedPnl > 0).length;
    const lossesLocal = group.filter((entry) => entry.realizedPnl < 0).length;
    const posterior = (winsLocal + priorWins) / Math.max(winsLocal + lossesLocal + priorWins + priorLosses, 1);
    return {
      count: group.length,
      posterior,
      expectancy: group.length > 0 ? average(group.map((entry) => entry.realizedPnl)) : 0
    };
  };

  const global = summarize(entries, 3, 3);
  const exactStats = summarize(exact, 2, 2);
  const symbolStats = summarize(symbolMatches, 2, 2);
  const contextStats = summarize(contextMatches, 2, 2);
  const regimeStats = summarize(regimeMatches, 2, 2);

  const weightedPosterior = clamp(
    global.posterior * 0.15
    + regimeStats.posterior * 0.2
    + symbolStats.posterior * 0.25
    + contextStats.posterior * 0.25
    + exactStats.posterior * 0.15,
    0.05,
    0.98
  );
  const support = exactStats.count + contextStats.count + symbolStats.count + regimeStats.count;
  const reason = `context exact ${exactStats.count}, symbol ${symbolStats.count}, regime ${regimeStats.count}, context ${contextStats.count}.`;
  return { posterior: weightedPosterior, support, reason };
}

export function buildEntryMeta(engine: any, agent: any, symbol: any, score: number): any {
  const intel = engine.marketIntel.getCompositeSignal(symbol.symbol);
  const decision = getMetaLabelDecision(engine, agent, symbol, score, intel);
  const context = buildJournalContext(engine, symbol);
  return {
    score: round(Number.isFinite(score) ? score : 0, 2),
    heuristicProbability: decision.heuristicProbability,
    contextualProbability: decision.contextualProbability,
    trainedProbability: decision.trainedProbability,
    approve: decision.approve,
    reason: decision.reason,
    confidencePct: context.confidencePct,
    regime: context.regime,
    newsBias: context.newsBias,
    orderFlowBias: context.orderFlowBias,
    macroVeto: context.macroVeto,
    embargoed: context.embargoed,
    tags: [...context.tags, `style-${agent.config.style}`, `mode-${agent.config.executionMode}`],
    expectedGrossEdgeBps: decision.expectedGrossEdgeBps,
    estimatedCostBps: decision.estimatedCostBps,
    expectedNetEdgeBps: decision.expectedNetEdgeBps
  };
}

export function buildMetaCandidate(
  engine: any,
  agent: any,
  symbol: any,
  intel: {
    direction: 'strong-buy' | 'buy' | 'neutral' | 'sell' | 'strong-sell';
    confidence: number;
    adverseSelectionRisk?: number;
    quoteStabilityMs?: number;
  }
): MetaLabelCandidate {
  const context = buildJournalContext(engine, symbol);
  const openMeta = agent.position?.entryMeta;
  const probability = openMeta?.trainedProbability ?? openMeta?.contextualProbability ?? openMeta?.heuristicProbability ?? intel.confidence;
  const expectedGrossEdgeBps = estimateExpectedGrossEdgeBps(probability, agent.config.targetBps, agent.config.stopBps);
  const estimatedCostBps = estimateRoundTripCostBps({
    assetClass: symbol.assetClass,
    broker: agent.config.broker,
    spreadBps: symbol.spreadBps,
    orderType: agent.config.executionMode === 'broker-paper' ? 'market' : 'market',
    adverseSelectionRisk: intel.adverseSelectionRisk,
    quoteStabilityMs: intel.quoteStabilityMs,
    postOnly: false,
    shortSide: false
  });
  const expectedNetEdgeBps = expectedGrossEdgeBps - estimatedCostBps;
  return {
    strategyId: agent.config.id,
    strategy: `${agent.config.name} / scalping`,
    style: agent.config.style,
    symbol: symbol.symbol,
    regime: context.regime,
    orderFlowBias: intel.direction,
    newsBias: context.newsBias,
    confidencePct: intel.confidence,
    spreadBps: symbol.spreadBps,
    macroVeto: context.macroVeto,
    embargoed: context.embargoed,
    tags: [...context.tags, `style-${agent.config.style}`, `mode-${agent.config.executionMode}`],
    source: agent.config.executionMode === 'broker-paper' ? 'broker' : 'simulated',
    assetClass: symbol.assetClass,
    expectedGrossEdgeBps,
    estimatedCostBps,
    expectedNetEdgeBps,
    ...(openMeta ? {
      entryScore: openMeta.score,
      entryHeuristicProbability: openMeta.heuristicProbability,
      entryContextualProbability: openMeta.contextualProbability,
      entryTrainedProbability: openMeta.trainedProbability,
      entryApprove: openMeta.approve,
      entryReason: openMeta.reason,
      entryConfidencePct: openMeta.confidencePct,
      entryRegime: openMeta.regime,
      entryNewsBias: openMeta.newsBias,
      entryOrderFlowBias: openMeta.orderFlowBias,
      entryMacroVeto: openMeta.macroVeto,
      entryEmbargoed: openMeta.embargoed,
      entryTags: openMeta.tags
    } : {})
  };
}

export function buildJournalContext(engine: any, symbol: any): {
  regime: string;
  newsBias: string;
  orderFlowBias: string;
  macroVeto: boolean;
  embargoed: boolean;
  confidencePct: number;
  tags: string[];
} {
  const intel = engine.marketIntel.getCompositeSignal(symbol.symbol);
  const news = engine.newsIntel.getSignal(symbol.symbol);
  const macro = engine.newsIntel.getMacroSignal();
  const embargo = engine.eventCalendar.getEmbargo(symbol.symbol);
  const sessionBucket = engine.getSessionBucket();
  const volBucket = engine.getVolatilityBucket(symbol);
  const tags = [
    news.veto ? 'symbol-news-veto' : '',
    macro.veto ? 'macro-veto' : '',
    embargo.blocked ? `embargo-${embargo.kind}` : '',
    intel.tradeable ? 'intel-tradeable' : 'intel-weak',
    `regime-${engine.classifySymbolRegime(symbol)}`,
    `session-${sessionBucket}`,
    `vol-${volBucket}`
  ].filter((tag): tag is string => tag.length > 0);

  return {
    regime: engine.classifySymbolRegime(symbol),
    newsBias: news.direction,
    orderFlowBias: intel.direction,
    macroVeto: macro.veto,
    embargoed: embargo.blocked,
    confidencePct: intel.confidence,
    tags
  };
}
