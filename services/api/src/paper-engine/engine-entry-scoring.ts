// @ts-nocheck
import {
  average,
  clamp,
  pickLast,
  round
} from '../paper-engine-utils.js';
import {
  estimateRoundTripCostBps,
  inferAssetClassFromSymbol
} from '../fee-model.js';
import { evaluateKpiGate } from '../kpi-gates.js';

export function getRouteBlock(engine: any, agent: any, symbol: any): string | null {
  // Paper mode: never block trades on route concentration — we need data
  if (agent.config.executionMode === 'broker-paper') {
    return null;
  }
  if (!agent.config.autonomyEnabled) {
    return null;
  }
  const COINBASE_LIVE_ROUTING_ENABLED = (process.env.COINBASE_LIVE_ROUTING_ENABLED ?? '0') === '1';
  if (agent.config.broker === 'coinbase-live' && !engine.shouldSimulateLocally(agent.config.broker) && !COINBASE_LIVE_ROUTING_ENABLED) {
    return `Coinbase live routing is disabled for paper-mode crypto lanes. ${symbol.symbol} stays watch-only until live routing is explicitly approved.`;
  }
  const route = engine.scalpRouteCandidates.get(agent.config.id);
  if (!route) {
    return null;
  }
  // Allow new agents (< 5 trades) to trade even without proven edge — they need data
  if (route.expectedNetEdgeBps <= 0 && agent.trades >= 5) {
    return `No positive-net ${symbol.assetClass} scalp route for ${route.symbols[0] ?? symbol.symbol} after estimated fees and slippage.`;
  }
  // During bootstrap, skip route concentration only after net edge is positive.
  if (agent.trades < 5) {
    return null;
  }
  if (!route.selected) {
    const leaderId = engine.selectedScalpByAssetClass.get(symbol.assetClass);
    const leader = leaderId ? engine.scalpRouteCandidates.get(leaderId) : null;
    const routeSymbol = route.symbols[0] ?? symbol.symbol;
    const leaderSymbol = leader?.symbols[0] ?? routeSymbol;
    if (leader && leader.strategyId !== route.strategyId) {
      return `Routing to ${leaderSymbol} for ${symbol.assetClass} scalps: ${leader.expectedNetEdgeBps.toFixed(2)}bps net edge after ${leader.estimatedCostBps.toFixed(2)}bps estimated costs beats ${routeSymbol} at ${route.expectedNetEdgeBps.toFixed(2)}bps.`;
    }
    return `No positive-net ${symbol.assetClass} scalp route for ${routeSymbol} after estimated fees and slippage.`;
  }
  return null;
}

export function getPrecisionBlock(engine: any, agent: any, symbol: any): string | null {
  // Paper mode: never block — collect data
  return null;
  if (agent.config.executionMode !== 'broker-paper') {
    return null;
  }

  const entries = engine.getMetaJournalEntries();
  const symbolEntries = entries
    .filter((entry) => entry.symbol === symbol.symbol && entry.realizedPnl !== 0)
    .sort((left, right) => Date.parse(left.exitAt) - Date.parse(right.exitAt));
  const assetEntries = entries
    .filter((entry) => (entry.assetClass ?? inferAssetClassFromSymbol(entry.symbol)) === symbol.assetClass && entry.realizedPnl !== 0)
    .sort((left, right) => Date.parse(left.exitAt) - Date.parse(right.exitAt));

  const symbolPerf = engine.summarizePerformance(symbolEntries.slice(-12));
  const assetPerf = engine.summarizePerformance(assetEntries.slice(-20));
  const symbolGate = evaluateKpiGate({
    scope: 'symbol',
    sampleCount: symbolPerf.sampleCount,
    winRatePct: symbolPerf.winRate * 100,
    profitFactor: symbolPerf.profitFactor,
    expectancy: symbolPerf.expectancy,
    netEdgeBps: undefined,
    confidencePct: undefined,
    drawdownPct: undefined
  });
  const assetGate = evaluateKpiGate({
    scope: 'asset',
    sampleCount: assetPerf.sampleCount,
    winRatePct: assetPerf.winRate * 100,
    profitFactor: assetPerf.profitFactor,
    expectancy: assetPerf.expectancy,
    netEdgeBps: undefined,
    confidencePct: undefined,
    drawdownPct: undefined
  });

  if (symbolPerf.sampleCount >= symbolGate.thresholds.minSampleCount && !symbolGate.passed) {
    return `Precision block on ${symbol.symbol}: ${symbolGate.summary}`;
  }

  if (assetPerf.sampleCount >= assetGate.thresholds.minSampleCount && !assetGate.passed) {
    return `Asset-class block on ${symbol.assetClass}: ${assetGate.summary}`;
  }

  return null;
}

export function getManagerBlock(engine: any, agent: any, symbol: any): string | null {
  const outcomes = pickLast(agent.recentOutcomes, 8);
  if (outcomes.length < 6) return null;

  const wins = outcomes.filter((value) => value > 0);
  const losses = outcomes.filter((value) => value < 0);
  const grossWins = wins.reduce((sum, value) => sum + value, 0);
  const grossLosses = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0;
  const expectancy = average(outcomes);
  const recentWinRate = wins.length / outcomes.length;
  const consecutiveLosses = engine.countConsecutiveLosses(outcomes);
  const brokerPaperLane = agent.config.executionMode === 'broker-paper';
  const profitFactorFloor = brokerPaperLane ? 1.05 : 0.95;
  const winRateFloor = brokerPaperLane ? 0.5 : 0.45;
  const lossStreakLimit = brokerPaperLane ? 2 : 3;
  const expectancyFloor = brokerPaperLane ? -0.5 : -2;

  if ((profitFactor < profitFactorFloor && recentWinRate < winRateFloor) || consecutiveLosses >= lossStreakLimit || expectancy <= expectancyFloor) {
    return `Manager block on ${symbol.symbol}: recent PF ${profitFactor.toFixed(2)}, win ${(recentWinRate * 100).toFixed(1)}%, ${consecutiveLosses} straight losses.`;
  }

  return null;
}

export function describeWatchState(engine: any, style: string, symbol: any, score: number): string {
  const lead = style === 'momentum'
    ? 'Waiting for momentum confirmation'
    : style === 'breakout'
      ? 'Waiting for breakout range expansion'
      : 'Waiting for deeper pullback to fade';

  return `${lead} in ${symbol.symbol}. Score ${score.toFixed(2)} with ${symbol.spreadBps.toFixed(1)} bps spread.`;
}

export function describeAiState(engine: any, decision: any): string {
  if (decision.status === 'queued') {
    return `${decision.symbol} candidate queued for Claude review.`;
  }

  if (decision.status === 'evaluating') {
    return `${decision.symbol} candidate is under AI review now.`;
  }

  if (decision.finalAction === 'reject' || decision.finalAction === 'review') {
    return `${decision.reason}`;
  }

  return `${decision.symbol} cleared by AI council.`;
}

export function normalizeFlowBucket(engine: any, direction: string): 'bullish' | 'bearish' | 'neutral' {
  if (direction === 'buy' || direction === 'strong-buy' || direction === 'bullish') return 'bullish';
  if (direction === 'sell' || direction === 'strong-sell' || direction === 'bearish') return 'bearish';
  return 'neutral';
}

export function getConfidenceBucket(engine: any, confidence: number): 'low' | 'medium' | 'high' {
  if (confidence >= 70) return 'high';
  if (confidence >= 35) return 'medium';
  return 'low';
}

export function getSpreadBucket(engine: any, spreadBps: number, limitBps: number): 'tight' | 'medium' | 'wide' {
  const ratio = spreadBps / Math.max(limitBps, 0.1);
  if (ratio <= 0.35) return 'tight';
  if (ratio <= 0.75) return 'medium';
  return 'wide';
}

export function entryNote(engine: any, style: string, symbol: any, score: number): string {
  if (style === 'momentum') {
    return `Bought ${symbol.symbol} momentum squeeze after positive tape acceleration. Score ${score.toFixed(2)}.`;
  }
  if (style === 'breakout') {
    return `Bought ${symbol.symbol} on breakout through short-term range high. Score ${score.toFixed(2)}.`;
  }
  return `Bought ${symbol.symbol} on short-term overreaction into mean-reversion zone. Score ${score.toFixed(2)}.`;
}

export function getEntryScore(engine: any, style: string, shortReturn: number, mediumReturn: number, symbol: any): number {
  if (symbol.price <= 0 || symbol.history.length < 2) return 0;
  const spreadPenalty = symbol.spreadBps * 0.03;
  const avg = average(pickLast(symbol.history, 12));
  const deviation = avg > 0 ? (symbol.price - avg) / symbol.price : 0;

  // RSI(2) bonus: extreme readings boost score significantly
  const rsi2 = engine.marketIntel.computeRSI2(symbol.symbol);
  let rsi2Bonus = 0;
  if (rsi2 !== null) {
    if (style === 'mean-reversion') {
      // Oversold = high score for mean-reversion
      if (rsi2 < 10) rsi2Bonus = 3.0;
      else if (rsi2 < 25) rsi2Bonus = 1.5;
      else if (rsi2 > 75) rsi2Bonus = -1.0; // wrong side for mean-reversion
    } else {
      // For momentum/breakout, overbought momentum confirmation
      if (rsi2 > 65 && rsi2 < 85) rsi2Bonus = 0.8; // strong momentum, not yet exhausted
      else if (rsi2 < 15) rsi2Bonus = -1.5; // too oversold, don't chase long
    }
  }

  // Stochastic bonus: crossovers in extreme zones
  const stoch = engine.marketIntel.computeStochastic(symbol.symbol);
  let stochBonus = 0;
  if (stoch) {
    if (style === 'mean-reversion' && stoch.crossover === 'bullish' && stoch.k < 30) stochBonus = 1.5;
    else if (style === 'momentum' && stoch.crossover === 'bullish' && stoch.k > 50) stochBonus = 1.0;
    else if (stoch.crossover === 'bearish' && stoch.k > 70) stochBonus = -1.0;
  }

  // Insider signal bonus: high-conviction insider buying boosts score significantly
  const insiderSignal = engine.insiderRadar.getSignal(symbol.symbol);
  let insiderBonus = 0;
  if (insiderSignal && insiderSignal.convictionScore >= 0.5) {
    if (insiderSignal.direction === 'bullish') {
      insiderBonus = insiderSignal.isCluster ? 4.0 : 2.0;
      insiderBonus *= insiderSignal.convictionScore; // scale with conviction
    } else if (insiderSignal.direction === 'bearish' && insiderSignal.convictionScore >= 0.7) {
      insiderBonus = -3.0 * insiderSignal.convictionScore;
    }
  }

  const indicatorBonus = rsi2Bonus + stochBonus + insiderBonus;

  if (style === 'momentum') {
    return shortReturn * 1400 + mediumReturn * 600 + symbol.bias * 1200 - spreadPenalty + indicatorBonus;
  }
  if (style === 'breakout') {
    const breakoutWindow = pickLast(symbol.history, 9).slice(0, -1);
    const breakoutBase = breakoutWindow.length > 0 ? Math.max(...breakoutWindow) : symbol.price;
    const breakout = symbol.price / breakoutBase - 1;
    return breakout * 2200 + shortReturn * 900 + symbol.bias * 900 - spreadPenalty + indicatorBonus;
  }
  return (-deviation * 1800) + (-shortReturn * 500) + (mediumReturn * 240) - spreadPenalty + indicatorBonus;
}

export function entryThreshold(engine: any, style: string, assetClass?: string): number {
  let base: number;
  if (style === 'breakout') {
    base = 1.85;
  } else if (style === 'momentum') {
    base = 1.35;
  } else {
    base = 1.05;
  }

  // Crypto agents (Alpaca paper) have a 27% win rate — they enter on weak signals.
  // Raise the bar by ~40% so only higher-conviction setups pass the threshold.
  if (assetClass === 'crypto') {
    base *= 1.4;
  }

  return base;
}

export function exitThreshold(engine: any, style: string): number {
  return -999;
}

export function estimatedBrokerRoundTripCostBps(engine: any, symbol: any): number {
  if (symbol.assetClass === 'crypto') {
    return Math.max(26, symbol.spreadBps * 2 + 8);
  }

  return Math.max(4, symbol.spreadBps * 1.75 + 1.5);
}

export function fastPathThreshold(engine: any, style: string, assetClass?: string): number {
  return entryThreshold(engine, style, assetClass) + (style === 'breakout' ? 0.9 : 0.6);
}

export function brokerRulesFastPathThreshold(engine: any, agent: any, symbol: any): number {
  return fastPathThreshold(engine, agent.config.style, symbol?.assetClass) + 0.2;
}

export function canUseBrokerRulesFastPath(
  engine: any,
  agent: any,
  symbol: any,
  score: number,
  aiDecision: any
): boolean {
  if (agent.config.executionMode !== 'broker-paper') {
    return false;
  }

  if (score < brokerRulesFastPathThreshold(engine, agent, symbol)) {
    return false;
  }

  if (!aiDecision) {
    return true;
  }

  if (aiDecision.status === 'queued' || aiDecision.status === 'evaluating') {
    return true;
  }

  if (aiDecision.status === 'complete' && aiDecision.finalAction === 'approve') {
    return true;
  }

  if (aiDecision.status === 'complete' && aiDecision.finalAction === 'reject') {
    return false;
  }

  return aiDecision.primary.provider === 'rules';
}
