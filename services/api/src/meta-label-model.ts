import type { AssetClass, TradeJournalEntry } from '@hermes/contracts';

export type MetaStyle = 'momentum' | 'mean-reversion' | 'breakout' | 'arbitrage';

export interface MetaLabelCandidate {
  strategyId: string;
  strategy: string;
  style: MetaStyle;
  symbol: string;
  regime: string;
  orderFlowBias: string;
  newsBias: string;
  confidencePct: number;
  spreadBps: number;
  macroVeto: boolean;
  embargoed: boolean;
  tags: string[];
  source: 'broker' | 'simulated';
  assetClass?: AssetClass | undefined;
  entryScore?: number | undefined;
  entryHeuristicProbability?: number | undefined;
  entryContextualProbability?: number | undefined;
  entryTrainedProbability?: number | undefined;
  entryApprove?: boolean | undefined;
  entryReason?: string | undefined;
  entryConfidencePct?: number | undefined;
  entryRegime?: string | undefined;
  entryNewsBias?: string | undefined;
  entryOrderFlowBias?: string | undefined;
  entryMacroVeto?: boolean | undefined;
  entryEmbargoed?: boolean | undefined;
  entryTags?: string[] | undefined;
  expectedGrossEdgeBps?: number | undefined;
  estimatedCostBps?: number | undefined;
  expectedNetEdgeBps?: number | undefined;
}

export interface MetaLabelPrediction {
  posterior: number;
  support: number;
  sampleCount: number;
  matchedTokens: string[];
  reason: string;
}

export interface MetaLabelValidation {
  samples: number;
  accuracyPct: number;
  precisionAt60Pct: number;
  coverageAt60Pct: number;
  avgBrier: number;
}

export interface MetaLabelTokenEdge {
  token: string;
  edgePct: number;
  support: number;
}

export interface MetaLabelModelSnapshot {
  asOf: string;
  totalSamples: number;
  winners: number;
  losers: number;
  tokenCount: number;
  validation: MetaLabelValidation;
  topPositiveTokens: MetaLabelTokenEdge[];
  topNegativeTokens: MetaLabelTokenEdge[];
  candidates: Array<{
    agentId: string;
    symbol: string;
    assetClass?: AssetClass | undefined;
    posterior: number;
    support: number;
    sampleCount: number;
    matchedTokens: string[];
  }>;
}

interface TokenStats {
  wins: number;
  losses: number;
}

export interface ModelState {
  sampleCount: number;
  wins: number;
  losses: number;
  tokenStats: Map<string, TokenStats>;
  samples: Array<{ tokens: string[]; winner: boolean }>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}

function normalizeDirection(value: string): 'bullish' | 'bearish' | 'neutral' {
  const normalized = value.toLowerCase();
  if (normalized.includes('strong-buy') || normalized.includes('buy') || normalized.includes('bull')) return 'bullish';
  if (normalized.includes('strong-sell') || normalized.includes('sell') || normalized.includes('bear')) return 'bearish';
  return 'neutral';
}

function confidenceBucket(confidencePct: number): 'low' | 'medium' | 'high' {
  if (confidencePct >= 70) return 'high';
  if (confidencePct >= 35) return 'medium';
  return 'low';
}

function spreadBucket(spreadBps: number): 'micro' | 'tight' | 'normal' | 'wide' | 'extreme' {
  if (spreadBps <= 0.15) return 'micro';
  if (spreadBps <= 0.75) return 'tight';
  if (spreadBps <= 2) return 'normal';
  if (spreadBps <= 5) return 'wide';
  return 'extreme';
}

function inferStyle(entry: TradeJournalEntry): MetaStyle {
  const text = `${entry.strategyId ?? ''} ${entry.strategy}`.toLowerCase();
  if (text.includes('revert') || text.includes('mean')) return 'mean-reversion';
  if (text.includes('breakout')) return 'breakout';
  return 'momentum';
}

function inferAssetClass(entry: TradeJournalEntry): AssetClass {
  if (entry.assetClass) return entry.assetClass;
  const symbol = entry.symbol.toUpperCase();
  if (symbol.endsWith('-USD')) {
    const base = symbol.split('-')[0] ?? '';
    if (['BTC', 'ETH', 'SOL', 'XRP'].includes(base)) return 'crypto';
    if (base === 'PAXG') return 'commodity-proxy';
    if (base === 'BCO' || base === 'WTICO') return 'commodity';
    return 'commodity-proxy';
  }
  if (symbol.includes('_')) {
    if (symbol.startsWith('USB')) return 'bond';
    if (symbol.startsWith('BCO') || symbol.startsWith('WTICO')) return 'commodity';
    return 'forex';
  }
  return 'equity';
}

function candidateTokens(candidate: MetaLabelCandidate): string[] {
  const tokens = new Set<string>([
    `strategy:${candidate.strategyId || candidate.strategy}`,
    `style:${candidate.style}`,
    `symbol:${candidate.symbol}`,
    `asset:${candidate.assetClass ?? 'unknown'}`,
    `regime:${candidate.regime || 'unknown'}`,
    `flow:${normalizeDirection(candidate.orderFlowBias)}`,
    `news:${normalizeDirection(candidate.newsBias)}`,
    `confidence:${confidenceBucket(candidate.confidencePct)}`,
    `spread:${spreadBucket(candidate.spreadBps)}`,
    `macro:${candidate.macroVeto ? 'on' : 'off'}`,
    `embargo:${candidate.embargoed ? 'on' : 'off'}`,
    `source:${candidate.source}`,
    `alignment:${normalizeDirection(candidate.orderFlowBias)}|${normalizeDirection(candidate.newsBias)}`
  ]);
  if (candidate.entryScore !== undefined) {
    tokens.add(`entry-score:${candidate.entryScore >= 4 ? 'strong' : candidate.entryScore >= 2 ? 'moderate' : candidate.entryScore >= 0 ? 'weak-pos' : candidate.entryScore <= -4 ? 'strong-neg' : candidate.entryScore < -2 ? 'moderate-neg' : 'weak-neg'}`);
  }
  if (candidate.entryHeuristicProbability !== undefined) {
    tokens.add(`entry-heuristic:${confidenceBucket(candidate.entryHeuristicProbability)}`);
  }
  if (candidate.entryContextualProbability !== undefined) {
    tokens.add(`entry-contextual:${confidenceBucket(candidate.entryContextualProbability)}`);
  }
  if (candidate.entryTrainedProbability !== undefined) {
    tokens.add(`entry-trained:${confidenceBucket(candidate.entryTrainedProbability)}`);
  }
  if (candidate.entryApprove !== undefined) {
    tokens.add(`entry-approve:${candidate.entryApprove ? 'yes' : 'no'}`);
  }
  if (candidate.entryReason) {
    tokens.add(`entry-reason:${candidate.entryReason.toLowerCase().slice(0, 24).replace(/\W+/g, '-')}`);
  }
  if (candidate.entryConfidencePct !== undefined) {
    tokens.add(`entry-confidence:${confidenceBucket(candidate.entryConfidencePct)}`);
  }
  if (candidate.entryRegime) {
    tokens.add(`entry-regime:${candidate.entryRegime}`);
  }
  if (candidate.entryNewsBias) {
    tokens.add(`entry-news:${normalizeDirection(candidate.entryNewsBias)}`);
  }
  if (candidate.entryOrderFlowBias) {
    tokens.add(`entry-flow:${normalizeDirection(candidate.entryOrderFlowBias)}`);
  }
  if (candidate.entryMacroVeto !== undefined) {
    tokens.add(`entry-macro:${candidate.entryMacroVeto ? 'on' : 'off'}`);
  }
  if (candidate.entryEmbargoed !== undefined) {
    tokens.add(`entry-embargo:${candidate.entryEmbargoed ? 'on' : 'off'}`);
  }
  if (Array.isArray(candidate.entryTags)) {
    for (const tag of candidate.entryTags) {
      if (tag.trim()) tokens.add(`entry-tag:${tag.trim().toLowerCase()}`);
    }
  }
  if (candidate.expectedGrossEdgeBps !== undefined) {
    tokens.add(`entry-gross:${candidate.expectedGrossEdgeBps >= 5 ? 'strong' : candidate.expectedGrossEdgeBps >= 1 ? 'positive' : candidate.expectedGrossEdgeBps <= -5 ? 'strong-neg' : 'weak'}`);
  }
  if (candidate.estimatedCostBps !== undefined) {
    tokens.add(`entry-cost:${candidate.estimatedCostBps >= 8 ? 'high' : candidate.estimatedCostBps >= 4 ? 'medium' : 'low'}`);
  }
  if (candidate.expectedNetEdgeBps !== undefined) {
    tokens.add(`entry-net:${candidate.expectedNetEdgeBps >= 5 ? 'strong' : candidate.expectedNetEdgeBps >= 0 ? 'positive' : candidate.expectedNetEdgeBps <= -5 ? 'strong-neg' : 'negative'}`);
  }
  for (const tag of candidate.tags) {
    if (tag.trim()) tokens.add(`tag:${tag.trim().toLowerCase()}`);
  }
  return Array.from(tokens.values()).sort();
}

function journalToCandidate(entry: TradeJournalEntry): MetaLabelCandidate {
  return {
    strategyId: entry.strategyId ?? entry.strategy,
    strategy: entry.strategy,
    style: inferStyle(entry),
    symbol: entry.symbol,
    regime: entry.regime ?? 'unknown',
    orderFlowBias: entry.orderFlowBias ?? 'neutral',
    newsBias: entry.newsBias ?? 'neutral',
    confidencePct: entry.confidencePct ?? 0,
    spreadBps: entry.spreadBps,
    macroVeto: entry.macroVeto ?? false,
    embargoed: entry.embargoed ?? false,
    tags: entry.tags ?? [],
    source: entry.source === 'broker' ? 'broker' : 'simulated',
    assetClass: inferAssetClass(entry),
    entryScore: entry.entryScore,
    entryHeuristicProbability: entry.entryHeuristicProbability,
    entryContextualProbability: entry.entryContextualProbability,
    entryTrainedProbability: entry.entryTrainedProbability,
    entryApprove: entry.entryApprove,
    entryReason: entry.entryReason,
    entryConfidencePct: entry.entryConfidencePct,
    entryRegime: entry.entryRegime,
    entryNewsBias: entry.entryNewsBias,
    entryOrderFlowBias: entry.entryOrderFlowBias,
    entryMacroVeto: entry.entryMacroVeto,
    entryEmbargoed: entry.entryEmbargoed,
    entryTags: entry.entryTags,
    expectedGrossEdgeBps: entry.expectedGrossEdgeBps,
    estimatedCostBps: entry.estimatedCostBps,
    expectedNetEdgeBps: entry.expectedNetEdgeBps
  };
}

export function buildModel(entries: TradeJournalEntry[]): ModelState {
  const tokenStats = new Map<string, TokenStats>();
  const samples: Array<{ tokens: string[]; winner: boolean }> = [];
  let wins = 0;
  let losses = 0;

  for (const entry of entries) {
    const winner = entry.realizedPnl > 0;
    if (winner) wins += 1;
    else if (entry.realizedPnl < 0) losses += 1;
    const tokens = candidateTokens(journalToCandidate(entry));
    samples.push({ tokens, winner });
    for (const token of tokens) {
      const stat = tokenStats.get(token) ?? { wins: 0, losses: 0 };
      if (winner) stat.wins += 1;
      else if (entry.realizedPnl < 0) stat.losses += 1;
      tokenStats.set(token, stat);
    }
  }

  // Prune tokenStats to top 500 by total count to prevent unbounded memory growth
  if (tokenStats.size > 500) {
    const sorted = Array.from(tokenStats.entries())
      .sort((a, b) => (b[1].wins + b[1].losses) - (a[1].wins + a[1].losses));
    const keep = new Set(sorted.slice(0, 500).map(([key]) => key));
    for (const key of tokenStats.keys()) {
      if (!keep.has(key)) tokenStats.delete(key);
    }
  }

  return {
    sampleCount: entries.length,
    wins,
    losses,
    tokenStats,
    samples
  };
}

function overlapCount(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  let matches = 0;
  for (const token of left) {
    if (rightSet.has(token)) matches += 1;
  }
  return matches;
}

export function predictWithModel(model: ModelState, candidate: MetaLabelCandidate): MetaLabelPrediction {
  const tokens = candidateTokens(candidate);
  const matchedTokens = tokens.filter((token) => model.tokenStats.has(token));
  const priorWin = (model.wins + 2) / Math.max(model.wins + model.losses + 4, 1);
  const priorLoss = 1 - priorWin;
  let logWin = Math.log(priorWin);
  let logLoss = Math.log(priorLoss);

  for (const token of tokens) {
    const stats = model.tokenStats.get(token) ?? { wins: 0, losses: 0 };
    const tokenWin = (stats.wins + 1) / Math.max(model.wins + 2, 1);
    const tokenLoss = (stats.losses + 1) / Math.max(model.losses + 2, 1);
    logWin += Math.log(tokenWin);
    logLoss += Math.log(tokenLoss);
  }

  const posterior = clamp(1 / (1 + Math.exp(logLoss - logWin)), 0.02, 0.98);
  const support = model.samples.filter((sample) => overlapCount(sample.tokens, tokens) >= 3).length;
  return {
    posterior,
    support,
    sampleCount: model.sampleCount,
    matchedTokens: matchedTokens.slice(0, 8),
    reason: `trained NB posterior ${round(posterior * 100, 1)}% from ${model.sampleCount} samples, ${matchedTokens.length} matched tokens, ${support} contextual overlaps.`
  };
}

export function predictMetaLabel(entries: TradeJournalEntry[], candidate: MetaLabelCandidate): MetaLabelPrediction {
  const filtered = entries.filter((entry) => (entry.lane ?? 'scalping') === 'scalping' && entry.realizedPnl !== 0);
  if (filtered.length < 8) {
    return {
      posterior: 0.5,
      support: 0,
      sampleCount: filtered.length,
      matchedTokens: [],
      reason: `Insufficient trained samples yet (${filtered.length}/8).`
    };
  }

  const model = buildModel(filtered);
  return predictWithModel(model, candidate);
}

function evaluateWalkForward(entries: TradeJournalEntry[]): MetaLabelValidation {
  const filtered = entries
    .filter((entry) => (entry.lane ?? 'scalping') === 'scalping' && entry.realizedPnl !== 0)
    .sort((left, right) => left.exitAt.localeCompare(right.exitAt));
  const minTrain = Math.max(10, Math.min(25, Math.floor(filtered.length * 0.6)));
  if (filtered.length <= minTrain) {
    return {
      samples: 0,
      accuracyPct: 0,
      precisionAt60Pct: 0,
      coverageAt60Pct: 0,
      avgBrier: 0
    };
  }

  let correct = 0;
  let confident = 0;
  let confidentCorrect = 0;
  let brier = 0;
  let samples = 0;

  for (let index = minTrain; index < filtered.length; index += 1) {
    const train = filtered.slice(0, index);
    const target = filtered[index];
    if (!target) {
      continue;
    }
    const prediction = predictMetaLabel(train, journalToCandidate(target));
    const actual = target.realizedPnl > 0 ? 1 : 0;
    const predicted = prediction.posterior >= 0.5 ? 1 : 0;
    if (predicted === actual) correct += 1;
    if (prediction.posterior >= 0.6) {
      confident += 1;
      if (actual === 1) confidentCorrect += 1;
    }
    brier += (prediction.posterior - actual) ** 2;
    samples += 1;
  }

  return {
    samples,
    accuracyPct: samples > 0 ? round((correct / samples) * 100, 1) : 0,
    precisionAt60Pct: confident > 0 ? round((confidentCorrect / confident) * 100, 1) : 0,
    coverageAt60Pct: samples > 0 ? round((confident / samples) * 100, 1) : 0,
    avgBrier: samples > 0 ? round(brier / samples, 4) : 0
  };
}

function rankTokenEdges(model: ModelState, direction: 'positive' | 'negative'): MetaLabelTokenEdge[] {
  const edges: MetaLabelTokenEdge[] = [];
  for (const [token, stats] of model.tokenStats.entries()) {
    const support = stats.wins + stats.losses;
    if (support < 3) continue;
    const winRate = (stats.wins + 1) / Math.max(stats.wins + stats.losses + 2, 1);
    const edgePct = (winRate - 0.5) * 100;
    if ((direction === 'positive' && edgePct > 0) || (direction === 'negative' && edgePct < 0)) {
      edges.push({ token, edgePct: round(edgePct, 1), support });
    }
  }
  return edges
    .sort((left, right) => direction === 'positive'
      ? right.edgePct - left.edgePct || right.support - left.support
      : left.edgePct - right.edgePct || right.support - left.support)
    .slice(0, 10);
}

export function buildMetaLabelModelSnapshot(
  entries: TradeJournalEntry[],
  candidates: Array<{ agentId: string; candidate: MetaLabelCandidate }>
): MetaLabelModelSnapshot {
  const filtered = entries.filter((entry) => (entry.lane ?? 'scalping') === 'scalping' && entry.realizedPnl !== 0);
  const model = buildModel(filtered);
  return {
    asOf: new Date().toISOString(),
    totalSamples: model.sampleCount,
    winners: model.wins,
    losers: model.losses,
    tokenCount: model.tokenStats.size,
    validation: evaluateWalkForward(filtered),
    topPositiveTokens: rankTokenEdges(model, 'positive'),
    topNegativeTokens: rankTokenEdges(model, 'negative'),
    candidates: candidates.map(({ agentId, candidate }) => {
      const prediction = predictMetaLabel(filtered, candidate);
      return {
        agentId,
        symbol: candidate.symbol,
        assetClass: candidate.assetClass,
        posterior: round(prediction.posterior * 100, 1),
        support: prediction.support,
        sampleCount: prediction.sampleCount,
        matchedTokens: prediction.matchedTokens
      };
    })
  };
}
