/**
 * Trade Executor Sub-Engine
 *
 * Handles opening and closing positions — both broker-routed and locally simulated.
 * Manages the full lifecycle: entry sizing → order submission → fill processing → journal recording.
 */
import { randomUUID } from 'node:crypto';
import { BROKER_ROUTER_URL, FILL_LIMIT, OUTCOME_HISTORY_LIMIT, COINBASE_LIVE_ROUTING_ENABLED } from './types.js';
import { round } from '../paper-engine-utils.js';
import { getFeeRate } from './scoring.js';
import { computeDynamicStop, computeDynamicTarget, entryNote, estimatedBrokerRoundTripCostBps } from './exit-logic.js';
import { computeHalfKelly, countConsecutiveLosses, computeAdaptiveCooldown } from './sizing.js';
import { computeFngSizeMultiplier, computeStreakMultiplier } from './sizing.js';
import { pushPoint } from './helpers.js';
// FIX #2: OANDA per-trade notional cap — 1% of account equity, default fallback $100k base
const OANDA_NOTIONAL_CAP_PCT = 0.005; // COO: 0.5% of equity per trade (was 1%) — 92.9% WR but -$467 PnL means wins are tiny vs losses. Halve to preserve capital.
const OANDA_DEFAULT_EQUITY = 100_000;
/** Derive lane from agent config id (same logic as engine-views.ts classifyLane) */
function classifyLane(strategyId) {
    if (!strategyId)
        return 'scalping';
    if (strategyId.startsWith('maker-'))
        return 'maker';
    if (strategyId.startsWith('grid-'))
        return 'grid';
    if (strategyId.startsWith('pairs-'))
        return 'pairs';
    return 'scalping';
}
export class TradeExecutor {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /** Check if this broker should simulate fills locally */
    shouldSimulateLocally(broker) {
        return broker === 'coinbase-live';
    }
    /** Open a simulated local position (Coinbase paper) */
    openSimulatedPosition(agent, symbol, score, direction, entryMeta, quantity, notional) {
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
    closeSimulatedPosition(agent, symbol, reason) {
        const position = agent.position;
        if (!position)
            return;
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
        if (pnl > 0)
            agent.wins += 1;
        agent.trades += 1;
        pushPoint(agent.recentOutcomes, round(pnl, 2), 200);
        pushPoint(agent.recentHoldTicks, this.deps.state.tick - position.entryTick, 200);
        this.deps.checkSymbolKillswitch(agent);
        agent.position = null;
        agent.cooldownRemaining = computeAdaptiveCooldown(agent.config.cooldownTicks, agent.lastExitPnl, agent.recentOutcomes, agent.config.style, this.deps.marketIntel.getFearGreedValue());
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
    calculateNotional(agent, symbol, entryMeta) {
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
        // FIX #1: halve scalper notional — scalp lane bleeds at 63% WR, fees eat edge
        const scalperNotionalMult = classifyLane(agent.config.id) === 'scalping' ? 0.5 : 1.0;
        const sizedFraction = baseFraction
            * agent.allocationMultiplier
            * convictionMultiplier
            * streakMultiplier
            * executionMultiplier
            * regimeMultiplier
            * calibrationMultiplier
            * edgeConfidenceMultiplier
            * fngMultiplier
            * scalperNotionalMult;
        // FIX #2: OANDA hard cap — 1% of oandaEquity (default fallback $1,000)
        let notional = Math.min(this.deps.getAgentEquity(agent) * sizedFraction, agent.cash * 0.9);
        if (agent.config.broker === 'oanda-rest') {
            const oandaEquity = this.deps.state.brokerOandaAccount?.equity ?? OANDA_DEFAULT_EQUITY;
            const oandaCap = oandaEquity * OANDA_NOTIONAL_CAP_PCT;
            notional = Math.min(notional, oandaCap);
        }
        const maxNotional = agent.startingEquity * 0.02;
        notional = Math.min(notional, maxNotional);
        if (notional > 0 && notional < 50)
            console.warn('[trade-executor] tiny notional', agent.config.id, 'notional:', notional);
        return Math.max(0, notional);
    }
}
