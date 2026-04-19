// @ts-nocheck
import type { RiskCheck } from '@hermes/contracts';
import type {
  VenueId,
  BrokerAccountSnapshot,
  BrokerRouteReport,
  NormalizedOrder
} from './broker-types.js';
import {
  readEnv,
  requestJson,
  normalizeArray,
  asRecord,
  textField,
  numberField,
  collectFetchErrors,
  emptyBrokerSnapshot,
  extractErrorMessage,
  buildRouteReport,
  trimTrailingSlash
} from './broker-utils.js';

// ── Config ───────────────────────────────────────────────────────────

const oandaBaseUrlRaw: string =
  trimTrailingSlash(process.env.OANDA_API_BASE_URL ?? 'https://api-fxpractice.oanda.com/v3');

const oandaBaseUrl: string =
  oandaBaseUrlRaw.endsWith('/v3') ? oandaBaseUrlRaw.slice(0, -3) : oandaBaseUrlRaw;

const oandaApiKey: string = readEnv(['OANDA_API_KEY', 'OANDA_TOKEN']);
const oandaAccountId: string = readEnv(['OANDA_ACCOUNT_ID', 'OANDA_ACCOUNT']);

// ── Sync ─────────────────────────────────────────────────────────────

export async function syncOanda(broker: VenueId): Promise<BrokerAccountSnapshot> {
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
  const status = errors.length > 0 ? 'degraded' : 'healthy';
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

// ── Route ────────────────────────────────────────────────────────────

export async function routeOanda(order: NormalizedOrder, riskCheck: RiskCheck, startedAt: number): Promise<BrokerRouteReport> {
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

  // ── §4.1 LATENCY TRACKING: record submitAt just before HTTP POST to broker ──
  const submitAt = new Date().toISOString();

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
  }, startedAt, submitAt);
}
