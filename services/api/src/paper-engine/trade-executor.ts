/**
 * Trade Executor Sub-Engine
 *
 * Handles opening and closing positions — both broker-routed and locally simulated.
 * Manages the full lifecycle: entry sizing → order submission → fill processing → journal recording.
 */

import { randomUUID } from 'node:crypto';
import type { AgentFillEvent, TradeJournalEntry, BrokerId, AssetClass } from '@hermes/contracts';
import type {
  AgentState, SymbolState, PositionState, PositionDirection,
  PositionEntryMetaState, BrokerRouteResponse, AgentConfig,
  BROKER_ROUTER_URL, FILL_LIMIT, OUTCOME_HISTORY_LIMIT, COINBASE_LIVE_ROUTING_ENABLED
} from './types.js';
import { round } from '../paper-engine-utils.js';
import { getFeeRate } from './scoring.js';
import { computeDynamicStop, computeDynamicTarget, entryNote, estimatedBrokerRoundTripCostBps } from './exit-logic.js';
import { computeHalfKelly, countConsecutiveLosses, computeAdaptiveCooldown } from './sizing.js';
import { computeFngSizeMultiplier, computeStreakMultiplier } from './sizing.js';
import { pushPoint } from './helpers.js';
import type { SharedState } from './shared-state.js';

export interface TradeExecutorDeps {
  state: SharedState;
  marketIntel: any;
  aiCouncil: any;
  insiderRadar: any;
  derivativesIntel: any;
  newsIntel: any;
  eventCalendar: any;
  recordFill: (params: any) => void;
  recordJournal: (entry: TradeJournalEntry) => void;
  recordEvent: (type: string, payload: Record<string, unknown>) => void;
  persistStateSnapshot: () => void;
  getAgentEquity: (agent: AgentState) => number;
  getMetaLabelDecision: (agent: AgentState, symbol: SymbolState, score: number, intel: any) => any;
  buildJournalContext: (symbol: SymbolState) => any;
  getPositionDirection: (position: PositionState | null | undefined) => PositionDirection;
  getRegimeThrottleMultiplier: (symbol: SymbolState) => number;
  computeConfidenceCalibrationMultiplier: (agent: AgentState) => number;
  getExecutionQualityMultiplier: (broker: BrokerId) => number;
  checkSymbolKillswitch: (agent: AgentState) => void;
}

export class TradeExecutor {
  constructor(private deps: TradeExecutorDeps) {}

  /** Check if this broker should simulate fills locally */
  shouldSimulateLocally(broker: BrokerId): boolean {
    return broker === 'coinbase-live';
  }

  /** Open a simulated local position (Coinbase paper) */
  openSimulatedPosition(
    agent: AgentState,
    symbol: SymbolState,
    score: number,
    direction: PositionDirection,
    entryMeta: PositionEntryMetaState,
    quantity: number,
    notional: number
  ): void {
    const fillPrice = direction === 'short'
      ? symbol.price * (1 - (symbol.spreadBps / 10_000) * 0.25)
      : symbol.price * (1 + (symbol.spreadBps / 10_000) * 0.25);
    const entryFees = quantity * fillPrice * getFeeRate(symbol.assetClass);
    agent.cash -= (notional + entryFees);
    agent.realizedPnl -= entryFees;
    agent.feesPaid = round(agent.feesPaid + entryFees, 4);

    const atr = this.deps.marketIntel.computeATR(symbol.symbol);
    agent.position = {
      direction,
      quantity,
      entryPrice: fillPrice,
      entryTick: this.deps.state.tick,
      entryAt: new Date().toISOString(),
      stopPrice: computeDynamicStop(fillPrice, agent.config.stopBps, direction, symbol.assetClass, atr),
      targetPrice: computeDynamicTarget(fillPrice, agent.config.targetBps, direction, symbol.assetClass, atr),
      peakPrice: fillPrice,
      note: entryNote(agent.config.style, symbol, score),
      entryMeta
    };
    agent.status = 'in-trade';
    agent.lastSymbol = symbol.symbol;
    agent.lastAction = `Paper sim ${direction} ${symbol.symbol} at ${round(fillPrice, 2)} (local sim).`;

    this.deps.recordFill({
      agent, symbol,
      orderId: `sim-${agent.config.id}-${direction === 'short' ? 'sell' : 'buy'}-${Date.now()}`,
      side: direction === 'short' ? 'sell' : 'buy',
      status: 'filled',
      price: fillPrice,
      pnlImpact: 0,
      note: `Paper sim entry at ${round(fillPrice, 2)}.`,
      source: 'simulated'
    });
    this.deps.persistStateSnapshot();
  }

  /** Close a simulated local position */
  closeSimulatedPosition(agent: AgentState, symbol: SymbolState, reason: string): void {
    const position = agent.position;
    if (!position) return;

    const direction = this.deps.getPositionDirection(position);
    const exitPrice = direction === 'short'
      ? symbol.price * (1 + (symbol.spreadBps / 10_000) * 0.25)
      : symbol.price * (1 - (symbol.spreadBps / 10_000) * 0.25);
    const proceeds = position.quantity * exitPrice;
    const exitFees = proceeds * getFeeRate(symbol.assetClass);
    const grossPnl = direction === 'short'
      ? (position.entryPrice - exitPrice) * position.quantity
      : (exitPrice - position.entryPrice) * position.quantity;
    const pnl = grossPnl - exitFees;

    agent.cash += (proceeds - exitFees);
    agent.realizedPnl += pnl;
    agent.feesPaid = round(agent.feesPaid + exitFees, 4);
    agent.lastExitPnl = pnl;
    if (pnl > 0) agent.wins += 1;
    agent.trades += 1;

    pushPoint(agent.recentOutcomes, round(pnl, 2), 200);
    pushPoint(agent.recentHoldTicks, this.deps.state.tick - position.entryTick, 200);
    this.deps.checkSymbolKillswitch(agent);

    agent.position = null;
    agent.cooldownRemaining = computeAdaptiveCooldown(
      agent.config.cooldownTicks, agent.lastExitPnl,
      agent.recentOutcomes, agent.config.style,
      this.deps.marketIntel.getFearGreedValue()
    );
    agent.status = 'cooldown';
    agent.lastAction = `Paper sim exit ${symbol.symbol} at ${round(exitPrice, 2)} (${reason}). PnL ${pnl >= 0 ? '+' : ''}${round(pnl, 2)}.`;

    this.deps.recordFill({
      agent, symbol,
      orderId: `sim-${agent.config.id}-${direction === 'short' ? 'buy' : 'sell'}-${Date.now()}`,
      side: direction === 'short' ? 'buy' : 'sell',
      status: 'filled',
      price: exitPrice,
      pnlImpact: round(pnl, 4),
      note: `Paper sim exit at ${round(exitPrice, 2)}. ${reason}`,
      source: 'simulated'
    });
    this.deps.persistStateSnapshot();
  }

  /** Calculate position size for a broker paper entry */
  calculateNotional(agent: AgentState, symbol: SymbolState, entryMeta: PositionEntryMetaState): number {
    const kellyFraction = computeHalfKelly(agent.recentOutcomes ?? []);
    const baseFraction = kellyFraction > 0 ? Math.min(kellyFraction, agent.config.sizeFraction * 2) : agent.config.sizeFraction;

    const intel = this.deps.marketIntel.getCompositeSignal(symbol.symbol);
    const convictionMultiplier = intel.confidence >= 60 ? 1.3 : intel.confidence >= 40 ? 1.0 : 0.7;
    const fng = this.deps.marketIntel.getFearGreedValue();
    const consecutiveLosses = countConsecutiveLosses(agent.recentOutcomes ?? []);
    const streakMultiplier = computeStreakMultiplier(consecutiveLosses, agent.config.style, fng);
    const executionMultiplier = this.deps.getExecutionQualityMultiplier(agent.config.broker);
    const fngMultiplier = computeFngSizeMultiplier(agent.config.style, symbol.assetClass, fng);
    const regimeMultiplier = this.deps.getRegimeThrottleMultiplier(symbol);
    const calibrationMultiplier = this.deps.computeConfidenceCalibrationMultiplier(agent);
    const edgeConfidenceMultiplier = Math.max(0.55, Math.min(1.35, (entryMeta.trainedProbability / 100) * 1.4));

    const sizedFraction = baseFraction
      * agent.allocationMultiplier
      * convictionMultiplier
      * streakMultiplier
      * executionMultiplier
      * regimeMultiplier
      * calibrationMultiplier
      * edgeConfidenceMultiplier
      * fngMultiplier;

    return Math.min(this.deps.getAgentEquity(agent) * sizedFraction, agent.cash * 0.9);
  }
}
