/**
 * Entry Scoring Module
 *
 * Pure functions for computing entry scores with RSI, Stochastic, and insider bonuses.
 * No shared state — all inputs passed as parameters.
 */

import type { AgentStyle, SymbolState } from './types.js';
import type { MarketIntelligence } from '../market-intel.js';
import { getInsiderRadar } from '../insider-radar.js';
import { average, pickLast } from '../paper-engine-utils.js';

/**
 * Compute the entry quality score for a given style and market conditions.
 * Higher score = stronger entry signal.
 */
export function computeEntryScore(
  style: AgentStyle,
  shortReturn: number,
  mediumReturn: number,
  symbol: SymbolState,
  marketIntel: MarketIntelligence
): number {
  if (symbol.price <= 0 || symbol.history.length < 2) return 0;
  const spreadPenalty = symbol.spreadBps * 0.03;
  const avg = average(pickLast(symbol.history, 12));
  const deviation = avg > 0 ? (symbol.price - avg) / symbol.price : 0;

  // RSI(2) bonus: extreme readings boost score significantly
  const rsi2 = marketIntel.computeRSI2(symbol.symbol);
  let rsi2Bonus = 0;
  if (rsi2 !== null) {
    if (style === 'mean-reversion') {
      if (rsi2 < 10) rsi2Bonus = 3.0;
      else if (rsi2 < 25) rsi2Bonus = 1.5;
      else if (rsi2 > 75) rsi2Bonus = -1.0;
    } else {
      if (rsi2 > 65 && rsi2 < 85) rsi2Bonus = 0.8;
      else if (rsi2 < 15) rsi2Bonus = -1.5;
    }
  }

  // Stochastic bonus: crossovers in extreme zones
  const stoch = marketIntel.computeStochastic(symbol.symbol);
  let stochBonus = 0;
  if (stoch) {
    if (style === 'mean-reversion' && stoch.crossover === 'bullish' && stoch.k < 30) stochBonus = 1.5;
    else if (style === 'momentum' && stoch.crossover === 'bullish' && stoch.k > 50) stochBonus = 1.0;
    else if (stoch.crossover === 'bearish' && stoch.k > 70) stochBonus = -1.0;
  }

  // Insider signal bonus
  let insiderBonus = 0;
  try {
    const insiderSignal = getInsiderRadar().getSignal(symbol.symbol);
    if (insiderSignal && insiderSignal.convictionScore >= 0.5) {
      if (insiderSignal.direction === 'bullish') {
        insiderBonus = insiderSignal.isCluster ? 4.0 : 2.0;
        insiderBonus *= insiderSignal.convictionScore;
      } else if (insiderSignal.direction === 'bearish' && insiderSignal.convictionScore >= 0.7) {
        insiderBonus = -3.0 * insiderSignal.convictionScore;
      }
    }
  } catch { /* insider-radar not available */ }

  const indicatorBonus = rsi2Bonus + stochBonus + insiderBonus;

  if (style === 'momentum') {
    return shortReturn * 1400 + mediumReturn * 600 + symbol.bias * 1200 - spreadPenalty + indicatorBonus;
  }
  if (style === 'breakout') {
    const breakoutWindow = pickLast(symbol.history, 9).slice(0, -1);
    const breakoutBase = breakoutWindow.length > 0 ? Math.max(...breakoutWindow) : symbol.price;
    const breakout = symbol.price / breakoutBase - 1;
    return breakout * 2200 + shortReturn * 900 + symbol.bias * 900 - spreadPenalty + indicatorBonus;
  }
  return (-deviation * 1800) + (-shortReturn * 500) + (mediumReturn * 240) - spreadPenalty + indicatorBonus;
}

/**
 * Fee rate per side for a given asset class.
 */
export function getFeeRate(assetClass: string): number {
  if (assetClass === 'crypto') return 0.004;
  if (assetClass === 'forex') return 0;
  return 0.0001;
}

/**
 * Round-trip fee in basis points for target/stop calculations.
 */
export function roundTripFeeBps(assetClass: string): number {
  return getFeeRate(assetClass) * 10_000 * 2;
}
