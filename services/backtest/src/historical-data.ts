import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, createSign, randomBytes } from 'node:crypto';
import type { BacktestCandle } from '@hermes/contracts';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const legacyEnv = loadLegacyEnv();

function readEnv(names: string[], normalizeNewlines = false): string {
  for (const name of names) {
    const value = process.env[name] ?? legacyEnv[name];
    if (!value) continue;
    const normalized = normalizeNewlines ? value.replace(/\\n/g, '\n') : value;
    const trimmed = normalized.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function loadLegacyEnv(): Record<string, string> {
  const files = [
    path.resolve(moduleDir, '../../../../project-sanctuary/hermes-trading-post/backend/.env'),
    path.resolve(moduleDir, '../../../../project-sanctuary/hermes-trading-post/backend/live-bots/.env'),
    path.resolve(moduleDir, '../../../../project-sanctuary/hermes-trading-post/backend/live-ai-bots/.env')
  ];
  const values: Record<string, string> = {};
  for (const filePath of files) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const sep = line.indexOf('=');
        if (sep <= 0) continue;
        const key = line.slice(0, sep).trim();
        const value = line.slice(sep + 1).trim();
        if (key && !(key in values)) values[key] = value;
      }
    } catch { /* ignore */ }
  }
  return values;
}

function isCrypto(symbol: string): boolean { return symbol.endsWith('-USD'); }
function isForex(symbol: string): boolean { return symbol.includes('_'); }

const alpacaKey = readEnv(['ALPACA_PAPER_KEY', 'ALPACA_API_KEY_ID', 'APCA_API_KEY_ID']);
const alpacaSecret = readEnv(['ALPACA_PAPER_SECRET', 'ALPACA_API_SECRET_KEY', 'APCA_API_SECRET_KEY']);
const coinbaseApiKey = readEnv(['COINBASE_API_KEY', 'CDP_API_KEY_NAME']);
const coinbaseApiSecret = readEnv(['COINBASE_API_SECRET', 'CDP_API_KEY_PRIVATE'], true);
const oandaApiKey = readEnv(['OANDA_API_KEY', 'OANDA_TOKEN']);
const oandaAccountId = readEnv(['OANDA_ACCOUNT_ID', 'OANDA_ACCOUNT']);
const alpacaDataUrl = process.env.ALPACA_DATA_BASE_URL ?? 'https://data.alpaca.markets';
const coinbaseBaseUrl = process.env.COINBASE_ADVANCED_TRADE_BASE_URL ?? 'https://api.coinbase.com/api/v3/brokerage/';
const oandaBaseUrl = process.env.OANDA_API_BASE_URL ?? 'https://api-fxpractice.oanda.com';

export async function fetchCandles(symbol: string, startDate: string, endDate: string): Promise<BacktestCandle[]> {
  if (isForex(symbol)) return fetchOandaCandles(symbol, startDate, endDate);
  if (isCrypto(symbol)) return fetchCoinbaseCandles(symbol, startDate, endDate);
  try {
    return await fetchAlpacaCandles(symbol, startDate, endDate);
  } catch (error) {
    console.warn(`[backtest] Alpaca fallback for ${symbol}: ${error instanceof Error ? error.message : 'unknown error'}`);
    return fetchYahooCandles(symbol, startDate, endDate);
  }
}

function chooseAlpacaTimeframe(startDate: string, endDate: string): '1Min' | '5Min' | '15Min' | '1Hour' | '1Day' {
  const spanDays = (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000;
  if (spanDays > 120) return '1Day';
  if (spanDays > 30) return '1Day';
  if (spanDays > 10) return '1Hour';
  if (spanDays > 2) return '15Min';
  return '1Min';
}

function chooseCoinbaseGranularity(startDate: string, endDate: string): 'ONE_MINUTE' | 'FIVE_MINUTE' | 'FIFTEEN_MINUTE' | 'ONE_HOUR' | 'SIX_HOUR' | 'ONE_DAY' {
  const spanDays = (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000;
  if (spanDays > 120) return 'ONE_DAY';
  if (spanDays > 30) return 'ONE_DAY';
  if (spanDays > 10) return 'SIX_HOUR';
  if (spanDays > 2) return 'ONE_HOUR';
  if (spanDays > 0.5) return 'FIVE_MINUTE';
  return 'ONE_MINUTE';
}

function chooseOandaGranularity(startDate: string, endDate: string): 'M1' | 'M5' | 'H1' | 'D' {
  const spanDays = (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000;
  if (spanDays > 90) return 'D';
  if (spanDays > 14) return 'H1';
  if (spanDays > 2) return 'M5';
  return 'M1';
}

async function fetchAlpacaCandles(symbol: string, startDate: string, endDate: string): Promise<BacktestCandle[]> {
  if (!alpacaKey || !alpacaSecret) throw new Error('Missing Alpaca credentials for backtest data.');
  const candles: BacktestCandle[] = [];
  let pageToken: string | null = null;
  const timeframe = chooseAlpacaTimeframe(startDate, endDate);

  for (let page = 0; page < 20; page++) {
    const url = new URL(`/v2/stocks/${symbol}/bars`, alpacaDataUrl);
    url.searchParams.set('timeframe', timeframe);
    url.searchParams.set('start', startDate);
    url.searchParams.set('end', endDate);
    url.searchParams.set('limit', '10000');
    url.searchParams.set('adjustment', 'all');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const response = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': alpacaKey, 'APCA-API-SECRET-KEY': alpacaSecret }
    });
    if (!response.ok) throw new Error(`Alpaca bars request failed: ${response.status}`);
    const body = await response.json() as { bars?: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>; next_page_token?: string };
    for (const bar of body.bars ?? []) {
      candles.push({ timestamp: bar.t, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v });
    }
    pageToken = body.next_page_token ?? null;
    if (!pageToken) break;
  }
  return candles;
}

async function fetchCoinbaseCandles(symbol: string, startDate: string, endDate: string): Promise<BacktestCandle[]> {
  if (!coinbaseApiKey || !coinbaseApiSecret) throw new Error('Missing Coinbase credentials for backtest data.');
  const candles: BacktestCandle[] = [];
  const startTs = Math.floor(new Date(startDate).getTime() / 1000);
  const endTs = Math.floor(new Date(endDate).getTime() / 1000);
  const granularity = chooseCoinbaseGranularity(startDate, endDate);
  const candleSeconds = granularity === 'ONE_DAY'
    ? 86_400
    : granularity === 'SIX_HOUR'
      ? 21_600
      : granularity === 'ONE_HOUR'
        ? 3_600
        : granularity === 'FIFTEEN_MINUTE'
          ? 900
          : granularity === 'FIVE_MINUTE'
            ? 300
            : 60;
  const chunkSize = Math.min(300 * candleSeconds, Math.max(86_400, endTs - startTs)); // aim for manageable chunks

  for (let cursor = startTs; cursor < endTs; cursor += chunkSize) {
    const chunkEnd = Math.min(cursor + chunkSize, endTs);
    const base = new URL(coinbaseBaseUrl.endsWith('/') ? coinbaseBaseUrl : `${coinbaseBaseUrl}/`);
    const resource = `market/products/${symbol}/candles?start=${cursor}&end=${chunkEnd}&granularity=${granularity}`;
    const requestPath = `/${base.pathname.replace(/^\/+/, '').replace(/\/+$/, '')}/${resource}`.replace(/\/+/g, '/');
    const token = createCoinbaseJwt('GET', requestPath, base.host);
    const response = await fetch(new URL(resource, base), { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`[backtest] Coinbase ${response.status} for chunk ${cursor}-${chunkEnd}: ${text.slice(0, 200)}`);
      // Retry once after a pause
      await sleep(1000);
      const retry = await fetch(new URL(resource, base), {
        headers: { Authorization: `Bearer ${createCoinbaseJwt('GET', requestPath, base.host)}` }
      });
      if (!retry.ok) throw new Error(`Coinbase candles failed: ${retry.status}`);
      const retryBody = await retry.json() as { candles?: Array<{ start: string; open: string; high: string; low: string; close: string; volume: string }> };
      for (const c of retryBody.candles ?? []) {
        candles.push({
          timestamp: new Date(Number(c.start) * 1000).toISOString(),
          open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume)
        });
      }
    } else {
      const body = await response.json() as { candles?: Array<{ start: string; open: string; high: string; low: string; close: string; volume: string }> };
      for (const c of body.candles ?? []) {
        candles.push({
          timestamp: new Date(Number(c.start) * 1000).toISOString(),
          open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume)
        });
      }
    }

    // Brief pause between chunks to be a good API citizen
    if (cursor + chunkSize < endTs) await sleep(200);
  }
  return candles.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

async function fetchYahooCandles(symbol: string, startDate: string, endDate: string): Promise<BacktestCandle[]> {
  const startTs = Math.floor(new Date(startDate).getTime() / 1000);
  const endTs = Math.floor(new Date(endDate).getTime() / 1000);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set('period1', String(startTs));
  url.searchParams.set('period2', String(endTs));
  url.searchParams.set('interval', '1d');
  url.searchParams.set('includePrePost', 'false');
  url.searchParams.set('events', 'div,splits');

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json'
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Yahoo Finance candles failed: ${response.status} ${text.slice(0, 120)}`);
  }

  const body = await response.json() as {
    chart?: {
      error?: { description?: string } | null;
      result?: Array<{
        timestamp?: number[];
        indicators?: {
          quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }>;
          adjclose?: Array<{ adjclose?: Array<number | null> }>;
        };
      }>;
    };
  };
  const result = body.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  const adjClose = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
  const candles: BacktestCandle[] = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    const open = quote?.open?.[index];
    const high = quote?.high?.[index];
    const low = quote?.low?.[index];
    const close = adjClose[index] ?? quote?.close?.[index];
    const volume = quote?.volume?.[index];
    if (timestamp === undefined || close === undefined || close === null) continue;
    candles.push({
      timestamp: new Date(timestamp * 1000).toISOString(),
      open: Number(open ?? close),
      high: Number(high ?? close),
      low: Number(low ?? close),
      close: Number(close),
      volume: Number(volume ?? 0)
    });
  }

  if (candles.length === 0) {
    throw new Error(`Yahoo Finance returned no candles for ${symbol}`);
  }
  return candles.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOandaCandles(symbol: string, startDate: string, endDate: string): Promise<BacktestCandle[]> {
  if (!oandaApiKey) throw new Error('Missing OANDA credentials for backtest data.');
  const candles: BacktestCandle[] = [];
  const granularity = chooseOandaGranularity(startDate, endDate);
  const url = `${oandaBaseUrl}/v3/instruments/${symbol}/candles?granularity=${granularity}&from=${startDate}&to=${endDate}&count=5000`;
  const response = await fetch(url, { headers: { 'Authorization': `Bearer ${oandaApiKey}` } });
  if (!response.ok) throw new Error(`OANDA candles failed: ${response.status}`);
  const body = await response.json() as { candles?: Array<{ time: string; mid?: { o: string; h: string; l: string; c: string }; volume: number }> };
  for (const c of body.candles ?? []) {
    if (!c.mid) continue;
    candles.push({
      timestamp: c.time, open: Number(c.mid.o), high: Number(c.mid.h), low: Number(c.mid.l), close: Number(c.mid.c), volume: c.volume
    });
  }
  return candles;
}

function createCoinbaseJwt(method: string, requestPath: string, requestHost: string): string {
  const key = createPrivateKey(normalizePem(coinbaseApiSecret));
  const header = { alg: 'ES256', kid: coinbaseApiKey, nonce: randomBytes(16).toString('hex'), typ: 'JWT' };
  const now = Math.floor(Date.now() / 1_000);
  const normalizedPath = new URL(`https://${requestHost}${requestPath}`).pathname;
  const payload = { aud: ['cdp_service'], iss: 'cdp', nbf: now, exp: now + 120, sub: coinbaseApiKey, uri: `${method.toUpperCase()} ${requestHost}${normalizedPath}` };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signer = createSign('sha256');
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${encodedHeader}.${encodedPayload}.${toBase64Url(signature)}`;
}

function normalizePem(secret: string): string {
  return secret.includes('\\n') ? secret.replace(/\\n/g, '\n') : secret;
}

function toBase64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
