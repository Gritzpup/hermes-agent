// @ts-nocheck
import { createPrivateKey, createSign, randomBytes } from 'node:crypto';
import { CoinbaseWebSocketFeed, type Level2Snapshot, type TickerUpdate } from './ws-feed.js';
import { redis, TOPICS } from '@hermes/infra';
import { logger } from '@hermes/logger';
import type { MarketSnapshot } from '@hermes/contracts';
import {
  readEnv,
  isCryptoSymbol,
  fetchWithTimeout,
  midpoint,
  round,
  scoreLiquidity,
  assessMarketQuality,
  normalizePem,
  toBase64Url,
  extractErrorMessage
} from './utils.js';
import {
  previousPrices,
  snapshotState,
  upsertSnapshotState,
  patchSourceState,
  pushTick
} from './data-processing.js';

/* ── Coinbase credentials ────────────────────────────────────────── */

const coinbaseBaseUrl = process.env.COINBASE_ADVANCED_TRADE_BASE_URL ?? 'https://api.coinbase.com/api/v3/brokerage/';
const coinbaseApiKey = readEnv(['COINBASE_API_KEY', 'CDP_API_KEY_NAME']);
const coinbaseApiSecret = readEnv(['COINBASE_API_SECRET', 'CDP_API_KEY_PRIVATE'], true);
// B8 FIX: Reduced from 10s to 5s — combined with the heartbeat watchdog in ws-feed.ts,
// this gives a 5s hard ceiling on silent feed hangs before data-sources marks it stale.
const coinbaseWsFreshMs = Number(process.env.COINBASE_WS_STALE_MS ?? 5_000);

/* ── WebSocket state ─────────────────────────────────────────────── */

export const coinbaseTickerState = new Map<string, TickerUpdate>();
export const coinbaseMicrostructureState = new Map<string, Level2Snapshot>();
export let coinbaseWsFeed: CoinbaseWebSocketFeed | null = null;
export let coinbaseWsConnected = false;
export let coinbaseWsLastMessageAt = 0;
export const coinbaseWsFreshMsValue = coinbaseWsFreshMs;
const coinbaseLiveDetail = 'Pulling live crypto tape from Coinbase public WebSocket ticker + L2 (no paid Pro subscription required). REST is fallback only.';

/* ── WebSocket feed management ───────────────────────────────────── */

export function startCoinbaseFeed(symbols: string[]): void {
  const cryptoSymbols = symbols.filter((symbol) => isCryptoSymbol(symbol));
  if (cryptoSymbols.length === 0 || coinbaseWsFeed) {
    return;
  }

  coinbaseWsFeed = new CoinbaseWebSocketFeed(cryptoSymbols);
  coinbaseWsFeed.on('status', (status: { connected?: boolean }) => {
    coinbaseWsConnected = status.connected === true;
    patchSourceState('coinbase-live', coinbaseWsConnected ? 'live' : 'degraded', coinbaseWsConnected ? coinbaseLiveDetail : 'Coinbase WebSocket reconnecting. REST fallback remains available.');
  });
  coinbaseWsFeed.on('ticker', (ticker: TickerUpdate) => {
    coinbaseWsLastMessageAt = Date.now();
    coinbaseTickerState.set(ticker.symbol, ticker);
    updateCoinbaseSnapshotState(ticker.symbol);
  });
  coinbaseWsFeed.on('level2', (snapshot: Level2Snapshot) => {
    coinbaseWsLastMessageAt = Date.now();
    coinbaseMicrostructureState.set(snapshot.symbol, snapshot);
    updateCoinbaseSnapshotState(snapshot.symbol);
  });
  void coinbaseWsFeed.start();
}

function updateCoinbaseSnapshotState(symbol: string): void {
  if (!isCryptoSymbol(symbol)) return;

  const ticker = coinbaseTickerState.get(symbol);
  const micro = coinbaseMicrostructureState.get(symbol);
  const bid = micro?.bestBid ?? ticker?.bid ?? 0;
  const ask = micro?.bestAsk ?? ticker?.ask ?? 0;
  const rawLastPrice = ticker?.price ?? midpoint(bid, ask);
  if (rawLastPrice <= 0 && bid <= 0 && ask <= 0) return;

  const lastPrice = rawLastPrice > 0 ? rawLastPrice : midpoint(bid, ask);
  const previousSnapshot = snapshotState.snapshots.find((entry) => entry.symbol === symbol);
  const prior = previousSnapshot?.lastPrice ?? previousPrices.get(symbol) ?? lastPrice;
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

  const snapshot: MarketSnapshot = {
    symbol,
    broker: 'coinbase-live',
    assetClass: symbol === 'PAXG-USD' ? 'commodity-proxy' : 'crypto',
    lastPrice: round(lastPrice, 2),
    changePct: prior > 0 ? round(((lastPrice - prior) / prior) * 100, 2) : 0,
    volume: Math.round(ticker?.volume24h ?? previousSnapshot?.volume ?? 0),
    spreadBps: round(spreadBps, 2),
    liquidityScore,
    status: bid > 0 && ask > 0 && lastPrice > 0 ? (quality.tradable ? 'live' : 'delayed') : 'stale',
    source: 'service',
    session: quality.session,
    tradable: quality.tradable,
    qualityFlags: quality.qualityFlags,
    updatedAt: new Date().toISOString()
  };

  upsertSnapshotState(snapshot);
  patchSourceState('coinbase-live', 'live', coinbaseLiveDetail);

  // HFT: Real-time broadcast of crypto tick via Redis
  redis.publish(TOPICS.MARKET_TICK, JSON.stringify(snapshot)).catch(err => {
    logger.error({ err }, 'Failed to publish market tick to Redis');
  });

  // HFT: Stream tick to TimescaleDB via high-speed buffered writer
  pushTick({
    symbol,
    price: snapshot.lastPrice,
    size: 0,
    side: null,
    broker: 'coinbase-live'
  });
}

/* ── Coinbase authenticated JSON helper ──────────────────────────── */

export async function fetchCoinbaseJson<T>(resource: string): Promise<T> {
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
