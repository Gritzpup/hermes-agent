// @ts-nocheck
/**
 * Engine Broker Execution Sub-Module
 *
 * Position opening, closing, fill processing, and broker order routing.
 * Split from engine-broker.ts for maintainability.
 */
import { randomUUID } from 'node:crypto';
import { clamp, round } from '../paper-engine-utils.js';
import { redis, TOPICS } from '@hermes/infra';
import { logger } from '@hermes/logger';
import { BROKER_ROUTER_URL, OUTCOME_HISTORY_LIMIT, } from './types.js';
import { getLiveCapitalSafety, recordLiveRoundTrip, isLiveRollbackActive } from './live-capital-safety.js';
// ── Dedupe: journaled flatten keys (Phase B fix — suppresses duplicate journal entries
//    when a position takes multiple reconcile ticks to fully null).  Bound at 5000 entries
//    to avoid unbounded memory growth; oldest 1000 are evicted when the limit is exceeded. ──
const journaledFlatKeys = new Set();
// ── Live-capital safety helpers ──────────────────────────────────────
/** Returns paper-engine's theoretical fill price for a symbol (same formula as openSimulatedPosition) */
function paperTheoreticalPrice(symbol, direction, filledQty) {
    const side = direction === 'short' ? 'sell' : 'buy';
    return side === 'sell'
        ? symbol.price * (1 - (symbol.spreadBps / 10_000) * 0.25)
        : symbol.price * (1 + (symbol.spreadBps / 10_000) * 0.25);
}
/** Returns pct delta between live fill and paper-theoretical price */
function liveVsPaperDeltaPct(livePrice, paperPrice) {
    if (!paperPrice || paperPrice === 0)
        return 0;
    return ((livePrice - paperPrice) / paperPrice) * 100;
}
/** After each live coinbase fill, record to safety module and handle any halt */
async function handleLiveFillSafety(engine, agent, symbol, report, direction, realized) {
    if (agent.config.broker !== 'coinbase-live')
        return;
    if (process.env.COINBASE_LIVE_ROUTING_ENABLED !== '1')
        return;
    const safety = getLiveCapitalSafety();
    if (!safety.isLiveActive())
        return;
    // Compute live-vs-paper divergence delta
    const livePrice = report.avgFillPrice ?? symbol.price;
    const pPaper = paperTheoreticalPrice(symbol, direction, report.filledQty ?? 0);
    const deltaPct = liveVsPaperDeltaPct(livePrice, pPaper);
    const fill = {
        symbol: symbol.symbol,
        pnl: realized ?? 0,
        liveVsPaperDelta: deltaPct,
        timestamp: Date.now()
    };
    safety.recordLiveFill(fill);
    // Canary auto-rollback: record round-trip PnL on exit fills
    // Only record when direction indicates a closing trade (pnl is realized)
    if (realized !== undefined && realized !== null) {
        recordLiveRoundTrip(realized);
    }
    // Check divergence / drawdown / loss caps
    const verdict = safety.checkDivergence();
    if (verdict.halt) {
        console.warn(`[live-safety] HALT TRIGGERED — flattening all live Coinbase positions | reason="${verdict.reason}"`);
        // Flatten every coinbase-live agent
        for (const a of engine.agents?.values() ?? []) {
            if (a.config.broker !== 'coinbase-live' || !a.position)
                continue;
            try {
                await engine.closeBrokerPaperPosition(a, symbol, 'live-safety halt');
            }
            catch (err) {
                console.error(`[live-safety] flatten error for ${a.config.id}:`, err instanceof Error ? err.message : err);
            }
        }
        // Mark live agents paused
        for (const a of engine.agents?.values() ?? []) {
            if (a.config.broker === 'coinbase-live') {
                a.status = 'paused';
                a.pausedReason = `live-safety: ${verdict.reason}`;
            }
        }
    }
}
// Safety gate — called before any LIVE coinbase order is published to the HFT bus.
function checkLiveCapitalSafety(symbol, notional, currentConcurrentCount) {
    const safety = getLiveCapitalSafety();
    // Gate only active when flag = 1; otherwise module is inert.
    if (process.env.COINBASE_LIVE_ROUTING_ENABLED !== '1')
        return;
    if (!safety.isLiveActive())
        return;
    // Canary auto-rollback gate: reject if 3 consecutive losses or -$10 cumulative
    if (isLiveRollbackActive()) {
        throw new Error(`[live-safety] canOpenLivePosition blocked: live-canary-rollback-active`);
    }
    const check = safety.canOpenLivePosition(symbol, notional, currentConcurrentCount);
    if (!check.allowed) {
        throw new Error(`[live-safety] canOpenLivePosition blocked: ${check.reason}`);
    }
}
export async function routeBrokerOrder(engine, payload) {
    const startedAtMs = Date.now();
    // ── Phase 4 live-capital safety gate ──────────────────────────────
    if (payload.mode === 'paper' && payload.broker === 'coinbase-live') {
        // Count open positions for this broker as a rough concurrent-count proxy
        const concurrentCount = engine ? Array.from(engine.agents?.values() ?? [])
            .filter((a) => a.config.broker === 'coinbase-live' && a.position && !a.position.adopted)
            .length : 0;
        checkLiveCapitalSafety(payload.symbol, payload.notional, concurrentCount);
    }
    try {
        // High-performance Redis publish (Sub-millisecond latency)
        const topic = TOPICS.ORDER_REQUEST;
        await redis.publish(topic, JSON.stringify({
            ...payload,
            timestamp: new Date().toISOString()
        }));
        logger.debug(`[HFT] Order ${payload.id} published to ${topic}`);
        // Return an initial "accepted" response.
        // The actual fill will be handled asynchronously via the Paper Engine's Redis subscriber.
        return {
            orderId: payload.id,
            broker: payload.broker,
            symbol: payload.symbol,
            status: 'submitted',
            filledQty: 0,
            avgFillPrice: 0,
            latencyMs: Date.now() - startedAtMs,
            message: 'Order submitted to HFT bus',
            timestamp: new Date().toISOString()
        };
    }
    catch (error) {
        logger.error(`[HFT] Failed to publish order ${payload.id}: ${error instanceof Error ? error.message : 'unknown'}`);
        engine.operationalKillSwitchUntilMs = Math.max(engine.operationalKillSwitchUntilMs, Date.now() + 10 * 60_000);
        throw error;
    }
}
export async function openBrokerPaperPosition(engine, agent, symbol, score, entryMeta, decision, direction) {
    // Half-Kelly dynamic sizing from rolling 30-trade window
    const kellyFraction = engine.computeHalfKelly(agent);
    const baseFraction = kellyFraction > 0 ? Math.min(kellyFraction, agent.config.sizeFraction * 2) : agent.config.sizeFraction;
    // Conviction-based sizing + streak awareness
    const intel = engine.marketIntel.getCompositeSignal(symbol.symbol);
    const convictionMultiplier = intel.confidence >= 60 ? 1.3 : intel.confidence >= 40 ? 1.0 : 0.7;
    const regimeMultiplier = engine.getRegimeThrottleMultiplier(symbol);
    const calibrationMultiplier = engine.computeConfidenceCalibrationMultiplier(agent);
    const edgeConfidenceMultiplier = clamp((entryMeta.trainedProbability / 100) * 1.4, 0.55, 1.35);
    // Cold streak protection: reduce size after consecutive losses
    // Gemini insight: disable for mean-reversion in extreme fear — they NEED to probe multiple times
    const recentOutcomes = agent.recentOutcomes ?? [];
    const consecutiveLosses = engine.countConsecutiveLosses(recentOutcomes);
    const streakFng = engine.marketIntel.getFearGreedValue();
    const disableStreakPenalty = agent.config.style === 'mean-reversion' && streakFng !== null && streakFng <= 20;
    const streakMultiplier = disableStreakPenalty ? 1.0 : (consecutiveLosses >= 3 ? 0.5 : consecutiveLosses >= 2 ? 0.75 : 1.0);
    const executionMultiplier = engine.getExecutionQualityMultiplier(agent.config.broker);
    // Fear & Greed regime sizing: bearish = shrink momentum, boost mean-reversion
    const fng = engine.marketIntel.getFearGreedValue();
    let fngMultiplier = 1.0;
    if (fng !== null && symbol.assetClass === 'crypto') {
        if (fng < 25) {
            // Extreme fear: momentum agents shrink, mean-reversion agents grow
            fngMultiplier = agent.config.style === 'momentum' ? 0.5 : agent.config.style === 'mean-reversion' ? 1.4 : 0.7;
        }
        else if (fng < 40) {
            fngMultiplier = agent.config.style === 'momentum' ? 0.7 : agent.config.style === 'mean-reversion' ? 1.2 : 0.9;
        }
        else if (fng > 75) {
            // Extreme greed: momentum agents grow, mean-reversion agents shrink
            fngMultiplier = agent.config.style === 'momentum' ? 1.3 : agent.config.style === 'mean-reversion' ? 0.7 : 1.0;
        }
    }
    const sizedFraction = baseFraction
        * agent.allocationMultiplier
        * convictionMultiplier
        * streakMultiplier
        * executionMultiplier
        * regimeMultiplier
        * calibrationMultiplier
        * edgeConfidenceMultiplier
        * fngMultiplier;
    // Hard cap: 2% of starting equity per trade. Prevents multiplier-chain explosions
    // (e.g. HalfKelly×2 + conviction×1.3 + edgeConf×1.35 = 2.7× equity) from blowing up OANDA positions.
    const maxNotional = agent.startingEquity * 0.02;
    const notional = Math.min(Math.min(engine.getAgentEquity(agent) * sizedFraction, agent.cash * 0.9), maxNotional);
    if (notional <= 50) {
        agent.status = 'watching';
        agent.lastAction = 'Waiting for capital recycle before submitting a broker-backed paper order.';
        return;
    }
    // OANDA requires integer units for forex/bond/commodity; crypto uses 6 decimals
    const rawQty = notional / Math.max(symbol.price, 1);
    const quantity = agent.config.broker === 'oanda-rest'
        ? Math.max(1, Math.floor(rawQty))
        : round(rawQty, 6);
    if (quantity <= 0) {
        agent.status = 'watching';
        agent.lastAction = `Skipped ${symbol.symbol} because the computed order quantity was not tradable.`;
        return;
    }
    // Coinbase has no paper API — simulate fills locally using live tape prices
    if (engine.shouldSimulateLocally(agent.config.broker)) {
        const fillPrice = direction === 'short'
            ? symbol.price * (1 - (symbol.spreadBps / 10_000) * 0.25)
            : symbol.price * (1 + (symbol.spreadBps / 10_000) * 0.25);
        const entryFees = quantity * fillPrice * engine.getFeeRate(symbol.assetClass);
        agent.cash -= (notional + entryFees);
        agent.realizedPnl -= entryFees;
        agent.feesPaid = round(agent.feesPaid + entryFees, 4);
        agent.position = {
            direction,
            quantity,
            entryPrice: fillPrice,
            entryTick: engine.tick,
            entryAt: new Date().toISOString(),
            stopPrice: engine.computeDynamicStop(fillPrice, agent, symbol, direction),
            targetPrice: engine.computeDynamicTarget(fillPrice, agent, symbol, direction),
            peakPrice: fillPrice,
            note: engine.entryNote(agent.config.style, symbol, score),
            entryMeta
        };
        agent.status = 'in-trade';
        agent.lastSymbol = symbol.symbol;
        agent.lastAction = `Paper sim buy ${symbol.symbol} at ${round(fillPrice, 2)} (local sim, no live orders).`;
        engine.recordFill({
            agent, symbol,
            orderId: `sim-${agent.config.id}-${direction === 'short' ? 'sell' : 'buy'}-${Date.now()}`,
            side: direction === 'short' ? 'sell' : 'buy', status: 'filled', price: fillPrice, pnlImpact: 0,
            note: `Paper sim entry at ${round(fillPrice, 2)}. ${agent.position.note}`,
            source: 'simulated',
            councilAction: decision.finalAction,
            councilConfidence: Math.max(decision.primary.confidence, decision.challenger?.confidence ?? 0),
            councilReason: decision.reason
        });
        engine.persistStateSnapshot();
        return;
    }
    const entrySide = direction === 'short' ? 'sell' : 'buy';
    const orderId = `paper-${agent.config.id}-${entrySide}-${Date.now()}`;
    const brokerLabel = engine.formatBrokerLabel(agent.config.broker);
    agent.pendingOrderId = orderId;
    agent.pendingSide = entrySide;
    agent.pendingEntryMeta = entryMeta;
    agent.status = 'cooldown';
    agent.lastSymbol = symbol.symbol;
    agent.lastAction = `Submitting ${brokerLabel} ${entrySide} for ${symbol.symbol}.`;
    try {
        const entryCounters = engine.executionQualityCounters.get(agent.config.broker) ?? { attempts: 0, rejects: 0, partialFills: 0 };
        entryCounters.attempts += 1;
        engine.executionQualityCounters.set(agent.config.broker, entryCounters);
        const report = await engine.routeBrokerOrder({
            id: orderId,
            symbol: symbol.symbol,
            broker: agent.config.broker,
            side: entrySide,
            orderType: 'market',
            notional,
            quantity,
            strategy: `${agent.config.name} / scalping`,
            mode: 'paper',
            thesis: engine.entryNote(agent.config.style, symbol, score)
        });
        agent.lastBrokerSyncAt = report.timestamp;
        if (report.status === 'rejected') {
            entryCounters.rejects += 1;
            engine.executionQualityCounters.set(agent.config.broker, entryCounters);
            agent.pendingOrderId = null;
            agent.pendingSide = null;
            agent.pendingEntryMeta = undefined;
            agent.cooldownRemaining = 1;
            agent.lastAction = `${brokerLabel} ${entrySide} rejected for ${symbol.symbol}: ${report.message}`;
            return;
        }
        if (report.status !== 'filled' || report.avgFillPrice <= 0 || report.filledQty <= 0) {
            agent.pendingEntryMeta = entryMeta;
            agent.lastAction = `${brokerLabel} ${entrySide} accepted for ${symbol.symbol}, waiting for broker fill.`;
            return;
        }
        engine.applyBrokerFilledEntry(agent, symbol, report, score, entryMeta);
    }
    catch (error) {
        agent.pendingOrderId = null;
        agent.pendingSide = null;
        agent.cooldownRemaining = 2;
        agent.lastAction = `Failed to submit ${brokerLabel} ${entrySide} for ${symbol.symbol}: ${error instanceof Error ? error.message : 'unknown error'}.`;
    }
}
export async function closeBrokerPaperPosition(engine, agent, symbol, reason) {
    const position = agent.position;
    if (!position) {
        return;
    }
    // Discard dust positions that are below broker minimums
    const notional = position.quantity * symbol.price;
    if (notional < 1) {
        agent.position = null;
        agent.pendingOrderId = null;
        agent.pendingSide = null;
        agent.cooldownRemaining = 1;
        agent.status = 'cooldown';
        agent.lastAction = `Discarded dust position in ${symbol.symbol} (notional $${notional.toFixed(4)}).`;
        engine.persistStateSnapshot();
        return;
    }
    // Local simulation path (currently disabled — all trades go through broker APIs)
    if (engine.shouldSimulateLocally(agent.config.broker)) {
        const direction = engine.getPositionDirection(position);
        const exitPrice = direction === 'short'
            ? symbol.price * (1 + (symbol.spreadBps / 10_000) * 0.25)
            : symbol.price * (1 - (symbol.spreadBps / 10_000) * 0.25);
        const proceeds = position.quantity * exitPrice;
        const exitFees = proceeds * engine.getFeeRate(symbol.assetClass);
        const pnl = engine.computeGrossPnl(position, exitPrice, position.quantity) - exitFees;
        agent.cash += (proceeds - exitFees);
        agent.realizedPnl += pnl;
        agent.feesPaid = round(agent.feesPaid + exitFees, 4);
        agent.lastExitPnl = pnl;
        if (pnl > 0)
            agent.wins += 1;
        agent.trades += 1;
        agent.position = null;
        agent.cooldownRemaining = engine.getAdaptiveCooldown(agent, symbol);
        agent.status = 'cooldown';
        agent.lastAction = `Paper sim exit ${symbol.symbol} at ${round(exitPrice, 2)} (${reason}). PnL ${pnl >= 0 ? '+' : ''}${round(pnl, 2)}.`;
        engine.recordFill({
            agent, symbol,
            orderId: `sim-${agent.config.id}-${direction === 'short' ? 'buy' : 'sell'}-${Date.now()}`,
            side: direction === 'short' ? 'buy' : 'sell', status: 'filled', price: exitPrice, pnlImpact: pnl,
            note: `Paper sim exit at ${round(exitPrice, 2)}. ${reason}`,
            source: 'simulated'
        });
        engine.persistStateSnapshot();
        return;
    }
    const exitSide = engine.getPositionDirection(position) === 'short' ? 'buy' : 'sell';
    const orderId = `paper-${agent.config.id}-${exitSide}-${Date.now()}`;
    const brokerLabel = engine.formatBrokerLabel(agent.config.broker);
    agent.pendingOrderId = orderId;
    agent.pendingSide = exitSide;
    agent.status = 'cooldown';
    agent.lastAction = `Submitting ${brokerLabel} exit for ${symbol.symbol} after ${reason}.`;
    try {
        const exitCounters = engine.executionQualityCounters.get(agent.config.broker) ?? { attempts: 0, rejects: 0, partialFills: 0 };
        exitCounters.attempts += 1;
        engine.executionQualityCounters.set(agent.config.broker, exitCounters);
        // Use broker's actual position quantity to avoid dust
        const brokerQty = engine._brokerPositionCache?.get(agent.config.symbol) ?? position.quantity;
        const sellQty = agent.config.broker === 'oanda-rest'
            ? Math.floor(brokerQty)
            : brokerQty;
        const report = await engine.routeBrokerOrder({
            id: orderId,
            symbol: symbol.symbol,
            broker: agent.config.broker,
            side: exitSide,
            orderType: 'market',
            notional: sellQty * Math.max(symbol.price, position.entryPrice),
            quantity: sellQty,
            strategy: `${agent.config.name} / scalping`,
            mode: 'paper',
            thesis: `Exit ${symbol.symbol} because ${reason}.`
        });
        agent.lastBrokerSyncAt = report.timestamp;
        if (report.status === 'rejected') {
            exitCounters.rejects += 1;
            engine.executionQualityCounters.set(agent.config.broker, exitCounters);
            agent.pendingOrderId = null;
            agent.pendingSide = null;
            agent.lastAction = `${brokerLabel} exit rejected for ${symbol.symbol}: ${report.message}`;
            return;
        }
        if (report.status !== 'filled' || report.avgFillPrice <= 0 || report.filledQty <= 0) {
            agent.lastAction = `${brokerLabel} exit accepted for ${symbol.symbol}, waiting for broker fill.`;
            return;
        }
        engine.applyBrokerFilledExit(agent, symbol, report, reason);
    }
    catch (error) {
        agent.pendingOrderId = null;
        agent.pendingSide = null;
        agent.lastAction = `Failed to submit ${brokerLabel} exit for ${symbol.symbol}: ${error instanceof Error ? error.message : 'unknown error'}.`;
    }
}
export function applyBrokerFilledEntry(engine, agent, symbol, report, score, entryMeta) {
    const decision = agent.pendingCouncilDecision;
    const pendingSide = agent.pendingSide;
    const direction = pendingSide === 'sell' ? 'short' : 'long';
    const fillPrice = report.avgFillPrice;
    const quantity = round(report.filledQty, 6);
    const costBasis = fillPrice * quantity;
    const note = engine.entryNote(agent.config.style, symbol, score);
    agent.pendingOrderId = null;
    agent.pendingSide = null;
    agent.pendingEntryMeta = undefined;
    const entryFees = costBasis * engine.getFeeRate(symbol.assetClass);
    agent.cash -= (costBasis + entryFees);
    agent.realizedPnl -= entryFees;
    agent.feesPaid = round(agent.feesPaid + entryFees, 4);
    agent.position = {
        direction,
        quantity,
        entryPrice: fillPrice,
        entryTick: engine.tick,
        entryAt: new Date().toISOString(),
        stopPrice: engine.computeDynamicStop(fillPrice, agent, symbol, direction),
        targetPrice: engine.computeDynamicTarget(fillPrice, agent, symbol, direction),
        peakPrice: fillPrice,
        note,
        entryMeta: entryMeta ?? agent.pendingEntryMeta ?? engine.buildEntryMeta(agent, symbol, score)
    };
    agent.status = 'in-trade';
    agent.lastSymbol = symbol.symbol;
    agent.lastAction = `Broker-filled ${engine.formatBrokerLabel(agent.config.broker)} entry at ${round(fillPrice, 2)}. ${note}`;
    console.log(`[TRADE] ${agent.config.name} BROKER-ENTRY ${symbol.symbol} price=$${fillPrice.toFixed(2)} qty=${quantity.toFixed(6)} notional=$${costBasis.toFixed(2)} fees=$${entryFees.toFixed(4)} broker=${agent.config.broker} orderId=${report.orderId}`);
    // ── Phase 4 live-capital safety: record entry fill ───────────────
    handleLiveFillSafety(engine, agent, symbol, report, direction, 0).catch((err) => console.error('[live-safety] handleLiveFillSafety error:', err instanceof Error ? err.message : err));
    // ── §4.1 LATENCY TRACKING: record fillAt and compute latency metrics ──
    const fillAt = new Date().toISOString();
    const signalAt = agent._signalAt;
    const submitAt = report.submitAt;
    // Record latency sample for the entry
    if (signalAt && submitAt && engine.latencyTracker) {
        const signalToSubmitMs = new Date(submitAt).getTime() - new Date(signalAt).getTime();
        const submitToFillMs = new Date(fillAt).getTime() - new Date(submitAt).getTime();
        const signalToFillMs = new Date(fillAt).getTime() - new Date(signalAt).getTime();
        engine.latencyTracker.recordLatency({
            venue: agent.config.broker,
            symbol: symbol.symbol,
            signalToSubmitMs,
            submitToFillMs,
            signalToFillMs,
            signalAt,
            submitAt,
            fillAt
        });
    }
    engine.recordFill({
        agent,
        symbol,
        orderId: report.orderId,
        side: pendingSide ?? 'buy',
        status: 'filled',
        price: fillPrice,
        pnlImpact: 0,
        note: `Broker-filled ${engine.formatBrokerLabel(agent.config.broker)} entry at ${round(fillPrice, 2)}. ${note}`,
        source: 'broker',
        councilAction: decision?.finalAction,
        councilConfidence: decision ? Math.max(decision.primary.confidence, decision.challenger?.confidence ?? 0) : undefined,
        councilReason: decision?.reason,
        // ── §4.1 LATENCY TRACKING fields ──
        signalAt,
        submitAt,
        fillAt,
        signalToSubmitMs: signalAt && submitAt ? new Date(submitAt).getTime() - new Date(signalAt).getTime() : undefined,
        submitToFillMs: submitAt ? new Date(fillAt).getTime() - new Date(submitAt).getTime() : undefined,
        signalToFillMs: signalAt ? new Date(fillAt).getTime() - new Date(signalAt).getTime() : undefined
    });
    agent.pendingCouncilDecision = undefined;
    engine.persistStateSnapshot();
}
export function applyBrokerFilledExit(engine, agent, symbol, report, reason, forcePnl) {
    const position = agent.position;
    if (!position) {
        agent.pendingOrderId = null;
        agent.pendingSide = null;
        return;
    }
    const exitPrice = report.avgFillPrice;
    const closedQuantity = round(Math.min(position.quantity, report.filledQty > 0 ? report.filledQty : position.quantity), 6);
    const isPartialFill = closedQuantity < position.quantity * 0.95; // <95% = partial
    const direction = engine.getPositionDirection(position);
    const grossPnl = engine.computeGrossPnl(position, exitPrice, closedQuantity);
    const fees = closedQuantity * exitPrice * engine.getFeeRate(symbol.assetClass);
    const realized = forcePnl !== undefined ? forcePnl : grossPnl - fees;
    const costBasis = position.entryPrice * closedQuantity;
    const realizedPnlPct = (realized / costBasis) * 100;
    engine.noteTradeOutcome(agent, symbol, realized, reason);
    if (isPartialFill) {
        const counters = engine.executionQualityCounters.get(agent.config.broker) ?? { attempts: 0, rejects: 0, partialFills: 0 };
        counters.partialFills += 1;
        engine.executionQualityCounters.set(agent.config.broker, counters);
        const remainQty = round(position.quantity - closedQuantity, 6);
        console.log(`[PARTIAL FILL] ${agent.config.name} ${symbol.symbol}: closed ${closedQuantity} of ${position.quantity}, ${remainQty} remaining. Will retry next tick.`);
        // Keep position open with reduced quantity — next tick will attempt to close remainder
        position.quantity = remainQty;
        agent.cash += (position.entryPrice * closedQuantity) + realized;
        agent.realizedPnl = round(agent.realizedPnl + realized, 2);
        agent.feesPaid = round(agent.feesPaid + fees, 4);
        agent.lastAction = `Partial fill on ${symbol.symbol} exit: ${closedQuantity} filled, ${remainQty} remaining.`;
        agent.pendingOrderId = null;
        agent.pendingSide = null;
        return;
    }
    const verdict = realized > 0 ? 'winner' : realized < 0 ? 'loser' : 'scratch';
    const aiComment = realized >= 0
        ? 'The setup worked because the entry quality and tape gate kept the strategy out of weak quotes.'
        : 'The broker-backed paper trade still lost edge. Trade less or tighten entry quality before adding more size.';
    const holdTicks = engine.tick - position.entryTick;
    const journalContext = engine.buildJournalContext(symbol);
    // FIX 2b: Compute realized round-trip cost (entry+exit spread + fees)
    // Fall back to estimatedCostBps if spread data is unavailable (paper-simulated Coinbase).
    const exitSpreadBps = typeof symbol.spreadBps === 'number' ? symbol.spreadBps : 0;
    const entrySpreadBps = typeof position.entryMeta?.estimatedCostBps === 'number'
        ? Math.max(0, (position.entryMeta.estimatedCostBps - exitSpreadBps) / 2)
        : symbol.spreadBps ?? 0;
    const feeNotional = (position.quantity * (position.entryPrice + exitPrice)) / 2;
    const feeBps = feeNotional > 0 ? round((fees / feeNotional) * 10_000, 2) : 0;
    const realizedCostBps = typeof symbol.spreadBps === 'number' && symbol.spreadBps > 0
        ? round(entrySpreadBps + exitSpreadBps + feeBps, 2)
        : position.entryMeta?.estimatedCostBps ?? undefined;
    agent.pendingOrderId = null;
    agent.pendingSide = null;
    agent.pendingEntryMeta = undefined;
    agent.cash += costBasis + realized;
    agent.realizedPnl = round(agent.realizedPnl + realized, 2);
    agent.feesPaid = round(agent.feesPaid + fees, 4);
    agent.lastExitPnl = realized;
    agent.trades += 1;
    if (realized >= 0) {
        agent.wins += 1;
    }
    else {
        agent.losses += 1;
    }
    console.log(`[TRADE] ${agent.config.name} BROKER-EXIT ${symbol.symbol} pnl=$${realized.toFixed(4)} exit=$${exitPrice.toFixed(2)} reason=${reason} total_trades=${agent.trades} total_pnl=$${agent.realizedPnl.toFixed(2)}`);
    // ── §4.1 LATENCY TRACKING: record fillAt for exit fills ──
    const exitFillAt = new Date().toISOString();
    const exitSignalAt = agent._signalAt;
    const exitSubmitAt = report.submitAt;
    // Record latency sample for the exit (using same signalAt as entry)
    if (exitSignalAt && exitSubmitAt && engine.latencyTracker) {
        const signalToSubmitMs = new Date(exitSubmitAt).getTime() - new Date(exitSignalAt).getTime();
        const submitToFillMs = new Date(exitFillAt).getTime() - new Date(exitSubmitAt).getTime();
        const signalToFillMs = new Date(exitFillAt).getTime() - new Date(exitSignalAt).getTime();
        engine.latencyTracker.recordLatency({
            venue: agent.config.broker,
            symbol: symbol.symbol,
            signalToSubmitMs,
            submitToFillMs,
            signalToFillMs,
            signalAt: exitSignalAt,
            submitAt: exitSubmitAt,
            fillAt: exitFillAt
        });
    }
    engine.recordFill({
        agent,
        symbol,
        orderId: report.orderId,
        side: direction === 'short' ? 'buy' : 'sell',
        status: 'filled',
        price: exitPrice,
        pnlImpact: realized,
        note: `Broker-filled ${engine.formatBrokerLabel(agent.config.broker)} exit at ${round(exitPrice, 2)} on ${reason}.`,
        source: 'broker',
        // ── §4.1 LATENCY TRACKING fields (exit uses same signal/submit timestamps as entry) ──
        signalAt: exitSignalAt,
        submitAt: exitSubmitAt,
        fillAt: exitFillAt,
        signalToSubmitMs: exitSignalAt && exitSubmitAt ? new Date(exitSubmitAt).getTime() - new Date(exitSignalAt).getTime() : undefined,
        submitToFillMs: exitSubmitAt ? new Date(exitFillAt).getTime() - new Date(exitSubmitAt).getTime() : undefined,
        signalToFillMs: exitSignalAt ? new Date(exitFillAt).getTime() - new Date(exitSignalAt).getTime() : undefined
    });
    // Annotate repatriated/adopted positions in journal
    const isAdopted = position.adopted === true;
    const journalSource = isAdopted ? 'repatriated' : 'broker';
    const journalThesis = isAdopted && !String(position.note ?? '').startsWith('[adopted]')
        ? `[adopted] ${position.note}`
        : position.note;
    engine.recordJournal({
        id: `paper-journal-${Date.now()}-${agent.config.id}-${randomUUID()}`,
        symbol: symbol.symbol,
        assetClass: symbol.assetClass,
        broker: agent.config.broker,
        strategy: `${agent.config.name} / scalping`,
        strategyId: agent.config.id,
        lane: 'scalping',
        thesis: journalThesis,
        entryAt: position.entryAt ?? new Date().toISOString(),
        entryTimestamp: position.entryAt ?? new Date().toISOString(),
        exitAt: new Date().toISOString(),
        realizedPnl: round(realized, 2),
        realizedPnlPct: round(realizedPnlPct, 3),
        slippageBps: round(symbol.price > 0 ? Math.abs((exitPrice - symbol.price) / symbol.price) * 10_000 : symbol.spreadBps * 0.25, 2),
        spreadBps: round(symbol.spreadBps, 2),
        realizedCostBps,
        ...(report.latencyMs !== undefined ? { latencyMs: report.latencyMs } : {}),
        holdTicks,
        confidencePct: journalContext.confidencePct,
        regime: journalContext.regime,
        newsBias: journalContext.newsBias,
        orderFlowBias: journalContext.orderFlowBias,
        macroVeto: journalContext.macroVeto,
        embargoed: journalContext.embargoed,
        tags: [...journalContext.tags, `dir-${direction}`],
        ...(position.entryMeta ? {
            entryScore: position.entryMeta.score,
            entryHeuristicProbability: position.entryMeta.heuristicProbability,
            entryContextualProbability: position.entryMeta.contextualProbability,
            entryTrainedProbability: position.entryMeta.trainedProbability,
            entryApprove: position.entryMeta.approve,
            entryReason: position.entryMeta.reason,
            entryConfidencePct: position.entryMeta.confidencePct,
            entryRegime: position.entryMeta.regime,
            entryNewsBias: position.entryMeta.newsBias,
            entryOrderFlowBias: position.entryMeta.orderFlowBias,
            entryMacroVeto: position.entryMeta.macroVeto,
            entryEmbargoed: position.entryMeta.embargoed,
            entryTags: position.entryMeta.tags,
            estimatedCostBps: position.entryMeta.estimatedCostBps,
            expectedGrossEdgeBps: position.entryMeta.expectedGrossEdgeBps,
            expectedNetEdgeBps: position.entryMeta.expectedNetEdgeBps
        } : {}),
        aiComment,
        exitReason: reason,
        verdict,
        source: journalSource
    });
    engine.pushPoint(agent.recentOutcomes, round(realized, 2), OUTCOME_HISTORY_LIMIT);
    engine.pushPoint(agent.recentHoldTicks, holdTicks, OUTCOME_HISTORY_LIMIT);
    engine.checkSymbolKillswitch(agent);
    engine.applyAdaptiveTuning(agent, symbol);
    engine.evaluateChallengerProbation(agent, symbol);
    // ── Phase 4 live-capital safety: record exit fill ───────────────
    handleLiveFillSafety(engine, agent, symbol, report, direction, realized).catch((err) => console.error('[live-safety] handleLiveFillSafety error:', err instanceof Error ? err.message : err));
    agent.position = null;
    agent.status = 'cooldown';
    agent.cooldownRemaining = engine.getAdaptiveCooldown(agent, symbol);
    agent.lastSymbol = symbol.symbol;
    agent.lastAction = `Booked ${realized >= 0 ? 'gain' : 'loss'} on broker-backed ${symbol.symbol}: ${round(realized, 2)} after ${reason}.`;
    engine.persistStateSnapshot();
}
export async function fetchBrokerAccount(engine, broker) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        const response = await fetch(`${BROKER_ROUTER_URL}/account?broker=${broker}`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok)
            return null;
        const payload = await response.json();
        return Array.isArray(payload.brokers) ? payload.brokers[0] ?? null : null;
    }
    catch {
        return null;
    }
}
export function finalizeBrokerFlat(engine, agent, symbol, reason) {
    const position = agent.position;
    if (!position) {
        agent.pendingOrderId = null;
        agent.pendingSide = null;
        return;
    }
    // Phase H guard: only journal positions Hermes actually opened.
    // Positions imported from broker state without a Hermes-side entryMeta
    // (or with entryPrice = 0, which is a normalization artifact of missing
    // OANDA averagePrice fields) should not produce synthetic round-trip journals.
    const hasHermesEntry = Boolean(position.entryMeta) && typeof position.entryPrice === 'number' && position.entryPrice > 0;
    if (!hasHermesEntry) {
        agent.pendingOrderId = null;
        agent.pendingSide = null;
        if ('pendingEntryMeta' in agent)
            agent.pendingEntryMeta = undefined;
        console.warn(`[engine-broker] Skipping synthetic journal for ${agent.config.id} ${symbol.symbol}: no Hermes-side entry (entryPrice=${position.entryPrice}, entryMeta=${Boolean(position.entryMeta)}). Clearing pending state.`);
        return;
    }
    // Phase B dedupe: suppress repeated calls for the same agent+position+reason.
    // `position.entryAt` is always set at position creation; `entryTick` is the
    // guaranteed fallback if `entryAt` is somehow absent.
    const flatKey = `${agent.config.id}::${position.entryAt ?? position.entryTick}::${reason}`;
    if (journaledFlatKeys.has(flatKey)) {
        return;
    }
    journaledFlatKeys.add(flatKey);
    if (journaledFlatKeys.size > 5000) {
        const toDrop = Array.from(journaledFlatKeys).slice(0, 1000);
        for (const k of toDrop)
            journaledFlatKeys.delete(k);
    }
    const reconciliationReport = {
        orderId: agent.pendingOrderId ?? `reconciled-${agent.config.id}-${Date.now()}`,
        broker: engine.getAgentBroker(agent),
        symbol: symbol.symbol,
        status: 'filled',
        filledQty: position.quantity,
        avgFillPrice: symbol.price,
        message: reason,
        timestamp: new Date().toISOString(),
        source: 'broker'
    };
    engine.applyBrokerFilledExit(agent, symbol, reconciliationReport, reason);
}
// ---------------------------------------------------------------------------
// Recently-expired order TTL map (5-minute window).
// Records order IDs that were auto-cleared in engine-trading.ts so that a
// late-arriving fill can be recovered and re-attached to the correct agent.
// ---------------------------------------------------------------------------
const EXPIRED_TTL_MS = 5 * 60 * 1000;
export const recentlyExpiredOrderIds = new Map();
export function recordExpiredOrder(orderId, agentId, expected) {
    recentlyExpiredOrderIds.set(orderId, { agentId, expiredAt: Date.now(), expected });
}
/**
 * Process an async order-status event from the broker HFT bus.
 *
 * Recovery path: if the fill's orderId is not found on any current agent (because
 * the 30-second TTL cleared it from pendingOrderId), check the recently-expired
 * map.  If the entry is still within the 5-minute window, re-attach the fill to
 * the agent so it is not silently dropped.
 */
export function handleAsyncOrderStatus(engine, data) {
    // Cleanup: purge entries older than 5 minutes on every call
    const now = Date.now();
    for (const [id, entry] of recentlyExpiredOrderIds.entries()) {
        if (now - entry.expiredAt > EXPIRED_TTL_MS) {
            recentlyExpiredOrderIds.delete(id);
        }
    }
    // Try to find agent by current pendingOrderId first
    let agent = Array.from(engine.agents.values()).find((a) => a.pendingOrderId === data.orderId);
    // Recovery path: if not found, check recently-expired map
    if (!agent) {
        const expired = recentlyExpiredOrderIds.get(data.orderId);
        if (expired && now - expired.expiredAt <= EXPIRED_TTL_MS) {
            agent = engine.agents.get(expired.agentId);
            if (agent) {
                agent.pendingOrderId = data.orderId;
                agent.pendingSide = expired.expected;
                logger.info(`[paper-engine] Recovered fill for expired order ${data.orderId}: re-attached to ${agent.config.id}`);
                recentlyExpiredOrderIds.delete(data.orderId);
            }
        }
    }
    if (!agent)
        return;
    logger.info(`Paper Engine received async status for order ${data.orderId}: ${data.status}`);
    const symbol = engine.market.get(agent.config.symbol);
    if (!symbol)
        return;
    if (data.status === 'filled') {
        if (agent.pendingSide === 'buy') {
            engine.applyBrokerFilledEntry(agent, symbol, data, 0);
        }
        else {
            engine.applyBrokerFilledExit(agent, symbol, data, data.message || 'execution');
        }
    }
    else if (data.status === 'rejected') {
        agent.pendingOrderId = null;
        agent.pendingSide = null;
        agent.lastAction = `Order rejected by broker: ${data.message}`;
    }
}
