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

async function syncVenue(broker: VenueId, trigger: string): Promise<BrokerAccountSnapshot> {
  if (syncInFlight.has(broker)) {
    return syncInFlight.get(broker)!;
  }

  const promise = (async () => {
    try {
      const snapshot = broker === 'alpaca-paper'
        ? await syncAlpaca(broker)
        : broker === 'coinbase-live'
          ? await syncCoinbase(broker)
          : await syncOanda(broker);
      runtimeState.brokers[broker] = snapshot;
      runtimeState.asOf = new Date().toISOString();
      recordReport({
        id: randomUUID(),
        orderId: `sync-${broker}-${trigger}`,
        broker,
        brokerMode: broker,
        venue: broker === 'alpaca-paper' ? 'alpaca' : broker === 'coinbase-live' ? 'coinbase' : 'oanda',
        symbol: broker === 'alpaca-paper' ? 'ALPACA-PAPER' : broker === 'coinbase-live' ? 'COINBASE-LIVE' : 'OANDA-REST',
        status: snapshot.status === 'missing-credentials' ? 'rejected' : 'accepted',
        mode: broker === 'alpaca-paper' ? 'paper' : broker === 'oanda-rest' ? 'paper' : 'live',
        source: 'broker',
        filledQty: 0,
        avgFillPrice: 0,
        slippageBps: 0,
        latencyMs: 0,
        message: snapshot.status === 'healthy'
          ? `${broker} synced successfully.`
          : snapshot.errors.at(-1) ?? `${broker} sync returned ${snapshot.status}.`,
        timestamp: snapshot.asOf,
        riskCheck: null,
        eventSource: 'sync',
        details: `Sync trigger: ${trigger}`,
        errors: snapshot.errors,
        accountSnapshot: snapshot.account,
        positionsSnapshot: snapshot.positions,
        fillsSnapshot: snapshot.fills,
        ordersSnapshot: snapshot.orders
      });
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown sync error';
      // Preserve existing state on error to avoid wiping cash/positions (which causes PnL hallucinations)
      const prevSnapshot = runtimeState.brokers[broker] || emptyBrokerSnapshot(broker, broker === 'alpaca-paper' ? 'alpaca' : 'coinbase');
      const snapshot = {
        ...prevSnapshot,
        status: 'error' as SyncStatus,
        asOf: new Date().toISOString(),
        errors: [...(prevSnapshot.errors || []), message].slice(-10)
      };
      runtimeState.brokers[broker] = snapshot;
      runtimeState.asOf = snapshot.asOf;
      recordReport({
        id: randomUUID(),
        orderId: `sync-${broker}-${trigger}`,
        broker,
        brokerMode: broker,
        venue: broker === 'alpaca-paper' ? 'alpaca' : 'coinbase',
        symbol: broker,
        status: 'rejected',
        mode: broker === 'alpaca-paper' ? 'paper' : 'live',
        source: 'broker',
        filledQty: 0,
        avgFillPrice: 0,
        slippageBps: 0,
        latencyMs: 0,
        message,
        timestamp: snapshot.asOf,
        riskCheck: null,
        eventSource: 'sync',
        details: `Sync failed during ${trigger}.`,
        errors: [message],
        accountSnapshot: snapshot.account,
        positionsSnapshot: snapshot.positions,
        fillsSnapshot: snapshot.fills,
        ordersSnapshot: snapshot.orders
      });
      return snapshot;
    } finally {
      syncInFlight.delete(broker);
      persistState();
    }
  })();

  syncInFlight.set(broker, promise);
  return promise;
}

async function syncAlpaca(broker: VenueId): Promise<BrokerAccountSnapshot> {
  const keyId = readEnv(['ALPACA_API_KEY_ID', 'ALPACA_PAPER_KEY', 'APCA_API_KEY_ID']);
  const secretKey = readEnv(['ALPACA_API_SECRET_KEY', 'ALPACA_PAPER_SECRET', 'APCA_API_SECRET_KEY']);
  if (!keyId || !secretKey) {
    return {
      ...emptyBrokerSnapshot(broker, 'alpaca'),
      asOf: new Date().toISOString(),
      errors: ['Missing Alpaca paper credentials.']
    };
  }

  const headers = {
    'APCA-API-KEY-ID': keyId,
    'APCA-API-SECRET-KEY': secretKey
  };
  // Retry wrapper for transient Alpaca failures (connection drops, 5xx, timeouts)
  const retryJson = async (url: string, opts: RequestInit & { timeoutMs?: number } = {}): Promise<{ ok: boolean; status: number; data: unknown }> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await requestJson(url, opts);
      if (result.ok || (result.status >= 400 && result.status < 500 && result.status !== 429)) return result;
      if (attempt < 2) await sleep(500 * Math.pow(2, attempt));
    }
    return requestJson(url, opts);
  };

  const [account, positions, fills, orders] = await Promise.all([
    retryJson(`${alpacaPaperBaseUrl}/v2/account`, { headers }),
    retryJson(`${alpacaPaperBaseUrl}/v2/positions`, { headers }),
    retryJson(`${alpacaPaperBaseUrl}/v2/account/activities/FILL?direction=desc&limit=100`, { headers }),
    retryJson(`${alpacaPaperBaseUrl}/v2/orders?status=all&limit=100`, { headers })
  ]);

  const errors = collectFetchErrors([account, positions, fills, orders]);
  const status: SyncStatus = errors.length > 0 ? 'degraded' : 'healthy';
  return {
    broker,
    venue: 'alpaca',
    status,
    asOf: new Date().toISOString(),
    account: account.ok ? account.data : null,
    positions: positions.ok ? normalizeAlpacaPositions(normalizeArray(positions.data), 'alpaca-paper') : [],
    fills: fills.ok ? normalizeArray(fills.data) : [],
    orders: orders.ok ? normalizeArray(orders.data) : [],
    errors
  };
}

function readCoinbaseCredentials(mode: 'sync' | 'trade'): { apiKey: string; apiSecret: string } {
  const apiKey = mode === 'trade'
    ? readEnv(['COINBASE_TRADING_API_KEY', 'COINBASE_TRADE_API_KEY', 'HERMES_COINBASE_TRADING_API_KEY', 'COINBASE_API_KEY', 'CDP_API_KEY_NAME'])
    : readEnv(['COINBASE_API_KEY', 'CDP_API_KEY_NAME', 'COINBASE_TRADING_API_KEY', 'COINBASE_TRADE_API_KEY', 'HERMES_COINBASE_TRADING_API_KEY']);
  const apiSecret = mode === 'trade'
    ? readEnv(['COINBASE_TRADING_API_SECRET', 'COINBASE_TRADE_API_SECRET', 'HERMES_COINBASE_TRADING_API_SECRET', 'COINBASE_API_SECRET', 'CDP_API_KEY_PRIVATE'], true)
    : readEnv(['COINBASE_API_SECRET', 'CDP_API_KEY_PRIVATE', 'COINBASE_TRADING_API_SECRET', 'COINBASE_TRADE_API_SECRET', 'HERMES_COINBASE_TRADING_API_SECRET'], true);
  return { apiKey, apiSecret };
}

async function syncCoinbase(broker: VenueId): Promise<BrokerAccountSnapshot> {
  const { apiKey, apiSecret } = readCoinbaseCredentials('sync');
  if (!apiKey || !apiSecret) {
    return {
      ...emptyBrokerSnapshot(broker, 'coinbase'),
      asOf: new Date().toISOString(),
      errors: ['Missing Coinbase API key/secret.']
    };
  }

  const coinbaseBookQuery = buildCoinbaseProductQuery(coinbaseUniverse);
  const [accounts, fills, orders, book] = await Promise.all([
    requestJson(`${coinbaseBaseUrl}/accounts`, { headers: coinbaseHeaders('GET', `${coinbaseBaseUrl}/accounts`, apiKey, apiSecret) }),
    requestJson(`${coinbaseBaseUrl}/orders/historical/fills?limit=100`, {
      headers: coinbaseHeaders('GET', `${coinbaseBaseUrl}/orders/historical/fills?limit=100`, apiKey, apiSecret)
    }),
    requestJson(`${coinbaseBaseUrl}/orders/historical/batch?limit=100`, {
      headers: coinbaseHeaders('GET', `${coinbaseBaseUrl}/orders/historical/batch?limit=100`, apiKey, apiSecret)
    }),
    requestJson(`${coinbaseBaseUrl}/best_bid_ask?${coinbaseBookQuery}`, {
      headers: coinbaseHeaders('GET', `${coinbaseBaseUrl}/best_bid_ask?${coinbaseBookQuery}`, apiKey, apiSecret)
    })
  ]);

  const errors = collectFetchErrors([accounts, fills, orders, book]);
  const positions = normalizeCoinbasePositions(accounts.ok ? accounts.data : null, book.ok ? book.data : null);
  const status: SyncStatus = errors.length > 0 ? 'degraded' : 'healthy';
  return {
    broker,
    venue: 'coinbase',
    status,
    asOf: new Date().toISOString(),
    account: accounts.ok ? accounts.data : null,
    positions,
    fills: fills.ok ? normalizeArray(fills.data) : [],
    orders: orders.ok ? normalizeArray(orders.data) : [],
    errors
  };
}

async function routeAlpaca(order: NormalizedOrder, riskCheck: RiskCheck, startedAt: number): Promise<BrokerRouteReport> {
  const keyId = readEnv(['ALPACA_API_KEY_ID', 'ALPACA_PAPER_KEY', 'APCA_API_KEY_ID']);
  const secretKey = readEnv(['ALPACA_API_SECRET_KEY', 'ALPACA_PAPER_SECRET', 'APCA_API_SECRET_KEY']);
  if (!keyId || !secretKey) {
    throw new Error('Alpaca paper credentials are missing.');
  }
  const venueSymbol = toAlpacaOrderSymbol(order.symbol);
  const timeInForce = isUsdCryptoSymbol(order.symbol) ? 'gtc' : 'day';
  const headers = {
    'APCA-API-KEY-ID': keyId,
    'APCA-API-SECRET-KEY': secretKey
  };

  const payload: Record<string, unknown> = {
    client_order_id: order.id,
    symbol: venueSymbol,
    qty: order.quantity.toString(),
    side: order.side,
    type: order.orderType,
    time_in_force: timeInForce
  };
  if (order.orderType === 'limit' && typeof order.limitPrice === 'number') {
    payload.limit_price = order.limitPrice.toString();
  }

  const response = await requestJson(`${alpacaPaperBaseUrl}/v2/orders`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(extractErrorMessage(response.data, 'Alpaca order rejected.'));
  }

  const initialData = asRecord(response.data);
  const orderId = textField(initialData, ['id', 'order_id']);
  const finalData = orderId
    ? await pollAlpacaOrderStatus(orderId, headers, initialData)
    : initialData;
  const status = normalizeOrderStatus(textField(finalData, ['status', 'order_status']), 'accepted');
  const fillQty = numberField(finalData, ['filled_qty', 'filledQty', 'qty']) ?? order.quantity;
  const fillPrice = numberField(finalData, ['filled_avg_price', 'avg_fill_price', 'avg_price', 'filled_avg_px', 'limit_price']) ?? order.limitPrice ?? 0;

  return buildRouteReport(order, {
    orderId: orderId || order.id,
    status,
    filledQty: fillQty,
    avgFillPrice: fillPrice,
    slippageBps: order.orderType === 'market' ? 2.1 : 0.8,
    message: `Alpaca paper order ${status}.`,
    riskCheck,
    eventSource: 'route',
    details: `Submitted to Alpaca paper at ${alpacaPaperBaseUrl}.`,
    errors: [],
    accountSnapshot: null,
    positionsSnapshot: [],
    fillsSnapshot: [],
    ordersSnapshot: [initialData, finalData]
  }, startedAt);
}

async function routeCoinbase(order: NormalizedOrder, riskCheck: RiskCheck, startedAt: number): Promise<BrokerRouteReport> {
  if (order.mode !== 'live' || !coinbaseLiveRoutingEnabled) {
    throw new Error('Coinbase live routing is disabled for non-live orders. Enable COINBASE_LIVE_ROUTING_ENABLED=1 only when explicitly approved.');
  }

  const { apiKey, apiSecret } = readCoinbaseCredentials('trade');
  if (!apiKey || !apiSecret) {
    throw new Error('Coinbase API key/secret are missing.');
  }

  const createUrl = `${coinbaseBaseUrl}/orders`;
  const payload: Record<string, unknown> = {
    client_order_id: order.id,
    product_id: order.symbol,
    side: order.side.toUpperCase(),
    order_configuration:
      order.orderType === 'limit'
        ? {
            limit_limit_gtc: {
              base_size: order.quantity.toString(),
              limit_price: (order.limitPrice ?? order.notional / Math.max(order.quantity, 1)).toString(),
              post_only: order.postOnly === true
            }
          }
        : {
            market_market_ioc: {
              base_size: order.quantity.toString()
            }
          }
  };

  const response = await requestJson(createUrl, {
    method: 'POST',
    headers: {
      ...coinbaseHeaders('POST', createUrl, apiKey, apiSecret),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(extractErrorMessage(response.data, 'Coinbase order rejected.'));
  }

  const data = asRecord(response.data);
  const errorResponse = asRecord(data.error_response);
  const explicitSuccess = typeof data.success === 'boolean' ? data.success : undefined;
  if (explicitSuccess === false || Object.keys(errorResponse).length > 0) {
    throw new Error(extractErrorMessage(errorResponse, extractErrorMessage(data, 'Coinbase order rejected.')));
  }

  const success = asRecord(data.success_response);
  const orderId = textField(success, ['order_id']) ?? textField(data, ['order_id', 'id']) ?? order.id;
  const statusUrl = `${coinbaseBaseUrl}/orders/historical/${orderId}`;
  const statusResponse = await requestJson(statusUrl, {
    headers: coinbaseHeaders('GET', statusUrl, apiKey, apiSecret)
  });
  const statusData = statusResponse.ok ? asRecord(statusResponse.data) : data;
  const normalizedStatus = normalizeOrderStatus(textField(statusData, ['status', 'order_status']), 'accepted');
  const fillQtyRaw = numberField(statusData, ['filled_size', 'filled_qty', 'filledQty', 'size']);
  const fillPriceRaw = numberField(statusData, ['average_filled_price', 'avg_fill_price', 'filled_avg_price']);
  const fillQty = normalizedStatus === 'filled' ? (fillQtyRaw ?? order.quantity) : (fillQtyRaw ?? 0);
  const fillPrice = normalizedStatus === 'filled' ? (fillPriceRaw ?? order.limitPrice ?? 0) : (fillPriceRaw ?? 0);

  return buildRouteReport(order, {
    orderId,
    status: normalizedStatus,
    filledQty: fillQty,
    avgFillPrice: fillPrice,
    slippageBps: order.orderType === 'market' ? 2.4 : 1,
    message: `Coinbase order ${normalizedStatus}.`,
    riskCheck,
    eventSource: 'route',
    details: `Submitted to Coinbase Advanced Trade at ${coinbaseBaseUrl}.`,
    errors: statusResponse.ok ? [] : [extractErrorMessage(statusResponse.data, 'Coinbase order placed but status lookup failed.')],
    accountSnapshot: null,
    positionsSnapshot: [],
    fillsSnapshot: [],
    ordersSnapshot: [data, statusData]
  }, startedAt);
}

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

async function syncOanda(broker: VenueId): Promise<BrokerAccountSnapshot> {
  if (!oandaApiKey || !oandaAccountId) {
    return {
      ...emptyBrokerSnapshot(broker, 'oanda' as 'alpaca' | 'coinbase'),
      asOf: new Date().toISOString(),
      errors: ['Missing OANDA credentials (OANDA_API_KEY / OANDA_ACCOUNT_ID).']
    };
  }

  const headers = { 'Authorization': `Bearer ${oandaApiKey}`, 'Content-Type': 'application/json' };
  const base = `${oandaBaseUrl}/v3/accounts/${oandaAccountId}`;
  const [account, positions, orders, trades] = await Promise.all([
    requestJson(base, { headers }),
    requestJson(`${base}/openPositions`, { headers }),
    requestJson(`${base}/orders`, { headers }),
    requestJson(`${base}/trades`, { headers })
  ]);

  const errors = collectFetchErrors([account, positions, orders, trades]);
  const status: SyncStatus = errors.length > 0 ? 'degraded' : 'healthy';
  const accountRecord = asRecord(account.ok ? (asRecord(account.data).account ?? account.data) : null);
  const positionsList = normalizeArray(positions.ok ? (asRecord(positions.data).positions ?? positions.data) : []);
  const ordersList = normalizeArray(orders.ok ? (asRecord(orders.data).orders ?? orders.data) : []);
  const tradesList = normalizeArray(trades.ok ? (asRecord(trades.data).trades ?? trades.data) : []);

  return {
    broker,
    venue: 'oanda' as 'alpaca' | 'coinbase',
    status,
    asOf: new Date().toISOString(),
    account: accountRecord,
    positions: positionsList,
    fills: tradesList,
    orders: ordersList,
    errors
  };
}

async function routeOanda(order: NormalizedOrder, riskCheck: RiskCheck, startedAt: number): Promise<BrokerRouteReport> {
  if (!oandaApiKey || !oandaAccountId) {
    throw new Error('OANDA API key/account are missing.');
  }

  const units = order.side === 'buy' ? order.quantity : -order.quantity;
  const createUrl = `${oandaBaseUrl}/v3/accounts/${oandaAccountId}/orders`;
  const payload = {
    order: {
      type: 'MARKET',
      instrument: order.symbol,
      units: units.toString(),
      timeInForce: 'FOK'
    }
  };

  const response = await requestJson(createUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${oandaApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(extractErrorMessage(response.data, 'OANDA order rejected.'));
  }

  const data = asRecord(response.data);
  const fill = asRecord(data.orderFillTransaction ?? data.orderCreateTransaction ?? {});
  const fillPrice = numberField(fill, ['price', 'averagePrice']) ?? order.limitPrice ?? 0;
  const fillQty = Math.abs(numberField(fill, ['units']) ?? order.quantity);
  const status = fill.type === 'ORDER_FILL' ? 'filled' as const : 'accepted' as const;

  return buildRouteReport(order, {
    orderId: textField(fill, ['id', 'orderID', 'order_id']) ?? order.id,
    status,
    filledQty: fillQty,
    avgFillPrice: fillPrice,
    slippageBps: 1.5,
    message: `OANDA order ${status}.`,
    riskCheck,
    eventSource: 'route',
    details: `Submitted to OANDA REST v20 at ${oandaBaseUrl}.`,
    errors: [],
    accountSnapshot: null,
    positionsSnapshot: [],
    fillsSnapshot: [],
    ordersSnapshot: [data]
  }, startedAt);
}

function buildRouteReport(
  order: NormalizedOrder,
  patch: {
    orderId?: string;
    status: OrderStatus;
    filledQty: number;
    avgFillPrice: number;
    slippageBps: number;
    message: string;
    riskCheck: RiskCheck | null;
    eventSource: 'route' | 'sync';
    details: string;
    errors: string[];
    accountSnapshot?: unknown;
    positionsSnapshot?: unknown[];
    fillsSnapshot?: unknown[];
    ordersSnapshot?: unknown[];
  },
  startedAt: number
): BrokerRouteReport {
  return {
    id: randomUUID(),
    orderId: patch.orderId ?? order.id,
    broker: order.broker,
    brokerMode: order.broker,
    venue: order.broker === 'alpaca-paper' ? 'alpaca' : order.broker === 'coinbase-live' ? 'coinbase' : 'oanda',
    symbol: order.symbol,
    status: patch.status,
    filledQty: patch.filledQty,
    avgFillPrice: patch.avgFillPrice,
    slippageBps: patch.slippageBps,
    latencyMs: Date.now() - startedAt,
    message: patch.message,
    timestamp: new Date().toISOString(),
    mode: order.mode,
    source: 'broker',
    riskCheck: patch.riskCheck,
    eventSource: patch.eventSource,
    details: patch.details,
    errors: patch.errors,
    accountSnapshot: patch.accountSnapshot ?? null,
    positionsSnapshot: patch.positionsSnapshot ?? [],
    fillsSnapshot: patch.fillsSnapshot ?? [],
    ordersSnapshot: patch.ordersSnapshot ?? []
  };
}

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

function buildCoinbaseJwt(method: string, requestUrl: string, apiKey: string, apiSecret: string): string {
  const normalizedSecret = normalizePem(apiSecret);
  const key = createPrivateKey({ key: normalizedSecret, format: 'pem' });
  const now = Math.floor(Date.now() / 1000);
  const parsedUrl = new URL(requestUrl);
  const header = {
    alg: 'ES256',
    typ: 'JWT',
    kid: apiKey,
    nonce: randomBytes(16).toString('hex')
  };
  const payload = {
    iss: 'cdp',
    sub: apiKey,
    aud: ['cdp_service'],
    nbf: now,
    exp: now + 120,
    uri: `${method.toUpperCase()} ${parsedUrl.host}${parsedUrl.pathname}`
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = createSign('SHA256').update(unsigned).sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${base64Url(signature)}`;
}

function normalizeCoinbasePositions(accountsData: unknown, bookData: unknown): PositionSnapshot[] {
  const accounts = normalizeArray(accountsData);
  const book = asRecord(bookData);
  const priceMap = new Map<string, number>();
  const bestBidAsk = normalizeArray(book.best_bid_ask ?? book.bestBidAsk ?? book.pricebooks ?? book.data);
  for (const row of bestBidAsk) {
    const record = asRecord(row);
    const productId = textField(record, ['product_id', 'productId', 'symbol']);
    const ask = numberField(record, ['ask_price', 'askPrice']) ?? numberField(asRecord(normalizeArray(record.asks)[0]), ['price']);
    const bid = numberField(record, ['bid_price', 'bidPrice']) ?? numberField(asRecord(normalizeArray(record.bids)[0]), ['price']);
    const price = ask ?? bid ?? numberField(record, ['price']);
    if (productId && typeof price === 'number' && price > 0) {
      priceMap.set(productId, price);
    }
  }

  return accounts
    .map((account): PositionSnapshot | null => {
      const record = asRecord(account);
      const currency = textField(record, ['currency', 'asset', 'symbol', 'name']) ?? 'unknown';
      if (currency === 'USD' || currency === 'USDC') return null;
      const quantity = numberField(record, ['available_balance.value', 'available_balance', 'balance', 'value']) ?? 0;
      if (quantity <= 0) return null;
      const productId = currency.includes('-USD') ? currency : `${currency}-USD`;
      const markPrice = priceMap.get(productId);
      if (!markPrice || markPrice <= 0) return null;
      return {
        id: `coinbase-${productId}`,
        broker: 'coinbase-live' as const,
        symbol: productId,
        strategy: 'broker-position',
        assetClass: 'crypto' as const,
        quantity,
        avgEntry: markPrice,
        markPrice,
        unrealizedPnl: 0,
        unrealizedPnlPct: 0,
        thesis: 'Derived from Coinbase account balance.',
        openedAt: new Date().toISOString(),
        source: 'broker' as const
      };
    })
    .filter((value): value is PositionSnapshot => value !== null);
}

function normalizeAlpacaPositions(positionsData: unknown[], broker: 'alpaca-paper'): PositionSnapshot[] {
  return positionsData
    .map((position): PositionSnapshot | null => {
      const record = asRecord(position);
      const symbol = normalizeAlpacaSymbol(textField(record, ['symbol']) ?? '');
      const quantity = Math.abs(numberField(record, ['qty', 'quantity']) ?? 0);
      if (!symbol || quantity <= 0) return null;

      const avgEntry = numberField(record, ['avg_entry_price', 'avgEntry']) ?? 0;
      const markPrice = numberField(record, ['current_price', 'mark_price', 'markPrice']) ?? avgEntry;
      const unrealizedPnl = numberField(record, ['unrealized_pl', 'unrealizedPnl']) ?? 0;
      const rawPct = numberField(record, ['unrealized_plpc', 'unrealizedPnlPct']) ?? 0;
      const unrealizedPnlPct = Math.abs(rawPct) <= 1 ? rawPct * 100 : rawPct;
      const assetClassValue = (textField(record, ['asset_class', 'assetClass']) ?? 'equity').toLowerCase();

      return {
        id: textField(record, ['asset_id', 'id']) ?? `alpaca-${symbol}`,
        broker,
        symbol,
        strategy: 'broker-position',
        assetClass: assetClassValue.includes('crypto') ? 'crypto' : 'equity',
        quantity,
        avgEntry,
        markPrice,
        unrealizedPnl,
        unrealizedPnlPct,
        thesis: 'Imported from Alpaca paper positions.',
        openedAt: textField(record, ['opened_at', 'openedAt']) ?? new Date().toISOString(),
        source: 'broker'
      };
    })
    .filter((value): value is PositionSnapshot => value !== null);
}

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

async function pollAlpacaOrderStatus(
  orderId: string,
  headers: Record<string, string>,
  fallback: Record<string, unknown>
): Promise<Record<string, unknown>> {
  let lastData = fallback;

  for (let attempt = 0; attempt < alpacaOrderPollAttempts; attempt += 1) {
    try {
      const response = await requestJson(`${alpacaPaperBaseUrl}/v2/orders/${orderId}`, { headers });
      if (response.ok) {
        lastData = asRecord(response.data);
        const status = normalizeOrderStatus(textField(lastData, ['status', 'order_status']), 'accepted');
        if (status !== 'accepted' || (numberField(lastData, ['filled_qty', 'filledQty']) ?? 0) > 0) {
          return lastData;
        }
      } else if (response.status === 429) {
        // Rate limited — back off harder
        console.warn(`[broker-router] Alpaca rate limited on order ${orderId}, backing off`);
        await sleep(alpacaOrderPollDelayMs * Math.pow(2, attempt + 2));
        continue;
      }
    } catch (err) {
      console.warn(`[broker-router] Alpaca poll error for ${orderId} (attempt ${attempt + 1}):`, err);
    }

    if (attempt < alpacaOrderPollAttempts - 1) {
      // Exponential backoff: 300ms, 600ms, 1200ms, 2400ms, 4800ms
      await sleep(alpacaOrderPollDelayMs * Math.pow(2, attempt));
    }
  }

  return lastData;
}

function loadProjectEnv(): Record<string, string> {
  const filePath = path.resolve(moduleDir, '../../../.env');
  const values: Record<string, string> = {};
  try {
    if (!fs.existsSync(filePath)) {
      return values;
    }
    const content = fs.readFileSync(filePath, 'utf8');
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
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !(key in values)) {
        values[key] = value;
      }
    }
  } catch {
    // Ignore project env read failures and fall back to process env / legacy env.
  }
  return values;
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
      if (!fs.existsSync(filePath)) {
        continue;
      }

      const content = fs.readFileSync(filePath, 'utf8');
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
