/**
 * Market Intelligence — Composite signal building.
 * Extracted from market-intel.ts for maintainability.
 *
 * Aggregates order flow, fear/greed, Bollinger, VWAP, trend, RSI, MACD,
 * support/resistance, RSI(2), Stochastic, and weighted OBI into a single
 * CompositeSignal per symbol.
 */

import type { CompositeSignal, OrderFlowSignal, FearGreedSignal, FundingRateSignal, HyperliquidSignal, StablecoinRegimeSignal, BollingerState, VwapState } from './market-intel.js';
import {
  computeRSI,
  computeRSI2,
  computeMACD,
  computeBollinger,
  computeVwap,
  computeStochastic,
  computeWeightedOBI,
} from './market-intel-indicators.js';

function round(v: number, d: number): number { return Number(v.toFixed(d)); }

interface OhlcBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

interface PriceVolume {
  price: number;
  volume: number;
  timestamp: number;
}

/** Detect nearest support/resistance levels from recent price action */
export function getSupportResistance(
  priceHistory: Map<string, number[]>,
  symbol: string
): { support: number; resistance: number; nearSupport: boolean; nearResistance: boolean } | null {
  const prices = priceHistory.get(symbol);
  if (!prices || prices.length < 30) return null;

  const recent = prices.slice(-50);
  const current = prices[prices.length - 1]!;

  // Find local highs and lows (pivot points)
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i]! > recent[i - 1]! && recent[i]! > recent[i - 2]! && recent[i]! > recent[i + 1]! && recent[i]! > recent[i + 2]!) {
      highs.push(recent[i]!);
    }
    if (recent[i]! < recent[i - 1]! && recent[i]! < recent[i - 2]! && recent[i]! < recent[i + 1]! && recent[i]! < recent[i + 2]!) {
      lows.push(recent[i]!);
    }
  }

  const resistance = highs.length > 0 ? Math.max(...highs) : current * 1.005;
  const support = lows.length > 0 ? Math.min(...lows) : current * 0.995;
  const range = resistance - support;
  const nearSupport = range > 0 && (current - support) / range < 0.15;
  const nearResistance = range > 0 && (resistance - current) / range < 0.15;

  return { support: round(support, 2), resistance: round(resistance, 2), nearSupport, nearResistance };
}

/**
 * Build a composite trading signal for a single symbol by aggregating all indicators.
 */
export function computeCompositeSignal(
  symbol: string,
  orderFlow: Map<string, OrderFlowSignal>,
  fearGreed: FearGreedSignal | null,
  priceHistory: Map<string, number[]>,
  volumeHistory: Map<string, PriceVolume[]>,
  barHistory: Map<string, OhlcBar[]>,
  fundingRates?: Map<string, FundingRateSignal>,
  hlData?: Map<string, HyperliquidSignal>,
  venueDivergence?: boolean,
  stableRegime?: StablecoinRegimeSignal | null,
): CompositeSignal {
  const reasons: string[] = [];
  let score = 0; // positive = bullish, negative = bearish

  // Order flow (weight: 40% + microstructure refinements)
  const flow = orderFlow.get(symbol);
  let adverseSelectionRisk = 0;
  let quoteStabilityMs = 0;
  if (flow) {
    if (flow.direction === 'buy' && flow.strength === 'strong') { score += 40; reasons.push(`Strong buy flow (${flow.imbalancePct}% imbalance)`); }
    else if (flow.direction === 'buy' && flow.strength === 'moderate') { score += 25; reasons.push(`Moderate buy flow (${flow.imbalancePct}%)`); }
    else if (flow.direction === 'sell' && flow.strength === 'strong') { score -= 40; reasons.push(`Strong sell flow (${flow.imbalancePct}%)`); }
    else if (flow.direction === 'sell' && flow.strength === 'moderate') { score -= 25; reasons.push(`Moderate sell flow (${flow.imbalancePct}%)`); }

    if (typeof flow.pressureImbalancePct === 'number') {
      if (flow.pressureImbalancePct >= 25) {
        score += 10;
        reasons.push(`Bullish book pressure (${flow.pressureImbalancePct.toFixed(1)}%)`);
      } else if (flow.pressureImbalancePct <= -25) {
        score -= 10;
        reasons.push(`Bearish book pressure (${flow.pressureImbalancePct.toFixed(1)}%)`);
      }
    }

    adverseSelectionRisk = flow.adverseSelectionScore ?? 0;
    quoteStabilityMs = flow.spreadStableMs ?? 0;
    if (quoteStabilityMs > 0 && quoteStabilityMs < 2_500) {
      score *= 0.8;
      reasons.push(`Quotes unstable (${Math.round(quoteStabilityMs)} ms spread age)`);
    }
    if (adverseSelectionRisk >= 70) {
      score *= 0.7;
      reasons.push(`Adverse selection elevated (${adverseSelectionRisk.toFixed(1)})`);
    }
  }

  // Fear & Greed (weight: 15%)
  if (fearGreed) {
    if (fearGreed.contrarian === 'buy') { score += 15; reasons.push(`Extreme Fear (${fearGreed.value}) = contrarian buy`); }
    else if (fearGreed.contrarian === 'sell') { score -= 15; reasons.push(`Extreme Greed (${fearGreed.value}) = contrarian sell`); }
  }

  // Bollinger (weight: 20%)
  const bb = computeBollinger(priceHistory, symbol);
  if (bb) {
    if (bb.pricePosition < 0.1) { score += 20; reasons.push(`Price at lower Bollinger band (oversold)`); }
    else if (bb.pricePosition > 0.9) { score -= 20; reasons.push(`Price at upper Bollinger band (overbought)`); }
    if (bb.squeeze) { reasons.push('Bollinger squeeze detected — big move imminent'); }
  }

  // VWAP (weight: 15%)
  const vw = computeVwap(volumeHistory, symbol);
  if (vw) {
    if (vw.signal === 'buy') { score += 15; reasons.push(`Below VWAP (${vw.deviation}% deviation)`); }
    else if (vw.signal === 'sell') { score -= 15; reasons.push(`Above VWAP (${vw.deviation}% deviation)`); }
  }

  // Trend (weight: 10%)
  const prices = priceHistory.get(symbol);
  if (prices && prices.length >= 50) {
    const sma20 = prices.slice(-20).reduce((s, v) => s + v, 0) / 20;
    const sma50 = prices.slice(-50).reduce((s, v) => s + v, 0) / 50;
    if (sma20 > sma50) { score += 10; reasons.push('Short-term trend bullish (SMA20 > SMA50)'); }
    else { score -= 10; reasons.push('Short-term trend bearish (SMA20 < SMA50)'); }
  }

  // RSI (weight: 15%) — momentum confirmation
  if (prices && prices.length >= 15) {
    const rsi = computeRSI(prices, 14);
    // Guard degenerate series (flat/low-variance → RSI pins to 0 or 100, producing fake extremes)
    if (rsi !== null && rsi !== 100 && rsi !== 0) {
      if (rsi > 70) { score -= 15; reasons.push(`RSI overbought (${rsi.toFixed(0)})`); }
      else if (rsi < 30) { score += 15; reasons.push(`RSI oversold (${rsi.toFixed(0)})`); }
      else if (rsi > 55) { score += 5; reasons.push(`RSI bullish momentum (${rsi.toFixed(0)})`); }
      else if (rsi < 45) { score -= 5; reasons.push(`RSI bearish momentum (${rsi.toFixed(0)})`); }
    }
  }

  // MACD (weight: 10%) — trend change detection
  if (prices && prices.length >= 26) {
    const macd = computeMACD(prices);
    if (macd) {
      if (macd.histogram > 0 && macd.histogramPrev <= 0) { score += 10; reasons.push('MACD bullish crossover'); }
      else if (macd.histogram < 0 && macd.histogramPrev >= 0) { score -= 10; reasons.push('MACD bearish crossover'); }
      else if (macd.histogram > 0) { score += 3; reasons.push('MACD positive'); }
      else if (macd.histogram < 0) { score -= 3; reasons.push('MACD negative'); }
    }
  }

  // Support/Resistance (weight: 10%) — buy near support, sell near resistance
  const sr = getSupportResistance(priceHistory, symbol);
  if (sr) {
    if (sr.nearSupport) { score += 10; reasons.push(`Near support at ${sr.support}`); }
    if (sr.nearResistance) { score -= 10; reasons.push(`Near resistance at ${sr.resistance}`); }
  }

  // RSI(2) fast signal — Larry Connors' extreme mean-reversion edge. Readings at 0/100
  // are historically high-probability reversal signals, worth more weight than normal.
  // Bumped extreme to ±35 (was ±20) on 2026-04-17 so single-strong-signal setups clear
  // the 30-confidence tradeable threshold even when other indicators are quiet.
  const rsi2 = computeRSI2(priceHistory, symbol);
  // Guard degenerate series: when all prices are identical (flat market like stable forex),
  // RSI(2) pins to 100/0 and must NOT be used — it would produce phantom sell signals.
  // Require avg absolute change > 0.005% (0.5 bp) as evidence of genuine price movement.
  const avgChange = prices && prices.length >= 3
    ? prices.slice(-3).reduce((s, p, i, arr) => s + Math.abs(p - (arr[i - 1] ?? p)), 0) / 2 : 0;
  const hasVolatility = prices && prices.length >= 3 && avgChange > 0 && (avgChange / (prices[prices.length - 1] ?? 1)) > 0.00005;
  if (rsi2 !== null && rsi2 !== 100 && rsi2 !== 0 && hasVolatility) {
    if (rsi2 < 5) { score += 35; reasons.push(`RSI(2) extreme oversold (${rsi2.toFixed(1)}) — high-prob bounce`); }
    else if (rsi2 < 15) { score += 20; reasons.push(`RSI(2) very oversold (${rsi2.toFixed(1)})`); }
    else if (rsi2 < 25) { score += 10; reasons.push(`RSI(2) oversold (${rsi2.toFixed(1)})`); }
    else if (rsi2 > 95) { score -= 35; reasons.push(`RSI(2) extreme overbought (${rsi2.toFixed(1)}) — high-prob pullback`); }
    else if (rsi2 > 85) { score -= 20; reasons.push(`RSI(2) very overbought (${rsi2.toFixed(1)})`); }
    else if (rsi2 > 75) { score -= 10; reasons.push(`RSI(2) overbought (${rsi2.toFixed(1)})`); }
  }

  // Stochastic(14,3,3) confirmation (weight: 10%) — crossover signals
  const stoch = computeStochastic(barHistory, priceHistory, symbol);
  if (stoch) {
    if (stoch.crossover === 'bullish' && stoch.k < 30) { score += 10; reasons.push(`Stochastic bullish crossover in oversold zone (K=${stoch.k})`); }
    else if (stoch.crossover === 'bearish' && stoch.k > 70) { score -= 10; reasons.push(`Stochastic bearish crossover in overbought zone (K=${stoch.k})`); }
    else if (stoch.crossover === 'bullish') { score += 4; reasons.push(`Stochastic bullish crossover (K=${stoch.k})`); }
    else if (stoch.crossover === 'bearish') { score -= 4; reasons.push(`Stochastic bearish crossover (K=${stoch.k})`); }
  }

  // Weighted OBI (weight: 10%) — near-touch order book pressure
  const obiWeighted = computeWeightedOBI(orderFlow, symbol);
  if (obiWeighted !== null && Math.abs(obiWeighted) > 0.3) {
    const obiScore = obiWeighted > 0 ? 10 : -10;
    score += obiScore;
    reasons.push(`Weighted OBI ${obiWeighted > 0 ? 'bid' : 'ask'} pressure (${(obiWeighted * 100).toFixed(1)}%)`);
  }

  // Perp funding rate (weight: ~8%) — contrarian bias. Crowded longs (extreme positive
  // funding) → short-biased; crowded shorts → long-biased. Only fires when an extreme
  // reading is present so it doesn't dampen normal signals.
  const funding = fundingRates?.get(symbol);
  if (funding && funding.bias !== 'neutral') {
    const strong = funding.extreme ? 8 : 4;
    if (funding.bias === 'sell') {
      score -= strong;
      reasons.push(`Funding crowded long (${funding.annualizedPct.toFixed(1)}% annualized) — contrarian short bias`);
    } else {
      score += strong;
      reasons.push(`Funding crowded short (${funding.annualizedPct.toFixed(1)}% annualized) — contrarian long bias`);
    }
  }

  // Hyperliquid OI momentum (weight: 10). Accelerating OI with price direction = strong trend.
  const hl = hlData?.get(symbol);
  if (hl && Math.abs(hl.oiMomentumPct) >= 0.5) {
    const last = priceHistory.get(symbol);
    const priceDir = last && last.length >= 2 ? Math.sign(last[last.length - 1]! - last[last.length - 5]!) : 0;
    if (priceDir !== 0 && Math.sign(hl.oiMomentumPct) === priceDir) {
      const strong = Math.abs(hl.oiMomentumPct) >= 2 ? 10 : 5;
      score += priceDir * strong;
      reasons.push(`HL OI ${hl.oiMomentumPct.toFixed(2)}% confirms ${priceDir > 0 ? 'up' : 'down'} trend`);
    } else if (priceDir !== 0) {
      // OI up while price down (or vice versa) = reversal warning
      score -= priceDir * 4;
      reasons.push(`HL OI divergence from price — reversal risk`);
    }
  }

  // Stablecoin inflow/outflow regime — directional bias for major crypto
  if (stableRegime && (symbol.endsWith('-USD') || symbol.startsWith('BTC') || symbol.startsWith('ETH') || symbol.startsWith('SOL') || symbol.startsWith('XRP'))) {
    if (stableRegime.regime === 'inflow') { score += 12; reasons.push(`Stablecoin inflow regime (${stableRegime.changePct24h?.toFixed(2)}%) — buying pressure`); }
    else if (stableRegime.regime === 'outflow') { score -= 12; reasons.push(`Stablecoin outflow regime (${stableRegime.changePct24h?.toFixed(2)}%) — selling pressure`); }
  }

  const confidence = Math.min(Math.abs(score), 100);
  const direction: CompositeSignal['direction'] =
    score >= 50 ? 'strong-buy' :
    score >= 20 ? 'buy' :
    score <= -50 ? 'strong-sell' :
    score <= -20 ? 'sell' : 'neutral';

  // Gating thresholds:
  // - confidence floor 20 for forex (EUR/GBP/USD-JPY trade on macro regime, not momentum)
  //   previously 30 blocked ALL 3 forex pairs since they have weak intraday signals
  // - direction can be neutral if Bollinger squeeze is detected (breakout setup, no pre-direction)
  // - adverse floor 75 for non-crypto (forex spreads are tighter)
  // - stability: 0ms allowed (forex has no order-flow stream, quoteStability stays 0)
  const isCrypto = symbol.endsWith('-USD') && !symbol.includes('_');
  // Forex tradeable conditions:
  // - Standard: confidence >= 15 + non-neutral direction (momentum breakout)
  // - Squeeze: confidence >= 5 + Bollinger squeeze (breakout setups need no pre-direction)
  // Squeeze bypass exists because by definition squeeze = low vol = low confidence = valid entry
  const isForex = symbol.includes('_') && (
    symbol.endsWith('_USD') || symbol.endsWith('_JPY') || symbol.includes('AUD')
  );
  const hasSqueeze = bb?.squeeze ?? false;
  const adverseFloor = isCrypto ? 60 : 75;
  const tradeableForex = hasSqueeze
    ? confidence >= 5 && adverseSelectionRisk < adverseFloor
    : confidence >= 15 && direction !== 'neutral' && adverseSelectionRisk < adverseFloor;
  const tradeableCrypto = confidence >= 30 && direction !== 'neutral' && adverseSelectionRisk < adverseFloor && (quoteStabilityMs === 0 || quoteStabilityMs >= 1_000);
  const tradeable = isForex
    ? tradeableForex
    : (isCrypto && symbol === 'BTC-USD' && venueDivergence) ? false : tradeableCrypto;
  return {
    symbol,
    direction,
    confidence,
    reasons,
    tradeable,
    venueDivergence: Boolean(venueDivergence),
    adverseSelectionRisk: round(adverseSelectionRisk, 1),
    quoteStabilityMs,
    rsi2: rsi2 !== null ? round(rsi2, 1) : undefined,
    stochastic: stoch ?? undefined,
    obiWeighted: obiWeighted !== null ? obiWeighted : undefined
  };
}
