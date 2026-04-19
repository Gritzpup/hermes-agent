/**
 * Position Sizing Module
 *
 * Pure functions for Half-Kelly, adaptive cooldown, and streak calculations.
 * No shared state — all inputs passed as parameters.
 */
/**
 * Half-Kelly position sizing from rolling 30-trade window.
 * Returns half-Kelly fraction clamped to [0.01, 0.15].
 * Returns 0 if insufficient data (caller uses config default).
 */
export function computeHalfKelly(recentOutcomes) {
    const outcomes = recentOutcomes.slice(-30);
    if (outcomes.length < 10)
        return 0;
    const wins = outcomes.filter((o) => o > 0);
    const losses = outcomes.filter((o) => o < 0);
    if (wins.length === 0 || losses.length === 0)
        return 0;
    const winRate = wins.length / outcomes.length;
    const lossRate = 1 - winRate;
    const avgWin = wins.reduce((s, v) => s + v, 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((s, v) => s + v, 0) / losses.length);
    if (avgLoss === 0)
        return 0;
    const R = avgWin / avgLoss;
    const kelly = (winRate * R - lossRate) / R;
    const halfKelly = kelly / 2;
    return Math.max(0.01, Math.min(0.15, halfKelly));
}
/** Count consecutive losses from the end of the outcomes array. */
export function countConsecutiveLosses(outcomes) {
    let count = 0;
    for (let index = outcomes.length - 1; index >= 0; index -= 1) {
        if ((outcomes[index] ?? 0) < 0)
            count += 1;
        else
            break;
    }
    return count;
}
/** Relative price movement over a lookback window. */
export function relativeMove(history, lookback) {
    const end = history.at(-1);
    const start = history.at(Math.max(history.length - lookback, 0));
    if (!end || !start)
        return 0;
    return (end - start) / start;
}
/**
 * Adaptive cooldown: longer after losses in bad conditions, shorter when winning.
 * Returns number of ticks to cool down.
 */
export function computeAdaptiveCooldown(baseCooldown, lastExitPnl, recentOutcomes, style, fearGreedValue) {
    const consecutiveLosses = countConsecutiveLosses(recentOutcomes);
    let multiplier = 1.0;
    if (lastExitPnl < 0) {
        multiplier = 1.3;
        if (consecutiveLosses >= 2)
            multiplier = 1.6;
        if (consecutiveLosses >= 3)
            multiplier = 2.0;
    }
    else if (lastExitPnl > 0) {
        multiplier = 0.8;
    }
    if (fearGreedValue !== null && fearGreedValue < 30 && style === 'momentum') {
        multiplier *= 1.4;
    }
    return Math.max(2, Math.round(baseCooldown * multiplier));
}
/**
 * Fear & Greed regime sizing multiplier.
 * Adjusts position size based on market sentiment for crypto.
 */
export function computeFngSizeMultiplier(style, assetClass, fearGreedValue) {
    if (fearGreedValue === null || assetClass !== 'crypto')
        return 1.0;
    if (fearGreedValue < 25) {
        return style === 'momentum' ? 0.5 : style === 'mean-reversion' ? 1.4 : 0.7;
    }
    if (fearGreedValue < 40) {
        return style === 'momentum' ? 0.7 : style === 'mean-reversion' ? 1.2 : 0.9;
    }
    if (fearGreedValue > 75) {
        return style === 'momentum' ? 1.3 : style === 'mean-reversion' ? 0.7 : 1.0;
    }
    return 1.0;
}
/**
 * Cold streak multiplier — disabled for mean-reversion in extreme fear.
 */
export function computeStreakMultiplier(consecutiveLosses, style, fearGreedValue) {
    const disableStreakPenalty = style === 'mean-reversion' && fearGreedValue !== null && fearGreedValue <= 20;
    if (disableStreakPenalty)
        return 1.0;
    return consecutiveLosses >= 3 ? 0.5 : consecutiveLosses >= 2 ? 0.75 : 1.0;
}
