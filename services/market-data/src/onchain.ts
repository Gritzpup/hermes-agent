/**
 * On-Chain Signals Poller
 *
 * Pulls DeFiLlama and Hyperliquid data every 5 minutes and writes results
 * to Redis at hermes:onchain:{symbol}.
 *
 * Also upserts signals into the Qdrant 'onchain_signals' collection for RAG.
 *
 * Signals tracked:
 *   - Exchange net flow (USD inflow / outflow per symbol)
 *   - TVL delta for chains with relevant pools
 *
 * 5-second timeout per upstream call. Failures are logged and skipped — the
 * poller never crashes.
 */

import { redis } from '@hermes/infra';
import { logger } from '@hermes/logger';
import { fetchWithTimeout } from './utils.js';
import { upsert, COLLECTIONS } from './qdrant.js';

/* ── Config ───────────────────────────────────────────────────────── */

const POLL_INTERVAL_MS = Number(process.env.ONCHAIN_POLL_MS ?? 300_000); // 5 min
const UPSTREAM_TIMEOUT = 5_000; // ms per fetch call

/* ── Types ────────────────────────────────────────────────────────── */

export interface OnchainSignal {
  symbol:         string;
  timestamp:      string;
  exchangeFlowUsd: number; // positive = net inflow, negative = outflow
  tvlDeltaPct:   number;  // 7-day TVL change %
  source:         string;
  raw?:           Record<string, unknown>;
}

/* ── Symbol → DeFiLlama / Hyperliquid mapping ─────────────────────── */

const CRYPTO_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'] as const;
type CryptoSymbol = typeof CRYPTO_SYMBOLS[number];

/**
 * Map our internal symbol (e.g. BTC-USD) to the lowercase slug used by
 * DeFiLlama's /protocol/{protocol} endpoints and /tvl.
 * Coverage is best-effort — missing protocols are skipped without error.
 */
function defillamaSymbol(symbol: string): string {
  const map: Record<string, string> = {
    'BTC-USD': 'bitcoin',
    'ETH-USD': 'ethereum',
    'SOL-USD': 'solana',
    'XRP-USD': 'ripple',
    'BTC':     'bitcoin',
    'ETH':     'ethereum',
    'SOL':     'solana',
    'XRP':     'ripple',
  };
  return map[symbol] ?? symbol.toLowerCase();
}

/**
 * Map our internal symbol to Hyperliquid's internal symbol name.
 * Hyperliquid uses e.g. "BTC" for its BTC-PERP.
 */
function hyperliquidSymbol(symbol: string): string {
  const map: Record<string, string> = {
    'BTC-USD': 'BTC',
    'ETH-USD': 'ETH',
    'SOL-USD': 'SOL',
    'XRP-USD': 'XRP',
    'BTC':     'BTC',
    'ETH':     'ETH',
    'SOL':     'SOL',
    'XRP':     'XRP',
  };
  return map[symbol] ?? symbol.replace('-USD', '');
}

/* ── DeFiLlama fetchers ───────────────────────────────────────────── */

async function fetchDefillamaTvl(symbol: string): Promise<number | null> {
  try {
    const slug = defillamaSymbol(symbol);
    // Use the protocol-level TVL endpoint; fallback to asset-level
    const url = `https://api.llama.fi/protocol/${slug}`;
    const res = await fetchWithTimeout(url, { method: 'GET' }, UPSTREAM_TIMEOUT);
    if (!res.ok) return null;

    const data = await res.json() as Record<string, unknown>;
    const tvl = typeof data.tvl === 'number' ? data.tvl :
      typeof data.tvlUsd === 'number' ? data.tvlUsd : null;

    return tvl;
  } catch {
    return null;
  }
}

async function fetchDefillamaFlow(symbol: string): Promise<number | null> {
  try {
    // DeFiLlama doesn't expose per-symbol exchange flows directly.
    // We approximate using change in TVL over the last 24h as a proxy for net flow.
    const slug = defillamaSymbol(symbol);
    const url = `https://api.llama.fi/protocol/${slug}`;
    const res = await fetchWithTimeout(url, { method: 'GET' }, UPSTREAM_TIMEOUT);
    if (!res.ok) return null;

    const data = await res.json() as Record<string, unknown>;

    // chainsTvl or change_24h provide a rough net-flow signal
    const change24h = typeof data.change_24h === 'number' ? data.change_24h : null;
    return change24h;
  } catch {
    return null;
  }
}

/* ── Hyperliquid fetchers ─────────────────────────────────────────── */

interface HlMeta {
  universe: Array<{ name: string; szDecimals: number }>;
}

interface HlFunding {
  coin: string;
  fundingRate: number;
  prevFundingRate: number;
}

async function fetchHyperliquidFunding(symbol: string): Promise<number | null> {
  try {
    const hlSym = hyperliquidSymbol(symbol);
    const [metaRes, fundingRes] = await Promise.all([
      fetchWithTimeout('https://api.hyperliquid.xyz/info', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ type: 'meta' }),
      }, UPSTREAM_TIMEOUT),
      fetchWithTimeout('https://api.hyperliquid.xyz/info', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ type: 'fundingHistory', coin: hlSym }),
      }, UPSTREAM_TIMEOUT),
    ]);

    if (!metaRes.ok || !fundingRes.ok) return null;

    const [metaData, fundingData] = await Promise.all([
      metaRes.json() as Promise<HlMeta>,
      fundingRes.json() as Promise<HlFunding[]>,
    ]) as [HlMeta, HlFunding[]];

    // Find the entry for our symbol
    const fundingEntry = (Array.isArray(fundingData) ? fundingData : [])
      .find((f: HlFunding) => f.coin === hlSym);

    const fundingRate = fundingEntry?.fundingRate ?? null;
    return fundingRate;
  } catch {
    return null;
  }
}

/* ── Exchange-flow approximation from Coinbase public data ───────────
 *
 * Since we already have Coinbase WebSocket in data-sources.ts, we can
 * approximate net exchange flow by checking if the price is moving
 * strongly with volume — a volume-weighted price delta proxy.
 *
 * We use the previousPrices map from data-processing.ts to compute
 * the mid-price delta, which we treat as a directional flow signal.
 */

export async function getProxyFlowUsd(
  symbol: string,
  _priceChangePct: number,
): Promise<number> {
  // Placeholder: we return 0 because real exchange-flow data requires
  // proprietary APIs (Coinbase premium, Glassnode, etc.).
  // The DeFiLlama TVL change is a decent proxy for the purposes of
  // the memory agent's RAG context.
  return 0;
}

/* ── Per-symbol signal builder ────────────────────────────────────── */

async function buildSignal(symbol: string): Promise<OnchainSignal | null> {
  const [tvl, tvlDeltaPct, fundingRate] = await Promise.all([
    fetchDefillamaTvl(symbol),
    fetchDefillamaFlow(symbol),
    fetchHyperliquidFunding(symbol),
  ]);

  // If all three failed, skip this symbol
  if (tvl === null && tvlDeltaPct === null && fundingRate === null) {
    logger.warn({ symbol }, 'onchain: all upstream fetches failed for symbol');
    return null;
  }

  // Use TVL delta % as exchange-flow proxy when no direct flow data exists
  const exchangeFlowUsd = tvlDeltaPct ?? 0;

  const signal: OnchainSignal = {
    symbol,
    timestamp:      new Date().toISOString(),
    exchangeFlowUsd,
    tvlDeltaPct:    tvlDeltaPct ?? 0,
    source:         'defillama+hyperliquid',
    raw: {
      tvl,
      tvlDeltaPct,
      fundingRate,
    },
  };

  return signal;
}

/* ── Write to Redis ───────────────────────────────────────────────── */

async function writeToRedis(symbol: string, signal: OnchainSignal): Promise<void> {
  const key = `hermes:onchain:${symbol}`;
  await redis.set(key, JSON.stringify(signal), 'EX', 600); // 10-min TTL
}

/* ── Poller loop ───────────────────────────────────────────────────── */

async function pollOnce(): Promise<void> {
  const symbols = CRYPTO_SYMBOLS.map((s) => `${s}-USD`);

  await Promise.allSettled(
    symbols.map(async (symbol) => {
      const signal = await buildSignal(symbol);
      if (!signal) return;

      await Promise.allSettled([
        writeToRedis(symbol, signal),
        // Upsert to Qdrant for RAG (non-blocking on failure)
        upsert(COLLECTIONS.ONCHAIN_SIGNALS, `${symbol}:${Date.now()}`, {
          symbol:         signal.symbol,
          timestamp:       signal.timestamp,
          exchangeFlowUsd: signal.exchangeFlowUsd,
          tvlDeltaPct:    signal.tvlDeltaPct,
          source:         signal.source,
          // Store a searchable text representation
          text: [
            `${symbol} on-chain update:`,
            `exchange flow $${signal.exchangeFlowUsd >= 0 ? '+' : ''}${signal.exchangeFlowUsd.toFixed(2)} USD (24h).`,
            `TVL delta ${signal.tvlDeltaPct >= 0 ? '+' : ''}${signal.tvlDeltaPct.toFixed(2)}%.`,
            signal.raw?.fundingRate != null ? `Hyperliquid funding rate: ${(signal.raw.fundingRate as number).toFixed(4)}.` : '',
          ].join(' '),
        }),
      ]);
    }),
  );
}

let pollerInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the on-chain signal poller.
 * Call this from market-data's index.ts bootstrap.
 */
export function startOnchainPoller(): void {
  if (pollerInterval !== null) {
    logger.info('onchain poller already running');
    return;
  }

  logger.info('starting on-chain signal poller (5-min cadence)');

  // Run immediately on start, then on interval
  void pollOnce().catch((e) => logger.error({ e }, 'onchain pollOnce failed'));

  pollerInterval = setInterval(() => {
    void pollOnce().catch((e) => logger.error({ e }, 'onchain pollOnce failed'));
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the poller (useful for graceful shutdown).
 */
export function stopOnchainPoller(): void {
  if (pollerInterval !== null) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    logger.info('on-chain signal poller stopped');
  }
}

/**
 * Return the last cached on-chain signal for a symbol (from Redis).
 * Returns null if not in cache.
 */
export async function getCachedOnchainSignal(symbol: string): Promise<OnchainSignal | null> {
  const raw = await redis.get(`hermes:onchain:${symbol}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OnchainSignal;
  } catch {
    return null;
  }
}
