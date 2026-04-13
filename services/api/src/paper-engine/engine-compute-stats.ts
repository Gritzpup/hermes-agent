// @ts-nocheck
import type { TradeJournalEntry } from '@hermes/contracts';
import type { AgentState, RegimeKpiRow } from './types.js';
import { average, clamp, pickLast, round } from '../paper-engine-utils.js';
import { getPortfolioRiskSnapshot } from './engine-compute-risk.js';

export function buildRegimeKpis(engine: any): RegimeKpiRow[] {
  const rows = engine.getMetaJournalEntries().slice(-500);
  const grouped = new Map<string, TradeJournalEntry[]>();
  for (const entry of rows) {
    const regime = (entry.regime ?? 'unknown').trim() || 'unknown';
    const key = `${entry.symbol}::${regime}`;
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  const result: RegimeKpiRow[] = [];
  for (const [key, entries] of grouped.entries()) {
    const [symbolRaw, regimeRaw] = key.split('::');
    const symbol = symbolRaw ?? 'UNKNOWN';
    const regime = regimeRaw ?? 'unknown';
    const trades = entries.length;
    const winners = entries.filter((entry: TradeJournalEntry) => entry.realizedPnl > 0);
    const losers = entries.filter((entry: TradeJournalEntry) => entry.realizedPnl < 0);
    const grossWins = winners.reduce((sum: number, entry: TradeJournalEntry) => sum + entry.realizedPnl, 0);
    const grossLosses = Math.abs(losers.reduce((sum: number, entry: TradeJournalEntry) => sum + entry.realizedPnl, 0));
    const winRatePct = trades > 0 ? (winners.length / trades) * 100 : 0;
    const expectancy = trades > 0 ? average(entries.map((entry: TradeJournalEntry) => entry.realizedPnl)) : 0;
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0;
    const throttleMultiplier = trades < 6
      ? 1
      : profitFactor < 0.9 || winRatePct < 42
        ? 0.45
        : profitFactor < 1.05
          ? 0.72
          : 1.05;
    result.push({
      symbol,
      regime,
      trades,
      winRatePct: round(winRatePct, 1),
      expectancy: round(expectancy, 2),
      profitFactor: round(profitFactor, 2),
      throttleMultiplier: round(throttleMultiplier, 2)
    });
  }
  return result.sort((left, right) => right.trades - left.trades).slice(0, 80);
}

export function refreshCapitalAllocation(engine: any): void {
  const contenders = Array.from(engine.agents.values()).filter((agent: AgentState) => 
    agent.config.executionMode === 'broker-paper' && agent.config.autonomyEnabled
  );
  if (contenders.length === 0) {
    return;
  }

  const rawScores = contenders.map((agent: AgentState) => {
    const recent = pickLast(agent.recentOutcomes, 30);
    const wins = recent.filter((value: number) => value > 0).length;
    const losses = recent.filter((value: number) => value < 0).length;
    const posteriorMean = (wins + 1) / Math.max(wins + losses + 2, 1);
    const expectancy = recent.length > 0 ? average(recent) : 0;
    const grossWins = recent.filter((value: number) => value > 0).reduce((sum: number, value: number) => sum + value, 0);
    const grossLosses = Math.abs(recent.filter((value: number) => value < 0).reduce((sum: number, value: number) => sum + value, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 1.5 : 1;
    const symbol = engine.market.get(agent.config.symbol) ?? null;
    const recentJournal = engine.getRecentJournalEntries(agent, symbol, 12);
    const mistakeProfile = engine.buildMistakeProfile(agent, symbol, recentJournal);
    const tapeBonus = symbol && engine.hasTradableTape(symbol) ? 0.08 : -0.12;
    const embargoPenalty = engine.eventCalendar.getEmbargo(agent.config.symbol).blocked ? -0.35 : 0;
    const newsPenalty = engine.newsIntel.getSignal(agent.config.symbol).veto ? -0.25 : 0;
    const intelligence = engine.marketIntel.getCompositeSignal(agent.config.symbol);
    const convictionBonus = intelligence.tradeable ? Math.min(intelligence.confidence / 1000, 0.08) : 0;
    const mistakePenalty = mistakeProfile.dominant === 'clean'
      ? mistakeProfile.sampleCount >= 8 ? 0.02 : 0
      : mistakeProfile.dominant === 'spread-leakage'
        ? clamp(0.08 + mistakeProfile.severity / 1200, 0.08, 0.22)
        : mistakeProfile.dominant === 'premature-exit'
          ? clamp(0.06 + mistakeProfile.severity / 1500, 0.06, 0.18)
          : mistakeProfile.dominant === 'overstay'
            ? clamp(0.07 + mistakeProfile.severity / 1400, 0.07, 0.2)
            : mistakeProfile.dominant === 'noise-chasing'
              ? clamp(0.1 + mistakeProfile.severity / 1100, 0.1, 0.24)
              : clamp(0.14 + mistakeProfile.severity / 900, 0.14, 0.28);
    const score = clamp(
      0.35
        + posteriorMean * 0.4
        + clamp(profitFactor / 4, 0, 0.35)
        + clamp(expectancy / 40, -0.08, 0.08)
        + tapeBonus
        + convictionBonus
        + embargoPenalty
        + newsPenalty
        - mistakePenalty,
      0.2,
      1.8
    );
    return { agent, score, posteriorMean, profitFactor, expectancy, mistakeProfile };
  });

  const meanScore = average(rawScores.map((item: any) => item.score)) || 1;
  for (const item of rawScores) {
    const multiplier = clamp(round(item.score / meanScore, 3), 0.4, 1.6);
    const changed = Math.abs(multiplier - item.agent.allocationMultiplier) >= 0.05;
    item.agent.allocationMultiplier = multiplier;
    item.agent.allocationScore = round(item.score, 3);
    item.agent.allocationReason = `Bandit allocation score ${item.score.toFixed(2)} from posterior ${(item.posteriorMean * 100).toFixed(1)}%, PF ${item.profitFactor.toFixed(2)}, expectancy ${item.expectancy.toFixed(2)}. Mistake loop: ${item.mistakeProfile.summary}`;
    if (changed) {
      engine.recordEvent('allocation-update', {
        agentId: item.agent.config.id,
        symbol: item.agent.config.symbol,
        allocationMultiplier: item.agent.allocationMultiplier,
        allocationScore: item.agent.allocationScore,
        reason: item.agent.allocationReason
      });
    }
  }
}

export function buildDeskAnalytics(engine: any): any {
  const scopedAgents = engine.getDeskAgentStates();
  const analyticsAgents = scopedAgents.filter((agent: AgentState) => agent.evaluationWindow === 'live-market');
  const sourceAgents = analyticsAgents.length > 0 ? analyticsAgents : scopedAgents;
  const recentOutcomes = sourceAgents.flatMap((agent: AgentState) => pickLast(agent.recentOutcomes, 6));
  const recentHolds = sourceAgents.flatMap((agent: AgentState) => pickLast(agent.recentHoldTicks, 6));
  const wins = recentOutcomes.filter((value: number) => value > 0);
  const losses = recentOutcomes.filter((value: number) => value < 0);
  const grossWins = wins.reduce((sum: number, value: number) => sum + value, 0);
  const grossLosses = Math.abs(losses.reduce((sum: number, value: number) => sum + value, 0));
  const totalOpenRisk = Array.from(engine.agents.values()).reduce((sum: number, agent: AgentState) => {
    if (!agent.position) return sum;
    const symbol = engine.market.get(agent.config.symbol);
    const markPrice = symbol?.price ?? agent.position.entryPrice;
    return sum + engine.getPositionUnrealizedPnl(agent.position, markPrice);
  }, 0);
  const avgWinner = wins.length > 0 ? grossWins / wins.length : 0;
  const avgLoser = losses.length > 0 ? grossLosses / losses.length : 0;
  const recentWinRate = recentOutcomes.length > 0 ? (wins.length / recentOutcomes.length) * 100 : 0;

  return {
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0,
    avgWinner: round(avgWinner, 2),
    avgLoser: round(avgLoser, 2),
    avgHoldTicks: round(average(recentHolds), 2),
    recentWinRate: round(recentWinRate, 1),
    totalOpenRisk: round(totalOpenRisk, 2),
    adaptiveMode: 'bounded paper tuning on broker-fed market snapshots',
    verificationNote: 'Firm equity comes from live paper accounts.',
    executionQuality: engine.getExecutionQualityByBroker(),
    portfolioRisk: getPortfolioRiskSnapshot(engine),
    regimeKpis: engine.regimeKpis,
    circuitBreaker: {
      active: engine.circuitBreakerLatched,
      scope: engine.circuitBreakerScope,
      reason: engine.circuitBreakerReason,
      reviewed: engine.circuitBreakerReviewed
    },
    slo: engine.latestSlo,
    walkForward: engine.getWalkForwardSnapshot()
  };
}

export function buildExecutionBands(engine: any): any[] {
  return Array.from(engine.agents.values()).map((agent: AgentState) => {
    const symbol = engine.market.get(agent.config.symbol);
    const currentPrice = symbol?.price ?? agent.position?.entryPrice ?? 0;
    const position = agent.position;
    const unrealizedPnl = position
      ? engine.getPositionUnrealizedPnl(position, currentPrice)
      : 0;
    return {
      agentId: agent.config.id,
      agentName: agent.config.name,
      symbol: agent.config.symbol,
      status: agent.status,
      unrealizedPnl: round(unrealizedPnl, 2),
      entryPrice: position ? round(position.entryPrice, 2) : null,
      currentPrice: round(currentPrice, 2),
      stopPrice: position ? round(position.stopPrice ?? 0, 2) || null : null,
      targetPrice: position ? round(position.targetPrice ?? 0, 2) || null : null,
      lastAction: agent.lastAction ?? ''
    };
  });
}

export function getStrategyTelemetry(engine: any): any[] {
  return Array.from(engine.agents.values()).map((agent: AgentState) => {
    const symbol = engine.market.get(agent.config.symbol);
    const outcomes = (agent.recentOutcomes ?? []).slice(-12);
    const wins = outcomes.filter((v: number) => v > 0);
    const losses = outcomes.filter((v: number) => v < 0);
    const grossWins = wins.reduce((s: number, v: number) => s + v, 0);
    const grossLosses = Math.abs(losses.reduce((s: number, v: number) => s + v, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0;
    const mistakeProfile = agent.lastMistakeProfile;
    return {
      id: agent.config.id,
      agentName: agent.config.name,
      symbol: agent.config.symbol,
      style: agent.config.style,
      status: agent.status,
      profitFactor: round(profitFactor, 2),
      winRate: round((agent.wins / Math.max(agent.trades, 1)) * 100, 1),
      targetBps: round(agent.config.targetBps ?? 0, 2),
      stopBps: round(agent.config.stopBps ?? 0, 2),
      maxHoldTicks: agent.config.maxHoldTicks ?? 0,
      mistakeScore: mistakeProfile?.severity ?? null,
      mistakeTrend: mistakeProfile?.trend ?? 'stable',
      mistakeSummary: mistakeProfile?.summary ?? null,
      allocationMultiplier: round(agent.allocationMultiplier ?? 1.0, 2),
      allocationReason: agent.allocationReason ?? '',
      improvementBias: agent.improvementBias ?? 'neutral',
      lastAdjustment: agent.lastTuningNote ?? agent.lastAction ?? '',
      netPnl: round(agent.realizedPnl - agent.feesPaid, 2),
      activeCooldown: agent.cooldownRemaining
    };
  });
}
