/**
 * Venue Sanity — cross-venue BTC-USD price sanity check.
 *
 * Polls Kraken, Binance US, and Gemini every 60s and compares each to the
 * current Coinbase mark (BTC-USD last price in market-intel price history).
 * "divergent" is true when any venue deviates >= 40 bps from Coinbase.
 * Graceful: a venue that is unreachable contributes null to its slot and is
 * excluded from deviation calculation.
 */

import { getMarketIntel } from './market-intel.js';

const KRAKEN_URL = 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD';
const BINANCE_US_URL = 'https://api.binance.us/api/v3/ticker/price?symbol=BTCUSDT';
const GEMINI_URL = 'https://api.gemini.com/v2/ticker/btcusd';

const POLL_MS = 60_000;
const DIVERGENCE_BPS = 40; // bps

export interface VenueQuote {
  price: number | null;
  ts: number | null;
}

export interface VenueSanityResult {
  coinbase: VenueQuote;
  kraken: VenueQuote;
  binanceUs: VenueQuote;
  gemini: VenueQuote;
  maxDeviationBps: number;
  divergent: boolean;
}

let pollTimer: NodeJS.Timeout | null = null;
let lastResult: VenueSanityResult | null = null;

async function fetchWithTimeout(url: string, timeoutMs = 6000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function pollOnce(): Promise<VenueSanityResult> {
  // Coinbase mark: latest BTC-USD price from market-intel
  const intel = getMarketIntel();
  const cbPrice = intel.getLastPrice('BTC-USD');
  const coinbaseTs = cbPrice ? Date.now() : null;

  // Poll all three venues concurrently
  const [krakenResp, binanceUsResp, geminiResp] = await Promise.all([
    fetchWithTimeout(KRAKEN_URL).catch(() => null),
    fetchWithTimeout(BINANCE_US_URL).catch(() => null),
    fetchWithTimeout(GEMINI_URL).catch(() => null),
  ]);

  let krakenPrice: number | null = null;
  let krakenTs: number | null = null;
  if (krakenResp?.ok) {
    try {
      const d = await krakenResp.json() as { result?: Record<string, { c?: string[] }> };
      const first = Object.values(d.result ?? {})[0];
      const p = first?.c?.[0];
      if (p) { krakenPrice = Number(p); krakenTs = Date.now(); }
    } catch { /* ignore */ }
  }

  let binanceUsPrice: number | null = null;
  let binanceUsTs: number | null = null;
  if (binanceUsResp?.ok) {
    try {
      const d = await binanceUsResp.json() as { price?: string };
      if (d.price) { binanceUsPrice = Number(d.price); binanceUsTs = Date.now(); }
    } catch { /* ignore */ }
  }

  let geminiPrice: number | null = null;
  let geminiTs: number | null = null;
  if (geminiResp?.ok) {
    try {
      const d = await geminiResp.json() as { price?: string; timestamp?: number };
      if (d.price) { geminiPrice = Number(d.price); geminiTs = d.timestamp ? d.timestamp * 1000 : Date.now(); }
    } catch { /* ignore */ }
  }

  const venues: Array<{ price: number | null; label: string }> = [
    { price: krakenPrice, label: 'Kraken' },
    { price: binanceUsPrice, label: 'Binance US' },
    { price: geminiPrice, label: 'Gemini' },
  ];

  // Compute max deviation vs Coinbase (only from venues that are non-null)
  let maxDevBps = 0;
  if (cbPrice !== null) {
    for (const v of venues) {
      if (v.price !== null && cbPrice > 0) {
        const devBps = Math.abs(v.price - cbPrice) / cbPrice * 10_000;
        if (devBps > maxDevBps) maxDevBps = devBps;
      }
    }
  }

  return {
    coinbase: { price: cbPrice, ts: coinbaseTs },
    kraken: { price: krakenPrice, ts: krakenTs },
    binanceUs: { price: binanceUsPrice, ts: binanceUsTs },
    gemini: { price: geminiPrice, ts: geminiTs },
    maxDeviationBps: Math.round(maxDevBps * 100) / 100,
    divergent: maxDevBps >= DIVERGENCE_BPS,
  };
}

export function startVenueSanity(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void pollOnce().then((r) => {
      lastResult = r;
      // Thread divergence flag into market-intel composite signal (Phase 3.1)
      try {
        getMarketIntel().setVenueDivergence(r.divergent);
      } catch { /* market-intel may not be initialised yet */ }
    });
  }, POLL_MS);
  void pollOnce().then((r) => {
    lastResult = r;
    try {
      getMarketIntel().setVenueDivergence(r.divergent);
    } catch { /* market-intel may not be initialised yet */ }
  });
}

export function stopVenueSanity(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/**
 * Returns the latest venue sanity result.  May be null before first poll.
 */
export function getVenueSanity(_symbol: 'BTC-USD'): VenueSanityResult | null {
  return lastResult;
}
