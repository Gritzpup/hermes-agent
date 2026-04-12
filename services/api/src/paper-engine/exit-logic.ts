/**
 * Exit Logic Module
 *
 * Dynamic stop/target calculation and trailing stop management.
 * Pure functions — no shared state.
 */

import type { AgentConfig, AgentStyle, PositionDirection, PositionState, SymbolState } from './types.js';
import { roundTripFeeBps } from './scoring.js';

/**
 * Compute a dynamic stop price using ATR if available.
 */
export function computeDynamicStop(
  entryPrice: number,
  stopBps: number,
  direction: PositionDirection,
  assetClass: string,
  atr: number | null
): number {
  if (atr && atr > 0) {
    const atrStop = atr * 1.5;
    const bpsStop = entryPrice * (stopBps / 10_000);
    const stop = Math.max(atrStop, bpsStop);
    return direction === 'short'
      ? entryPrice + stop
      : entryPrice - stop;
  }
  return direction === 'short'
    ? entryPrice * (1 + stopBps / 10_000)
    : entryPrice * (1 - stopBps / 10_000);
}

/**
 * Compute a dynamic target price using ATR if available.
 */
export function computeDynamicTarget(
  entryPrice: number,
  targetBps: number,
  direction: PositionDirection,
  assetClass: string,
  atr: number | null
): number {
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
export function getTrailingStopParams(
  assetClass: string,
  fearGreedValue: number | null
): { beActivation: number; trailActivation: number; trailRatio: number } {
  const extremeFearCrypto = fearGreedValue !== null && fearGreedValue <= 25 && assetClass === 'crypto';
  return {
    beActivation: extremeFearCrypto ? 0.25 : 0.4,
    trailActivation: extremeFearCrypto ? 0.35 : 0.7,
    trailRatio: extremeFearCrypto ? 0.75 : 0.5
  };
}

/**
 * Catastrophic stop threshold based on strategy style.
 * Returns the multiplier (e.g., 0.98 = -2%).
 */
export function getCatastrophicStopPct(style: AgentStyle): number {
  return style === 'momentum' ? 0.98
    : style === 'breakout' ? 0.985
    : 0.99;
}

/**
 * Generate a human-readable entry note.
 */
export function entryNote(style: AgentStyle, symbol: SymbolState, score: number): string {
  if (style === 'momentum') {
    return `Bought ${symbol.symbol} momentum squeeze after positive tape acceleration. Score ${score.toFixed(2)}.`;
  }
  if (style === 'breakout') {
    return `Bought ${symbol.symbol} on breakout through short-term range high. Score ${score.toFixed(2)}.`;
  }
  return `Bought ${symbol.symbol} on short-term overreaction into mean-reversion zone. Score ${score.toFixed(2)}.`;
}

/**
 * Estimated broker round-trip cost in basis points for a given symbol.
 */
export function estimatedBrokerRoundTripCostBps(assetClass: string, spreadBps: number): number {
  if (assetClass === 'crypto') {
    return Math.max(26, spreadBps * 2 + 8);
  }
  return Math.max(4, spreadBps * 1.75 + 1.5);
}
