/**
 * Entry Direction Resolution
 *
 * Determines whether an agent should go long or short based on
 * composite signals, Fear & Greed, RSI(2), and regime conditions.
 */
/**
 * Resolve whether an entry should be long or short.
 * Returns 'long' or 'short' based on market conditions and agent style.
 */
export function resolveDirection(style, symbol, ctx) {
    const bearishFlow = ctx.signal.direction === 'sell' || ctx.signal.direction === 'strong-sell';
    const bullishFlow = ctx.signal.direction === 'buy' || ctx.signal.direction === 'strong-buy';
    const bearishMarket = ctx.fearGreedValue !== null && ctx.fearGreedValue < 35;
    const extremeFear = ctx.fearGreedValue !== null && ctx.fearGreedValue <= 20;
    // Disable ALL short entries in extreme fear crypto — short squeezes kill shorts
    if (extremeFear && symbol.assetClass === 'crypto') {
        return 'long';
    }
    // Mean-reversion: short when overbought in bearish market, long when oversold
    if (style === 'mean-reversion') {
        if (ctx.rsi2 !== null && ctx.rsi2 > 80 && (bearishFlow || bearishMarket))
            return 'short';
        if ((ctx.riskOff || ctx.panicRegime) && ctx.score <= -0.8 && bearishFlow)
            return 'short';
        return 'long';
    }
    // Momentum: follow the trend direction
    if (bearishFlow && (ctx.score <= -0.4 || bearishMarket || symbol.drift <= -0.0015)) {
        return 'short';
    }
    if (bullishFlow && (ctx.score >= 0.4 || symbol.drift >= 0.0015)) {
        return 'long';
    }
    // Tie-break: use Fear & Greed for crypto, score for others
    if (symbol.assetClass === 'crypto' && bearishMarket)
        return 'short';
    return ctx.score < 0 ? 'short' : 'long';
}
