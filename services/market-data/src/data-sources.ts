// @ts-nocheck
import type { MarketSnapshot, MarketDataSourceState, BrokerId } from '@hermes/contracts';
import type { MarketSession } from './types.js';
import {
  readEnv,
  trimTrailingSlash,
  isBondSymbol,
  fetchWithTimeout,
  midpoint,
  round,
  scoreLiquidity,
  assessMarketQuality,
  extractErrorMessage,
  imputeEquitySpreadBps
} from './utils.js';
import {
  previousPrices,
  buildSourceState,
  pushTick
} from './data-processing.js';
import {
  coinbaseTickerState,
  coinbaseMicrostructureState,
  coinbaseWsConnected,
  coinbaseWsLastMessageAt,
  coinbaseWsFreshMsValue
} from './coinbase-feed.js';

// Re-export everything index.ts needs from coinbase-feed
export {
  coinbaseWsConnected,
  coinbaseWsLastMessageAt,
  coinbaseMicrostructureState,
  startCoinbaseFeed,
  fetchCoinbaseJson
} from './coinbase-feed.js';

/* ── Credentials & config ────────────────────────────────────────── */

const alpacaBaseUrl = process.env.ALPACA_DATA_BASE_URL ?? 'https://data.alpaca.markets';
const alpacaTradingBaseUrl = trimTrailingSlash(process.env.ALPACA_API_BASE_URL ?? 'https://paper-api.alpaca.markets');
const alpacaPaperKey = readEnv(['ALPACA_PAPER_KEY', 'ALPACA_API_KEY_ID', 'APCA_API_KEY_ID']);
const alpacaPaperSecret = readEnv(['ALPACA_PAPER_SECRET', 'ALPACA_API_SECRET_KEY', 'APCA_API_SECRET_KEY']);
const oandaBaseUrl = process.env.OANDA_API_BASE_URL ?? 'https://api-fxpractice.oanda.com/v3';
const oandaApiKey = readEnv(['OANDA_API_KEY', 'OANDA_TOKEN']);
const oandaAccountId = readEnv(['OANDA_ACCOUNT_ID', 'OANDA_ACCOUNT']);

const alpacaClockCacheMs = Number(process.env.ALPACA_CLOCK_CACHE_MS ?? 30_000);
const coinbaseLiveDetail = 'Pulling live crypto tape from Coinbase public WebSocket ticker + L2 (no paid Pro subscription required). REST is fallback only.';

/* ── Alpaca clock cache ──────────────────────────────────────────── */

let alpacaClockCache: { fetchedAt: number; session: MarketSession; detail: string } | null = null;

/* ── Alpaca ───────────────────────────────────────────────────────── */

export async function fetchAlpacaSnapshots(symbols: string[]): Promise<{ snapshots: MarketSnapshot[]; source: MarketDataSourceState }> {
  if (symbols.length === 0) {
    return {
      snapshots: [],
      source: buildSourceState('alpaca-paper', symbols, 'stale', 'No Alpaca symbols configured.')
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

    const snapshots = symbols.map((symbol): MarketSnapshot => {
        const entry = rawEntries[symbol];
        const bid = entry?.latestQuote?.bp ?? 0;
        const ask = entry?.latestQuote?.ap ?? 0;
        const lastTrade = entry?.latestTrade?.p ?? midpoint(bid, ask);
        const open = entry?.dailyBar?.o ?? lastTrade;
        const rawSpreadBps = bid > 0 && ask > 0 ? ((ask - bid) / midpoint(bid, ask)) * 10_000 : 0;
        const spreadBps = imputeEquitySpreadBps(symbol, rawSpreadBps, bid, ask, lastTrade);
        const spreadWasImputed = spreadBps !== rawSpreadBps;
        const liquidityScore = scoreLiquidity(spreadBps);

        // For quality assessment, use imputed bid/ask when the raw quote is
        // missing or unrealistically wide — this prevents the incomplete-quote
        // flag from making the snapshot permanently untradable for equities
        // whose last trade price is valid.
        const effectiveBid = (bid > 0 && ask > 0 && !spreadWasImputed)
          ? bid
          : lastTrade > 0 ? lastTrade * (1 - spreadBps / 20_000) : 0;
        const effectiveAsk = (bid > 0 && ask > 0 && !spreadWasImputed)
          ? ask
          : lastTrade > 0 ? lastTrade * (1 + spreadBps / 20_000) : 0;

        const quality = assessMarketQuality({
          assetClass: 'equity',
          lastPrice: lastTrade,
          bid: effectiveBid,
          ask: effectiveAsk,
          spreadBps,
          liquidityScore,
          session: clock.session,
          source: 'service'
        });

        // Add imputed-spread flag when we overrode the raw data, so
        // downstream consumers can see the spread is synthetic.
        if (spreadWasImputed && !quality.qualityFlags.includes('imputed-spread')) {
          quality.qualityFlags.push('imputed-spread');
        }

        const hasUsablePrice = lastTrade > 0 && (effectiveBid > 0 && effectiveAsk > 0);
        const snapshot = {
          symbol,
          broker: 'alpaca-paper' as BrokerId,
          assetClass: 'equity' as const,
          lastPrice: round(lastTrade, 2),
          changePct: open > 0 ? round(((lastTrade - open) / open) * 100, 2) : 0,
          volume: Math.round(entry?.dailyBar?.v ?? 0),
          spreadBps: round(spreadBps, 2),
          liquidityScore,
          status: (hasUsablePrice ? (quality.tradable ? 'live' : 'delayed') : 'stale') as MarketSnapshot['status'],
          source: 'service' as const,
          session: quality.session as any,
          tradable: quality.tradable,
          qualityFlags: quality.qualityFlags,
          updatedAt
        };

        pushTick({ symbol, price: snapshot.lastPrice, size: 0, broker: 'alpaca-paper' });
        return snapshot as MarketSnapshot;
      });

    return {
      snapshots,
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

/* ── Coinbase REST polling ───────────────────────────────────────── */

export async function fetchCoinbaseSnapshots(symbols: string[]): Promise<{ snapshots: MarketSnapshot[]; source: MarketDataSourceState }> {
  if (symbols.length === 0) {
    return {
      snapshots: [],
      source: buildSourceState('coinbase-live', symbols, 'stale', 'No Coinbase symbols configured.')
    };
  }

  try {
    const updatedAt = new Date().toISOString();
    const wsFresh = coinbaseWsConnected && coinbaseWsLastMessageAt > 0 && (Date.now() - coinbaseWsLastMessageAt) <= coinbaseWsFreshMsValue;
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

      const snapshot = {
        symbol,
        broker: 'coinbase-live' as BrokerId,
        assetClass: symbol === 'PAXG-USD' ? 'commodity-proxy' : 'crypto',
        lastPrice: round(lastPrice, 2),
        changePct: prior > 0 ? round(((lastPrice - prior) / prior) * 100, 2) : 0,
        volume: Math.round(book?.volume ?? 0),
        spreadBps: round(spreadBps, 2),
        liquidityScore,
        status: (bid > 0 && ask > 0 && lastPrice > 0 ? (wsFresh && quality.tradable ? 'live' : 'delayed') : 'stale') as MarketSnapshot['status'],
        source: 'service' as const,
        session: quality.session as any,
        tradable: quality.tradable,
        qualityFlags: quality.qualityFlags,
        updatedAt
      };

      pushTick({ symbol, price: snapshot.lastPrice, size: 0, broker: 'coinbase-live' });
      return snapshot as MarketSnapshot;
    });

    const detail = wsFresh
      ? coinbaseLiveDetail
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

/* ── OANDA ───────────────────────────────────────────────────────── */

export async function fetchOandaSnapshots(symbols: string[]): Promise<{ snapshots: MarketSnapshot[]; source: MarketDataSourceState }> {
  if (symbols.length === 0) {
    return {
      snapshots: [],
      source: buildSourceState('oanda-rest', symbols, 'stale', 'No OANDA symbols configured.')
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

      const snapshot = {
        symbol,
        broker: 'oanda-rest' as BrokerId,
        assetClass,
        lastPrice: round(lastPrice, 5),
        changePct: prior > 0 ? round(((lastPrice - prior) / prior) * 100, 3) : 0,
        volume: 0,
        spreadBps: round(spreadBps, 2),
        liquidityScore,
        status: (bid > 0 && ask > 0 && lastPrice > 0 ? (quality.tradable ? 'live' : 'delayed') : 'stale') as MarketSnapshot['status'],
        source: 'service' as const,
        session: 'regular' as any,
        tradable: quality.tradable,
        qualityFlags: quality.qualityFlags,
        updatedAt
      };

      pushTick({ symbol, price: snapshot.lastPrice, size: 0, broker: 'oanda-rest' });
      return snapshot as MarketSnapshot;
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

/* ── Alpaca clock ────────────────────────────────────────────────── */

export async function fetchAlpacaClockState(): Promise<{ session: MarketSession; detail: string }> {
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
