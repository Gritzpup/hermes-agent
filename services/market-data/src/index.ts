import cors from 'cors';
import express from 'express';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createPrivateKey, createSign, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CoinbaseWebSocketFeed, type Level2Snapshot, type TickerUpdate } from './ws-feed.js';

type BrokerId = 'alpaca-paper' | 'coinbase-live' | 'oanda-rest';
type HealthStatus = 'healthy' | 'warning' | 'critical';
type SourceStatus = 'live' | 'degraded' | 'disconnected';
type MarketSession = 'regular' | 'extended' | 'unknown';

interface MarketSnapshot {
  symbol: string;
  broker: BrokerId;
  assetClass: 'equity' | 'crypto' | 'commodity-proxy' | 'forex' | 'bond' | 'commodity';
  lastPrice: number;
  changePct: number;
  volume: number;
  spreadBps: number;
  liquidityScore: number;
  status: 'live' | 'delayed' | 'stale';
  source?: 'broker' | 'service' | 'simulated' | 'mock';
  session?: MarketSession;
  tradable?: boolean;
  qualityFlags?: string[];
  updatedAt?: string;
}

interface MarketDataSourceState {
  venue: BrokerId;
  symbols: string[];
  status: SourceStatus;
  detail: string;
  updatedAt: string;
}

interface MarketDataSnapshotResponse {
  asOf: string;
  universe: string[];
  snapshots: MarketSnapshot[];
  sources: MarketDataSourceState[];
}

const app = express();
const port = Number(process.env.PORT ?? 4302);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const legacyEnv = loadLegacyEnv();
const alpacaBaseUrl = process.env.ALPACA_DATA_BASE_URL ?? 'https://data.alpaca.markets';
const alpacaTradingBaseUrl = trimTrailingSlash(process.env.ALPACA_API_BASE_URL ?? 'https://paper-api.alpaca.markets');
const alpacaPaperKey = readEnv(['ALPACA_PAPER_KEY', 'ALPACA_API_KEY_ID', 'APCA_API_KEY_ID']);
const alpacaPaperSecret = readEnv(['ALPACA_PAPER_SECRET', 'ALPACA_API_SECRET_KEY', 'APCA_API_SECRET_KEY']);
const coinbaseBaseUrl = process.env.COINBASE_ADVANCED_TRADE_BASE_URL ?? 'https://api.coinbase.com/api/v3/brokerage/';
const coinbaseApiKey = readEnv(['COINBASE_API_KEY', 'CDP_API_KEY_NAME']);
const coinbaseApiSecret = readEnv(['COINBASE_API_SECRET', 'CDP_API_KEY_PRIVATE'], true);
const oandaBaseUrl = process.env.OANDA_API_BASE_URL ?? 'https://api-fxpractice.oanda.com/v3';
const oandaApiKey = readEnv(['OANDA_API_KEY', 'OANDA_TOKEN']);
const oandaAccountId = readEnv(['OANDA_ACCOUNT_ID', 'OANDA_ACCOUNT']);

const refreshMs = Number(process.env.MARKET_DATA_REFRESH_MS ?? 5_000);
const coinbaseWsFreshMs = Number(process.env.COINBASE_WS_STALE_MS ?? 10_000);
const alpacaClockCacheMs = Number(process.env.ALPACA_CLOCK_CACHE_MS ?? 30_000);
const maxTradableEquitySpreadBps = Number(process.env.ALPACA_MAX_TRADABLE_SPREAD_BPS ?? 5);
const minTradableEquityLiquidity = Number(process.env.ALPACA_MIN_TRADABLE_LIQUIDITY ?? 85);
const maxTradableCryptoSpreadBps = Number(process.env.COINBASE_MAX_TRADABLE_SPREAD_BPS ?? 8);
const minTradableCryptoLiquidity = Number(process.env.COINBASE_MIN_TRADABLE_LIQUIDITY ?? 80);
const maxTradableForexSpreadBps = Number(process.env.OANDA_MAX_TRADABLE_SPREAD_BPS ?? 20);
const minTradableForexLiquidity = Number(process.env.OANDA_MIN_TRADABLE_LIQUIDITY ?? 30);
const defaultUniverse = [
  // Crypto — Coinbase live
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'PAXG-USD',
  // Forex — OANDA practice
  'EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD',
  // Stock indices (CFDs) — OANDA practice
  'SPX500_USD', 'NAS100_USD', 'US30_USD',
  // Bonds — OANDA practice
  'USB02Y_USD', 'USB05Y_USD', 'USB10Y_USD', 'USB30Y_USD',
  // Commodities — OANDA practice
  'XAU_USD', 'BCO_USD', 'WTICO_USD',
  // US Stocks — Alpaca paper
  'SPY', 'QQQ', 'NVDA',
  // Volatility — Alpaca paper (VIX ETF proxy)
  'VIXY'
];
const universe = (process.env.MARKET_DATA_UNIVERSE ?? defaultUniverse.join(','))
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const runtimeDir = path.resolve(moduleDir, '../../.runtime');
const runtimeFile = path.join(runtimeDir, 'market-data.json');

const previousPrices = new Map<string, number>();
let lastRefreshError = 'Waiting for first market refresh.';
let lastSuccessfulRefreshAt = 0;
let refreshInFlight = false;
let alpacaClockCache: { fetchedAt: number; session: MarketSession; detail: string } | null = null;
let coinbaseWsFeed: CoinbaseWebSocketFeed | null = null;
let coinbaseWsConnected = false;
let coinbaseWsLastMessageAt = 0;

async function fetchWithTimeout(input: string | URL, init: RequestInit = {}, timeoutMs = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

const ALPACA_EQUITY_SYMBOLS = new Set(['VIXY', 'SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'UVXY', 'VXX', 'SVXY']);

function isCryptoSymbol(symbol: string): boolean {
  return symbol.endsWith('-USD');
}
function isAlpacaEquity(symbol: string): boolean {
  return ALPACA_EQUITY_SYMBOLS.has(symbol);
}
function isOandaSymbol(symbol: string): boolean {
  return symbol.includes('_') && !ALPACA_EQUITY_SYMBOLS.has(symbol);
}

const coinbaseTickerState = new Map<string, TickerUpdate>();
const coinbaseMicrostructureState = new Map<string, Level2Snapshot>();
let snapshotState: MarketDataSnapshotResponse = buildEmptySnapshotState({
  alpacaStatus: 'disconnected',
  alpacaDetail: 'Waiting for first successful Alpaca refresh.',
  coinbaseStatus: 'disconnected',
  coinbaseDetail: 'Waiting for first successful Coinbase refresh.',
  oandaStatus: 'disconnected',
  oandaDetail: 'Waiting for first successful OANDA refresh.'
});

app.use(cors());

app.get('/health', (_req, res) => {
  const ageMs = lastSuccessfulRefreshAt > 0 ? Date.now() - lastSuccessfulRefreshAt : Number.POSITIVE_INFINITY;
  const status: HealthStatus =
    lastSuccessfulRefreshAt === 0
      ? 'warning'
      : ageMs > refreshMs * 3
        ? 'critical'
        : ageMs > refreshMs * 1.5
          ? 'warning'
          : 'healthy';

  res.json({
    service: 'market-data',
    status,
    timestamp: new Date().toISOString(),
    message: status === 'healthy' ? 'Live market polling is current.' : lastRefreshError,
    sources: snapshotState.sources,
    runtimePath: runtimeFile
  });
});

app.get('/snapshots', (_req, res) => {
  res.json(snapshotState);
});

app.get('/microstructure', (_req, res) => {
  res.json({
    asOf: new Date().toISOString(),
    connected: coinbaseWsConnected,
    lastMessageAt: coinbaseWsLastMessageAt > 0 ? new Date(coinbaseWsLastMessageAt).toISOString() : null,
    snapshots: Array.from(coinbaseMicrostructureState.values())
  });
});

async function bootstrap(): Promise<void> {
  await fs.mkdir(runtimeDir, { recursive: true });
  const persisted = await loadPersistedSnapshot();
  if (persisted) {
    snapshotState = persisted;
    const parsed = Date.parse(persisted.asOf);
    if (!Number.isNaN(parsed)) {
      lastSuccessfulRefreshAt = parsed;
    }
    lastRefreshError = 'Loaded persisted market snapshot.';
  }

  startCoinbaseFeed(universe.filter((symbol) => isCryptoSymbol(symbol)));
  await refreshSnapshots();
  void persistSnapshotState();
}

async function refreshSnapshots(): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const equities = universe.filter((symbol) => isAlpacaEquity(symbol));
    const crypto = universe.filter((symbol) => isCryptoSymbol(symbol));
    const oandaSymbols = universe.filter((symbol) => isOandaSymbol(symbol));
    const [alpaca, coinbase, oanda] = await Promise.all([
      fetchAlpacaSnapshots(equities),
      fetchCoinbaseSnapshots(crypto),
      fetchOandaSnapshots(oandaSymbols)
    ]);

    snapshotState = {
      asOf: new Date().toISOString(),
      universe,
      snapshots: [...alpaca.snapshots, ...coinbase.snapshots, ...oanda.snapshots].sort((left, right) => left.symbol.localeCompare(right.symbol)),
      sources: [alpaca.source, coinbase.source, oanda.source]
    };

    if (alpaca.source.status === 'live' || coinbase.source.status === 'live' || oanda.source.status === 'live') {
      lastSuccessfulRefreshAt = Date.now();
      lastRefreshError = 'Market polling healthy.';
    } else {
      lastRefreshError = [alpaca.source.detail, coinbase.source.detail, oanda.source.detail].filter(Boolean).join(' ');
    }

    await persistSnapshotState();
  } catch (error) {
    lastRefreshError = `Market refresh failed: ${error instanceof Error ? error.message : 'unknown error'}`;
    snapshotState = buildEmptySnapshotState({
      alpacaStatus: 'degraded',
      alpacaDetail: lastRefreshError,
      coinbaseStatus: 'degraded',
      coinbaseDetail: lastRefreshError,
      oandaStatus: 'degraded',
      oandaDetail: lastRefreshError
    });
    await persistSnapshotState();
  } finally {
    refreshInFlight = false;
  }
}

function startCoinbaseFeed(symbols: string[]): void {
  const cryptoSymbols = symbols.filter((symbol) => isCryptoSymbol(symbol));
  if (cryptoSymbols.length === 0 || coinbaseWsFeed) {
    return;
  }

  coinbaseWsFeed = new CoinbaseWebSocketFeed(cryptoSymbols);
  coinbaseWsFeed.on('status', (status: { connected?: boolean }) => {
    coinbaseWsConnected = status.connected === true;
  });
  coinbaseWsFeed.on('ticker', (ticker: TickerUpdate) => {
    coinbaseWsLastMessageAt = Date.now();
    coinbaseTickerState.set(ticker.symbol, ticker);
  });
  coinbaseWsFeed.on('level2', (snapshot: Level2Snapshot) => {
    coinbaseWsLastMessageAt = Date.now();
    coinbaseMicrostructureState.set(snapshot.symbol, snapshot);
  });
  void coinbaseWsFeed.start();
}

async function fetchAlpacaSnapshots(symbols: string[]): Promise<{ snapshots: MarketSnapshot[]; source: MarketDataSourceState }> {
  if (symbols.length === 0) {
    return {
      snapshots: [],
      source: buildSourceState('alpaca-paper', symbols, 'disconnected', 'No Alpaca symbols configured.')
    };
  }

  if (!alpacaPaperKey || !alpacaPaperSecret) {
    return {
      snapshots: [],
      source: buildSourceState('alpaca-paper', symbols, 'degraded', 'Missing Alpaca paper credentials.')
    };
  }

  try {
    const updatedAt = new Date().toISOString();
    const url = new URL('/v2/stocks/snapshots', alpacaBaseUrl);
    url.searchParams.set('symbols', symbols.join(','));
    const clock = await fetchAlpacaClockState();
    const response = await fetchWithTimeout(url, {
      headers: {
        'APCA-API-KEY-ID': alpacaPaperKey,
        'APCA-API-SECRET-KEY': alpacaPaperSecret
      }
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(extractErrorMessage(payload, `Alpaca data request failed with ${response.status}.`));
    }

    const rawEntries = (
      payload.snapshots && typeof payload.snapshots === 'object'
        ? payload.snapshots
        : payload
    ) as Record<string, {
      dailyBar?: { o?: number; c?: number; v?: number };
      latestTrade?: { p?: number };
      latestQuote?: { bp?: number; ap?: number };
    }>;

    if (!rawEntries || Object.keys(rawEntries).length === 0) {
      throw new Error('Alpaca did not return a snapshots object.');
    }

    return {
      snapshots: symbols.map((symbol): MarketSnapshot => {
        const entry = rawEntries[symbol];
        const bid = entry?.latestQuote?.bp ?? 0;
        const ask = entry?.latestQuote?.ap ?? 0;
        const lastTrade = entry?.latestTrade?.p ?? midpoint(bid, ask);
        const open = entry?.dailyBar?.o ?? lastTrade;
        const spreadBps = bid > 0 && ask > 0 ? ((ask - bid) / midpoint(bid, ask)) * 10_000 : 0;
        const liquidityScore = scoreLiquidity(spreadBps);
        const quality = assessMarketQuality({
          assetClass: 'equity',
          lastPrice: lastTrade,
          bid,
          ask,
          spreadBps,
          liquidityScore,
          session: clock.session,
          source: 'service'
        });

        return {
          symbol,
          broker: 'alpaca-paper',
          assetClass: 'equity',
          lastPrice: round(lastTrade, 2),
          changePct: open > 0 ? round(((lastTrade - open) / open) * 100, 2) : 0,
          volume: Math.round(entry?.dailyBar?.v ?? 0),
          spreadBps: round(spreadBps, 2),
          liquidityScore,
          status: bid > 0 && ask > 0 && lastTrade > 0 ? (quality.tradable ? 'live' : 'delayed') : 'stale',
          source: 'service',
          session: quality.session,
          tradable: quality.tradable,
          qualityFlags: quality.qualityFlags,
          updatedAt
        };
      }),
      source: buildSourceState(
        'alpaca-paper',
        symbols,
        'live',
        `Pulling live equity snapshots from Alpaca data API. ${clock.detail}`
      )
    };
  } catch (error) {
    return {
      snapshots: [],
      source: buildSourceState(
        'alpaca-paper',
        symbols,
        'degraded',
        `Alpaca snapshot polling failed: ${error instanceof Error ? error.message : 'unknown error'}.`
      )
    };
  }
}

async function fetchCoinbaseSnapshots(symbols: string[]): Promise<{ snapshots: MarketSnapshot[]; source: MarketDataSourceState }> {
  if (symbols.length === 0) {
    return {
      snapshots: [],
      source: buildSourceState('coinbase-live', symbols, 'disconnected', 'No Coinbase symbols configured.')
    };
  }

  try {
    const updatedAt = new Date().toISOString();
    const wsFresh = coinbaseWsConnected && coinbaseWsLastMessageAt > 0 && (Date.now() - coinbaseWsLastMessageAt) <= coinbaseWsFreshMs;
    const booksBySymbol = new Map<string, { bid: number; ask: number; price: number; volume: number }>();

    if (wsFresh) {
      for (const symbol of symbols) {
        const ticker = coinbaseTickerState.get(symbol);
        const micro = coinbaseMicrostructureState.get(symbol);
        const bid = micro?.bestBid ?? ticker?.bid ?? 0;
        const ask = micro?.bestAsk ?? ticker?.ask ?? 0;
        const price = ticker?.price ?? midpoint(bid, ask);
        const volume = ticker?.volume24h ?? 0;
        if (price > 0 || (bid > 0 && ask > 0)) {
          booksBySymbol.set(symbol, { bid, ask, price, volume });
        }
      }
    }

    const missing = symbols.filter((symbol) => !booksBySymbol.has(symbol));
    if (missing.length > 0) {
      const fallbackBooks = await Promise.all(missing.map((symbol) => fetchCoinbasePublicBook(symbol)));
      for (const fallback of fallbackBooks) {
        if (fallback) {
          booksBySymbol.set(fallback.symbol, fallback);
        }
      }
    }

    const snapshots: MarketSnapshot[] = symbols.map((symbol): MarketSnapshot => {
      const book = booksBySymbol.get(symbol);
      const bid = book?.bid ?? 0;
      const ask = book?.ask ?? 0;
      const lastPrice = book?.price && book.price > 0 ? book.price : midpoint(bid, ask);
      const prior = previousPrices.get(symbol) ?? lastPrice;
      previousPrices.set(symbol, lastPrice);
      const spreadBps = bid > 0 && ask > 0 && lastPrice > 0 ? ((ask - bid) / lastPrice) * 10_000 : 0;
      const liquidityScore = scoreLiquidity(spreadBps);
      const quality = assessMarketQuality({
        assetClass: symbol === 'PAXG-USD' ? 'commodity-proxy' : 'crypto',
        lastPrice,
        bid,
        ask,
        spreadBps,
        liquidityScore,
        session: 'regular',
        source: 'service'
      });

      return {
        symbol,
        broker: 'coinbase-live' as BrokerId,
        assetClass: symbol === 'PAXG-USD' ? 'commodity-proxy' : 'crypto',
        lastPrice: round(lastPrice, 2),
        changePct: prior > 0 ? round(((lastPrice - prior) / prior) * 100, 2) : 0,
        volume: Math.round(book?.volume ?? 0),
        spreadBps: round(spreadBps, 2),
        liquidityScore,
        status: bid > 0 && ask > 0 && lastPrice > 0 ? (wsFresh && quality.tradable ? 'live' : 'delayed') : 'stale',
        source: 'service',
        session: quality.session,
        tradable: quality.tradable,
        qualityFlags: quality.qualityFlags,
        updatedAt
      };
    });

    const detail = wsFresh
      ? 'Pulling live crypto tape from Coinbase public WebSocket ticker + L2 (no paid Pro subscription required). REST is fallback only.'
      : 'Coinbase public REST fallback is active because the WebSocket feed is stale or reconnecting.';

    return {
      snapshots,
      source: buildSourceState('coinbase-live', symbols, wsFresh ? 'live' : 'degraded', detail)
    };
  } catch (error) {
    return {
      snapshots: [],
      source: buildSourceState(
        'coinbase-live',
        symbols,
        'degraded',
        `Coinbase public market-data collection failed: ${error instanceof Error ? error.message : 'unknown error'}.`
      )
    };
  }
}


async function fetchCoinbasePublicBook(symbol: string): Promise<{ symbol: string; bid: number; ask: number; price: number; volume: number } | null> {
  try {
    const [bookResponse, productResponse] = await Promise.all([
      fetchWithTimeout(`https://api.coinbase.com/api/v3/brokerage/market/product_book?product_id=${encodeURIComponent(symbol)}&limit=1`),
      fetchWithTimeout(`https://api.coinbase.com/api/v3/brokerage/market/products/${encodeURIComponent(symbol)}`)
    ]);
    const bookPayload = await bookResponse.json() as {
      pricebook?: {
        bids?: Array<{ price?: string }>;
        asks?: Array<{ price?: string }>;
      };
    };
    const productPayload = await productResponse.json() as { price?: string; volume_24h?: string };

    if (!bookResponse.ok && !productResponse.ok) {
      return null;
    }

    const bid = Number(bookPayload.pricebook?.bids?.[0]?.price ?? 0);
    const ask = Number(bookPayload.pricebook?.asks?.[0]?.price ?? 0);
    const price = Number(productPayload.price ?? midpoint(bid, ask));
    const volume = Number(productPayload.volume_24h ?? 0);
    return { symbol, bid, ask, price, volume };
  } catch {
    return null;
  }
}

async function fetchOandaSnapshots(symbols: string[]): Promise<{ snapshots: MarketSnapshot[]; source: MarketDataSourceState }> {
  if (symbols.length === 0) {
    return {
      snapshots: [],
      source: buildSourceState('oanda-rest', symbols, 'disconnected', 'No OANDA symbols configured.')
    };
  }

  if (!oandaApiKey || !oandaAccountId) {
    return {
      snapshots: [],
      source: buildSourceState('oanda-rest', symbols, 'degraded', 'Missing OANDA credentials (OANDA_API_KEY/OANDA_ACCOUNT_ID).')
    };
  }

  try {
    const updatedAt = new Date().toISOString();
    const url = `${oandaBaseUrl}/accounts/${oandaAccountId}/pricing?instruments=${symbols.join(',')}`;
    const response = await fetchWithTimeout(url, {
      headers: {
        'Authorization': `Bearer ${oandaApiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    const payload = await response.json() as { prices?: any[], errorMessage?: string };
    if (!response.ok) {
      throw new Error(payload.errorMessage || `OANDA request failed with ${response.status}.`);
    }

    const prices = payload.prices ?? [];
    const snapshots: MarketSnapshot[] = symbols.map((symbol): MarketSnapshot => {
      const priceEntry = prices.find((p: any) => p.instrument === symbol);
      const bid = Number(priceEntry?.bids?.[0]?.price ?? 0);
      const ask = Number(priceEntry?.asks?.[0]?.price ?? 0);
      const lastPrice = midpoint(bid, ask);
      const prior = previousPrices.get(symbol) ?? lastPrice;
      previousPrices.set(symbol, lastPrice);
      
      const spreadBps = bid > 0 && ask > 0 ? ((ask - bid) / lastPrice) * 10_000 : 0;
      const liquidityScore = scoreLiquidity(spreadBps);
      const quality = assessMarketQuality({
        assetClass: symbol === 'PAXG-USD' ? 'commodity-proxy' : 'forex',
        lastPrice,
        bid,
        ask,
        spreadBps,
        liquidityScore,
        session: 'regular',
        source: 'service'
      });
      
      let assetClass: MarketSnapshot['assetClass'] = 'forex';
      if (isBondSymbol(symbol)) assetClass = 'bond';
      else if (['SPX500_USD', 'NAS100_USD', 'US30_USD', 'DE30_EUR', 'UK100_GBP'].includes(symbol)) assetClass = 'equity';
      else if (['XAU_USD', 'XAG_USD', 'BCO_USD', 'WTICO_USD'].includes(symbol)) assetClass = 'commodity';

      return {
        symbol,
        broker: 'oanda-rest',
        assetClass,
        lastPrice: round(lastPrice, 5),
        changePct: prior > 0 ? round(((lastPrice - prior) / prior) * 100, 3) : 0,
        volume: 0,
        spreadBps: round(spreadBps, 2),
        liquidityScore,
        status: bid > 0 && ask > 0 && lastPrice > 0 ? (quality.tradable ? 'live' : 'delayed') : 'stale',
        source: 'service',
        session: 'regular',
        tradable: quality.tradable,
        qualityFlags: quality.qualityFlags,
        updatedAt
      };
    });

    return {
      snapshots,
      source: buildSourceState('oanda-rest', symbols, 'live', 'Pulling live FX/CFD pricing from OANDA REST v20.')
    };
  } catch (error) {
    return {
      snapshots: [],
      source: buildSourceState(
        'oanda-rest',
        symbols,
        'degraded',
        `OANDA polling failed: ${error instanceof Error ? error.message : 'unknown error'}.`
      )
    };
  }
}

function buildSourceState(
  venue: BrokerId,
  symbols: string[],
  status: SourceStatus,
  detail: string
): MarketDataSourceState {
  return {
    venue,
    symbols,
    status,
    detail,
    updatedAt: new Date().toISOString()
  };
}

async function fetchAlpacaClockState(): Promise<{ session: MarketSession; detail: string }> {
  if (!alpacaPaperKey || !alpacaPaperSecret) {
    return {
      session: 'unknown',
      detail: 'Alpaca clock unavailable because paper credentials are missing.'
    };
  }

  if (alpacaClockCache && Date.now() - alpacaClockCache.fetchedAt < alpacaClockCacheMs) {
    return {
      session: alpacaClockCache.session,
      detail: alpacaClockCache.detail
    };
  }

  try {
    const response = await fetchWithTimeout(`${alpacaTradingBaseUrl}/v2/clock`, {
      headers: {
        'APCA-API-KEY-ID': alpacaPaperKey,
        'APCA-API-SECRET-KEY': alpacaPaperSecret
      }
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(extractErrorMessage(payload, `Alpaca clock request failed with ${response.status}.`));
    }

    const session: MarketSession = payload.is_open === true ? 'regular' : 'extended';
    const detail = session === 'regular'
      ? 'US equities are in the regular session.'
      : 'US equities are outside regular hours, so autonomous equity entries are blocked.';
    alpacaClockCache = {
      fetchedAt: Date.now(),
      session,
      detail
    };
    return { session, detail };
  } catch (error) {
    return {
      session: 'unknown',
      detail: `Alpaca clock unavailable: ${error instanceof Error ? error.message : 'unknown error'}.`
    };
  }
}

function assessMarketQuality(params: {
  assetClass: MarketSnapshot['assetClass'];
  lastPrice: number;
  bid: number;
  ask: number;
  spreadBps: number;
  liquidityScore: number;
  session: MarketSession;
  source: NonNullable<MarketSnapshot['source']>;
}): { session: MarketSession; tradable: boolean; qualityFlags: string[] } {
  const qualityFlags: string[] = [];
  const session = params.assetClass === 'equity' ? params.session : 'regular';

  if (params.source === 'mock' || params.source === 'simulated') {
    qualityFlags.push('fallback-data');
  }
  if (params.lastPrice <= 0) {
    qualityFlags.push('missing-last-price');
  }
  if (params.bid <= 0 || params.ask <= 0) {
    qualityFlags.push('incomplete-quote');
  }

  if (params.assetClass === 'equity') {
    if (session !== 'regular') {
      qualityFlags.push(session === 'extended' ? 'extended-session' : 'unknown-session');
    }
    if (params.spreadBps > maxTradableEquitySpreadBps) {
      qualityFlags.push('wide-spread');
    }
    if (params.liquidityScore < minTradableEquityLiquidity) {
      qualityFlags.push('low-liquidity');
    }
  } else if (params.assetClass === 'forex' || params.assetClass === 'bond' || params.assetClass === 'commodity') {
    // OANDA practice: wider spreads and lower liquidity are normal
    if (params.spreadBps > maxTradableForexSpreadBps) {
      qualityFlags.push('wide-spread');
    }
    if (params.liquidityScore < minTradableForexLiquidity) {
      qualityFlags.push('low-liquidity');
    }
  } else {
    // Crypto
    if (params.spreadBps > maxTradableCryptoSpreadBps) {
      qualityFlags.push('wide-spread');
    }
    if (params.liquidityScore < minTradableCryptoLiquidity) {
      qualityFlags.push('low-liquidity');
    }
  }

  return {
    session,
    tradable: qualityFlags.length === 0,
    qualityFlags
  };
}

async function fetchCoinbaseJson<T>(resource: string): Promise<T> {
  const baseUrl = new URL(coinbaseBaseUrl.endsWith('/') ? coinbaseBaseUrl : `${coinbaseBaseUrl}/`);
  const normalizedResource = resource.startsWith('/') ? resource.slice(1) : resource;
  const requestPath = `/${baseUrl.pathname.replace(/^\/+/, '').replace(/\/+$/, '')}/${normalizedResource}`.replace(/\/+/g, '/');
  const token = createCoinbaseJwt('GET', requestPath, baseUrl.host);
  const response = await fetchWithTimeout(new URL(normalizedResource, baseUrl), {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const text = await response.text();
  let payload: unknown = {};
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload as Record<string, unknown>, `Coinbase request failed with ${response.status}.`));
  }
  return payload as T;
}

function createCoinbaseJwt(method: string, requestPath: string, requestHost: string): string {
  const key = createPrivateKey(normalizePem(coinbaseApiSecret));
  const header = {
    alg: 'ES256',
    kid: coinbaseApiKey,
    nonce: randomBytes(16).toString('hex'),
    typ: 'JWT'
  };
  const now = Math.floor(Date.now() / 1_000);
  const normalizedPath = new URL(`https://${requestHost}${requestPath}`).pathname;
  const payload = {
    aud: ['cdp_service'],
    iss: 'cdp',
    nbf: now,
    exp: now + 120,
    sub: coinbaseApiKey,
    uri: `${method.toUpperCase()} ${requestHost}${normalizedPath}`
  };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signer = createSign('sha256');
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${encodedHeader}.${encodedPayload}.${toBase64Url(signature)}`;
}

function isForexSymbol(symbol: string): boolean {
  return /^[A-Z]{3}_[A-Z]{3}$/.test(symbol);
}

function isBondSymbol(symbol: string): boolean {
  return symbol.startsWith('USB') || symbol.endsWith('YB');
}


function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function scoreLiquidity(spreadBps: number): number {
  return Math.max(20, Math.min(99, Math.round(100 - spreadBps * 7)));
}

function midpoint(bid: number, ask: number): number {
  if (bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }
  return bid || ask || 0;
}

function normalizePem(secret: string): string {
  return secret.includes('\\n') ? secret.replace(/\\n/g, '\n') : secret;
}

function toBase64Url(value: string | Uint8Array): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function loadLegacyEnv(): Record<string, string> {
  const files = [
    path.resolve(moduleDir, '../../../.env'),
    path.resolve(moduleDir, '../../../../project-sanctuary/hermes-trading-post/backend/.env'),
    path.resolve(moduleDir, '../../../../project-sanctuary/hermes-trading-post/backend/live-bots/.env'),
    path.resolve(moduleDir, '../../../../project-sanctuary/hermes-trading-post/backend/live-ai-bots/.env')
  ];
  const values: Record<string, string> = {};

  for (const filePath of files) {
    try {
      if (!fsSync.existsSync(filePath)) {
        continue;
      }

      const content = fsSync.readFileSync(filePath, 'utf8');
      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
          continue;
        }
        const separator = line.indexOf('=');
        if (separator <= 0) {
          continue;
        }
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (key && !(key in values)) {
          values[key] = value;
        }
      }
    } catch {
      // Ignore legacy env read failures and fall back to process env only.
    }
  }

  return values;
}

function readEnv(names: string[], normalizeNewlines = false): string {
  for (const name of names) {
    const value = process.env[name] ?? legacyEnv[name];
    if (!value) {
      continue;
    }
    const normalized = normalizeNewlines ? value.replace(/\\n/g, '\n') : value;
    const trimmed = normalized.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return '';
}

function extractErrorMessage(payload: Record<string, unknown>, fallback: string): string {
  const message = payload.message;
  if (typeof message === 'string' && message.length > 0) {
    return message;
  }
  const error = payload.error;
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return fallback;
}

function round(value: number, decimals: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}

function buildEmptySnapshotState(params: {
  alpacaStatus: SourceStatus;
  alpacaDetail: string;
  coinbaseStatus: SourceStatus;
  coinbaseDetail: string;
  oandaStatus: SourceStatus;
  oandaDetail: string;
}): MarketDataSnapshotResponse {
  return {
    asOf: new Date().toISOString(),
    universe,
    snapshots: [],
    sources: [
      buildSourceState(
        'alpaca-paper',
        universe.filter((symbol) => isAlpacaEquity(symbol)),
        params.alpacaStatus,
        params.alpacaDetail
      ),
      buildSourceState(
        'coinbase-live',
        universe.filter((symbol) => isCryptoSymbol(symbol)),
        params.coinbaseStatus,
        params.coinbaseDetail
      ),
      buildSourceState(
        'oanda-rest',
        universe.filter((symbol) => isOandaSymbol(symbol)),
        params.oandaStatus,
        params.oandaDetail
      )
    ]
  };
}

async function loadPersistedSnapshot(): Promise<MarketDataSnapshotResponse | null> {
  try {
    const text = await fs.readFile(runtimeFile, 'utf8');
    const parsed = JSON.parse(text) as Partial<MarketDataSnapshotResponse>;
    if (!parsed || !Array.isArray(parsed.snapshots) || !Array.isArray(parsed.sources)) {
      return null;
    }

    const snapshots = parsed.snapshots.filter(isPersistedSnapshot);
    const sources = parsed.sources.filter(isPersistedSourceState);

    return {
      asOf: typeof parsed.asOf === 'string' ? parsed.asOf : new Date().toISOString(),
      universe: Array.isArray(parsed.universe) ? parsed.universe.filter((value): value is string => typeof value === 'string') : universe,
      snapshots,
      sources
    };
  } catch {
    return null;
  }
}

function isPersistedSnapshot(value: unknown): value is MarketSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const snapshot = value as Partial<MarketSnapshot>;
  if (snapshot.source === 'mock' || snapshot.source === 'simulated') {
    return false;
  }
  if (snapshot.qualityFlags?.includes('fallback-data')) {
    return false;
  }
  return typeof snapshot.symbol === 'string' && typeof snapshot.lastPrice === 'number';
}

function isPersistedSourceState(value: unknown): value is MarketDataSourceState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const source = value as Partial<MarketDataSourceState>;
  return (
    (source.venue === 'alpaca-paper' || source.venue === 'coinbase-live' || source.venue === 'oanda-rest') &&
    (source.status === 'live' || source.status === 'degraded' || source.status === 'disconnected') &&
    Array.isArray(source.symbols) &&
    typeof source.detail === 'string' &&
    typeof source.updatedAt === 'string'
  );
}

async function persistSnapshotState(): Promise<void> {
  try {
    await fs.mkdir(runtimeDir, { recursive: true });
    const tmpFile = `${runtimeFile}.tmp`;
    await fs.writeFile(tmpFile, `${JSON.stringify(snapshotState, null, 2)}\n`, 'utf8');
    await fs.rename(tmpFile, runtimeFile);
  } catch (error) {
    lastRefreshError = `Failed to persist market snapshot: ${error instanceof Error ? error.message : 'unknown error'}`;
  }
}

void bootstrap();
setInterval(() => {
  void refreshSnapshots();
}, refreshMs);

app.listen(port, '0.0.0.0', () => {
  console.log(`[market-data] listening on http://0.0.0.0:${port}`);
});
