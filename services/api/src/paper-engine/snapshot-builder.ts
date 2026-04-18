/**
 * Snapshot Builder Sub-Engine
 *
 * Builds read-only snapshots of engine state for the API and dashboard.
 * All methods are pure reads — no mutations.
 */

import type {
  AgentFillEvent, MarketSnapshot, PositionSnapshot, TradeJournalEntry,
  PaperDeskSnapshot, PaperAgentSnapshot
} from '@hermes/contracts';
import { QUARANTINED_EXIT_REASONS } from '@hermes/contracts';
import type {
  AgentState, AgentConfig, SymbolState, PositionState, PositionDirection,
  HISTORY_LIMIT, STARTING_EQUITY, TICK_MS
} from './types.js';
import { round, formatAgo } from '../paper-engine-utils.js';
import type { SharedState } from './shared-state.js';

export class SnapshotBuilder {
  constructor(private state: SharedState) {}

  /** Get all market snapshots */
  getMarketSnapshots(): MarketSnapshot[] {
    return Array.from(this.state.market.values()).map((symbol) => ({
      symbol: symbol.symbol,
      broker: symbol.broker,
      assetClass: symbol.assetClass,
      lastPrice: round(symbol.price, 2),
      changePct: symbol.openPrice > 0 ? ((symbol.price - symbol.openPrice) / symbol.openPrice) * 100 : 0,
      volume: Math.round(symbol.volume),
      spreadBps: round(symbol.spreadBps, 2),
      liquidityScore: Math.round(symbol.liquidityScore),
      status: symbol.marketStatus,
      source: symbol.sourceMode,
      session: symbol.session,
      tradable: symbol.tradable,
      qualityFlags: [...symbol.qualityFlags],
      updatedAt: symbol.updatedAt
    }));
  }

  /** Get the journal (all entries including quarantined — use getAnalyticsJournal for KPIs) */
  getJournal(): TradeJournalEntry[] {
    return [...this.state.journal];
  }

  /** Get journal entries for analytics — quarantined entries excluded */
  getAnalyticsJournal(): TradeJournalEntry[] {
    return this.state.journal.filter(
      (entry) => !entry.exitReason || !QUARANTINED_EXIT_REASONS.has(entry.exitReason)
    );
  }

  /** Get visible fills for dashboard */
  getVisibleFills(deskAgentIds: Set<string>): AgentFillEvent[] {
    return this.state.fills.filter((fill) => deskAgentIds.has(fill.agentId));
  }

  /** Convert agent to snapshot for API */
  toAgentSnapshot(agent: AgentState, tick: number, market: Map<string, SymbolState>): PaperAgentSnapshot {
    const symbol = market.get(agent.config.symbol);
    const markPrice = symbol?.price ?? 0;
    const unrealizedPnl = agent.position
      ? this.computeUnrealizedPnl(agent.position, markPrice)
      : 0;

    return {
      id: agent.config.id,
      name: agent.config.name,
      symbol: agent.config.symbol,
      broker: agent.config.broker,
      style: agent.config.style,
      executionMode: agent.config.executionMode,
      status: agent.status,
      startingEquity: agent.startingEquity,
      realizedPnl: round(agent.realizedPnl, 2),
      unrealizedPnl: round(unrealizedPnl, 2),
      feesPaid: round(agent.feesPaid, 4),
      totalTrades: agent.trades,
      winRate: agent.trades > 0 ? (agent.wins / agent.trades) * 100 : 0,
      lastAction: agent.lastAction,
      lastSymbol: agent.lastSymbol,
      lastAdjustment: agent.lastAdjustment,
      allocationMultiplier: round(agent.allocationMultiplier, 2),
      allocationScore: round(agent.allocationScore, 2),
      config: { ...agent.config }
    } as unknown as PaperAgentSnapshot;
  }

  private computeUnrealizedPnl(position: PositionState, markPrice: number): number {
    const direction = position.direction ?? 'long';
    return direction === 'short'
      ? (position.entryPrice - markPrice) * position.quantity
      : (markPrice - position.entryPrice) * position.quantity;
  }
}
