/**
 * Entry Filters
 *
 * Pure filter functions for the canEnter() decision tree.
 * Each filter returns true to BLOCK the entry, false to allow.
 */
/** Time-of-day filter: only trade during peak hours for each asset class */
export function isTimeBlocked(assetClass) {
    const hour = new Date().getUTCHours();
    if (assetClass === 'crypto') {
        // Only block 4-6 UTC (lowest volume dead zone)
        return hour >= 4 && hour < 6;
    }
    if (assetClass === 'forex') {
        // London (07-16 UTC) and NY overlap (13-17 UTC)
        return hour < 7 || hour > 17;
    }
    return false; // indices/bonds/commodities: trade whenever OANDA serves them
}
/** VWAP flat filter: skip momentum/breakout during chop */
export function isVwapBlocked(style, assetClass, isVwapFlat, fearGreedValue, rsi2) {
    // Bypass for crypto capitulations — RSI(2) < 10 in extreme fear = buy the wick
    const cryptoCapitulation = assetClass === 'crypto' && fearGreedValue !== null && fearGreedValue <= 20 && rsi2 !== null && rsi2 < 10;
    if (style !== 'mean-reversion' && isVwapFlat && !cryptoCapitulation)
        return true;
    return false;
}
/** RSI(2) filter for entry quality */
export function isRsi2Blocked(style, direction, rsi2, fearGreedValue) {
    if (rsi2 === null)
        return false;
    // FIX #2: Mean-reversion RSI(2) gates — block when RSI is not at the right extremity
    // Mean-reversion longs: require RSI > 55 to block (need more oversold to enter, was 40/50)
    // Mean-reversion shorts: require RSI < 45 to block (was 40)
    // In extreme fear (FG <= 20), relax slightly to allow more entry attempts
    const rsi2LimitLong = (fearGreedValue !== null && fearGreedValue <= 20) ? 60 : 55;
    const rsi2LimitShort = (fearGreedValue !== null && fearGreedValue <= 20) ? 40 : 45;
    // Mean-reversion longs: block when RSI is > limit (not oversold enough)
    if (style === 'mean-reversion' && direction === 'long' && rsi2 > rsi2LimitLong)
        return true;
    // Mean-reversion shorts: block when RSI is < limit (not overbought enough)
    if (style === 'mean-reversion' && direction === 'short' && rsi2 < rsi2LimitShort)
        return true;
    // Momentum trades: block at extremes only (RSI > 85 = overbought for longs, RSI < 18 = oversold for shorts)
    if (style === 'momentum' && direction === 'long' && rsi2 > 85)
        return true;
    if (style === 'momentum' && direction === 'short' && rsi2 < 18)
        return true;
    return false;
}
/** RSI(14) multi-timeframe confirmation */
export function isRsi14Blocked(style, direction, rsi14, fearGreedValue) {
    if (rsi14 === null)
        return false;
    const rsi14Limit = (fearGreedValue !== null && fearGreedValue <= 20) ? 70 : 60;
    if (style === 'momentum' && direction === 'long' && rsi14 < 45)
        return true;
    if (style === 'mean-reversion' && direction === 'long' && rsi14 > rsi14Limit)
        return true;
    if (style === 'momentum' && direction === 'short' && rsi14 > 55)
        return true;
    if (style === 'mean-reversion' && direction === 'short' && rsi14 < 40)
        return true;
    return false;
}
/** Multi-timeframe 5m trend gate — only trade in direction of macro trend */
export function isTrendBlocked(style, direction, trend5m) {
    if (!trend5m || trend5m === 'flat')
        return false;
    if (style === 'momentum' && direction === 'long' && trend5m === 'down')
        return true;
    if (style === 'momentum' && direction === 'short' && trend5m === 'up')
        return true;
    return false;
}
/** Liquidity sweep detection — block after false breakouts */
export function isSweepBlocked(style, isSweep) {
    return style !== 'mean-reversion' && isSweep;
}
/** Realized vol ratio — don't enter when move already happened */
export function isVolSpikeBlocked(volRatio) {
    return volRatio !== null && volRatio > 2.5;
}
/** Volume/volatility confirmation on RSI(2) longs in extreme fear */
export function isFallingKnifeBlocked(assetClass, direction, rsi2, fearGreedValue, bollingerSqueeze, bollingerPosition) {
    if (assetClass !== 'crypto' || direction !== 'long' || rsi2 === null || rsi2 >= 10)
        return false;
    if (fearGreedValue === null || fearGreedValue >= 25)
        return false;
    // RSI(2) < 10 in extreme fear MUST have Bollinger squeeze OR price at bottom band
    if (!bollingerSqueeze && bollingerPosition > 0.05)
        return true; // falling knife
    return false;
}
