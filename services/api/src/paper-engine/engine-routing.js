// @ts-nocheck
import { round } from '../paper-engine-utils.js';
export function getTapeQualityBlock(engine, symbol) {
    if (symbol.price <= 0)
        return 'no market price';
    if (symbol.spreadBps > 100)
        return `spread too wide (${symbol.spreadBps.toFixed(1)}bps)`;
    const ageMs = Date.now() - new Date(symbol.updatedAt).getTime();
    // OANDA commodities (Gold, Silver, Oil, NatGas) are closed Friday ~21:00 UTC to Sunday ~21:00 UTC.
    // OANDA forex MAJORS (EUR/USD, USD/JPY, etc.) are 24/5 — they don't fully close,
    // just have reduced liquidity on weekends. We treat them as always open.
    // Bonds follow commodity hours.
    // When the market is genuinely closed the feed stops updating — that's expected.
    const isWeekendClosureAsset = symbol.assetClass === 'commodity' || symbol.assetClass === 'bond';
    if (isWeekendClosureAsset && ageMs > 120_000) {
        const now = new Date();
        const utcDay = now.getUTCDay();
        const utcHour = now.getUTCHours();
        // OANDA commodity markets close Friday ~21:00 UTC, reopen Sunday ~21:00 UTC
        const weekendClosed = utcDay === 6 // all Saturday
            || (utcDay === 5 && utcHour >= 21) // Friday after 21:00 UTC
            || (utcDay === 0 && utcHour < 21); // Sunday before 21:00 UTC
        if (weekendClosed) {
            return `${symbol.symbol} market closed (OANDA weekend)`;
        }
    }
    // Market-data service polls OANDA and Alpaca on a ~150 s cadence, so 143 s-old data
    // is actually fresh-from-last-poll, not a fault. Thresholds:
    // - OANDA forex: 300s (24/5 market, data is always fresh from last poll)
    // - OANDA commodities/bonds: 300s
    // - Equities: 240s (shorter — more time-sensitive)
    const isOandaAsset = symbol.assetClass === 'forex' || symbol.assetClass === 'commodity' || symbol.assetClass === 'bond';
    const staleThresholdMs = isOandaAsset ? 300_000 : 240_000;
    if (ageMs > staleThresholdMs)
        return 'market data stale';
    return null;
}
export function getPrecisionBlock(engine, agent, symbol) {
    // Logic to prevent entry if precision requirement isn't met
    return null;
}
export function getRouteBlock(engine, agent, symbol) {
    // Logic to prevent entry based on broker route status
    return null;
}
export function getManagerBlock(engine, agent, symbol) {
    // Centralized manager desk kills/blocks
    return null;
}
export function getAdaptiveCooldown(engine, agent, symbol) {
    const outcomes = agent.recentOutcomes ?? [];
    const consecutiveLosses = engine.countConsecutiveLosses(outcomes);
    const base = agent.config.cooldownTicks ?? 10;
    if (consecutiveLosses >= 2)
        return base * 3;
    if (consecutiveLosses >= 1)
        return base * 2;
    return base;
}
export function canUseBrokerRulesFastPath(engine, agent, symbol, score, aiDecision) {
    // COO FIX: Only bypass AI council if it hasn't decided yet (pending/null).
    // If AI says 'approve' → use that decision.
    // If AI says 'review' or 'reject' → don't bypass, wait for human review or reject.
    // Only allow broker fast-path when AI is still pending (status !== 'complete')
    if (!aiDecision || aiDecision?.status !== 'complete') {
        return score >= 8;
    }
    // AI has decided - don't bypass its decision
    return false;
}
export function fastPathThreshold(engine, style) {
    if (style === 'momentum')
        return 9;
    return 12;
}
// orderMode: 'taker' pays full fee; 'maker' earns spread (postOnly).
export function estimatedBrokerRoundTripCostBps(engine, symbol, orderMode = 'taker') {
    if (symbol.assetClass === 'crypto') {
        if (orderMode === 'maker') {
            return Math.max(8, (symbol.spreadBps ?? 4) * 0.5);
        }
        // Realistic retail taker: 80 bps floor (Coinbase taker 0.4% per side)
        return Math.max(80, (symbol.spreadBps ?? 4) * 2 + 12);
    }
    const fee = (engine.getFeeRate(symbol.assetClass) ?? 0.0003) * 2;
    return fee * 10_000 + (symbol.spreadBps ?? 4);
}
