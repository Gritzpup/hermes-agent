// @ts-nocheck
import { randomBytes, createSign, createPrivateKey } from 'node:crypto';
import type { RiskCheck, PositionSnapshot } from '@hermes/contracts';
import type {
  VenueId,
  BrokerAccountSnapshot,
  BrokerRouteReport,
  NormalizedOrder
} from './broker-types.js';
import {
  readEnv,
  projectEnv,
  requestJson,
  normalizeArray,
  asRecord,
  textField,
  numberField,
  normalizeOrderStatus,
  collectFetchErrors,
  emptyBrokerSnapshot,
  extractErrorMessage,
  buildRouteReport,
  base64Url,
  splitList,
  trimTrailingSlash
} from './broker-utils.js';
import { validateLiveCanaryApproval } from './live-canary-approval.js';

// ── Config ───────────────────────────────────────────────────────────

const coinbaseBaseUrl: string =
  trimTrailingSlash(process.env.COINBASE_API_BASE_URL ?? 'https://api.coinbase.com/api/v3/brokerage');

const coinbaseUniverse: string[] =
  splitList(process.env.COINBASE_UNIVERSE ?? 'BTC-USD,ETH-USD,SOL-USD,XRP-USD,PAXG-USD');

const coinbaseLiveRoutingEnabled: boolean =
  (process.env.COINBASE_LIVE_ROUTING_ENABLED ?? projectEnv.COINBASE_LIVE_ROUTING_ENABLED ?? '0') === '1';

// ── Phase 4 live-capital belt-and-suspenders ─────────────────────────
const HERMES_API_URL = trimTrailingSlash(process.env.HERMES_API_URL ?? 'http://127.0.0.1:4300');
const LIVE_HARDCAP_USD = Number(process.env.LIVE_HARDCAP_USD ?? 10);

async function checkApiLiveSafety(): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${HERMES_API_URL}/api/live-safety`, { signal: controller.signal });
    clearTimeout(to);
    if (!res.ok) return { allowed: false, reason: `API safety check HTTP ${res.status}` };
    const snap = await res.json() as any;
    if (snap.status === 'DISABLED') return { allowed: false, reason: 'API live-safety reports DISABLED (flag=0)' };
    if (snap.halted) return { allowed: false, reason: `API live-safety HALTED: ${snap.haltReason}` };
    if (snap.status !== 'ACTIVE') return { allowed: false, reason: `API live-safety status=${snap.status}` };
    return { allowed: true };
  } catch (err) {
    return { allowed: false, reason: `API safety check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}


// ── Credentials ──────────────────────────────────────────────────────

export function readCoinbaseCredentials(mode: 'sync' | 'trade'): { apiKey: string; apiSecret: string } {
  const apiKey = mode === 'trade'
    ? readEnv(['COINBASE_TRADING_API_KEY', 'COINBASE_TRADE_API_KEY', 'HERMES_COINBASE_TRADING_API_KEY', 'COINBASE_API_KEY', 'CDP_API_KEY_NAME'])
    : readEnv(['COINBASE_API_KEY', 'CDP_API_KEY_NAME', 'COINBASE_TRADING_API_KEY', 'COINBASE_TRADE_API_KEY', 'HERMES_COINBASE_TRADING_API_KEY']);
  const apiSecret = mode === 'trade'
    ? readEnv(['COINBASE_TRADING_API_SECRET', 'COINBASE_TRADE_API_SECRET', 'HERMES_COINBASE_TRADING_API_SECRET', 'COINBASE_API_SECRET', 'CDP_API_KEY_PRIVATE'], true)
    : readEnv(['COINBASE_API_SECRET', 'CDP_API_KEY_PRIVATE', 'COINBASE_TRADING_API_SECRET', 'COINBASE_TRADE_API_SECRET', 'HERMES_COINBASE_TRADING_API_SECRET'], true);
  return { apiKey, apiSecret };
}

// ── JWT Auth ─────────────────────────────────────────────────────────

export function coinbaseHeaders(method: string, requestUrl: string, apiKey: string, apiSecret: string): Record<string, string> {
  return {
    Authorization: `Bearer ${buildCoinbaseJwt(method, requestUrl, apiKey, apiSecret)}`
  };
}

function buildCoinbaseJwt(method: string, requestUrl: string, apiKey: string, apiSecret: string): string {
  const key = createPrivateKey({ key: apiSecret, format: 'pem' });
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

function buildCoinbaseProductQuery(symbols: string[]): string {
  const query = new URLSearchParams();
  for (const symbol of symbols) {
    query.append('product_ids', symbol);
  }
  return query.toString();
}

// ── Sync ─────────────────────────────────────────────────────────────

export async function syncCoinbase(broker: VenueId): Promise<BrokerAccountSnapshot> {
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
  const status = errors.length > 0 ? 'degraded' : 'healthy';
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

// ── Route ────────────────────────────────────────────────────────────

export async function routeCoinbase(order: NormalizedOrder, riskCheck: RiskCheck, startedAt: number): Promise<BrokerRouteReport> {
  if (order.mode !== 'live' || !coinbaseLiveRoutingEnabled) {
    throw new Error('Coinbase live routing is disabled for non-live orders. Enable COINBASE_LIVE_ROUTING_ENABLED=1 only when explicitly approved.');
  }

  // ── Human-in-the-loop approval gate ───────────────────────────────
  const approval = validateLiveCanaryApproval(order.notional);
  if (!approval.allowed) {
    throw new Error(`[live-canary-approval] Order refused: ${approval.reason}`);
  }

  // ── Phase 4 belt-and-suspenders: API safety gate ─────────────────
  const safetyCheck = await checkApiLiveSafety();
  if (!safetyCheck.allowed) {
    throw new Error(`[live-safety broker] Order refused by API safety gate: ${safetyCheck.reason}`);
  }

  // ── Phase 4 hard notional cap at broker layer ─────────────────────
  if (order.notional > LIVE_HARDCAP_USD) {
    throw new Error(`[live-safety broker] Notional $${order.notional.toFixed(2)} exceeds broker-layer hardcap $${LIVE_HARDCAP_USD}`);
  }

  const { apiKey, apiSecret } = readCoinbaseCredentials('trade');
  if (!apiKey || !apiSecret) {
    throw new Error('Coinbase API key/secret are missing.');
  }

  const createUrl = `${coinbaseBaseUrl}/orders`;
  const payload: Record<string, unknown> = {
    client_order_id: order.clientOrderId,
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

// ── Cancel ───────────────────────────────────────────────────────────

export async function cancelCoinbaseOrder(orderId: string): Promise<{ ok: boolean; status: number; data: unknown }> {
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

// ── Position normalization ───────────────────────────────────────────

export function normalizeCoinbasePositions(accountsData: unknown, bookData: unknown): PositionSnapshot[] {
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
