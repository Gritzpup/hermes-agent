// @ts-nocheck
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MarketSnapshot } from '@hermes/contracts';
import type { MarketSession } from './types.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/* ── Environment helpers ─────────────────────────────────────────── */

export function loadLegacyEnv(): Record<string, string> {
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

const legacyEnv = loadLegacyEnv();

export function readEnv(names: string[], normalizeNewlines = false): string {
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

/* ── Symbol classification ───────────────────────────────────────── */

export const ALPACA_EQUITY_SYMBOLS = new Set(['VIXY', 'SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'UVXY', 'VXX', 'SVXY']);

export function isCryptoSymbol(symbol: string): boolean {
  return symbol.endsWith('-USD');
}

export function isAlpacaEquity(symbol: string): boolean {
  return ALPACA_EQUITY_SYMBOLS.has(symbol);
}

export function isOandaSymbol(symbol: string): boolean {
  return symbol.includes('_') && !ALPACA_EQUITY_SYMBOLS.has(symbol);
}

export function isForexSymbol(symbol: string): boolean {
  return /^[A-Z]{3}_[A-Z]{3}$/.test(symbol);
}

export function isBondSymbol(symbol: string): boolean {
  return symbol.startsWith('USB') || symbol.endsWith('YB');
}

/* ── Equity spread imputation ───────────────────────────────────── */

/**
 * Typical spreads for liquid large-cap equities and ETFs.
 * Values are in bps. Symbols not listed default to 3 bps.
 *
 * Sources: real NBBO data — AAPL/SPY/QQQ trade at < 1 bps during
 * regular hours; VIXY/UVXY are wider due to lower liquidity.
 */
const EQUITY_TYPICAL_SPREAD_BPS: Record<string, number> = {
  SPY: 0.3,
  QQQ: 0.5,
  AAPL: 0.5,
  MSFT: 0.5,
  NVDA: 0.7,
  AMZN: 0.7,
  META: 0.7,
  AMD: 1.0,
  TSLA: 1.0,
  VIXY: 8,
  UVXY: 10,
  VXX: 6,
  SVXY: 5
};

/** Maximum plausible equity spread in bps during regular hours. */
const MAX_PLAUSIBLE_EQUITY_SPREAD_BPS = 25;

/**
 * Returns a usable spreadBps for an equity symbol.
 *
 * Three cases:
 * 1. No bid/ask data (both zero) — return the symbol's typical spread.
 * 2. Computed spread is unrealistically wide (extended hours, stale quote) —
 *    cap it at MAX_PLAUSIBLE_EQUITY_SPREAD_BPS so that agents aren't
 *    permanently blocked.
 * 3. Computed spread looks reasonable — pass it through.
 */
export function imputeEquitySpreadBps(
  symbol: string,
  rawSpreadBps: number,
  bid: number,
  ask: number,
  lastTrade: number
): number {
  const typical = EQUITY_TYPICAL_SPREAD_BPS[symbol] ?? 3;

  // Case 1: no quote data at all
  if (bid <= 0 || ask <= 0) {
    // If we have a last trade price, use typical; otherwise keep 0
    return lastTrade > 0 ? typical : 0;
  }

  // Case 2: spread is unrealistically wide (stale quote, extended hours, etc.)
  if (rawSpreadBps > MAX_PLAUSIBLE_EQUITY_SPREAD_BPS) {
    return typical;
  }

  // Case 3: reasonable spread — pass through
  return rawSpreadBps;
}

/* ── Numeric / string helpers ────────────────────────────────────── */

export function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function round(value: number, decimals: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}

export function midpoint(bid: number, ask: number): number {
  if (bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }
  return bid || ask || 0;
}

export function normalizePem(secret: string): string {
  return secret.includes('\\n') ? secret.replace(/\\n/g, '\n') : secret;
}

export function toBase64Url(value: string | Uint8Array): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function scoreLiquidity(spreadBps: number): number {
  return Math.max(20, Math.min(99, Math.round(100 - spreadBps * 7)));
}

export function extractErrorMessage(payload: Record<string, unknown>, fallback: string): string {
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

export async function fetchWithTimeout(input: string | URL, init: RequestInit = {}, timeoutMs = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/* ── Market quality assessment ───────────────────────────────────── */

export const maxTradableEquitySpreadBps = Number(process.env.ALPACA_MAX_TRADABLE_SPREAD_BPS ?? 5);
export const minTradableEquityLiquidity = Number(process.env.ALPACA_MIN_TRADABLE_LIQUIDITY ?? 85);
export const maxTradableCryptoSpreadBps = Number(process.env.COINBASE_MAX_TRADABLE_SPREAD_BPS ?? 8);
export const minTradableCryptoLiquidity = Number(process.env.COINBASE_MIN_TRADABLE_LIQUIDITY ?? 80);
export const maxTradableForexSpreadBps = Number(process.env.OANDA_MAX_TRADABLE_SPREAD_BPS ?? 20);
export const minTradableForexLiquidity = Number(process.env.OANDA_MIN_TRADABLE_LIQUIDITY ?? 30);

export function assessMarketQuality(params: {
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
