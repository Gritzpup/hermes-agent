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
    const prices = this.priceHistory.get(symbol);
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
    const bars = this.bar5mHistory.get(symbol);
    if (!bars || bars.length < 15) return null;
    return this.computeRSI(bars.map((b) => b.close), 14);
  }

  /** MACD histogram on 15-minute bars */
  computeMACD15m(symbol: string): number | null {
    const bars = this.bar15mHistory.get(symbol);
    if (!bars || bars.length < 27) return null;
    const macd = this.computeMACD(bars.map((b) => b.close));
    return macd?.histogram ?? null;
  }

  /** Recent realized volatility (last N bars) vs ATR — detects vol spikes/compression */
  getRecentVolRatio(symbol: string, lookback = 5): number | null {
    const bars = this.barHistory.get(symbol);
    if (!bars || bars.length < lookback + 14) return null;
    const recentBars = bars.slice(-lookback);
    const recentVol = recentBars.reduce((s, b) => s + (b.high - b.low), 0) / lookback;
    const atr = this.computeATR(symbol);
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
    const vw = this.computeVwap(symbol);
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
    const prices = this.priceHistory.get(symbol);
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

  private computeVwap(symbol: string): VwapState | null {
    const vh = this.volumeHistory.get(symbol);
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

  private computeComposite(symbol: string): CompositeSignal {
    const reasons: string[] = [];
    let score = 0; // positive = bullish, negative = bearish

    // Order flow (weight: 40% + microstructure refinements)
    const flow = this.orderFlow.get(symbol);
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
    if (this.fearGreed) {
      if (this.fearGreed.contrarian === 'buy') { score += 15; reasons.push(`Extreme Fear (${this.fearGreed.value}) = contrarian buy`); }
      else if (this.fearGreed.contrarian === 'sell') { score -= 15; reasons.push(`Extreme Greed (${this.fearGreed.value}) = contrarian sell`); }
    }

    // Bollinger (weight: 20%)
    const bb = this.computeBollinger(symbol);
    if (bb) {
      if (bb.pricePosition < 0.1) { score += 20; reasons.push(`Price at lower Bollinger band (oversold)`); }
      else if (bb.pricePosition > 0.9) { score -= 20; reasons.push(`Price at upper Bollinger band (overbought)`); }
      if (bb.squeeze) { reasons.push('Bollinger squeeze detected — big move imminent'); }
    }

    // VWAP (weight: 15%)
    const vw = this.computeVwap(symbol);
    if (vw) {
      if (vw.signal === 'buy') { score += 15; reasons.push(`Below VWAP (${vw.deviation}% deviation)`); }
      else if (vw.signal === 'sell') { score -= 15; reasons.push(`Above VWAP (${vw.deviation}% deviation)`); }
    }

    // Trend (weight: 10%)
    const prices = this.priceHistory.get(symbol);
    if (prices && prices.length >= 50) {
      const sma20 = prices.slice(-20).reduce((s, v) => s + v, 0) / 20;
      const sma50 = prices.slice(-50).reduce((s, v) => s + v, 0) / 50;
      if (sma20 > sma50) { score += 10; reasons.push('Short-term trend bullish (SMA20 > SMA50)'); }
      else { score -= 10; reasons.push('Short-term trend bearish (SMA20 < SMA50)'); }
    }

    // RSI (weight: 15%) — momentum confirmation
    if (prices && prices.length >= 15) {
      const rsi = this.computeRSI(prices, 14);
      if (rsi !== null) {
        if (rsi > 70) { score -= 15; reasons.push(`RSI overbought (${rsi.toFixed(0)})`); }
        else if (rsi < 30) { score += 15; reasons.push(`RSI oversold (${rsi.toFixed(0)})`); }
        else if (rsi > 55) { score += 5; reasons.push(`RSI bullish momentum (${rsi.toFixed(0)})`); }
        else if (rsi < 45) { score -= 5; reasons.push(`RSI bearish momentum (${rsi.toFixed(0)})`); }
      }
    }

    // MACD (weight: 10%) — trend change detection
    if (prices && prices.length >= 26) {
      const macd = this.computeMACD(prices);
      if (macd) {
        if (macd.histogram > 0 && macd.histogramPrev <= 0) { score += 10; reasons.push('MACD bullish crossover'); }
        else if (macd.histogram < 0 && macd.histogramPrev >= 0) { score -= 10; reasons.push('MACD bearish crossover'); }
        else if (macd.histogram > 0) { score += 3; reasons.push('MACD positive'); }
        else if (macd.histogram < 0) { score -= 3; reasons.push('MACD negative'); }
      }
    }

    // Support/Resistance (weight: 10%) — buy near support, sell near resistance
    const sr = this.getSupportResistance(symbol);
    if (sr) {
      if (sr.nearSupport) { score += 10; reasons.push(`Near support at ${sr.support}`); }
      if (sr.nearResistance) { score -= 10; reasons.push(`Near resistance at ${sr.resistance}`); }
    }

    // RSI(2) fast signal (weight: 20%) — extreme readings are high-probability mean-reversion
    const rsi2 = this.computeRSI2(symbol);
    if (rsi2 !== null) {
      if (rsi2 < 10) { score += 20; reasons.push(`RSI(2) extreme oversold (${rsi2.toFixed(1)}) — high-prob bounce`); }
      else if (rsi2 < 25) { score += 8; reasons.push(`RSI(2) oversold (${rsi2.toFixed(1)})`); }
      else if (rsi2 > 90) { score -= 20; reasons.push(`RSI(2) extreme overbought (${rsi2.toFixed(1)}) — high-prob pullback`); }
      else if (rsi2 > 75) { score -= 8; reasons.push(`RSI(2) overbought (${rsi2.toFixed(1)})`); }
    }

    // Stochastic(14,3,3) confirmation (weight: 10%) — crossover signals
    const stoch = this.computeStochastic(symbol);
    if (stoch) {
      if (stoch.crossover === 'bullish' && stoch.k < 30) { score += 10; reasons.push(`Stochastic bullish crossover in oversold zone (K=${stoch.k})`); }
      else if (stoch.crossover === 'bearish' && stoch.k > 70) { score -= 10; reasons.push(`Stochastic bearish crossover in overbought zone (K=${stoch.k})`); }
      else if (stoch.crossover === 'bullish') { score += 4; reasons.push(`Stochastic bullish crossover (K=${stoch.k})`); }
      else if (stoch.crossover === 'bearish') { score -= 4; reasons.push(`Stochastic bearish crossover (K=${stoch.k})`); }
    }

    // Weighted OBI (weight: 10%) — near-touch order book pressure
    const obiWeighted = this.computeWeightedOBI(symbol);
    if (obiWeighted !== null && Math.abs(obiWeighted) > 0.3) {
      const obiScore = obiWeighted > 0 ? 10 : -10;
      score += obiScore;
      reasons.push(`Weighted OBI ${obiWeighted > 0 ? 'bid' : 'ask'} pressure (${(obiWeighted * 100).toFixed(1)}%)`);
    }

    const confidence = Math.min(Math.abs(score), 100);
    const direction: CompositeSignal['direction'] =
      score >= 50 ? 'strong-buy' :
      score >= 20 ? 'buy' :
      score <= -50 ? 'strong-sell' :
      score <= -20 ? 'sell' : 'neutral';

    return {
      symbol,
      direction,
      confidence,
      reasons,
      // Fix #8: tightened gating — fewer marginal entries = higher win rate
      tradeable: confidence >= 40 && direction !== 'neutral' && adverseSelectionRisk < 60 && (quoteStabilityMs === 0 || quoteStabilityMs >= 2_000),
      adverseSelectionRisk: round(adverseSelectionRisk, 1),
      quoteStabilityMs,
      rsi2: rsi2 !== null ? round(rsi2, 1) : undefined,
      stochastic: stoch ?? undefined,
      obiWeighted: obiWeighted !== null ? obiWeighted : undefined
    };
  }

  private computeRSI(prices: number[], period: number): number | null {
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

  private computeMACD(prices: number[]): { macdLine: number; signalLine: number; histogram: number; histogramPrev: number } | null {
    if (prices.length < 27) return null;
    const ema12 = this.ema(prices, 12);
    const ema26 = this.ema(prices, 26);
    if (ema12.length < 2 || ema26.length < 2) return null;
    const macdLine = ema12[ema12.length - 1]! - ema26[ema26.length - 1]!;
    const macdPrev = ema12[ema12.length - 2]! - ema26[ema26.length - 2]!;
    // Signal line = 9-period EMA of MACD
    const macdSeries = ema12.map((v, i) => v - (ema26[i] ?? v));
    const signal = this.ema(macdSeries, 9);
    const signalLine = signal[signal.length - 1] ?? 0;
    const signalPrev = signal[signal.length - 2] ?? 0;
    return {
      macdLine,
      signalLine,
      histogram: macdLine - signalLine,
      histogramPrev: macdPrev - signalPrev
    };
  }

  computeATR(symbol: string, period = 14): number | null {
    // Use OHLC bars for proper true range if available (Fix #5)
    const bars = this.barHistory.get(symbol);
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
    const prices = this.priceHistory.get(symbol);
    if (!prices || prices.length < period + 1) return null;
    const trs: number[] = [];
    for (let i = prices.length - period; i < prices.length; i++) {
      trs.push(Math.abs(prices[i]! - prices[i - 1]!));
    }
    return trs.reduce((s, v) => s + v, 0) / trs.length;
  }

  /** RSI(14) — standard period RSI for trend confirmation. */
  computeRSI14(symbol: string): number | null {
    return this.computeRSI(this.priceHistory.get(symbol) ?? [], 14);
  }

  /**
   * RSI(2) — 2-period RSI, a fast mean-reversion signal.
   * Backtested at 76% win rate: enter when RSI(2) < 10, exit when price > 5-period SMA.
   * Returns null if insufficient data.
   */
  computeRSI2(symbol: string): number | null {
    return this.computeRSI(this.priceHistory.get(symbol) ?? [], 2);
  }

  /**
   * Stochastic(14,3,3) — forex confirmation oscillator.
   * %K = 100 * (close - lowest_low_14) / (highest_high_14 - lowest_low_14)
   * %D = 3-period SMA of %K
   * Crossover: %K crosses above %D = bullish, %K crosses below %D = bearish.
   */
  computeStochastic(symbol: string, kPeriod = 14, dPeriod = 3): { k: number; d: number; crossover: 'bullish' | 'bearish' | 'none' } | null {
    // Use OHLC bars for proper high/low Stochastic if available (Fix #5)
    const bars = this.barHistory.get(symbol);
    const useBars = bars && bars.length >= kPeriod + dPeriod;
    const prices = this.priceHistory.get(symbol);
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

  /**
   * Weighted Order Book Imbalance — weights top levels exponentially.
   * Level 1 gets weight 5, level 2 gets 4, etc. This amplifies the near-touch signal.
   * Returns value from -1 (all asks) to +1 (all bids). Threshold: |OBI| > 0.3 = strong signal.
   */
  computeWeightedOBI(symbol: string): number | null {
    const flow = this.orderFlow.get(symbol);
    if (!flow) return null;
    // Prefer the weighted calculation from top-5 levels, fall back to flat imbalance
    const pct = flow.weightedImbalancePct ?? flow.imbalancePct;
    return round(pct / 100, 3);
  }

  private ema(data: number[], period: number): number[] {
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
