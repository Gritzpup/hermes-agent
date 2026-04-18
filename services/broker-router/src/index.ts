// @ts-nocheck
import './load-env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { redis, TOPICS } from '@hermes/infra';
import { logger } from '@hermes/logger';
import { prisma } from '@hermes/contracts';
import type { OrderIntent, RiskCheck } from '@hermes/contracts';

import type { VenueId, BrokerRouteReport, NormalizedOrder } from './broker-types.js';
import {
  requestJson,
  textField,
  numberField,
  booleanField,
  extractErrorMessage,
  buildRouteReport
} from './broker-utils.js';
import { initState, getState, recordReport, startSyncLoop, maybeRefreshSnapshots, syncVenue } from './state.js';
import { routeAlpaca, cancelAlpacaOrder } from './alpaca-handler.js';
import { routeCoinbase, cancelCoinbaseOrder } from './coinbase-handler.js';
export { startFeeTierMonitor, stopFeeTierMonitor, getCurrentCoinbaseFeeTier, isMakerStrategiesBlocked, getTimeSinceLastFetch, type CoinbaseFeeTier } from './coinbase-fee-tier.js';
import { routeOanda } from './oanda-handler.js';

// ── Bootstrap ────────────────────────────────────────────────────────

const app = express();
const port = Number(process.env.PORT ?? 4303);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(moduleDir, '..');
const runtimeDir = path.join(serviceRoot, '.runtime');
const riskEngineUrl = process.env.RISK_ENGINE_URL ?? 'http://127.0.0.1:4301/evaluate';
const syncIntervalMs = Number(process.env.BROKER_SYNC_INTERVAL_MS ?? 5_000);

fs.mkdirSync(runtimeDir, { recursive: true });

const runtimeState = initState({
  statePath: path.join(runtimeDir, 'state.json'),
  reportsPath: path.join(runtimeDir, 'reports.jsonl'),
  syncIntervalMs
});

// ── Idempotency dedupe: client_order_id → cached BrokerRouteReport ─────
const MAX_CACHED_SUBMISSIONS = 10_000;
const submittedClientOrderIds = new Set<string>();
const submissionLog: string[] = [];           // FIFO eviction queue
const clientOrderIdCache = new Map<string, BrokerRouteReport>();

/**
 * Deterministic client order id: SHA-1 of intent + 1-second timestamp bucket.
 * Rounded to first 20 hex chars — matches broker `client_order_id` field limits.
 */
export function generateClientOrderId(
  agentId: string,
  symbol: string,
  side: string,
  notional: number,
  quantity: number
): string {
  const bucket = Math.floor(Date.now() / 1000).toString();
  const raw = `${agentId}|${symbol}|${side}|${notional}|${quantity}|${bucket}`;
  return createHash('sha1').update(raw).digest('hex').substring(0, 20);
}

/**
 * Returns a cached report if `clientOrderId` was already submitted this second,
 * otherwise registers it and returns null so the caller proceeds normally.
 */
export function dedupeClientOrderId(clientOrderId: string): BrokerRouteReport | null {
  if (submittedClientOrderIds.has(clientOrderId)) {
    const cached = clientOrderIdCache.get(clientOrderId);
    if (cached) return cached;
  }
  // Register: evict oldest if at capacity
  if (submittedClientOrderIds.size >= MAX_CACHED_SUBMISSIONS) {
    const oldest = submissionLog.shift();
    if (oldest) {
      submittedClientOrderIds.delete(oldest);
      clientOrderIdCache.delete(oldest);
    }
  }
  submittedClientOrderIds.add(clientOrderId);
  submissionLog.push(clientOrderId);
  return null;
}

/**
 * Cache a successful BrokerRouteReport keyed by its clientOrderId.
 * Call this after a successful route so future duplicates get the cached report.
 */
export function cacheSubmissionReport(clientOrderId: string, report: BrokerRouteReport): void {
  clientOrderIdCache.set(clientOrderId, report);
}

// ── Redis HFT subscription ──────────────────────────────────────────

const subscriber = redis.duplicate();
subscriber.subscribe(TOPICS.ORDER_REQUEST, (err) => {
  if (err) logger.error({ err }, 'Broker Router failed to subscribe to order requests');
});

subscriber.on('message', async (channel, message) => {
  if (channel === TOPICS.ORDER_REQUEST) {
    try {
      const order = JSON.parse(message) as OrderIntent;
      logger.info({ order }, 'HFT Order Received via Redis');
      await handleRedisOrder(order);
    } catch (err) {
      logger.error({ err }, 'Failed to process Redis order request');
    }
  }
});

// ── Express middleware ───────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ── Routes ──────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  const brokers = Object.values(runtimeState.brokers);
  const healthyCount = brokers.filter((s) => s.status === 'healthy').length;
  const degradedCount = brokers.filter((s) => s.status === 'degraded').length;
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
      id: randomUUID(), orderId: 'invalid-order', broker: 'alpaca-paper',
      symbol: 'unknown', status: 'rejected', filledQty: 0, avgFillPrice: 0,
      slippageBps: 0, latencyMs: Date.now() - startedAt,
      message: 'Invalid order payload.', timestamp: new Date().toISOString()
    });
    return;
  }

  try {
    const riskCheck = await fetchRiskCheck(order);
    if (!riskCheck.allowed) {
      const report = buildRouteReport(order, {
        status: 'rejected', filledQty: 0, avgFillPrice: 0, slippageBps: 0,
        message: riskCheck.reason, riskCheck, eventSource: 'route',
        details: 'Risk engine blocked the order before broker submission.',
        errors: [], accountSnapshot: null, positionsSnapshot: [], fillsSnapshot: [], ordersSnapshot: []
      }, startedAt);
      recordReport(report);
      await syncVenue(order.broker, 'post-risk-block');
      res.status(400).json(report);
      return;
    }

    const report = await routeOrder(order, riskCheck, startedAt);
    recordReport(report);
    await syncVenue(order.broker, 'post-route');
    res.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown route failure';
    const report = buildRouteReport(order, {
      status: 'rejected', filledQty: 0, avgFillPrice: 0, slippageBps: 0, message,
      riskCheck: null, eventSource: 'route',
      details: 'Broker route failed before an execution report could be produced.',
      errors: [message], accountSnapshot: null, positionsSnapshot: [], fillsSnapshot: [], ordersSnapshot: []
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
    const ok = result.ok;
    const message = ok ? 'Cancel submitted.' : extractErrorMessage(result.data, 'Cancel request failed.');
    recordReport(buildCancelReport(broker, orderId, symbol, ok ? 'canceled' : 'rejected', message, startedAt, ok ? [] : [message], [result.data]));
    res.status(ok ? 200 : 502).json({
      ok, broker, orderId, symbol, status: ok ? 'canceled' : 'rejected',
      message, timestamp: new Date().toISOString(), raw: result.data
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'cancel request failed';
    recordReport(buildCancelReport(broker, orderId, symbol, 'rejected', message, startedAt, [message], []));
    res.status(502).json({
      ok: false, broker, orderId, symbol, status: 'rejected',
      message, timestamp: new Date().toISOString()
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
    positions: brokers.flatMap((s) => s.positions),
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

// ── HFT Redis order handler ─────────────────────────────────────────

async function handleRedisOrder(rawOrder: any): Promise<void> {
  const startedAt = Date.now();
  const order = normalizeOrder(rawOrder);
  if (!order) return;

  try {
    await prisma.orderEvent.create({
      data: {
        id: order.id, timestamp: new Date(), symbol: order.symbol,
        type: order.orderType, side: order.side, status: 'submitted',
        quantity: order.quantity, broker: order.broker, agentId: order.strategy
      }
    });

    const riskCheck = await fetchRiskCheck(order);
    if (!riskCheck.allowed) {
      const report = buildRouteReport(order, {
        status: 'rejected', filledQty: 0, avgFillPrice: 0, slippageBps: 0,
        message: riskCheck.reason, riskCheck, eventSource: 'route',
        details: 'Risk engine blocked the order via Redis path.',
        errors: [], accountSnapshot: null, positionsSnapshot: [], fillsSnapshot: [], ordersSnapshot: []
      }, startedAt);
      await finalizeOrderReport(report);
      return;
    }

    const report = await routeOrder(order, riskCheck, startedAt);
    await finalizeOrderReport(report);
  } catch (err) {
    logger.error({ err, orderId: order.id }, 'HFT Order Processing Error');
  }
}

async function finalizeOrderReport(report: BrokerRouteReport): Promise<void> {
  redis.publish(TOPICS.ORDER_STATUS, JSON.stringify(report)).catch(err => {
    logger.error({ err }, 'Failed to publish order report to Redis');
  });

  await prisma.orderEvent.upsert({
    where: { id: report.id },
    update: { status: report.status, externalId: report.orderId, price: report.avgFillPrice, quantity: report.filledQty },
    create: {
      id: report.id, timestamp: new Date(), symbol: report.symbol, type: 'market',
      side: 'buy', status: report.status, quantity: report.filledQty,
      broker: report.broker, agentId: 'unknown'
    }
  }).catch(err => {
    logger.error({ err }, 'Failed to update order event in database');
  });

  recordReport(report);
}

// ── Shared routing dispatch ─────────────────────────────────────────

async function routeOrder(order: NormalizedOrder, riskCheck: RiskCheck, startedAt: number): Promise<BrokerRouteReport> {
  // ── Idempotency gate ──────────────────────────────────────────────
  const duplicate = dedupeClientOrderId(order.clientOrderId);
  if (duplicate) {
    return {
      ...duplicate,
      latencyMs: Date.now() - startedAt,
      message: `[dedupe] client_order_id=${order.clientOrderId} already submitted — returning cached response.`,
      details: duplicate.details,
      errors: [...duplicate.errors, 'duplicate-submission-suppressed'],
    };
  }

  const report = await doRouteOrder(order, riskCheck, startedAt);
  cacheSubmissionReport(order.clientOrderId, report);
  return report;
}

async function doRouteOrder(order: NormalizedOrder, riskCheck: RiskCheck, startedAt: number): Promise<BrokerRouteReport> {
  return order.broker === 'alpaca-paper'
    ? routeAlpaca(order, riskCheck, startedAt)
    : order.broker === 'coinbase-live'
      ? routeCoinbase(order, riskCheck, startedAt)
      : routeOanda(order, riskCheck, startedAt);
}

// ── Order normalization / risk ──────────────────────────────────────

function normalizeOrder(input: Partial<OrderIntent>): NormalizedOrder | null {
  const id = textField(input, ['id']) ?? randomUUID();
  const agentId = textField(input, ['strategy']) ?? 'unknown';
  const symbol = textField(input, ['symbol']);
  const side = textField(input, ['side']) as 'buy' | 'sell' | null;
  const quantity = numberField(input, ['quantity']) ?? 0;
  const notional = numberField(input, ['notional']) ?? quantity;
  // Deterministic client_order_id: prevents retry storms from placing duplicate real orders
  const clientOrderId = generateClientOrderId(
    agentId,
    symbol ?? '',
    side ?? '',
    notional,
    quantity
  );
  const broker = textField(input, ['broker']) as VenueId | null;
  const orderType = textField(input, ['orderType']) as 'market' | 'limit' | null;
  const strategy = textField(input, ['strategy']) ?? 'unknown';
  const mode = textField(input, ['mode']) as 'paper' | 'live' | null;
  const thesis = textField(input, ['thesis']) ?? '';
  const limitPrice = numberField(input, ['limitPrice']);
  const timeInForce = textField(input, ['timeInForce']) as 'day' | 'gtc' | 'ioc' | 'fok' | null;
  const postOnly = booleanField(input, ['postOnly']);

  if (!symbol || !broker || !side || !orderType || !mode || quantity <= 0 || notional <= 0) return null;
  if (broker !== 'alpaca-paper' && broker !== 'coinbase-live' && broker !== 'oanda-rest') return null;

  return {
    id, clientOrderId, symbol, broker, side, orderType, notional, quantity,
    limitPrice: limitPrice ?? undefined, timeInForce: timeInForce ?? undefined,
    postOnly: postOnly ?? undefined, strategy, mode, thesis
  };
}

async function fetchRiskCheck(order: NormalizedOrder): Promise<RiskCheck> {
  try {
    const response = await requestJson(riskEngineUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: order.id, symbol: order.symbol, broker: order.broker, side: order.side,
        orderType: order.orderType, notional: order.notional, quantity: order.quantity,
        limitPrice: order.limitPrice, strategy: order.strategy, mode: order.mode, thesis: order.thesis
      })
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
    maxNotional: order.notional, maxDailyLoss: 0, killSwitchArmed: !allowed
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseBrokerFilter(value: unknown): VenueId | null {
  const text = typeof value === 'string' ? value : Array.isArray(value) ? value[0] : '';
  if (text === 'alpaca-paper' || text === 'coinbase-live' || text === 'oanda-rest') return text;
  return null;
}

function buildCancelReport(
  broker: VenueId, orderId: string, symbol: string,
  status: 'canceled' | 'rejected', message: string,
  startedAt: number, errors: string[], ordersSnapshot: unknown[]
): BrokerRouteReport {
  return {
    id: randomUUID(), orderId, broker, brokerMode: broker,
    venue: broker === 'alpaca-paper' ? 'alpaca' : broker === 'coinbase-live' ? 'coinbase' : 'oanda',
    symbol, status, filledQty: 0, avgFillPrice: 0, slippageBps: 0,
    latencyMs: Date.now() - startedAt, message, timestamp: new Date().toISOString(),
    mode: broker === 'alpaca-paper' ? 'paper' : 'live',
    source: 'broker', riskCheck: null, eventSource: 'route',
    details: status === 'canceled' ? 'Cancel request submitted through broker-router.' : 'Cancel request failed inside broker-router.',
    errors, accountSnapshot: null, positionsSnapshot: [], fillsSnapshot: [], ordersSnapshot
  };
}
