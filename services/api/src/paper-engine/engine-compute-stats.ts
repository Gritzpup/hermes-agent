// @ts-nocheck
import type { TradeJournalEntry, CapitalAllocatorSnapshot } from '@hermes/contracts';
import type { AgentState, RegimeKpiRow } from './types.js';
import { average, clamp, pickLast, round } from '../paper-engine-utils.js';
import { getPortfolioRiskSnapshot } from './engine-compute-risk.js';
import { CapitalManager, REGIME_LANE_MULTIPLIERS } from './capital-manager.js';
import { redis, TOPICS } from '@hermes/infra';

// ─── Regime cache ──────────────────────────────────────────────────────────────
// Capital-manager receives regime via Redis pub/sub so the trading engine
// (engine-compute-stats) stays decoupled from strategy-director.
let _cachedRegime: string = 'unknown';
const _regimeSubscriber = redis.duplicate();
_regimeSubscriber.subscribe(TOPICS.REGIME_UPDATE, (err?: Error | null) => {
  if (err) console.error('[engine-compute-stats] Failed to subscribe to REGIME_UPDATE:', err?.message ?? err);
});
_regimeSubscriber.on('message', (_channel: string, message: string) => {
  try {
    const payload = JSON.parse(message) as { regime?: string };
    if (payload.regime) {
      _cachedRegime = payload.regime;
    }
  } catch {
    // malformed message — keep last known regime
  }
});

/** Returns the current regime, cached from the last REGIME_UPDATE broadcast. */
function _getRegime(): string {
  return _cachedRegime;
}

/**
 * Re-exports REGIME_LANE_MULTIPLIERS so callers (e.g. engine-views lane summaries)
 * can inspect the table without importing capital-manager directly.
 */
export { REGIME_LANE_MULTIPLIERS };

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

export function refreshCapitalAllocation(engine: any, snapshot?: CapitalAllocatorSnapshot): void {
  // Delegate to CapitalManager, which applies regime-aware lane multipliers.
  // The manager reads the current regime from the Redis-cached _cachedRegime
  // (populated by TOPICS.REGIME_UPDATE broadcasts from strategy-director).
  const capitalManager = new CapitalManager({
    state: engine,
    marketIntel: engine.marketIntel,
    newsIntel: engine.newsIntel,
    eventCalendar: engine.eventCalendar,
    hasTradableTape: (symbol: any) => engine.hasTradableTape(symbol),
    getMetaJournalEntries: (limit?: number) => engine.getMetaJournalEntries(limit),
    getRecentJournalEntries: (agent: AgentState, symbol: any, limit?: number) =>
      engine.getRecentJournalEntries(agent, symbol, limit),
    buildMistakeProfile: (agent: AgentState, symbol: any, entries: any[]) =>
      engine.buildMistakeProfile(agent, symbol, entries),
    getRegime: _getRegime,
  });

  capitalManager.refreshAllocation(snapshot);
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
      activeCooldown: agent.cooldownRemaining,
      sizeFractionPct: round((agent.allocationMultiplier ?? 1.0) * 100, 2)
    };
  });
}
