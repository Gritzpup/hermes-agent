// @ts-nocheck
import type { RiskCheck, PositionSnapshot } from '@hermes/contracts';
import { isUsdCryptoSymbol, toAlpacaOrderSymbol, normalizeAlpacaSymbol } from './venue-symbols.js';
import type {
  VenueId,
  BrokerAccountSnapshot,
  BrokerRouteReport,
  NormalizedOrder
} from './broker-types.js';
import {
  readEnv,
  requestJson,
  sleep,
  normalizeArray,
  asRecord,
  textField,
  numberField,
  normalizeOrderStatus,
  collectFetchErrors,
  emptyBrokerSnapshot,
  extractErrorMessage,
  buildRouteReport
} from './broker-utils.js';

// ── Config ───────────────────────────────────────────────────────────

const alpacaPaperBaseUrl: string =
  (process.env.ALPACA_API_BASE_URL ?? 'https://paper-api.alpaca.markets').replace(/\/$/, '');

const alpacaOrderPollAttempts = Number(process.env.ALPACA_ORDER_POLL_ATTEMPTS ?? 6);
const alpacaOrderPollDelayMs = Number(process.env.ALPACA_ORDER_POLL_DELAY_MS ?? 300);

// ── Credentials ──────────────────────────────────────────────────────

function alpacaCredentials(): { keyId: string; secretKey: string } {
  const keyId = readEnv(['ALPACA_API_KEY_ID', 'ALPACA_PAPER_KEY', 'APCA_API_KEY_ID']);
  const secretKey = readEnv(['ALPACA_API_SECRET_KEY', 'ALPACA_PAPER_SECRET', 'APCA_API_SECRET_KEY']);
  return { keyId, secretKey };
}

// ── Sync ─────────────────────────────────────────────────────────────

export async function syncAlpaca(broker: VenueId): Promise<BrokerAccountSnapshot> {
  const { keyId, secretKey } = alpacaCredentials();
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
  const status = errors.length > 0 ? 'degraded' : 'healthy';
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

// ── Route ────────────────────────────────────────────────────────────

export async function routeAlpaca(order: NormalizedOrder, riskCheck: RiskCheck, startedAt: number): Promise<BrokerRouteReport> {
  const { keyId, secretKey } = alpacaCredentials();
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
    client_order_id: order.clientOrderId,
    symbol: venueSymbol,
    qty: order.quantity.toString(),
    side: order.side,
    type: order.orderType,
    time_in_force: timeInForce
  };
  if (order.orderType === 'limit' && typeof order.limitPrice === 'number') {
    payload.limit_price = order.limitPrice.toString();
  }

  // ── §4.1 LATENCY TRACKING: record submitAt just before HTTP POST to broker ──
  const submitAt = new Date().toISOString();

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
  }, startedAt, submitAt);
}

// ── Cancel ───────────────────────────────────────────────────────────

export async function cancelAlpacaOrder(orderId: string): Promise<{ ok: boolean; status: number; data: unknown }> {
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

// ── Position normalization ───────────────────────────────────────────

export function normalizeAlpacaPositions(positionsData: unknown[], broker: 'alpaca-paper'): PositionSnapshot[] {
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

// ── Poll order status ────────────────────────────────────────────────

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
        console.warn(`[broker-router] Alpaca rate limited on order ${orderId}, backing off`);
        await sleep(alpacaOrderPollDelayMs * Math.pow(2, attempt + 2));
        continue;
      }
    } catch (err) {
      console.warn(`[broker-router] Alpaca poll error for ${orderId} (attempt ${attempt + 1}):`, err);
    }

    if (attempt < alpacaOrderPollAttempts - 1) {
      await sleep(alpacaOrderPollDelayMs * Math.pow(2, attempt));
    }
  }

  return lastData;
}
