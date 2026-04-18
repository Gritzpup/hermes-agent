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
import { getRecentWhaleTransfers, startEtherscanWhales, stopEtherscanWhales } from './etherscan-whales.js';
import { getCongressionalTrades, startApifyCongress, stopApifyCongress } from './apify-congress.js';

const MARKET_DATA_URL = process.env.MARKET_DATA_URL ?? 'http://127.0.0.1:4302';
const ORDERBOOK_URL = 'https://api.coinbase.com/api/v3/brokerage/market/product_book';
const FNG_URL = 'https://api.alternative.me/fng/?limit=1';
// Binance is geo-blocked from US IPs and Bybit was unreachable from this deployment,
// so funding data comes from OKX USDT-SWAPs. One GET per symbol, ~100ms each.
const OKX_FUNDING_URL = 'https://www.okx.com/api/v5/public/funding-rate';
const CMC_QUOTES_URL = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest';
const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
// Deribit removed DVOL from get_index_price; the replacement endpoint returns OHLC
// series keyed by currency. Use the most recent close as the "current DVOL".
const DERIBIT_DVOL_URL = 'https://www.deribit.com/api/v2/public/get_volatility_index_data';

const HL_SYMBOL_MAP: Record<string, string> = {
  BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD',
};

const DVOL_SYMBOL_MAP: Record<string, string> = {
  'BTC-USD': 'BTC',
  'ETH-USD': 'ETH',
};
const POLL_MS = 3_000;
const ORDERBOOK_DEPTH = 10;

// Map our spot-style symbols to OKX USDT-swap symbols for funding.
const FUNDING_SYMBOL_MAP: Record<string, string> = {
  'BTC-USD': 'BTC-USDT-SWAP',
  'ETH-USD': 'ETH-USDT-SWAP',
  'SOL-USD': 'SOL-USDT-SWAP',
  'XRP-USD': 'XRP-USDT-SWAP',
};

// Which of our symbols to enrich with CMC market data.
const CMC_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'] as const;
const CMC_TO_OUR_SYMBOL: Record<string, string> = {
  BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD',
};

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

export interface FundingRateSignal {
  symbol: string;
  rate: number;              // last 8h funding rate, e.g. 0.0001 = 0.01%
  annualizedPct: number;     // rate * 3 * 365 * 100
  bias: 'buy' | 'sell' | 'neutral'; // contrarian bias: crowded longs → sell
  extreme: boolean;          // |annualized| > 30% — strong contrarian tilt
  timestamp: string;
}

export interface HyperliquidSignal {
  symbol: string;              // our symbol format, e.g. BTC-USD
  markPriceUsd: number;
  openInterestUsd: number;     // openInterest * markPrice
  fundingRate: number;         // e.g. 0.0001250 (8h)
  annualizedFundingPct: number;
  dayVolumeUsd: number;
  impactBps: number;           // average of buy/sell impact in bps
  oiMomentumPct: number;       // (oiNow - oiPrev) / oiPrev * 100; 0 if no prior sample
  timestamp: string;
}

export interface ImpliedVolSignal {
  symbol: string;      // BTC-USD or ETH-USD
  dvol: number;        // Deribit VIX-equivalent, %
  dvolRegime: 'crushed' | 'normal' | 'elevated' | 'spike'; // thresholds: <35, 35-60, 60-90, >=90
  timestamp: string;
}

export interface FundingDivergenceSignal {
  symbol: string;
  okxFundingPct: number;
  hlFundingPct: number;
  divergencePct: number;
  bias: 'okx-rich' | 'hl-rich' | 'neutral';
  extreme: boolean;
  timestamp: string;
}

export interface StablecoinRegimeSignal {
  totalMcapUsd: number;
  changePct24h: number | null;   // requires history
  regime: 'inflow' | 'neutral' | 'outflow';  // >+0.5%, -0.5 to +0.5, <-0.5%
  timestamp: string;
}

export interface BtcChainHealth {
  hashrateEhs: number | null;
  mempoolFeesSatPerVB: number | null;
  regime: 'healthy' | 'stressed' | 'unknown';
}

export interface CmcMarketSignal {
  symbol: string;
  priceUsd: number;
  marketCapUsd: number;
  marketCapRank: number;     // 1 = largest — smaller is better for liquidity
  volume24hUsd: number;
  percentChange24h: number;  // daily price change %
  percentChange7d: number;
  volumePercentileInUniverse: number; // 0..1, rank inside our tracked crypto universe
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
  venueDivergence?: boolean;
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
  private fundingTimer: NodeJS.Timeout | null = null;
  private cmcTimer: NodeJS.Timeout | null = null;
  private orderbookPollInFlight = false;
  private fearGreedPollInFlight = false;
  private fundingPollInFlight = false;
  private cmcPollInFlight = false;
  private fundingRates = new Map<string, FundingRateSignal>();
  private cmcData = new Map<string, CmcMarketSignal>();
  private hlTimer: NodeJS.Timeout | null = null;
  private hlPollInFlight = false;
  private hlData = new Map<string, HyperliquidSignal>();
  private hlPrevOi = new Map<string, number>();
  private ivTimer: NodeJS.Timeout | null = null;
  private ivPollInFlight = false;
  private ivData = new Map<string, ImpliedVolSignal>();
  private stableTimer: NodeJS.Timeout | null = null;
  private stablePollInFlight = false;
  private stableSignal: StablecoinRegimeSignal | null = null;
  private stablePrevTotal = 0;
  private stablePrevTotalAt = 0;

  // Blockchain.info BTC chain health (Phase 3.2)
  private btcChainTimer: NodeJS.Timeout | null = null;
  private btcChainPollInFlight = false;
  private btcChainHealth: BtcChainHealth = { hashrateEhs: null, mempoolFeesSatPerVB: null, regime: 'unknown' };
  private prevHashrate: number | null = null;
  private prevHashrateAt: number | null = null;

  // Cached last BTC-USD price — used by venue-sanity.ts via getLastPrice()
  private _btcLastPrice: number | null = null;

  // Phase 4.1: Etherscan whale transfers
  private whaleTimer: NodeJS.Timeout | null = null;

  // Phase 4.2: Apify congressional trades
  private congressTimer: NodeJS.Timeout | null = null;

  // Phase 3.1: cached venue divergence result (updated by venue-sanity poller)
  private _venueDivergence = false;

  // Tracks prior extreme state per symbol so we only log on first cross
  private _prevExtremeDivergence = new Map<string, boolean>();

  // Non-crypto OANDA + Alpaca: bypasses market-feed.ts fingerprint dedup so priceHistory
  // accumulates for Bollinger/VWAP/RSI even when prices are unchanged between ticks.
  private oandaAlpacaTimer: NodeJS.Timeout | null = null;
  private oandaAlpacaPollInFlight = false;

  constructor(symbols: string[]) {
    this.symbols = symbols;
  }

  start(): void {
    if (this.timer) return;
    console.log(`[market-intel] Starting intelligence feeds for ${this.symbols.join(', ')}`);

    // Orderbook data comes from market-data websocket via feedOrderFlow();
    // no local ticker is required.

    // Fear & Greed - every 5 minutes (doesn't change fast)
    this.fngTimer = setInterval(() => { void this.pollFearGreed(); }, 300_000);
    void this.pollFearGreed();

    // Funding rate - every 5 minutes (funding epoch is 8h, so this is overkill but cheap)
    this.fundingTimer = setInterval(() => { void this.pollFundingRates(); }, 300_000);
    void this.pollFundingRates();

    // CoinMarketCap market-cap + 24h volume - every 15 minutes (free tier is 10k
    // credits/month; one call covers all 4 symbols so this is ~2.9k/mo). Only starts
    // if the API key is present.
    if (process.env.COINMARKETCAP_API_KEY) {
      this.cmcTimer = setInterval(() => { void this.pollCmc(); }, 900_000);
      void this.pollCmc();
    }

    // Hyperliquid: free, public, no key. One POST returns all perps.
    this.hlTimer = setInterval(() => { void this.pollHyperliquid(); }, 60_000);
    void this.pollHyperliquid();

    // Deribit DVOL - every 2 minutes, public, keyless
    this.ivTimer = setInterval(() => { void this.pollImpliedVol(); }, 120_000);
    void this.pollImpliedVol();

    // DeFiLlama stablecoin total - every 30 minutes (slow signal)
    this.stableTimer = setInterval(() => { void this.pollStablecoins(); }, 1_800_000);
    void this.pollStablecoins();

    // Blockchain.info BTC chain health - every 15 minutes
    this.btcChainTimer = setInterval(() => { void this.pollBtcChainHealth(); }, 900_000);
    void this.pollBtcChainHealth();

    // Phase 4.1: Etherscan whale transfers — every 10 min
    startEtherscanWhales();

    // Phase 4.2: Apify congressional trades — every 4h
    startApifyCongress();

    // Non-crypto OANDA + Alpaca: every 15s, fetch market-data /snapshots and feed
    // prices directly so priceHistory grows for Bollinger/VWAP/RSI computation.
    // 15s × 20 ticks = 5 min to reach Bollinger 20-period threshold.
    this.oandaAlpacaTimer = setInterval(() => { void this.pollOandaAlpaca(); }, 15_000);
    void this.pollOandaAlpaca();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.fngTimer) { clearInterval(this.fngTimer); this.fngTimer = null; }
    if (this.fundingTimer) { clearInterval(this.fundingTimer); this.fundingTimer = null; }
    if (this.cmcTimer) { clearInterval(this.cmcTimer); this.cmcTimer = null; }
    if (this.hlTimer) { clearInterval(this.hlTimer); this.hlTimer = null; }
    if (this.ivTimer) { clearInterval(this.ivTimer); this.ivTimer = null; }
    if (this.stableTimer) { clearInterval(this.stableTimer); this.stableTimer = null; }
    if (this.btcChainTimer) { clearInterval(this.btcChainTimer); this.btcChainTimer = null; }
    if (this.oandaAlpacaTimer) { clearInterval(this.oandaAlpacaTimer); this.oandaAlpacaTimer = null; }
    // Phase 4.1 + 4.2 external pollers
    stopEtherscanWhales();
    stopApifyCongress();
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

    // Cache last BTC-USD price for venue-sanity cross-check
    if (symbol === 'BTC-USD') this._btcLastPrice = price;

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

  private async pollFundingRates(): Promise<void> {
    if (this.fundingPollInFlight) return;
    this.fundingPollInFlight = true;
    try {
      const now = new Date().toISOString();
      const entries = Object.entries(FUNDING_SYMBOL_MAP);
      await Promise.all(entries.map(async ([ourSymbol, okxSymbol]) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 4000);
          const response = await fetch(`${OKX_FUNDING_URL}?instId=${okxSymbol}`, { signal: controller.signal });
          clearTimeout(timeout);
          if (!response.ok) return;
          const data = await response.json() as { code?: string; data?: Array<{ fundingRate?: string }> };
          if (data.code !== '0') return;
          const row = data.data?.[0];
          if (!row?.fundingRate) return;
          const rate = Number(row.fundingRate);
          if (!Number.isFinite(rate)) return;
          const annualizedPct = rate * 3 * 365 * 100;
          const bias: FundingRateSignal['bias'] =
            annualizedPct >= 20 ? 'sell' :
            annualizedPct <= -20 ? 'buy' : 'neutral';
          this.fundingRates.set(ourSymbol, {
            symbol: ourSymbol,
            rate,
            annualizedPct,
            bias,
            extreme: Math.abs(annualizedPct) >= 30,
            timestamp: now,
          });
        } catch {
          // Per-symbol failure — next tick retries this one.
        }
      }));
    } finally {
      this.fundingPollInFlight = false;
    }
  }

  getFundingRate(symbol: string): FundingRateSignal | null {
    return this.fundingRates.get(symbol) ?? null;
  }

  getFundingDivergence(symbol: string): FundingDivergenceSignal | null {
    const okx = this.fundingRates.get(symbol);
    const hl = this.hlData.get(symbol);
    if (!okx || !hl) return null;
    const okxPct = okx.annualizedPct;
    const hlPct = hl.annualizedFundingPct;
    const div = okxPct - hlPct;
    const bias: FundingDivergenceSignal['bias'] =
      div > 20 ? 'okx-rich' :
      div < -20 ? 'hl-rich' : 'neutral';
    const extreme = Math.abs(div) >= 30;
    const wasExtreme = this._prevExtremeDivergence.get(symbol) ?? false;
    if (extreme && !wasExtreme) {
      console.warn(`[funding-divergence] ${symbol} OKX=${okxPct.toFixed(2)}% HL=${hlPct.toFixed(2)}% div=${div.toFixed(2)}%`);
    }
    this._prevExtremeDivergence.set(symbol, extreme);
    return {
      symbol,
      okxFundingPct: okxPct,
      hlFundingPct: hlPct,
      divergencePct: div,
      bias,
      extreme,
      timestamp: new Date().toISOString(),
    };
  }

  getAllFundingDivergences(): FundingDivergenceSignal[] {
    const both = new Set([...this.fundingRates.keys()].filter((s) => this.hlData.has(s)));
    return [...both].map((s) => this.getFundingDivergence(s)!).filter((d): d is FundingDivergenceSignal => d !== null);
  }

  getCmcSignal(symbol: string): CmcMarketSignal | null {
    return this.cmcData.get(symbol) ?? null;
  }

  getHyperliquidSignal(symbol: string): HyperliquidSignal | null {
    return this.hlData.get(symbol) ?? null;
  }

  getImpliedVolSignal(symbol: string): ImpliedVolSignal | null {
    return this.ivData.get(symbol) ?? null;
  }

  getStablecoinRegime(): StablecoinRegimeSignal | null {
    return this.stableSignal;
  }

  getBtcChainHealth(): BtcChainHealth {
    return this.btcChainHealth;
  }

  /** Phase 4.1: most recent whale transfers detected on exchange hot wallets. */
  getWhaleTransfers() {
    return getRecentWhaleTransfers();
  }

  /**
   * Phase 4.2: congressional bias for `symbol`.
   * Returns +5 if bipartisan/cross-party purchase activity >$50k in recent filings,
   * -5 on heavy insider selling, 0 otherwise. Does NOT affect rotation scoring directly.
   */
  getCongressionalBias(symbol: string): number {
    const trades = getCongressionalTrades();
    const relevant = trades.filter((t) => t.symbol === symbol.toUpperCase());
    if (relevant.length === 0) return 0;
    let score = 0;
    for (const t of relevant) {
      if (t.type === 'purchase' && t.valueUsd >= 50_000) score += 5;
      else if (t.type === 'sale' && t.valueUsd >= 50_000) score -= 5;
    }
    return Math.max(-5, Math.min(5, score));
  }

  /** Returns the most recent price for `symbol`, or null if not yet received. */
  getLastPrice(symbol: string): number | null {
    if (symbol === 'BTC-USD') return this._btcLastPrice;
    return this.priceHistory.get(symbol)?.at(-1) ?? null;
  }

  private async pollCmc(): Promise<void> {
    if (this.cmcPollInFlight) return;
    const key = process.env.COINMARKETCAP_API_KEY;
    if (!key) return;
    this.cmcPollInFlight = true;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const url = `${CMC_QUOTES_URL}?symbol=${CMC_SYMBOLS.join(',')}&convert=USD`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'X-CMC_PRO_API_KEY': key, Accept: 'application/json' },
      });
      clearTimeout(timeout);
      if (!response.ok) return;

      type CmcQuote = { price: number; volume_24h: number; percent_change_24h: number; percent_change_7d: number; market_cap: number };
      type CmcCoin = { cmc_rank: number; quote: { USD: CmcQuote } };
      const data = await response.json() as { data?: Record<string, CmcCoin | CmcCoin[]> };
      if (!data.data) return;

      // Compute volume percentile across our tracked universe so the rotation engine
      // gets a 0..1 liquidity ranking instead of raw USD volume.
      const rows: Array<{ ourSymbol: string; coin: CmcCoin }> = [];
      for (const sym of CMC_SYMBOLS) {
        const raw = data.data[sym];
        const coin = Array.isArray(raw) ? raw[0] : raw;
        if (!coin?.quote?.USD) continue;
        const ourSymbol = CMC_TO_OUR_SYMBOL[sym];
        if (!ourSymbol) continue;
        rows.push({ ourSymbol, coin });
      }
      if (rows.length === 0) return;
      const volumes = rows.map((r) => r.coin.quote.USD.volume_24h).sort((a, b) => a - b);
      const volumeRank = (v: number) => {
        const idx = volumes.findIndex((x) => x >= v);
        return idx < 0 ? 1 : idx / Math.max(volumes.length - 1, 1);
      };

      const now = new Date().toISOString();
      for (const { ourSymbol, coin } of rows) {
        const q = coin.quote.USD;
        this.cmcData.set(ourSymbol, {
          symbol: ourSymbol,
          priceUsd: q.price,
          marketCapUsd: q.market_cap,
          marketCapRank: coin.cmc_rank,
          volume24hUsd: q.volume_24h,
          percentChange24h: q.percent_change_24h,
          percentChange7d: q.percent_change_7d,
          volumePercentileInUniverse: volumeRank(q.volume_24h),
          timestamp: now,
        });
      }
    } catch {
      // Non-critical — next tick retries.
    } finally {
      this.cmcPollInFlight = false;
    }
  }

  private async pollHyperliquid(): Promise<void> {
    if (this.hlPollInFlight) return;
    this.hlPollInFlight = true;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const response = await fetch(HL_INFO_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });
      clearTimeout(timeout);
      if (!response.ok) return;
      const payload = await response.json() as [
        { universe: Array<{ name: string }> },
        Array<{ funding?: string; openInterest?: string; markPx?: string; midPx?: string; impactPxs?: [string, string]; dayNtlVlm?: string }>,
      ];
      if (!Array.isArray(payload) || payload.length < 2) return;
      const universe = payload[0]?.universe ?? [];
      const ctxs = payload[1] ?? [];
      const now = new Date().toISOString();
      for (let i = 0; i < universe.length; i++) {
        const name = universe[i]?.name;
        const ctx = ctxs[i];
        if (!name || !ctx) continue;
        const ourSymbol = HL_SYMBOL_MAP[name];
        if (!ourSymbol) continue;
        const markPx = Number(ctx.markPx ?? ctx.midPx ?? '0');
        const oiContracts = Number(ctx.openInterest ?? '0');
        const funding = Number(ctx.funding ?? '0');
        if (!Number.isFinite(markPx) || markPx <= 0) continue;
        const oiUsd = oiContracts * markPx;
        const prevOi = this.hlPrevOi.get(ourSymbol);
        const oiMomentumPct = prevOi && prevOi > 0 ? ((oiUsd - prevOi) / prevOi) * 100 : 0;
        this.hlPrevOi.set(ourSymbol, oiUsd);
        const buyImpact = Number(ctx.impactPxs?.[0] ?? '0');
        const sellImpact = Number(ctx.impactPxs?.[1] ?? '0');
        const impactBps = markPx > 0 ? (Math.abs(buyImpact - markPx) + Math.abs(markPx - sellImpact)) / 2 / markPx * 10_000 : 0;
        this.hlData.set(ourSymbol, {
          symbol: ourSymbol,
          markPriceUsd: markPx,
          openInterestUsd: oiUsd,
          fundingRate: funding,
          annualizedFundingPct: funding * 3 * 365 * 100,
          dayVolumeUsd: Number(ctx.dayNtlVlm ?? '0'),
          impactBps,
          oiMomentumPct,
          timestamp: now,
        });
      }
    } catch {
      // Non-critical.
    } finally {
      this.hlPollInFlight = false;
    }
  }

  private async pollImpliedVol(): Promise<void> {
    if (this.ivPollInFlight) return;
    this.ivPollInFlight = true;
    try {
      const now = new Date().toISOString();
      await Promise.all(Object.entries(DVOL_SYMBOL_MAP).map(async ([ourSymbol, currency]) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          // Pull the last hour of 60 s bars and take the most recent close as current DVOL.
          const end = Date.now();
          const start = end - 3_600_000;
          const url = `${DERIBIT_DVOL_URL}?currency=${currency}&start_timestamp=${start}&end_timestamp=${end}&resolution=60`;
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timeout);
          if (!response.ok) return;
          const payload = await response.json() as { result?: { data?: Array<[number, number, number, number, number]> } };
          const bars = payload.result?.data ?? [];
          const last = bars[bars.length - 1];
          const dvol = Array.isArray(last) ? last[4] : undefined;
          if (typeof dvol !== 'number' || !Number.isFinite(dvol)) return;
          const regime: ImpliedVolSignal['dvolRegime'] =
            dvol < 35 ? 'crushed' :
            dvol < 60 ? 'normal' :
            dvol < 90 ? 'elevated' : 'spike';
          this.ivData.set(ourSymbol, { symbol: ourSymbol, dvol, dvolRegime: regime, timestamp: now });
        } catch { /* per-symbol retry next tick */ }
      }));
    } finally {
      this.ivPollInFlight = false;
    }
  }

  private async pollStablecoins(): Promise<void> {
    if (this.stablePollInFlight) return;
    this.stablePollInFlight = true;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch('https://stablecoins.llama.fi/stablecoins?includePrices=false', { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) return;
      const data = await response.json() as { peggedAssets?: Array<{ circulating?: { peggedUSD?: number } }> };
      const total = (data.peggedAssets ?? []).reduce((sum, a) => sum + (a.circulating?.peggedUSD ?? 0), 0);
      if (total <= 0) return;

      const now = Date.now();
      let changePct24h: number | null = null;
      if (this.stablePrevTotal > 0 && now - this.stablePrevTotalAt >= 20 * 60 * 60 * 1000) {
        changePct24h = ((total - this.stablePrevTotal) / this.stablePrevTotal) * 100;
        this.stablePrevTotal = total;
        this.stablePrevTotalAt = now;
      } else if (this.stablePrevTotal === 0) {
        this.stablePrevTotal = total;
        this.stablePrevTotalAt = now;
      }
      const regime: StablecoinRegimeSignal['regime'] =
        changePct24h === null ? 'neutral' :
        changePct24h > 0.5 ? 'inflow' :
        changePct24h < -0.5 ? 'outflow' : 'neutral';

      this.stableSignal = {
        totalMcapUsd: total,
        changePct24h,
        regime,
        timestamp: new Date(now).toISOString(),
      };
    } catch { /* non-critical */ } finally {
      this.stablePollInFlight = false;
    }
  }

  private async pollBtcChainHealth(): Promise<void> {
    if (this.btcChainPollInFlight) return;
    this.btcChainPollInFlight = true;
    try {
      const [hrResp, feeResp] = await Promise.all([
        fetch('https://blockchain.info/q/hashrate', { signal: AbortSignal.timeout(8000) }),
        fetch('https://blockchain.info/q/getmempoolfee', { signal: AbortSignal.timeout(8000) }),
      ]);

      let hashrateEhs: number | null = null;
      if (hrResp.ok) {
        const text = await hrResp.text();
        const v = Number(text);
        if (Number.isFinite(v) && v > 0) hashrateEhs = v;
      }

      let mempoolFeesSatPerVB: number | null = null;
      if (feeResp.ok) {
        const text = await feeResp.text();
        const v = Number(text);
        if (Number.isFinite(v) && v > 0) mempoolFeesSatPerVB = v;
      }

      // Regime: stressed if hashrate dropped >10% day/day OR mempool fees >100 sat/vB
      let regime: BtcChainHealth['regime'] = 'unknown';
      if (hashrateEhs !== null || mempoolFeesSatPerVB !== null) {
        let stressed = false;
        if (hashrateEhs !== null && this.prevHashrate !== null && this.prevHashrate > 0) {
          const dropPct = ((this.prevHashrate - hashrateEhs) / this.prevHashrate) * 100;
          if (dropPct > 10) stressed = true;
        }
        if (mempoolFeesSatPerVB !== null && mempoolFeesSatPerVB > 100) stressed = true;
        regime = stressed ? 'stressed' : 'healthy';

        const now = Date.now();
        if (this.prevHashrateAt === null || now - this.prevHashrateAt >= 20 * 60 * 60 * 1000) {
          if (hashrateEhs !== null) {
            this.prevHashrate = hashrateEhs;
            this.prevHashrateAt = now;
          }
        }
      }

      this.btcChainHealth = { hashrateEhs, mempoolFeesSatPerVB, regime };
    } catch { /* non-critical */ } finally {
      this.btcChainPollInFlight = false;
    }
  }

  /**
   * Poll OANDA + Alpaca snapshots from market-data REST API and feed prices directly
   * to feedPrice() so priceHistory accumulates for non-crypto symbols (Bollinger/VWAP/RSI).
   * Runs every 90s. Bypasses market-feed.ts fingerprint dedup which skips unchanged prices.
   */
  private async pollOandaAlpaca(): Promise<void> {
    if (this.oandaAlpacaPollInFlight) return;
    this.oandaAlpacaPollInFlight = true;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(`${MARKET_DATA_URL}/snapshots`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) return;
      const data = await response.json() as { snapshots?: Array<{ symbol: string; lastPrice: number; volume?: number; assetClass?: string }> };
      const snapshots = data.snapshots ?? [];
      for (const snap of snapshots) {
        // Only process OANDA (forex/commodity) and Alpaca (equity) — crypto is handled
        // by market-feed.ts via Coinbase WebSocket which fires more frequently.
        const isCrypto = snap.symbol.endsWith('-USD') && !snap.symbol.includes('_');
        if (isCrypto) continue;
        if (snap.lastPrice <= 0) continue;
        // For zero-volume OANDA snapshots, derive a synthetic volume from spreadBps
        // so VWAP has enough data points. spreadBps is in basis points (e.g., 1.45).
        const vol = (snap.volume ?? 0) > 0 ? snap.volume : undefined;
        this.feedPrice(snap.symbol, snap.lastPrice, vol);
      }
    } catch { /* non-critical */ } finally {
      this.oandaAlpacaPollInFlight = false;
    }
  }

  private computeBollinger(symbol: string): BollingerState | null {
    return _computeBollinger(this.priceHistory, symbol);
  }

  private computeVwap(symbol: string): VwapState | null {
    return _computeVwap(this.volumeHistory, symbol);
  }

  private computeComposite(symbol: string): CompositeSignal {
    return computeCompositeSignal(
      symbol,
      this.orderFlow,
      this.fearGreed,
      this.priceHistory,
      this.volumeHistory,
      this.barHistory,
      this.fundingRates,
      this.hlData,
      symbol === 'BTC-USD' ? this._venueDivergence : false,
      this.stableSignal,
    );
  }

  /** Called by venue-sanity.ts to cache the latest divergence flag. */
  setVenueDivergence(divergent: boolean): void {
    this._venueDivergence = divergent;
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
