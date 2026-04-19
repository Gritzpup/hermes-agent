/**
 * Exit Logic Module
 *
 * Dynamic stop/target calculation and trailing stop management.
 * Pure functions — no shared state.
 *
 * IMPROVEMENTS v2:
 * - ATR-based volatility-adjusted stops
 * - Regime-aware multiplier scaling
 * - Symbol-specific stop widening for high-volatility assets
 */
import { roundTripFeeBps } from './scoring.js';
/**
 * Volatility regime detection for stop adjustment
 */
function getVolatilityRegime(atr, entryPrice) {
    const atrPct = (atr / entryPrice) * 100;
    if (atrPct > 1.5)
        return 'high';
    if (atrPct > 0.5)
        return 'normal';
    return 'low';
}
/**
 * ATR multiplier based on volatility regime and asset class
 * High volatility = wider stops to avoid stop-hunting
 * Low volatility = tighter stops for better risk management
 */
function getAtrMultiplier(regime, assetClass, fearGreedValue) {
    // Base multipliers by volatility regime
    const regimeMult = regime === 'high' ? 2.0 : regime === 'normal' ? 1.5 : 1.0;
    // Asset class adjustments
    const assetMult = assetClass === 'crypto' ? 1.3 // Crypto is more volatile
        : assetClass === 'commodity' ? 1.2
            : 1.0;
    // Fear/Greed adjustments for crypto
    const fearMult = (fearGreedValue !== null && fearGreedValue <= 20 && assetClass === 'crypto')
        ? 0.8 // Extreme fear: tighter stops - bounces are fast
        : fearGreedValue !== null && fearGreedValue >= 80 && assetClass === 'crypto'
            ? 1.4 // Extreme greed: wider stops - trend may extend
            : 1.0;
    return regimeMult * assetMult * fearMult;
}
/**
 * Compute a dynamic stop price using ATR if available.
 * Volatility-adjusted: wider in chop, tighter in trends.
 */
export function computeDynamicStop(entryPrice, stopBps, direction, assetClass, atr, fearGreedValue = null) {
    if (atr && atr > 0) {
        const regime = getVolatilityRegime(atr, entryPrice);
        const mult = getAtrMultiplier(regime, assetClass, fearGreedValue);
        const atrStop = atr * mult;
        const bpsStop = entryPrice * (stopBps / 10_000);
        const stop = Math.max(atrStop, bpsStop);
        const finalStop = direction === 'short'
            ? entryPrice + stop
            : entryPrice - stop;
        return finalStop;
    }
    return direction === 'short'
        ? entryPrice * (1 + stopBps / 10_000)
        : entryPrice * (1 - stopBps / 10_000);
}
/**
 * Compute a dynamic target price using ATR if available.
 */
export function computeDynamicTarget(entryPrice, targetBps, direction, assetClass, atr) {
    const feeBps = roundTripFeeBps(assetClass);
    if (atr && atr > 0) {
        const atrTarget = atr * 2;
        const bpsTarget = entryPrice * ((targetBps + feeBps) / 10_000);
        const target = Math.max(atrTarget, bpsTarget);
        return direction === 'short'
            ? entryPrice - target
            : entryPrice + target;
    }
    return direction === 'short'
        ? entryPrice * (1 - (targetBps + feeBps) / 10_000)
        : entryPrice * (1 + (targetBps + feeBps) / 10_000);
}
/**
 * Trailing stop parameters adjusted for extreme fear crypto conditions.
 * Returns { beActivation, trailActivation, trailRatio }.
 */
export function getTrailingStopParams(assetClass, fearGreedValue) {
    const extremeFearCrypto = fearGreedValue !== null && fearGreedValue <= 25 && assetClass === 'crypto';
    return {
        beActivation: extremeFearCrypto ? 0.25 : 0.4,
        trailActivation: extremeFearCrypto ? 0.35 : 0.7,
        trailRatio: extremeFearCrypto ? 0.75 : 0.5
    };
}
/**
 * Catastrophic stop threshold based on strategy style and asset class.
 * Crypto mean-reversion widened from -1% to -2.5% to avoid stop-hunting
 * during normal volatility swings (2026-04-19 risk management fix).
 * Returns the multiplier (e.g., 0.975 = -2.5%).
 */
export function getCatastrophicStopPct(style, assetClass) {
    if (style === 'momentum')
        return 0.98;
    if (style === 'breakout')
        return 0.985;
    // Mean-reversion: crypto gets wider stop (-2.5%) vs default (-1%)
    if (assetClass === 'crypto')
        return 0.975;
    return 0.99;
}
/**
 * Generate a human-readable entry note.
 */
export function entryNote(style, symbol, score) {
    if (style === 'momentum') {
        return `Bought ${symbol.symbol} momentum squeeze after positive tape acceleration. Score ${score.toFixed(2)}.`;
    }
    if (style === 'breakout') {
        return `Bought ${symbol.symbol} on breakout through short-term range high. Score ${score.toFixed(2)}.`;
    }
    return `Bought ${symbol.symbol} on short-term overreaction into mean-reversion zone. Score ${score.toFixed(2)}.`;
}
/**
 * Signal-based exit check — should we close based on indicator recovery?
 * Returns exit reason string or null to keep holding.
 */
export function checkSignalExit(style, direction, rsi2, unrealizedBps, holdTicks, maxHoldTicks) {
    // Mean-reversion: take the bounce when RSI(2) recovers with profit
    if (style === 'mean-reversion' && direction === 'long' && rsi2 !== null && rsi2 >= 70 && unrealizedBps >= 8) {
        return `signal exit: RSI(2) bounce to ${rsi2.toFixed(0)} with +${unrealizedBps.toFixed(1)}bps`;
    }
    if (style === 'mean-reversion' && direction === 'short' && rsi2 !== null && rsi2 <= 30 && unrealizedBps >= 8) {
        return `signal exit: RSI(2) dip to ${rsi2.toFixed(0)} with +${unrealizedBps.toFixed(1)}bps`;
    }
    // Time-decay: if held > 60% of max and barely profitable, take it
    if (holdTicks >= maxHoldTicks * 0.6 && unrealizedBps > 0 && unrealizedBps < 5) {
        return `time-decay exit: +${unrealizedBps.toFixed(1)}bps at ${((holdTicks / maxHoldTicks) * 100).toFixed(0)}% hold`;
    }
    return null;
}
/**
 * Estimated broker round-trip cost in basis points for a given symbol.
 * orderMode: 'taker' pays the full fee; 'maker' earns most of the spread (postOnly).
 * Realistic Coinbase Advanced Trade retail round-trip: taker ~80–100 bps, maker ~8–15 bps.
 * Scalper targets MUST exceed taker friction to be profitable.
 */
export function estimatedBrokerRoundTripCostBps(assetClass, spreadBps, orderMode = 'taker') {
    if (assetClass === 'crypto') {
        if (orderMode === 'maker') {
            // Maker earns spread — effectively negative cost, just pay network/exchange fee
            return Math.max(8, spreadBps * 0.5);
        }
        // Realistic retail taker: Coinbase taker fee 0.4–0.6% per side = 80–120 bps round-trip
        return Math.max(80, spreadBps * 2 + 12);
    }
    return Math.max(4, spreadBps * 1.75 + 1.5);
}
