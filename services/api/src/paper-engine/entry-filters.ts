/**
 * Entry Filters
 *
 * Pure filter functions for the canEnter() decision tree.
 * Each filter returns true to BLOCK the entry, false to allow.
 */

import type { AgentStyle, PositionDirection, SymbolState } from './types.js';

/** Time-of-day filter: only trade during peak hours for each asset class */
export function isTimeBlocked(assetClass: string): boolean {
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
export function isVwapBlocked(
  style: AgentStyle,
  assetClass: string,
  isVwapFlat: boolean,
  fearGreedValue: number | null,
  rsi2: number | null
): boolean {
  // Bypass for crypto capitulations — RSI(2) < 10 in extreme fear = buy the wick
  const cryptoCapitulation = assetClass === 'crypto' && fearGreedValue !== null && fearGreedValue <= 20 && rsi2 !== null && rsi2 < 10;
  if (style !== 'mean-reversion' && isVwapFlat && !cryptoCapitulation) return true;
  return false;
}

/** RSI(2) filter for entry quality */
export function isRsi2Blocked(
  style: AgentStyle,
  direction: PositionDirection,
  rsi2: number | null,
  fearGreedValue: number | null
): boolean {
  if (rsi2 === null) return false;
  // In extreme fear, relax RSI(2) filter for mean-reversion
  const rsi2Limit = (fearGreedValue !== null && fearGreedValue <= 20) ? 55 : 40;
  if (style === 'mean-reversion' && direction === 'long' && rsi2 > rsi2Limit) return true;
  if (style === 'mean-reversion' && direction === 'short' && rsi2 < 60) return true;
  if (style === 'momentum' && direction === 'long' && rsi2 > 85) return true;
  if (style === 'momentum' && direction === 'short' && rsi2 < 18) return true;
  return false;
}

/** RSI(14) multi-timeframe confirmation */
export function isRsi14Blocked(
  style: AgentStyle,
  direction: PositionDirection,
  rsi14: number | null,
  fearGreedValue: number | null
): boolean {
  if (rsi14 === null) return false;
  const rsi14Limit = (fearGreedValue !== null && fearGreedValue <= 20) ? 70 : 60;
  if (style === 'momentum' && direction === 'long' && rsi14 < 45) return true;
  if (style === 'mean-reversion' && direction === 'long' && rsi14 > rsi14Limit) return true;
  if (style === 'momentum' && direction === 'short' && rsi14 > 55) return true;
  if (style === 'mean-reversion' && direction === 'short' && rsi14 < 40) return true;
  return false;
}

/** Multi-timeframe 5m trend gate — only trade in direction of macro trend */
export function isTrendBlocked(
  style: AgentStyle,
  direction: PositionDirection,
  trend5m: 'up' | 'down' | 'flat' | null
): boolean {
  if (!trend5m || trend5m === 'flat') return false;
  if (style === 'momentum' && direction === 'long' && trend5m === 'down') return true;
  if (style === 'momentum' && direction === 'short' && trend5m === 'up') return true;
  return false;
}

/** Liquidity sweep detection — block after false breakouts */
export function isSweepBlocked(style: AgentStyle, isSweep: boolean): boolean {
  return style !== 'mean-reversion' && isSweep;
}

/** Realized vol ratio — don't enter when move already happened */
export function isVolSpikeBlocked(volRatio: number | null): boolean {
  return volRatio !== null && volRatio > 2.5;
}

/** Volume/volatility confirmation on RSI(2) longs in extreme fear */
export function isFallingKnifeBlocked(
  assetClass: string,
  direction: PositionDirection,
  rsi2: number | null,
  fearGreedValue: number | null,
  bollingerSqueeze: boolean,
  bollingerPosition: number
): boolean {
  if (assetClass !== 'crypto' || direction !== 'long' || rsi2 === null || rsi2 >= 10) return false;
  if (fearGreedValue === null || fearGreedValue >= 25) return false;
  // RSI(2) < 10 in extreme fear MUST have Bollinger squeeze OR price at bottom band
  if (!bollingerSqueeze && bollingerPosition > 0.05) return true; // falling knife
  return false;
}
