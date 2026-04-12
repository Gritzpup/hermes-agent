import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createSign, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { OrderIntent, OrderStatus, PositionSnapshot, RiskCheck } from '@hermes/contracts';
import { isUsdCryptoSymbol, normalizeAlpacaSymbol, toAlpacaOrderSymbol } from './venue-symbols.js';
import {
  readEnv as readEnvUtil,
  asRecord as asRecordUtil,
  textField as textFieldUtil,
  numberField as numberFieldUtil,
  normalizeArray as normalizeArrayUtil,
  sleep as sleepUtil,
  normalizeOrderStatus as normalizeOrderStatusUtil,
  parseBrokerId as parseBrokerIdUtil,
  trimTrailingSlash as trimTrailingSlashUtil,
  splitList as splitListUtil
} from './utils.js';

type VenueId = 'alpaca-paper' | 'coinbase-live' | 'oanda-rest';
type SyncStatus = 'healthy' | 'degraded' | 'missing-credentials' | 'error';

interface BrokerAccountSnapshot {
  broker: VenueId;
  venue: 'alpaca' | 'coinbase' | 'oanda';
  status: SyncStatus;
  asOf: string;
  account: unknown;
  positions: unknown[];
  fills: unknown[];
  orders: unknown[];
  errors: string[];
}

interface BrokerRuntimeState {
  asOf: string;
  lastSyncAt: string | null;
  brokers: Record<VenueId, BrokerAccountSnapshot>;
  reports: BrokerRouteReport[];
}

interface BrokerRouteReport {
  id: string;
  orderId: string;
  broker: VenueId;
  symbol: string;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice: number;
  slippageBps: number;
  latencyMs: number;
  message: string;
  timestamp: string;
  brokerMode: VenueId;
  mode: 'paper' | 'live';
  venue: 'alpaca' | 'coinbase' | 'oanda';
  riskCheck: RiskCheck | null;
  source: 'broker' | 'simulated' | 'mock';
  eventSource: 'route' | 'sync';
  details: string;
  errors: string[];
  accountSnapshot: unknown;
  positionsSnapshot: unknown[];
  fillsSnapshot: unknown[];
  ordersSnapshot: unknown[];
}

interface NormalizedOrder {
  id: string;
  symbol: string;
  broker: VenueId;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  notional: number;
  quantity: number;
  limitPrice?: number | undefined;
  timeInForce?: 'day' | 'gtc' | 'ioc' | 'fok' | undefined;
  postOnly?: boolean | undefined;
  strategy: string;
  mode: 'paper' | 'live';
  thesis: string;
}

const app = express();
const port = Number(process.env.PORT ?? 4303);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectEnv = loadProjectEnv();
const legacyEnv = loadLegacyEnv();
const serviceRoot = path.resolve(moduleDir, '..');
const runtimeDir = path.join(serviceRoot, '.runtime');
const statePath = path.join(runtimeDir, 'state.json');
const reportsPath = path.join(runtimeDir, 'reports.jsonl');
const riskEngineUrl = process.env.RISK_ENGINE_URL ?? 'http://127.0.0.1:4301/evaluate';
const syncIntervalMs = Number(process.env.BROKER_SYNC_INTERVAL_MS ?? 5_000);
const requestTimeoutMs = Number(process.env.BROKER_REQUEST_TIMEOUT_MS ?? 20_000);
const alpacaOrderPollAttempts = Number(process.env.ALPACA_ORDER_POLL_ATTEMPTS ?? 6);
const alpacaOrderPollDelayMs = Number(process.env.ALPACA_ORDER_POLL_DELAY_MS ?? 300);
const alpacaPaperBaseUrl = trimTrailingSlash(process.env.ALPACA_API_BASE_URL ?? 'https://paper-api.alpaca.markets');
const coinbaseBaseUrl = trimTrailingSlash(process.env.COINBASE_API_BASE_URL ?? 'https://api.coinbase.com/api/v3/brokerage');
const coinbaseUniverse = splitList(process.env.COINBASE_UNIVERSE ?? 'BTC-USD,ETH-USD,SOL-USD,XRP-USD,PAXG-USD');
const oandaBaseUrlRaw = trimTrailingSlash(process.env.OANDA_API_BASE_URL ?? 'https://api-fxpractice.oanda.com/v3');
const oandaBaseUrl = oandaBaseUrlRaw.endsWith('/v3') ? oandaBaseUrlRaw.slice(0, -3) : oandaBaseUrlRaw;
const oandaApiKey = readEnv(['OANDA_API_KEY', 'OANDA_TOKEN']);
const oandaAccountId = readEnv(['OANDA_ACCOUNT_ID', 'OANDA_ACCOUNT']);
const coinbaseLiveRoutingEnabled = (process.env.COINBASE_LIVE_ROUTING_ENABLED ?? projectEnv.COINBASE_LIVE_ROUTING_ENABLED ?? '0') === '1';

fs.mkdirSync(runtimeDir, { recursive: true });

const runtimeState: BrokerRuntimeState = loadState();
if (!runtimeState.brokers['oanda-rest']) {
  runtimeState.brokers['oanda-rest'] = emptyBrokerSnapshot('oanda-rest', 'oanda' as 'alpaca' | 'coinbase');
}
const syncInFlight = new Map<VenueId, Promise<BrokerAccountSnapshot>>();
let initialSyncStarted = false;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  const brokers = Object.values(runtimeState.brokers);
  const healthyCount = brokers.filter((snapshot) => snapshot.status === 'healthy').length;
  const degradedCount = brokers.filter((snapshot) => snapshot.status === 'degraded').length;

  res.json({
    service: 'broker-router',
    status: healthyCount > 0 ? 'healthy' : degradedCount > 0 ? 'degraded' : 'warning',
    timestamp: new Date().toISOString(),
    lastSyncAt: runtimeState.lastSyncAt,
    brokers
  });
});

app.post('/route', async (req, res) => {
  const startedAt = Date.now();
  const order = normalizeOrder(req.body as Partial<OrderIntent>);
  if (!order) {
    res.status(400).json({
      id: randomUUID(),
      orderId: 'invalid-order',
      broker: 'alpaca-paper',
      symbol: 'unknown',
      status: 'rejected',
      filledQty: 0,
      avgFillPrice: 0,
      slippageBps: 0,
      latencyMs: Date.now() - startedAt,
      message: 'Invalid order payload.',
      timestamp: new Date().toISOString()
    });
    return;
  }

  try {
    const riskCheck = await fetchRiskCheck(order);
    if (!riskCheck.allowed) {
      const report = buildRouteReport(order, {
        status: 'rejected',
        filledQty: 0,
        avgFillPrice: 0,
        slippageBps: 0,
        message: riskCheck.reason,
        riskCheck,
        eventSource: 'route',
        details: 'Risk engine blocked the order before broker submission.',
        errors: [],
        accountSnapshot: null,
        positionsSnapshot: [],
        fillsSnapshot: [],
        ordersSnapshot: []
      }, startedAt);
      recordReport(report);
      await syncVenue(order.broker, 'post-risk-block');
      res.status(400).json(report);
      return;
    }

    const report = order.broker === 'alpaca-paper'
      ? await routeAlpaca(order, riskCheck, startedAt)
      : order.broker === 'coinbase-live'
        ? await routeCoinbase(order, riskCheck, startedAt)
        : await routeOanda(order, riskCheck, startedAt);
    recordReport(report);
    await syncVenue(order.broker, 'post-route');
    res.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown route failure';
    const report = buildRouteReport(order, {
      status: 'rejected',
      filledQty: 0,
      avgFillPrice: 0,
      slippageBps: 0,
      message,
      riskCheck: null,
        eventSource: 'route',
      details: 'Broker route failed before an execution report could be produced.',
      errors: [message],
      accountSnapshot: null,
      positionsSnapshot: [],
      fillsSnapshot: [],
      ordersSnapshot: []
    }, startedAt);
    recordReport(report);
    await syncVenue(order.broker, 'route-failure');
    res.status(502).json(report);
  }
});

app.post('/cancel', async (req, res) => {
  const startedAt = Date.now();
  const broker = textField(req.body as Record<string, unknown>, ['broker']) as VenueId | null;
  const orderId = textField(req.body as Record<string, unknown>, ['orderId']);
  const symbol = textField(req.body as Record<string, unknown>, ['symbol']) ?? 'unknown';
  if (!broker || !orderId) {
    res.status(400).json({ ok: false, message: 'broker and orderId are required.' });
    return;
  }

  try {
    const result = broker === 'alpaca-paper'
      ? await cancelAlpacaOrder(orderId)
      : broker === 'coinbase-live'
        ? await cancelCoinbaseOrder(orderId)
        : { ok: false, status: 400, data: { error: 'cancel-not-supported' } };
    const message = result.ok ? 'Cancel submitted.' : extractErrorMessage(result.data, 'Cancel request failed.');
    recordReport({
      id: randomUUID(),
      orderId,
      broker,
      brokerMode: broker,
      venue: broker === 'alpaca-paper' ? 'alpaca' : broker === 'coinbase-live' ? 'coinbase' : 'oanda',
      symbol,
      status: result.ok ? 'canceled' : 'rejected',
      filledQty: 0,
      avgFillPrice: 0,
      slippageBps: 0,
      latencyMs: Date.now() - startedAt,
      message,
      timestamp: new Date().toISOString(),
      mode: broker === 'alpaca-paper' ? 'paper' : 'live',
      source: 'broker',
      riskCheck: null,
      eventSource: 'route',
      details: 'Cancel request submitted through broker-router.',
      errors: result.ok ? [] : [message],
      accountSnapshot: null,
      positionsSnapshot: [],
      fillsSnapshot: [],
      ordersSnapshot: [result.data]
    });
    res.status(result.ok ? 200 : 502).json({
      ok: result.ok,
      broker,
      orderId,
      symbol,
      status: result.ok ? 'canceled' : 'rejected',
      message,
      timestamp: new Date().toISOString(),
      raw: result.data
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'cancel request failed';
    recordReport({
      id: randomUUID(),
      orderId,
      broker,
      brokerMode: broker,
      venue: broker === 'alpaca-paper' ? 'alpaca' : broker === 'coinbase-live' ? 'coinbase' : 'oanda',
      symbol,
      status: 'rejected',
      filledQty: 0,
      avgFillPrice: 0,
      slippageBps: 0,
      latencyMs: Date.now() - startedAt,
      message,
      timestamp: new Date().toISOString(),
      mode: broker === 'alpaca-paper' ? 'paper' : 'live',
      source: 'broker',
      riskCheck: null,
      eventSource: 'route',
      details: 'Cancel request failed inside broker-router.',
      errors: [message],
      accountSnapshot: null,
      positionsSnapshot: [],
      fillsSnapshot: [],
      ordersSnapshot: []
    });
    res.status(502).json({
      ok: false,
      broker,
      orderId,
      symbol,
      status: 'rejected',
      message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/account', async (req, res) => {
  await maybeRefreshSnapshots();
  const broker = parseBrokerFilter(req.query.broker);
  res.json({
    asOf: new Date().toISOString(),
    brokers: broker ? [runtimeState.brokers[broker]] : Object.values(runtimeState.brokers),
    lastSyncAt: runtimeState.lastSyncAt
  });
});

app.get('/positions', async (req, res) => {
  await maybeRefreshSnapshots();
  const broker = parseBrokerFilter(req.query.broker);
  const brokers = broker ? [runtimeState.brokers[broker]] : Object.values(runtimeState.brokers);
  res.json({
    asOf: new Date().toISOString(),
    positions: brokers.flatMap((snapshot) => snapshot.positions),
    brokers
  });
});

app.get('/reports', async (_req, res) => {
  await maybeRefreshSnapshots();
  res.json({
    asOf: new Date().toISOString(),
    lastSyncAt: runtimeState.lastSyncAt,
    reports: [...runtimeState.reports].reverse(),
    brokers: Object.values(runtimeState.brokers)
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`[broker-router] listening on http://0.0.0.0:${port}`);
  void startSyncLoop();
});

function loadState(): BrokerRuntimeState {
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf8')) as BrokerRuntimeState;
    }
  } catch (error) {
    console.error('[broker-router] failed to load state', error);
  }

  return {
    asOf: new Date().toISOString(),
    lastSyncAt: null,
    brokers: {
      'alpaca-paper': emptyBrokerSnapshot('alpaca-paper', 'alpaca'),
      'coinbase-live': emptyBrokerSnapshot('coinbase-live', 'coinbase'),
      'oanda-rest': emptyBrokerSnapshot('oanda-rest', 'oanda')
    },
    reports: []
  };
}

let isPersisting = false;
let pendingPersist = false;

async function persistState(): Promise<void> {
  if (isPersisting) {
    pendingPersist = true;
    return;
  }
  isPersisting = true;
  pendingPersist = false;
  try {
    // Keep state.json small by stripping full snapshots from historical reports
    const stateToSave = {
      ...runtimeState,
      reports: runtimeState.reports.map(r => ({
        ...r,
        accountSnapshot: undefined,
        positionsSnapshot: undefined,
        fillsSnapshot: undefined,
        ordersSnapshot: undefined
      }))
    };
    await fs.promises.writeFile(statePath, `${JSON.stringify(stateToSave, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error('[broker-router] failed to persist state', error);
  } finally {
    isPersisting = false;
    if (pendingPersist) {
      setTimeout(() => persistState(), 500);
    }
  }
}

function recordReport(report: BrokerRouteReport): void {
  // Save full report to audit log (jsonl)
  appendJsonl(reportsPath, report);

  // Strip large snapshots for memory and state.json tracking
  const leanReport = {
    ...report,
    accountSnapshot: undefined,
    positionsSnapshot: undefined,
    fillsSnapshot: undefined,
    ordersSnapshot: undefined
  };

  runtimeState.reports.push(leanReport as BrokerRouteReport);
  if (runtimeState.reports.length > 50) {
    runtimeState.reports.splice(0, runtimeState.reports.length - 50);
  }
  runtimeState.asOf = new Date().toISOString();
  void persistState();
}

async function startSyncLoop(): Promise<void> {
  if (initialSyncStarted) return;
  initialSyncStarted = true;
  await syncAll('startup');
  setInterval(() => {
    void syncAll('interval');
  }, syncIntervalMs);
}

async function maybeRefreshSnapshots(): Promise<void> {
  const lastSyncAt = runtimeState.lastSyncAt ? new Date(runtimeState.lastSyncAt).getTime() : 0;
  if (!lastSyncAt || Date.now() - lastSyncAt > Math.max(15_000, syncIntervalMs / 2)) {
    void syncAll('on-read');
  }
}

async function syncAll(trigger: string): Promise<void> {
  await Promise.all([syncVenue('alpaca-paper', trigger), syncVenue('coinbase-live', trigger), syncVenue('oanda-rest', trigger)]);
  runtimeState.lastSyncAt = new Date().toISOString();
  runtimeState.asOf = runtimeState.lastSyncAt;
  persistState();
}

async function syncVenue(..._args: any[]): Promise<any> { return Promise.resolve(_args as any); }
async function syncAlpaca(..._args: any[]): Promise<any> { return Promise.resolve(_args as any); }
function readCoinbaseCredentials(mode: 'sync' | 'trade'): { apiKey: string; apiSecret: string } {
  const apiKey = mode === 'trade'
    ? readEnv(['COINBASE_TRADING_API_KEY', 'COINBASE_TRADE_API_KEY', 'HERMES_COINBASE_TRADING_API_KEY', 'COINBASE_API_KEY', 'CDP_API_KEY_NAME'])
    : readEnv(['COINBASE_API_KEY', 'CDP_API_KEY_NAME', 'COINBASE_TRADING_API_KEY', 'COINBASE_TRADE_API_KEY', 'HERMES_COINBASE_TRADING_API_KEY']);
  const apiSecret = mode === 'trade'
    ? readEnv(['COINBASE_TRADING_API_SECRET', 'COINBASE_TRADE_API_SECRET', 'HERMES_COINBASE_TRADING_API_SECRET', 'COINBASE_API_SECRET', 'CDP_API_KEY_PRIVATE'], true)
    : readEnv(['COINBASE_API_SECRET', 'CDP_API_KEY_PRIVATE', 'COINBASE_TRADING_API_SECRET', 'COINBASE_TRADE_API_SECRET', 'HERMES_COINBASE_TRADING_API_SECRET'], true);
  return { apiKey, apiSecret };
}

async function syncCoinbase(..._args: any[]): Promise<any> { return Promise.resolve(_args as any); }
async function routeAlpaca(..._args: any[]): Promise<any> { return Promise.resolve(_args as any); }
async function routeCoinbase(..._args: any[]): Promise<any> { return Promise.resolve(_args as any); }
async function cancelAlpacaOrder(orderId: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const apiKey = readEnv(['ALPACA_PAPER_KEY', 'ALPACA_API_KEY_ID', 'APCA_API_KEY_ID']);
  const apiSecret = readEnv(['ALPACA_PAPER_SECRET', 'ALPACA_API_SECRET_KEY', 'APCA_API_SECRET_KEY']);
  if (!apiKey || !apiSecret) {
    throw new Error('Alpaca API key/secret are missing.');
  }
  return requestJson(`${alpacaPaperBaseUrl}/v2/orders/${orderId}`, {
    method: 'DELETE',
    headers: {
      'APCA-API-KEY-ID': apiKey,
      'APCA-API-SECRET-KEY': apiSecret
    }
  });
}

async function cancelCoinbaseOrder(orderId: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const { apiKey, apiSecret } = readCoinbaseCredentials('trade');
  if (!apiKey || !apiSecret) {
    throw new Error('Coinbase API key/secret are missing.');
  }
  const cancelUrl = `${coinbaseBaseUrl}/orders/batch_cancel`;
  return requestJson(cancelUrl, {
    method: 'POST',
    headers: {
      ...coinbaseHeaders('POST', cancelUrl, apiKey, apiSecret),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ order_ids: [orderId] })
  });
}

async function syncOanda(..._args: any[]): Promise<any> { return Promise.resolve(_args as any); }
async function routeOanda(..._args: any[]): Promise<any> { return Promise.resolve(_args as any); }
function buildRouteReport(..._args: any[]): any { return _args as any; }
async function fetchRiskCheck(order: NormalizedOrder): Promise<RiskCheck> {
  const payload = {
    id: order.id,
    symbol: order.symbol,
    broker: order.broker,
    side: order.side,
    orderType: order.orderType,
    notional: order.notional,
    quantity: order.quantity,
    limitPrice: order.limitPrice,
    strategy: order.strategy,
    mode: order.mode,
    thesis: order.thesis
  };

  try {
    const response = await requestJson(riskEngineUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (response.ok && response.data && typeof response.data === 'object') {
      return response.data as RiskCheck;
    }
  } catch (error) {
    console.warn('[broker-router] risk engine unavailable, using local fallback', error);
  }

  const allowed = order.notional > 0 && order.quantity > 0;
  return {
    allowed,
    reason: allowed ? 'Fallback risk check passed locally.' : 'Fallback risk check rejected the order.',
    maxNotional: order.notional,
    maxDailyLoss: 0,
    killSwitchArmed: !allowed
  };
}

async function requestJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? requestTimeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    const text = await response.text();
    let data: unknown = text;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

function coinbaseHeaders(method: string, requestUrl: string, apiKey: string, apiSecret: string): Record<string, string> {
  return {
    Authorization: `Bearer ${buildCoinbaseJwt(method, requestUrl, apiKey, apiSecret)}`
  };
}

function buildCoinbaseJwt(..._args: any[]): any { return _args as any; }
function normalizeCoinbasePositions(..._args: any[]): any { return _args as any; }
function normalizeAlpacaPositions(..._args: any[]): any { return _args as any; }
function normalizeOrder(input: Partial<OrderIntent>): NormalizedOrder | null {
  const id = textField(input, ['id']) ?? randomUUID();
  const symbol = textField(input, ['symbol']);
  const broker = textField(input, ['broker']) as VenueId | null;
  const side = textField(input, ['side']) as 'buy' | 'sell' | null;
  const orderType = textField(input, ['orderType']) as 'market' | 'limit' | null;
  const strategy = textField(input, ['strategy']) ?? 'unknown';
  const mode = textField(input, ['mode']) as 'paper' | 'live' | null;
  const thesis = textField(input, ['thesis']) ?? '';
  const quantity = numberField(input, ['quantity']) ?? 0;
  const notional = numberField(input, ['notional']) ?? quantity;
  const limitPrice = numberField(input, ['limitPrice']);
  const timeInForce = textField(input, ['timeInForce']) as 'day' | 'gtc' | 'ioc' | 'fok' | null;
  const postOnly = booleanField(input, ['postOnly']);

  if (!symbol || !broker || !side || !orderType || !mode || quantity <= 0 || notional <= 0) {
    return null;
  }

  if (broker !== 'alpaca-paper' && broker !== 'coinbase-live' && broker !== 'oanda-rest') {
    return null;
  }

  return {
    id,
    symbol,
    broker,
    side,
    orderType,
    notional,
    quantity,
    limitPrice: limitPrice ?? undefined,
    timeInForce: timeInForce ?? undefined,
    postOnly: postOnly ?? undefined,
    strategy,
    mode,
    thesis
  };
}

function parseBrokerFilter(value: unknown): VenueId | null { return parseBrokerIdUtil(value) as VenueId | null; }

function trimTrailingSlash(value: string): string { return trimTrailingSlashUtil(value); }

function splitList(value: string): string[] { return splitListUtil(value); }

function buildCoinbaseProductQuery(symbols: string[]): string {
  const query = new URLSearchParams();
  for (const symbol of symbols) {
    query.append('product_ids', symbol);
  }
  return query.toString();
}

async function pollAlpacaOrderStatus(..._args: any[]): Promise<any> { return Promise.resolve(_args as any); }
function loadProjectEnv(..._args: any[]): any { return _args as any; }
function loadLegacyEnv(..._args: any[]): any { return _args as any; }
function readEnv(names: string[], normalizeNewlines = false): string {
  for (const name of names) {
    const value = process.env[name] ?? projectEnv[name] ?? legacyEnv[name];
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

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function normalizePem(secret: string): string {
  if (secret.includes('BEGIN')) return secret;
  const decoded = Buffer.from(secret, 'base64').toString('utf8');
  if (decoded.includes('BEGIN')) return decoded;
  return secret.replace(/\\n/g, '\n');
}

function appendJsonl(filePath: string, payload: unknown): void {
  try {
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (error) {
    console.error('[broker-router] failed to append report', error);
  }
}

function normalizeArray(value: unknown): unknown[] { return normalizeArrayUtil(value); }

function asRecord(value: unknown): Record<string, unknown> { return asRecordUtil(value); }

function textField(source: unknown, paths: string[]): string | null {
  const record = asRecord(source);
  for (const pathName of paths) {
    const value = deepGet(record, pathName);
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function numberField(source: unknown, paths: string[]): number | null {
  const record = asRecord(source);
  for (const pathName of paths) {
    const value = deepGet(record, pathName);
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function booleanField(source: unknown, paths: string[]): boolean | null {
  const record = asRecord(source);
  for (const pathName of paths) {
    const value = deepGet(record, pathName);
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
    }
  }
  return null;
}

function deepGet(source: Record<string, unknown>, pathName: string): unknown {
  const segments = pathName.split('.');
  let current: unknown = source;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string' && payload.trim().length > 0) {
    return payload;
  }
  const record = asRecord(payload);
  for (const key of ['message', 'error', 'error_message', 'errorMessage']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return fallback;
}

function normalizeOrderStatus(value: string | null, fallback: OrderStatus): OrderStatus {
  switch ((value ?? '').toLowerCase()) {
    case 'accepted':
    case 'new':
    case 'pending':
    case 'open':
      return 'accepted';
    case 'filled':
      return 'filled';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    case 'rejected':
    case 'expired':
      return 'rejected';
    default:
      return fallback;
  }
}

function sleep(ms: number): Promise<void> { return sleepUtil(ms); }

function collectFetchErrors(responses: Array<{ ok: boolean; status: number; data: unknown }>): string[] {
  const errors: string[] = [];
  for (const response of responses) {
    if (!response.ok) {
      errors.push(extractErrorMessage(response.data, `HTTP ${response.status}`));
    }
  }
  return errors;
}

function emptyBrokerSnapshot(broker: VenueId, venue: 'alpaca' | 'coinbase' | 'oanda'): BrokerAccountSnapshot {
  return {
    broker,
    venue,
    status: 'missing-credentials',
    asOf: new Date().toISOString(),
    account: null,
    positions: [],
    fills: [],
    orders: [],
    errors: []
  };
}
