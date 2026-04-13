// @ts-nocheck
/**
 * Market Intelligence — Technical indicator computation.
 * Extracted from market-intel.ts for maintainability.
 *
 * Pure functions for RSI, MACD, Bollinger, ATR, VWAP, Stochastic, EMA.
 */

import type { BollingerState, VwapState, OrderFlowSignal } from './market-intel.js';

interface PriceVolume {
  price: number;
  volume: number;
  timestamp: number;
}

interface OhlcBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

function round(v: number, d: number): number { return Number(v.toFixed(d)); }

// ─── EMA ─────────────────────────────────────────────────────────────────────

export function ema(data: number[], period: number): number[] {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  let emaVal = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result.push(emaVal);
  for (let i = period; i < data.length; i++) {
    emaVal = data[i]! * k + emaVal * (1 - k);
    result.push(emaVal);
  }
  return result;
}

// ─── RSI ─────────────────────────────────────────────────────────────────────

export function computeRSI(prices: number[], period: number): number | null {
  if (prices.length < period + 1) return null;
  const changes = [];
  for (let i = prices.length - period; i < prices.length; i++) {
    changes.push(prices[i]! - prices[i - 1]!);
  }
  const gains = changes.filter((c) => c > 0);
  const losses = changes.filter((c) => c < 0).map((c) => Math.abs(c));
  const avgGain = gains.length > 0 ? gains.reduce((s, v) => s + v, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, v) => s + v, 0) / period : 0;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/** RSI(2) — fast mean-reversion signal on a symbol's price history */
export function computeRSI2(priceHistory: Map<string, number[]>, symbol: string): number | null {
  return computeRSI(priceHistory.get(symbol) ?? [], 2);
}

/** RSI(14) — standard period RSI */
export function computeRSI14(priceHistory: Map<string, number[]>, symbol: string): number | null {
  return computeRSI(priceHistory.get(symbol) ?? [], 14);
}

/** RSI(14) on 5-minute bars */
export function computeRSI14_5m(bar5mHistory: Map<string, OhlcBar[]>, symbol: string): number | null {
  const bars = bar5mHistory.get(symbol);
  if (!bars || bars.length < 15) return null;
  return computeRSI(bars.map((b) => b.close), 14);
}

// ─── MACD ────────────────────────────────────────────────────────────────────

export function computeMACD(prices: number[]): { macdLine: number; signalLine: number; histogram: number; histogramPrev: number } | null {
  if (prices.length < 27) return null;
  const ema12 = ema(prices, 12);
  const ema26 = ema(prices, 26);
  if (ema12.length < 2 || ema26.length < 2) return null;
  const macdLine = ema12[ema12.length - 1]! - ema26[ema26.length - 1]!;
  const macdPrev = ema12[ema12.length - 2]! - ema26[ema26.length - 2]!;
  const macdSeries = ema12.map((v, i) => v - (ema26[i] ?? v));
  const signal = ema(macdSeries, 9);
  const signalLine = signal[signal.length - 1] ?? 0;
  const signalPrev = signal[signal.length - 2] ?? 0;
  return {
    macdLine,
    signalLine,
    histogram: macdLine - signalLine,
    histogramPrev: macdPrev - signalPrev
  };
}

/** MACD histogram on 15-minute bars */
export function computeMACD15m(bar15mHistory: Map<string, OhlcBar[]>, symbol: string): number | null {
  const bars = bar15mHistory.get(symbol);
  if (!bars || bars.length < 27) return null;
  const macd = computeMACD(bars.map((b) => b.close));
  return macd?.histogram ?? null;
}

// ─── Bollinger Bands ─────────────────────────────────────────────────────────

export function computeBollinger(priceHistory: Map<string, number[]>, symbol: string): BollingerState | null {
  const prices = priceHistory.get(symbol);
  if (!prices || prices.length < 20) return null;

  const period = 20;
  const recent = prices.slice(-period);
  const middle = recent.reduce((s, v) => s + v, 0) / recent.length;
  const std = Math.sqrt(recent.reduce((s, v) => s + (v - middle) ** 2, 0) / recent.length);
  const upper = middle + 2 * std;
  const lower = middle - 2 * std;
  const bandwidth = upper - lower;
  const price = prices[prices.length - 1]!;
  const pricePosition = bandwidth > 0 ? (price - lower) / bandwidth : 0.5;

  // Squeeze: bandwidth is in bottom 20% of its recent range
  const recentBandwidths = [];
  for (let i = period; i <= prices.length; i++) {
    const window = prices.slice(i - period, i);
    const m = window.reduce((s, v) => s + v, 0) / window.length;
    const sd = Math.sqrt(window.reduce((s, v) => s + (v - m) ** 2, 0) / window.length);
    recentBandwidths.push(4 * sd);
  }
  const bandwidthRank = recentBandwidths.filter((b) => b < bandwidth).length / Math.max(recentBandwidths.length, 1);
  const squeeze = bandwidthRank < 0.2;

  return {
    symbol,
    upper: round(upper, 2),
    middle: round(middle, 2),
    lower: round(lower, 2),
    bandwidth: round(bandwidth, 2),
    squeeze,
    pricePosition: round(pricePosition, 3)
  };
}

// ─── VWAP ────────────────────────────────────────────────────────────────────

export function computeVwap(volumeHistory: Map<string, PriceVolume[]>, symbol: string): VwapState | null {
  const vh = volumeHistory.get(symbol);
  if (!vh || vh.length < 10) return null;

  let cumPV = 0;
  let cumV = 0;
  for (const point of vh) {
    cumPV += point.price * point.volume;
    cumV += point.volume;
  }
  const vwap = cumV > 0 ? cumPV / cumV : 0;
  const price = vh[vh.length - 1]!.price;
  const deviation = price > 0 ? ((price - vwap) / price) * 100 : 0;
  const signal: VwapState['signal'] = deviation < -0.1 ? 'buy' : deviation > 0.1 ? 'sell' : 'neutral';

  // VWAP slope: compare recent VWAP to older VWAP to detect chop vs trend
  let slope = 0;
  if (vh.length >= 20) {
    const recentHalf = vh.slice(-10);
    const olderHalf = vh.slice(-20, -10);
    let recentPV = 0, recentV = 0, olderPV = 0, olderV = 0;
    for (const p of recentHalf) { recentPV += p.price * p.volume; recentV += p.volume; }
    for (const p of olderHalf) { olderPV += p.price * p.volume; olderV += p.volume; }
    const recentVwap = recentV > 0 ? recentPV / recentV : 0;
    const olderVwap = olderV > 0 ? olderPV / olderV : 0;
    slope = olderVwap > 0 ? ((recentVwap - olderVwap) / olderVwap) * 100 : 0;
  }
  const isFlat = Math.abs(slope) < 0.01;

  return { symbol, vwap: round(vwap, 2), price: round(price, 2), deviation: round(deviation, 3), slope: round(slope, 4), signal, isFlat };
}

// ─── ATR ─────────────────────────────────────────────────────────────────────

export function computeATR(
  barHistory: Map<string, OhlcBar[]>,
  priceHistory: Map<string, number[]>,
  symbol: string,
  period = 14
): number | null {
  // Use OHLC bars for proper true range if available
  const bars = barHistory.get(symbol);
  if (bars && bars.length >= period + 1) {
    const trs: number[] = [];
    for (let i = bars.length - period; i < bars.length; i++) {
      const bar = bars[i]!;
      const prevClose = bars[i - 1]!.close;
      const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
      trs.push(tr);
    }
    return trs.reduce((s, v) => s + v, 0) / trs.length;
  }
  // Fallback: close-to-close proxy
  const prices = priceHistory.get(symbol);
  if (!prices || prices.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = prices.length - period; i < prices.length; i++) {
    trs.push(Math.abs(prices[i]! - prices[i - 1]!));
  }
  return trs.reduce((s, v) => s + v, 0) / trs.length;
}

// ─── Stochastic ──────────────────────────────────────────────────────────────

export function computeStochastic(
  barHistory: Map<string, OhlcBar[]>,
  priceHistory: Map<string, number[]>,
  symbol: string,
  kPeriod = 14,
  dPeriod = 3
): { k: number; d: number; crossover: 'bullish' | 'bearish' | 'none' } | null {
  const bars = barHistory.get(symbol);
  const useBars = bars && bars.length >= kPeriod + dPeriod;
  const prices = priceHistory.get(symbol);
  if (!useBars && (!prices || prices.length < kPeriod + dPeriod)) return null;

  const kValues: number[] = [];
  const dataLen = useBars ? bars!.length : prices!.length;
  for (let end = dataLen - dPeriod - 1; end < dataLen; end++) {
    let lowestLow: number, highestHigh: number, close: number;
    if (useBars) {
      const window = bars!.slice(Math.max(0, end - kPeriod + 1), end + 1);
      lowestLow = Math.min(...window.map((b) => b.low));
      highestHigh = Math.max(...window.map((b) => b.high));
      close = bars![end]!.close;
    } else {
      const window = prices!.slice(Math.max(0, end - kPeriod + 1), end + 1);
      lowestLow = Math.min(...window);
      highestHigh = Math.max(...window);
      close = prices![end]!;
    }
    const range = highestHigh - lowestLow;
    kValues.push(range > 0 ? ((close - lowestLow) / range) * 100 : 50);
  }

  // %D = 3-period SMA of %K
  const dValues: number[] = [];
  for (let i = dPeriod - 1; i < kValues.length; i++) {
    const slice = kValues.slice(i - dPeriod + 1, i + 1);
    dValues.push(slice.reduce((s, v) => s + v, 0) / dPeriod);
  }

  if (dValues.length < 2) return null;

  const k = kValues[kValues.length - 1]!;
  const d = dValues[dValues.length - 1]!;
  const prevK = kValues[kValues.length - 2]!;
  const prevD = dValues[dValues.length - 2]!;

  let crossover: 'bullish' | 'bearish' | 'none' = 'none';
  if (prevK <= prevD && k > d) crossover = 'bullish';
  else if (prevK >= prevD && k < d) crossover = 'bearish';

  return { k: round(k, 1), d: round(d, 1), crossover };
}

// ─── Weighted OBI ────────────────────────────────────────────────────────────

export function computeWeightedOBI(orderFlow: Map<string, OrderFlowSignal>, symbol: string): number | null {
  const flow = orderFlow.get(symbol);
  if (!flow) return null;
  const pct = flow.weightedImbalancePct ?? flow.imbalancePct;
  return round(pct / 100, 3);
}
