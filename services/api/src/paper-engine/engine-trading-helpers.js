// @ts-nocheck
import { round } from '../paper-engine-utils.js';
export function getPositionDirection(engine, position) {
    return position?.direction ?? 'long';
}
export function getPositionUnrealizedPnl(engine, position, markPrice) {
    const direction = engine.getPositionDirection(position);
    const directionalMove = direction === 'short'
        ? (position.entryPrice - markPrice)
        : (markPrice - position.entryPrice);
    return directionalMove * position.quantity;
}
export function maybeTrailBrokerStop(engine, agent, symbol) {
    const position = agent.position;
    if (!position)
        return;
    const direction = engine.getPositionDirection(position);
    const targetDelta = direction === 'short'
        ? position.entryPrice - position.targetPrice
        : position.targetPrice - position.entryPrice;
    if (targetDelta <= 0)
        return;
    const progress = direction === 'short'
        ? position.entryPrice - symbol.price
        : symbol.price - position.entryPrice;
    const progressPct = progress / targetDelta;
    // Gemini insight: in extreme fear crypto, bounces are violent but short — trail tighter
    const fng = engine.marketIntel.getFearGreedValue();
    const extremeFearCrypto = fng !== null && fng <= 25 && symbol.assetClass === 'crypto';
    const beActivation = extremeFearCrypto ? 0.25 : 0.4;
    const trailActivation = extremeFearCrypto ? 0.35 : 0.7;
    const trailRatio = extremeFearCrypto ? 0.75 : 0.5;
    // Move stop to breakeven + costs
    if (progressPct >= beActivation) {
        const costProtectedStop = direction === 'short'
            ? position.entryPrice * (1 - (engine.estimatedBrokerRoundTripCostBps(symbol) * 0.6) / 10_000)
            : position.entryPrice * (1 + (engine.estimatedBrokerRoundTripCostBps(symbol) * 0.6) / 10_000);
        position.stopPrice = direction === 'short'
            ? Math.min(position.stopPrice, costProtectedStop)
            : Math.max(position.stopPrice, costProtectedStop);
    }
    // Trail at ratio of gains
    if (progressPct >= trailActivation) {
        const trailingStop = direction === 'short'
            ? position.entryPrice - progress * trailRatio
            : position.entryPrice + progress * trailRatio;
        position.stopPrice = direction === 'short'
            ? Math.min(position.stopPrice, trailingStop)
            : Math.max(position.stopPrice, trailingStop);
    }
}
export function getFeeRate(engine, assetClass) {
    if (assetClass === 'crypto')
        return 0.0006; // 6bps
    if (assetClass === 'equity')
        return 0.0001; // 1bp
    return 0.0003; // 3bps
}
export function roundTripFeeBps(engine, assetClass) {
    return engine.getFeeRate(assetClass) * 2 * 10_000;
}
export function computeDynamicStop(engine, fillPrice, agent, symbol, direction) {
    const mult = direction === 'short' ? 1 : -1;
    const stopBps = agent.config.stopBps;
    return fillPrice * (1 + (mult * stopBps) / 10_000);
}
export function computeDynamicTarget(engine, fillPrice, agent, symbol, direction) {
    const mult = direction === 'short' ? -1 : 1;
    const targetBps = agent.config.targetBps;
    return fillPrice * (1 + (mult * targetBps) / 10_000);
}
export function resolveEntryDirection(engine, agent, symbol, score, intel) {
    if (intel?.direction === 'buy' || intel?.direction === 'strong-buy')
        return 'long';
    if (intel?.direction === 'sell' || intel?.direction === 'strong-sell')
        return 'short';
    return score > 0 ? 'long' : 'short';
}
export function computeGrossPnl(engine, position, exitPrice, quantity) {
    const direction = engine.getPositionDirection(position);
    if (direction === 'short') {
        return (position.entryPrice - exitPrice) * quantity;
    }
    return (exitPrice - position.entryPrice) * quantity;
}
export function getSessionBucket(engine, isoTs) {
    const date = isoTs ? new Date(isoTs) : new Date();
    const hours = date.getUTCHours();
    if (hours >= 0 && hours < 8)
        return 'asia';
    if (hours >= 8 && hours < 16)
        return 'europe';
    return 'america';
}
export function getVolatilityBucket(engine, symbol) {
    // Logic to classify volatility based on recent returns
    return 'medium';
}
export function noteTradeOutcome(engine, agent, symbol, realized, reason) {
    // Logic to record the outcome in agent history
}
export function getAgentNetPnl(engine, agent) {
    const realized = agent.realizedPnl;
    const unrealized = agent.position
        ? engine.getPositionUnrealizedPnl(agent.position, engine.market.get(agent.config.symbol)?.price ?? agent.position.entryPrice)
        : 0;
    return realized + unrealized;
}
export function getAgentEquity(engine, agent) {
    return agent.deployment.startingRealizedPnl + engine.getAgentNetPnl(agent);
}
export function getDeskEquity(engine) {
    return Array.from(engine.agents.values()).reduce((sum, agent) => sum + engine.getAgentEquity(agent), 0);
}
export function getBenchmarkEquity(engine) {
    const pilotSymbols = new Set(engine.getDeskAgentStates().map((a) => a.config.symbol));
    const scopedSymbols = Array.from(engine.market.values()).filter((s) => pilotSymbols.has(s.symbol));
    const symbols = scopedSymbols.filter((s) => engine.hasTradableTape(s));
    const benchmarkSymbols = symbols.length > 0 ? symbols : (scopedSymbols.length > 0 ? scopedSymbols : Array.from(engine.market.values()));
    const validReturns = benchmarkSymbols
        .filter((s) => s.price > 0 && s.openPrice > 0)
        .map((s) => (s.price - s.openPrice) / s.openPrice);
    const averageReturn = validReturns.length > 0 ? (validReturns.reduce((a, b) => a + b, 0) / validReturns.length) : 0;
    return round(engine.getDeskStartingEquity() * (1 + averageReturn), 2);
}
export function computeHalfKelly(engine, agent) {
    const outcomes = (agent.recentOutcomes ?? []).slice(-30);
    if (outcomes.length < 10)
        return agent.config.sizeFraction;
    const wins = outcomes.filter(o => o > 0);
    const losses = outcomes.filter(o => o < 0);
    if (losses.length === 0)
        return Math.min(agent.config.sizeFraction * 1.5, 0.15);
    const winRate = wins.length / outcomes.length;
    const avgWin = wins.reduce((a, b) => a + b, 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length);
    const b = avgWin / avgLoss;
    const kelly = (winRate * b - (1 - winRate)) / b;
    const halfKelly = kelly / 2;
    return Math.min(Math.max(halfKelly, 0.01), 0.15);
}
export function breachesCrowdingLimit(engine, symbol, proposedNotional) {
    const currentNotional = Array.from(engine.agents.values())
        .filter(a => a.position && a.config.symbol === symbol)
        .reduce((sum, a) => sum + (a.position?.entryPrice ?? 0) * (a.position?.quantity ?? 0), 0);
    const deskEquity = engine.getDeskEquity();
    const limitPct = 40; // 40% max per symbol across all agents
    return (currentNotional + proposedNotional) > (deskEquity * limitPct / 100);
}
export function getEffectiveLeverage(engine) {
    const totalNotional = Array.from(engine.agents.values())
        .filter(a => a.position)
        .reduce((sum, a) => sum + (a.position?.entryPrice ?? 0) * (a.position?.quantity ?? 0), 0);
    const deskEquity = engine.getDeskEquity();
    return deskEquity > 0 ? totalNotional / deskEquity : 0;
}
