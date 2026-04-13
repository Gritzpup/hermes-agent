/**
 * Market Intelligence Module
 * 
 * Aggregates multiple data sources into actionable trading signals:
 * 
 * 1. ORDER FLOW: Coinbase L2 orderbook imbalance (FREE, no auth)
 *    - Bid/ask depth ratio reveals institutional positioning
 *    - >60% imbalance = strong directional signal
 * 
 * 2. FEAR & GREED INDEX: Crypto market sentiment (FREE)
 *    - Extreme fear (<20) = contrarian buy when flow agrees
 *    - Extreme greed (>80) = contrarian sell when flow agrees
 * 
 * 3. BOLLINGER SQUEEZE: Volatility contraction precedes big moves
 *    - When bands narrow, next move is likely large
 *    - Direction determined by order flow
 * 
 * 4. VWAP: Volume-weighted fair value
 *    - Price below VWAP = undervalued (buy)
 *    - Price above VWAP = overvalued (sell)
 * 
 * 5. MULTI-TIMEFRAME: Trend alignment across timeframes
 *    - All timeframes agree = highest confidence
 */

import {
  computeRSI,
  computeRSI2 as _computeRSI2,
  computeRSI14 as _computeRSI14,
  computeRSI14_5m as _computeRSI14_5m,
  computeMACD,
  computeMACD15m as _computeMACD15m,
  computeBollinger as _computeBollinger,
  computeVwap as _computeVwap,
  computeATR as _computeATR,
  computeStochastic as _computeStochastic,
  computeWeightedOBI as _computeWeightedOBI,
  ema as _ema,
} from './market-intel-indicators.js';
import {
  computeCompositeSignal,
  getSupportResistance as _getSupportResistance,
} from './market-intel-signals.js';

const ORDERBOOK_URL = 'https://api.coinbase.com/api/v3/brokerage/market/product_book';
const FNG_URL = 'https://api.alternative.me/fng/?limit=1';
const POLL_MS = 3_000;
const ORDERBOOK_DEPTH = 10;

export interface OrderFlowSignal {
  symbol: string;
  bidDepth: number;
  askDepth: number;
  imbalancePct: number;
  weightedImbalancePct?: number; // top-5 level weighted OBI
  queueImbalancePct?: number;
  tradeImbalancePct?: number;
  pressureImbalancePct?: number;
  adverseSelectionScore?: number;
  spreadStableMs?: number;
  direction: 'buy' | 'sell' | 'neutral';
  strength: 'weak' | 'moderate' | 'strong';
  spread: number;
  spreadBps: number;
  timestamp: string;
}

export interface FearGreedSignal {
  value: number;
  label: string;
  regime: 'extreme-fear' | 'fear' | 'neutral' | 'greed' | 'extreme-greed';
  contrarian: 'buy' | 'sell' | 'neutral';
  timestamp: string;
}

export interface BollingerState {
  symbol: string;
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
  squeeze: boolean;
  pricePosition: number; // 0 = at lower band, 1 = at upper band
}

export interface VwapState {
  symbol: string;
  vwap: number;
  price: number;
  deviation: number; // positive = above VWAP
  slope: number; // VWAP slope as % change over recent window — near zero = chop
  signal: 'buy' | 'sell' | 'neutral';
  isFlat: boolean; // true when |slope| < 0.01% — market is chopping
}

export interface MarketIntelSnapshot {
  timestamp: string;
  orderFlow: OrderFlowSignal[];
  fearGreed: FearGreedSignal | null;
  bollinger: BollingerState[];
  vwap: VwapState[];
  compositeSignal: CompositeSignal[];
}

export interface CompositeSignal {
  symbol: string;
  direction: 'strong-buy' | 'buy' | 'neutral' | 'sell' | 'strong-sell';
  confidence: number; // 0-100
  reasons: string[];
  tradeable: boolean;
  adverseSelectionRisk?: number;
  quoteStabilityMs?: number;
  rsi2?: number | undefined;
  stochastic?: { k: number; d: number; crossover: 'bullish' | 'bearish' | 'none' } | undefined;
  obiWeighted?: number | undefined; // weighted order book imbalance (-1 to 1)
}

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

export class MarketIntelligence {
  private orderFlow = new Map<string, OrderFlowSignal>();
  private fearGreed: FearGreedSignal | null = null;
  private priceHistory = new Map<string, number[]>();
  private volumeHistory = new Map<string, PriceVolume[]>();
  private barHistory = new Map<string, OhlcBar[]>(); // 60s bars
  private currentBar = new Map<string, OhlcBar>();
  private bar5mHistory = new Map<string, OhlcBar[]>(); // 5-minute bars
  private currentBar5m = new Map<string, OhlcBar>();
  private bar15mHistory = new Map<string, OhlcBar[]>(); // 15-minute bars
  private currentBar15m = new Map<string, OhlcBar>();
  private symbols: string[];
  private timer: NodeJS.Timeout | null = null;
  private fngTimer: NodeJS.Timeout | null = null;
  private orderbookPollInFlight = false;
  private fearGreedPollInFlight = false;

  constructor(symbols: string[]) {
    this.symbols = symbols;
  }

  start(): void {
    if (this.timer) return;
    console.log(`[market-intel] Starting intelligence feeds for ${this.symbols.join(', ')}`);

    // Orderbook data now comes from market-data websocket via feedOrderFlow()
    // REST polling removed — was duplicate, stale, and rate-limited (Fix #4/#20)
    this.timer = setInterval(() => { /* tick placeholder for future use */ }, POLL_MS);

    // Fear & Greed - every 5 minutes (doesn't change fast)
    this.fngTimer = setInterval(() => { void this.pollFearGreed(); }, 300_000);
    void this.pollFearGreed();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.fngTimer) { clearInterval(this.fngTimer); this.fngTimer = null; }
  }

  feedOrderFlow(signal: OrderFlowSignal): void {
    this.orderFlow.set(signal.symbol, { ...signal, timestamp: signal.timestamp || new Date().toISOString() });
  }

  /**
   * Feed price data from market-data service for technical indicators
   */
  feedPrice(symbol: string, price: number, volume?: number): void {
    const history = this.priceHistory.get(symbol) ?? [];
    history.push(price);
    if (history.length > 200) history.shift();
    this.priceHistory.set(symbol, history);

    if (volume !== undefined) {
      const vh = this.volumeHistory.get(symbol) ?? [];
      vh.push({ price, volume, timestamp: Date.now() });
      if (vh.length > 200) vh.shift();
      this.volumeHistory.set(symbol, vh);
    }

    // Build multi-timeframe OHLC bars (1m, 5m, 15m)
    const now = Date.now();
    this.updateBar(symbol, price, volume ?? 0, now, 60_000, this.currentBar, this.barHistory);
    this.updateBar(symbol, price, volume ?? 0, now, 300_000, this.currentBar5m, this.bar5mHistory);
    this.updateBar(symbol, price, volume ?? 0, now, 900_000, this.currentBar15m, this.bar15mHistory);
  }

  private updateBar(
    symbol: string, price: number, volume: number, now: number,
    periodMs: number, currentMap: Map<string, OhlcBar>, historyMap: Map<string, OhlcBar[]>
  ): void {
    let bar = currentMap.get(symbol);
    if (!bar || now - bar.timestamp >= periodMs) {
      if (bar) {
        const bars = historyMap.get(symbol) ?? [];
        bars.push(bar);
        if (bars.length > 200) bars.shift();
        historyMap.set(symbol, bars);
      }
      currentMap.set(symbol, { open: price, high: price, low: price, close: price, volume, timestamp: now });
    } else {
      bar.high = Math.max(bar.high, price);
      bar.low = Math.min(bar.low, price);
      bar.close = price;
      bar.volume += volume;
    }
  }

  getSnapshot(): MarketIntelSnapshot {
    const orderFlow = Array.from(this.orderFlow.values());
    const bollinger = this.symbols.map((s) => this.computeBollinger(s)).filter((b): b is BollingerState => b !== null);
    const vwap = this.symbols.map((s) => this.computeVwap(s)).filter((v): v is VwapState => v !== null);
    const compositeSignal = this.symbols.map((s) => this.computeComposite(s));

    return {
      timestamp: new Date().toISOString(),
      orderFlow,
      fearGreed: this.fearGreed,
      bollinger,
      vwap,
      compositeSignal
    };
  }

  /** Detect nearest support/resistance levels from recent price action */
  getSupportResistance(symbol: string): { support: number; resistance: number; nearSupport: boolean; nearResistance: boolean } | null {
    return _getSupportResistance(this.priceHistory, symbol);
  }

  getCompositeSignal(symbol: string): CompositeSignal {
    return this.computeComposite(symbol);
  }

  /** Get current Fear & Greed value (0-100). Returns null if unavailable. */
  getFearGreedValue(): number | null {
    return this.fearGreed?.value ?? null;
  }

  /** SMA50 trend direction on 5-minute bars — THE macro trend gate */
  getTrend5m(symbol: string): 'up' | 'down' | 'flat' | null {
    const bars = this.bar5mHistory.get(symbol);
    if (!bars || bars.length < 50) return null;
    const closes = bars.slice(-50).map((b) => b.close);
    const sma50 = closes.reduce((s, v) => s + v, 0) / closes.length;
    const current = closes[closes.length - 1]!;
    const pctFromSma = ((current - sma50) / sma50) * 100;
    if (pctFromSma > 0.1) return 'up';
    if (pctFromSma < -0.1) return 'down';
    return 'flat';
  }

  /** RSI(14) on 5-minute bars for multi-timeframe confirmation */
  computeRSI14_5m(symbol: string): number | null {
    return _computeRSI14_5m(this.bar5mHistory, symbol);
  }

  /** MACD histogram on 15-minute bars */
  computeMACD15m(symbol: string): number | null {
    return _computeMACD15m(this.bar15mHistory, symbol);
  }

  /** Recent realized volatility (last N bars) vs ATR — detects vol spikes/compression */
  getRecentVolRatio(symbol: string, lookback = 5): number | null {
    const bars = this.barHistory.get(symbol);
    if (!bars || bars.length < lookback + 14) return null;
    const recentBars = bars.slice(-lookback);
    const recentVol = recentBars.reduce((s, b) => s + (b.high - b.low), 0) / lookback;
    const atr = _computeATR(this.barHistory, this.priceHistory, symbol);
    if (!atr || atr <= 0) return null;
    return recentVol / atr;
  }

  /** Detect liquidity sweep — price spikes then reverses quickly */
  isLiquiditySweep(symbol: string): boolean {
    const prices = this.priceHistory.get(symbol);
    if (!prices || prices.length < 5) return false;
    const recent = prices.slice(-5);
    const spike = Math.max(...recent) - Math.min(...recent);
    const avg = recent.reduce((s, v) => s + v, 0) / recent.length;
    const spikePct = (spike / avg) * 100;
    // Spike > 0.3% in 5 ticks
    if (spikePct < 0.3) return false;
    // Check if price reversed: last price closer to start than to peak
    const start = recent[0]!;
    const end = recent[recent.length - 1]!;
    const peak = recent.reduce((max, v) => Math.max(max, Math.abs(v - start)), 0);
    const reversal = Math.abs(end - start);
    // If reversal is < 40% of the peak move, it's a sweep
    return reversal < peak * 0.4;
  }

  /** Returns true when VWAP slope is near zero — market is chopping, skip entries */
  isVwapFlat(symbol: string): boolean {
    const vw = _computeVwap(this.volumeHistory, symbol);
    return vw !== null && vw.isFlat;
  }

  private async pollOrderbooks(): Promise<void> {
    if (this.orderbookPollInFlight) return;
    this.orderbookPollInFlight = true;
    try {
      const symbols = this.symbols.filter((s) => s.endsWith('-USD'));
      await Promise.all(symbols.map(async (symbol) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2500);
          const url = `${ORDERBOOK_URL}?product_id=${symbol}&limit=${ORDERBOOK_DEPTH}`;
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timeout);

          if (!response.ok) return;
          const data = await response.json() as {
            pricebook?: {
              bids?: Array<{ price: string; size: string }>;
              asks?: Array<{ price: string; size: string }>;
            };
          };

          const bids = data.pricebook?.bids ?? [];
          const asks = data.pricebook?.asks ?? [];
          if (bids.length === 0 || asks.length === 0) return;

          const bidDepth = bids.reduce((sum, b) => sum + Number(b.price) * Number(b.size), 0);
          const askDepth = asks.reduce((sum, a) => sum + Number(a.price) * Number(a.size), 0);
          const totalDepth = bidDepth + askDepth;
          const imbalancePct = totalDepth > 0 ? ((bidDepth - askDepth) / totalDepth) * 100 : 0;

          // Weighted OBI: top levels matter more (exponential decay: level 1=5x, 2=4x, ..., 5=1x)
          const maxWeightLevels = Math.min(5, bids.length, asks.length);
          let wBid = 0, wAsk = 0;
          for (let lvl = 0; lvl < maxWeightLevels; lvl++) {
            const weight = maxWeightLevels - lvl;
            wBid += Number(bids[lvl]!.price) * Number(bids[lvl]!.size) * weight;
            wAsk += Number(asks[lvl]!.price) * Number(asks[lvl]!.size) * weight;
          }
          const wTotal = wBid + wAsk;
          const weightedOBI = wTotal > 0 ? ((wBid - wAsk) / wTotal) * 100 : 0;

          const bestBid = Number(bids[0]!.price);
          const bestAsk = Number(asks[0]!.price);
          const mid = (bestBid + bestAsk) / 2;
          const spread = bestAsk - bestBid;
          const spreadBps = mid > 0 ? (spread / mid) * 10_000 : 0;

          const absImb = Math.abs(imbalancePct);
          const direction: OrderFlowSignal['direction'] = absImb < 15 ? 'neutral' : imbalancePct > 0 ? 'buy' : 'sell';
          const strength: OrderFlowSignal['strength'] = absImb > 60 ? 'strong' : absImb > 30 ? 'moderate' : 'weak';

          const existing = this.orderFlow.get(symbol);
          this.orderFlow.set(symbol, {
            symbol,
            bidDepth: round(bidDepth, 0),
            askDepth: round(askDepth, 0),
            imbalancePct: round(imbalancePct, 1),
            weightedImbalancePct: round(weightedOBI, 1),
            ...(existing?.queueImbalancePct !== undefined ? { queueImbalancePct: existing.queueImbalancePct } : {}),
            ...(existing?.tradeImbalancePct !== undefined ? { tradeImbalancePct: existing.tradeImbalancePct } : {}),
            ...(existing?.pressureImbalancePct !== undefined ? { pressureImbalancePct: existing.pressureImbalancePct } : {}),
            ...(existing?.adverseSelectionScore !== undefined ? { adverseSelectionScore: existing.adverseSelectionScore } : {}),
            ...(existing?.spreadStableMs !== undefined ? { spreadStableMs: existing.spreadStableMs } : {}),
            direction,
            strength,
            spread: round(spread, 2),
            spreadBps: round(spreadBps, 2),
            timestamp: new Date().toISOString()
          });
        } catch {
          // Non-critical
        }
      }));
    } finally {
      this.orderbookPollInFlight = false;
    }
  }

  private async pollFearGreed(): Promise<void> {
    if (this.fearGreedPollInFlight) return;
    this.fearGreedPollInFlight = true;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(FNG_URL, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) return;
      const data = await response.json() as { data?: Array<{ value: string; value_classification: string }> };
      const item = data.data?.[0];
      if (!item) return;

      const value = Number(item.value);
      const regime: FearGreedSignal['regime'] =
        value <= 20 ? 'extreme-fear' :
        value <= 40 ? 'fear' :
        value <= 60 ? 'neutral' :
        value <= 80 ? 'greed' : 'extreme-greed';

      const contrarian: FearGreedSignal['contrarian'] =
        value <= 20 ? 'buy' : value >= 80 ? 'sell' : 'neutral';

      this.fearGreed = {
        value,
        label: item.value_classification,
        regime,
        contrarian,
        timestamp: new Date().toISOString()
      };

      console.log(`[market-intel] Fear & Greed: ${value} (${item.value_classification}) → contrarian ${contrarian}`);
    } catch {
      // Non-critical
    } finally {
      this.fearGreedPollInFlight = false;
    }
  }

  private computeBollinger(symbol: string): BollingerState | null {
    return _computeBollinger(this.priceHistory, symbol);
  }

  private computeVwap(symbol: string): VwapState | null {
    return _computeVwap(this.volumeHistory, symbol);
  }

  private computeComposite(symbol: string): CompositeSignal {
    return computeCompositeSignal(symbol, this.orderFlow, this.fearGreed, this.priceHistory, this.volumeHistory, this.barHistory);
  }

  computeATR(symbol: string, period = 14): number | null {
    return _computeATR(this.barHistory, this.priceHistory, symbol, period);
  }

  /** RSI(14) — standard period RSI for trend confirmation. */
  computeRSI14(symbol: string): number | null {
    return _computeRSI14(this.priceHistory, symbol);
  }

  /**
   * RSI(2) — 2-period RSI, a fast mean-reversion signal.
   * Backtested at 76% win rate: enter when RSI(2) < 10, exit when price > 5-period SMA.
   * Returns null if insufficient data.
   */
  computeRSI2(symbol: string): number | null {
    return _computeRSI2(this.priceHistory, symbol);
  }

  /**
   * Stochastic(14,3,3) — forex confirmation oscillator.
   */
  computeStochastic(symbol: string, kPeriod = 14, dPeriod = 3): { k: number; d: number; crossover: 'bullish' | 'bearish' | 'none' } | null {
    return _computeStochastic(this.barHistory, this.priceHistory, symbol, kPeriod, dPeriod);
  }

  /**
   * Weighted Order Book Imbalance — weights top levels exponentially.
   */
  computeWeightedOBI(symbol: string): number | null {
    return _computeWeightedOBI(this.orderFlow, symbol);
  }
}

let intel: MarketIntelligence | undefined;

// Default symbols — will be overridden by initMarketIntel() with full universe
const DEFAULT_SYMBOLS = [
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'PAXG-USD',
  'EUR_USD', 'GBP_USD', 'USD_JPY', 'SPX500_USD', 'NAS100_USD',
  'USB10Y_USD', 'USB30Y_USD', 'XAU_USD', 'XAG_USD', 'WTICO_USD',
  'BCO_USD', 'NATGAS_USD', 'XCU_USD', 'XPT_USD', 'XPD_USD',
  'SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN', 'META', 'AMD', 'VIXY'
];

export function getMarketIntel(): MarketIntelligence {
  if (!intel) {
    intel = new MarketIntelligence(DEFAULT_SYMBOLS);
    intel.start();
  }
  return intel;
}
