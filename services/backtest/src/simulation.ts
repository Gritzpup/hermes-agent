import type { BacktestAgentConfig, BacktestCandle, BacktestFill, BacktestResult } from '@hermes/contracts';
import { randomUUID } from 'node:crypto';

const STARTING_EQUITY = 100_000;
const CRYPTO_TAKER_FEE_BPS = 6.0;
const CRYPTO_MAKER_FEE_BPS = 2.0;
const EQUITY_SLIPPAGE_BPS = 0.8;
const CRYPTO_SLIPPAGE_BPS = 1.8;
const FOREX_SLIPPAGE_BPS = 0.7;
const BOND_SLIPPAGE_BPS = 0.8;
const COMMODITY_SLIPPAGE_BPS = 1.0;

function assetClassForSymbol(symbol: string): 'crypto' | 'equity' | 'forex' | 'bond' | 'commodity' | 'commodity-proxy' {
  const normalized = symbol.toUpperCase();
  if (normalized.endsWith('-USD')) {
    const base = normalized.split('-')[0] ?? '';
    if (['BTC', 'ETH', 'SOL', 'XRP'].includes(base)) return 'crypto';
    if (base === 'PAXG') return 'commodity-proxy';
    if (base === 'BCO' || base === 'WTICO') return 'commodity';
    return 'commodity-proxy';
  }
  if (normalized.includes('_')) {
    if (normalized.startsWith('USB')) return 'bond';
    if (normalized.startsWith('BCO') || normalized.startsWith('WTICO')) return 'commodity';
    return 'forex';
  }
  return 'equity';
}

function feeRate(symbol: string): number {
  const assetClass = assetClassForSymbol(symbol);
  if (assetClass === 'crypto') {
    return (CRYPTO_TAKER_FEE_BPS * 0.5) / 10_000;
  }
  return 0;
}

function roundTripCostBps(symbol: string): number {
  const assetClass = assetClassForSymbol(symbol);
  const spread = estimatedSpreadBps(symbol);
  const feeBps = assetClass === 'crypto' ? CRYPTO_TAKER_FEE_BPS * 2 : 0;
  const slippage = assetClass === 'crypto'
    ? CRYPTO_SLIPPAGE_BPS
    : assetClass === 'equity'
      ? EQUITY_SLIPPAGE_BPS
      : assetClass === 'forex'
        ? FOREX_SLIPPAGE_BPS
        : assetClass === 'bond'
          ? BOND_SLIPPAGE_BPS
          : COMMODITY_SLIPPAGE_BPS;
  return feeBps + spread + slippage;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = average(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1));
}

function pickLast(values: number[], n: number): number[] {
  return values.slice(Math.max(values.length - n, 0));
}

function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = values[0]!;
  for (let i = 1; i < values.length; i++) {
    e = values[i]! * k + e * (1 - k);
  }
  return e;
}

// Realistic spread by asset class
function estimatedSpreadBps(symbol: string): number {
  const assetClass = assetClassForSymbol(symbol);
  if (assetClass === 'crypto') return 3.0;
  if (assetClass === 'forex') return 1.2;
  if (assetClass === 'bond') return 1.0;
  if (assetClass === 'commodity') return 1.5;
  if (assetClass === 'commodity-proxy') return 1.3;
  return 1.0;
}

interface Position {
  side: 'long' | 'short';
  entryPrice: number;
  quantity: number;
  entryIndex: number;
  stopPrice: number;
  targetPrice: number;
  peakPrice: number;
  trailingStop: number;
}

/**
 * Improved entry scoring with regime awareness.
 * Returns a score where higher = stronger signal.
 */
function computeEntrySignal(
  style: string,
  prices: number[],
  returns: number[],
  volatility: number,
  trendStrength: number,
  multiplier: number
): { score: number; pass: boolean; direction: 'long' | 'short' } {
  if (prices.length < 20) return { score: 0, pass: false, direction: 'long' };

  const price = prices[prices.length - 1]!;
  const shortSma = average(pickLast(prices, 5));
  const longSma = average(pickLast(prices, 20));
  const shortReturn = (price - prices[Math.max(prices.length - 6, 0)]!) / prices[Math.max(prices.length - 6, 0)]!;
  const medReturn = (price - prices[Math.max(prices.length - 12, 0)]!) / prices[Math.max(prices.length - 12, 0)]!;

  // Volatility filter: don't trade in dead chop or extreme volatility
  const volTooLow = volatility < 0.0002;
  const volTooHigh = volatility > 0.005;
  if (volTooLow || volTooHigh) return { score: 0, pass: false, direction: 'long' };

  if (style === 'momentum') {
    // LONG: price above short SMA above long SMA, positive acceleration
    const longAligned = shortSma > longSma && price > shortSma;
    const longAccel = shortReturn > medReturn * 0.5 && shortReturn > 0;
    const longScore = (shortReturn * 800 + medReturn * 400 + trendStrength * 500) * multiplier;

    // SHORT: price below short SMA below long SMA, negative acceleration
    const shortAligned = shortSma < longSma && price < shortSma;
    const shortAccel = shortReturn < medReturn * 0.5 && shortReturn < 0;
    const shortScore = (-shortReturn * 800 + -medReturn * 400 + -trendStrength * 500) * multiplier;

    const threshold = 2.5 * multiplier;
    if (longAligned && longAccel && longScore > threshold) return { score: longScore, pass: true, direction: 'long' as const };
    if (shortAligned && shortAccel && shortScore > threshold) return { score: shortScore, pass: true, direction: 'short' as const };
    return { score: Math.max(longScore, shortScore), pass: false, direction: 'long' as const };
  }

  if (style === 'mean-reversion') {
    const deviation = (price - longSma) / longSma;

    // LONG: oversold bounce
    const oversold = deviation < -0.001;
    const bouncing = shortReturn > 0 && returns.length > 2 && returns[returns.length - 2]! < 0;
    const longScore = (-deviation * 1200 + (bouncing ? 2 : 0)) * multiplier;

    // SHORT: overbought reversal
    const overbought = deviation > 0.001;
    const fading = shortReturn < 0 && returns.length > 2 && returns[returns.length - 2]! > 0;
    const shortScore = (deviation * 1200 + (fading ? 2 : 0)) * multiplier;

    const threshold = 1.5 * multiplier;
    if (oversold && bouncing && longScore > threshold) return { score: longScore, pass: true, direction: 'long' as const };
    if (overbought && fading && shortScore > threshold) return { score: shortScore, pass: true, direction: 'short' as const };
    return { score: Math.max(longScore, shortScore), pass: false, direction: 'long' as const };
  }

  if (style === 'breakout') {
    const recentHigh = Math.max(...pickLast(prices, 20).slice(0, -1));
    const recentLow = Math.min(...pickLast(prices, 20).slice(0, -1));
    const volExpanding = volatility > average(pickLast(returns.map(Math.abs), 30)) * 1.2;

    // LONG breakout
    const breakingUp = price > recentHigh;
    const longScore = ((price / recentHigh - 1) * 1500 + (volExpanding ? 2 : 0) + shortReturn * 600) * multiplier;

    // SHORT breakdown
    const breakingDown = price < recentLow;
    const shortScore = ((recentLow / price - 1) * 1500 + (volExpanding ? 2 : 0) + -shortReturn * 600) * multiplier;

    const threshold = 2.0 * multiplier;
    if (breakingUp && longScore > threshold) return { score: longScore, pass: true, direction: 'long' as const };
    if (breakingDown && shortScore > threshold) return { score: shortScore, pass: true, direction: 'short' as const };
    return { score: Math.max(longScore, shortScore), pass: false, direction: 'long' as const };
  }

  return { score: 0, pass: false, direction: 'long' as const };
}

export function runBacktest(candles: BacktestCandle[], config: BacktestAgentConfig, symbol: string): BacktestResult {
  const entryMult = config.entryThresholdMultiplier ?? 1;
  const exitMult = config.exitThresholdMultiplier ?? 1;
  const spreadBps = estimatedSpreadBps(symbol);
  const rtCostBps = roundTripCostBps(symbol);

  // Ensure target exceeds round-trip costs
  const effectiveTargetBps = Math.max(config.targetBps, rtCostBps * 1.5);
  const effectiveStopBps = config.stopBps;

  const fills: BacktestFill[] = [];
  const equityCurve: number[] = [];
  const priceHistory: number[] = [];
  const returnHistory: number[] = [];
  let cash = STARTING_EQUITY;
  let position: Position | null = null;
  let wins = 0;
  let losses = 0;
  let grossWins = 0;
  let grossLosses = 0;
  let cooldown = 0;
  let peak = STARTING_EQUITY;
  let maxDrawdown = 0;
  const tradeReturns: number[] = [];

  // Rolling volatility
  let rollingVol = 0;
  let trendStrength = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    const price = candle.close;

    if (priceHistory.length > 0) {
      const prevPrice = priceHistory[priceHistory.length - 1]!;
      const ret = (price - prevPrice) / prevPrice;
      returnHistory.push(ret);

      // Update rolling metrics
      const recentReturns = pickLast(returnHistory, 30);
      rollingVol = stddev(recentReturns);
      trendStrength = trendStrength * 0.95 + ret * 0.05;
    }

    priceHistory.push(price);

    const equity = position ? cash + position.quantity * price : cash;
    equityCurve.push(round(equity, 2));
    peak = Math.max(peak, equity);
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, dd);

    if (priceHistory.length < 25) continue;

    // === MANAGE EXISTING POSITION ===
    if (position) {
      const holdTicks = i - position.entryIndex;
      const isLong = position.side === 'long';

      // Profit tracking
      const unrealizedBps = isLong
        ? (price - position.entryPrice) / position.entryPrice * 10_000
        : (position.entryPrice - price) / position.entryPrice * 10_000;

      // Dynamic trailing stop
      if (unrealizedBps > effectiveTargetBps * 0.4) {
        const costBuffer = feeRate(symbol) * position.entryPrice * 3;
        const breakeven = isLong
          ? position.entryPrice + costBuffer
          : position.entryPrice - costBuffer;
        if (isLong) position.trailingStop = Math.max(position.trailingStop, breakeven);
        else position.trailingStop = Math.min(position.trailingStop, breakeven);
      }
      if (unrealizedBps > effectiveTargetBps * 0.7) {
        const trail = isLong
          ? position.entryPrice + (price - position.entryPrice) * 0.5
          : position.entryPrice - (position.entryPrice - price) * 0.5;
        if (isLong) position.trailingStop = Math.max(position.trailingStop, trail);
        else position.trailingStop = Math.min(position.trailingStop, trail);
      }

      const targetHit = isLong ? price >= position.targetPrice : price <= position.targetPrice;
      const effectiveStop = isLong
        ? Math.max(position.stopPrice, position.trailingStop)
        : Math.min(position.stopPrice, position.trailingStop);
      const stopHit = isLong ? price <= effectiveStop : price >= effectiveStop;
      const timeoutHit = holdTicks >= config.maxHoldTicks;

      const { score } = computeEntrySignal(config.style, priceHistory, returnHistory, rollingVol, trendStrength, entryMult);
      const fadeThreshold = config.style === 'momentum' ? -1.0 : config.style === 'breakout' ? -0.5 : -2.0;
      const sustainedFade = holdTicks >= 5 && score < fadeThreshold * exitMult;

      if (targetHit || stopHit || timeoutHit || sustainedFade) {
        const reason = targetHit ? 'target' : stopHit ? 'stop' : timeoutHit ? 'timeout' : 'fade';
        const exitPrice = targetHit
          ? position.targetPrice
          : stopHit
            ? effectiveStop
            : price;

        const grossPnl = isLong
          ? (exitPrice - position.entryPrice) * position.quantity
          : (position.entryPrice - exitPrice) * position.quantity;
        const fees = position.quantity * position.entryPrice * feeRate(symbol) * 2; // entry + exit fees
        const realized = grossPnl - fees;

        fills.push({ timestamp: candle.timestamp, side: 'sell', price: round(exitPrice, 2), pnl: round(realized, 2), reason });

        if (realized >= 0) { wins++; grossWins += realized; }
        else { losses++; grossLosses += Math.abs(realized); }

        cash += position.entryPrice * position.quantity + realized;
        tradeReturns.push(realized / STARTING_EQUITY);
        position = null;
        cooldown = config.cooldownTicks;
      }
      continue;
    }

    // === COOLDOWN ===
    if (cooldown > 0) {
      cooldown--;
      continue;
    }

    // === ENTRY LOGIC ===
    const { score, pass, direction } = computeEntrySignal(config.style, priceHistory, returnHistory, rollingVol, trendStrength, entryMult);

    if (pass && spreadBps <= config.spreadLimitBps) {
      const notional = Math.min(cash * config.sizeFraction, cash * 0.9);
      if (notional > 500) {
        const slippage = (spreadBps / 10_000) * 0.5;
        const fillPrice = direction === 'long'
          ? price * (1 + slippage)
          : price * (1 - slippage);
        const quantity = notional / fillPrice;
        cash -= notional; // reserve capital

        const targetPrice = direction === 'long'
          ? fillPrice * (1 + effectiveTargetBps / 10_000)
          : fillPrice * (1 - effectiveTargetBps / 10_000);
        const stopPrice = direction === 'long'
          ? fillPrice * (1 - effectiveStopBps / 10_000)
          : fillPrice * (1 + effectiveStopBps / 10_000);

        position = {
          side: direction,
          entryPrice: fillPrice,
          quantity,
          entryIndex: i,
          stopPrice,
          targetPrice,
          peakPrice: fillPrice,
          trailingStop: stopPrice
        };

        const sideLabel = direction === 'long' ? 'buy' : 'sell-short';
        fills.push({ timestamp: candle.timestamp, side: direction === 'long' ? 'buy' : 'sell', price: round(fillPrice, 2), pnl: 0, reason: `${sideLabel} score=${round(score, 1)}` });
      }
    }
  }

  // Close any remaining position
  if (position && candles.length > 0) {
    const lastCandle = candles[candles.length - 1]!;
    const exitPrice = lastCandle.close;
    const grossPnl = position.side === 'long'
      ? (exitPrice - position.entryPrice) * position.quantity
      : (position.entryPrice - exitPrice) * position.quantity;
    const fees = position.quantity * position.entryPrice * feeRate(symbol) * 2;
    const realized = grossPnl - fees;
    fills.push({ timestamp: lastCandle.timestamp, side: 'sell', price: round(exitPrice, 2), pnl: round(realized, 2), reason: 'end-of-data' });
    if (realized >= 0) { wins++; grossWins += realized; }
    else { losses++; grossLosses += Math.abs(realized); }
    cash += position.entryPrice * position.quantity + realized;
    tradeReturns.push(realized / STARTING_EQUITY);
  }

  const totalTrades = wins + losses;
  const totalReturn = cash - STARTING_EQUITY;
  const avgReturn = tradeReturns.length > 0 ? average(tradeReturns) : 0;
  const stdReturn = tradeReturns.length > 1 ? stddev(tradeReturns) : 0;
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

  return {
    id: randomUUID(),
    symbol,
    startDate: candles[0]?.timestamp ?? '',
    endDate: candles[candles.length - 1]?.timestamp ?? '',
    totalTrades,
    winRate: totalTrades > 0 ? round((wins / totalTrades) * 100, 1) : 0,
    profitFactor: grossLosses > 0 ? round(grossWins / grossLosses, 2) : grossWins > 0 ? 9.99 : 0,
    maxDrawdownPct: round(maxDrawdown, 2),
    sharpeRatio: round(sharpeRatio, 2),
    totalReturn: round(totalReturn, 2),
    totalReturnPct: round((totalReturn / STARTING_EQUITY) * 100, 2),
    equityCurve,
    fills
  };
}
