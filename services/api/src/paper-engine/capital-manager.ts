/**
 * Capital Manager Sub-Engine
 *
 * Handles per-agent capital allocation, portfolio risk budgets,
 * desk equity calculation, and circuit breaker logic.
 */

import type { BrokerId, AssetClass } from '@hermes/contracts';
import type {
  AgentState, SymbolState, PerformanceSummary,
  STARTING_EQUITY, DAILY_CIRCUIT_BREAKER_DD_PCT, WEEKLY_CIRCUIT_BREAKER_DD_PCT
} from './types.js';
import { round, average, clamp, pickLast } from '../paper-engine-utils.js';
import type { SharedState } from './shared-state.js';

export interface CapitalManagerDeps {
  state: SharedState;
  marketIntel: any;
  newsIntel: any;
  eventCalendar: any;
  hasTradableTape: (symbol: SymbolState) => boolean;
  getMetaJournalEntries: (limit?: number) => any[];
  getRecentJournalEntries: (agent: AgentState, symbol: SymbolState | null, limit?: number) => any[];
  buildMistakeProfile: (agent: AgentState, symbol: SymbolState | null, entries: any[]) => any;
}

export class CapitalManager {
  constructor(private deps: CapitalManagerDeps) {}

  /** Get desk equity across all brokers */
  getDeskEquity(startingEquity: number): number {
    const state = this.deps.state;
    const alpacaEquity = state.brokerPaperAccount?.equity ?? 0;
    const oandaEquity = state.brokerOandaAccount?.equity ?? 0;
    // Coinbase paper: use simulated equity
    const cbAgents = Array.from(state.agents.values()).filter((a) => a.config.broker === 'coinbase-live');
    const cbPaperPnl = cbAgents.reduce((s, a) => s + a.realizedPnl, 0);
    const coinbaseEquity = startingEquity + cbPaperPnl;
    const brokerTotal = alpacaEquity + oandaEquity + coinbaseEquity;
    if (brokerTotal > startingEquity) return round(brokerTotal, 2);
    return round(Array.from(state.agents.values()).reduce((sum, a) => sum + this.getAgentEquity(a), 0), 2);
  }

  /** Get starting equity across all brokers */
  getDeskStartingEquity(startingEquity: number): number {
    const state = this.deps.state;
    const alpacaBaseline = state.brokerPaperAccount?.dayBaseline ?? 0;
    const oandaBaseline = state.brokerOandaAccount?.dayBaseline ?? 0;
    const coinbaseBaseline = startingEquity;
    const brokerTotal = alpacaBaseline + oandaBaseline + coinbaseBaseline;
    if (brokerTotal > startingEquity) return round(brokerTotal, 2);
    return round(Array.from(state.agents.values()).reduce((sum, a) => sum + a.startingEquity, 0), 2);
  }

  /** Get equity for a single agent */
  getAgentEquity(agent: AgentState): number {
    const position = agent.position;
    if (!position) return agent.cash;
    const symbol = this.deps.state.market.get(agent.config.symbol);
    const markPrice = symbol?.price ?? position.entryPrice;
    const unrealized = position.direction === 'short'
      ? (position.entryPrice - markPrice) * position.quantity
      : (markPrice - position.entryPrice) * position.quantity;
    return agent.cash + (position.entryPrice * position.quantity) + unrealized;
  }

  /** Refresh per-agent capital allocation using bandit scoring */
  refreshAllocation(): void {
    const state = this.deps.state;
    const contenders = Array.from(state.agents.values()).filter(
      (a) => a.config.executionMode === 'broker-paper' && a.config.autonomyEnabled
    );
    if (contenders.length === 0) return;

    const rawScores = contenders.map((agent) => {
      const recent = pickLast(agent.recentOutcomes, 30);
      const wins = recent.filter((v) => v > 0).length;
      const losses = recent.filter((v) => v < 0).length;
      const posteriorMean = (wins + 1) / Math.max(wins + losses + 2, 1);
      const expectancy = recent.length > 0 ? average(recent) : 0;
      const grossWins = recent.filter((v) => v > 0).reduce((s, v) => s + v, 0);
      const grossLosses = Math.abs(recent.filter((v) => v < 0).reduce((s, v) => s + v, 0));
      const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 1.5 : 1;
      const symbol = state.market.get(agent.config.symbol) ?? null;
      const tapeBonus = symbol && this.deps.hasTradableTape(symbol) ? 0.08 : -0.12;
      const embargoPenalty = this.deps.eventCalendar.getEmbargo(agent.config.symbol).blocked ? -0.35 : 0;
      const newsPenalty = this.deps.newsIntel.getSignal(agent.config.symbol).veto ? -0.25 : 0;
      const intelligence = this.deps.marketIntel.getCompositeSignal(agent.config.symbol);
      const convictionBonus = intelligence.tradeable ? Math.min(intelligence.confidence / 1000, 0.08) : 0;

      const score = clamp(
        0.35 + posteriorMean * 0.4 + clamp(profitFactor / 4, 0, 0.35)
          + clamp(expectancy / 40, -0.08, 0.08) + tapeBonus + convictionBonus + embargoPenalty + newsPenalty,
        0.2, 1.8
      );
      return { agent, score, posteriorMean, profitFactor, expectancy };
    });

    const meanScore = average(rawScores.map((item) => item.score)) || 1;
    for (const item of rawScores) {
      const multiplier = clamp(round(item.score / meanScore, 3), 0.4, 1.6);
      item.agent.allocationMultiplier = multiplier;
      item.agent.allocationScore = round(item.score, 3);
      item.agent.allocationReason = `Bandit score ${item.score.toFixed(2)} from posterior ${(item.posteriorMean * 100).toFixed(1)}%, PF ${item.profitFactor.toFixed(2)}.`;
    }
  }

  /** Check portfolio circuit breaker */
  evaluateCircuitBreaker(startingEquity: number, dailyDdPct: number, weeklyDdPct: number): void {
    const state = this.deps.state;
    if (state.circuitBreakerLatched) return;

    const equity = this.getDeskEquity(startingEquity);
    const startEq = this.getDeskStartingEquity(startingEquity);
    if (startEq <= 0) return;

    const dailyDd = ((startEq - equity) / startEq) * 100;
    if (dailyDd >= dailyDdPct) {
      state.circuitBreakerLatched = true;
      state.circuitBreakerScope = 'daily';
      state.circuitBreakerReason = `Daily drawdown ${dailyDd.toFixed(2)}% exceeds ${dailyDdPct}% limit.`;
      state.circuitBreakerArmedAt = new Date().toISOString();
      console.log(`[CIRCUIT BREAKER] ${state.circuitBreakerReason}`);
    }
  }
}
