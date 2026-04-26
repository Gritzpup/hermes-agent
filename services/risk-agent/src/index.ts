// @ts-nocheck
/**
 * Risk Agent — per-lane specialist for real-time risk monitoring.
 *
 * Responsibilities:
 * - Subscribe to order events and compute real-time risk metrics
 * - Monitor position-level risk (VaR, drawdown, exposure limits)
 * - Publish risk alerts to Redis for the Strategy Director / COO
 *
 * Listens on: TOPICS.ORDER_STATUS, TOPICS.ORDER_REQUEST
 * Publishes to: TOPICS.RISK_SIGNAL
 */

import express from 'express';
import { redis, TOPICS } from '@hermes/infra';

const app = express();
const PORT = Number(process.env.RISK_AGENT_PORT ?? 4311);
const logger = { info: (...a: any[]) => console.log(`[risk-agent]`, ...a), error: (...a: any[]) => console.error(`[risk-agent]`, ...a) };

// ── In-memory risk state ────────────────────────────────────────────────────────
interface RiskState {
  totalDailyLoss: number;
  maxDailyLoss: number;
  openPositions: number;
  totalNotional: number;
  blockedSymbols: Set<string>;
}

const riskState: RiskState = {
  totalDailyLoss: 0,
  maxDailyLoss: Number(process.env.RISK_MAX_DAILY_LOSS ?? 5000),
  openPositions: 0,
  totalNotional: 0,
  blockedSymbols: new Set(),
};

// ── Redis subscriber ──────────────────────────────────────────────────────────
const sub = redis.duplicate();
sub.subscribe(TOPICS.ORDER_STATUS, TOPICS.ORDER_REQUEST, TOPICS.RISK_SIGNAL, (err: any) => {
  if (err) logger.error('subscribe error:', err);
});

sub.on('message', async (channel: string, message: string) => {
  try {
    const data = JSON.parse(message);
    if (channel === TOPICS.ORDER_STATUS) {
      await handleOrderStatus(data);
    } else if (channel === TOPICS.ORDER_REQUEST) {
      await handleOrderRequest(data);
    } else if (channel === TOPICS.RISK_SIGNAL) {
      await handleConcentrationEvent(data);
    }
  } catch (err) {
    logger.error('message parse error:', err instanceof Error ? err.message : String(err));
  }
});

async function handleOrderStatus(data: any): Promise<void> {
  if (data.status === 'filled' && data.filledQty > 0) {
    riskState.openPositions += 1;
    riskState.totalNotional += (data.avgFillPrice ?? 0) * data.filledQty;
  }
  if (data.status === 'filled' && data.pnl !== undefined) {
    riskState.totalDailyLoss += data.pnl;
    if (riskState.totalDailyLoss <= -riskState.maxDailyLoss) {
      // Circuit breaker: signal halt
      await redis.publish(TOPICS.RISK_SIGNAL, JSON.stringify({
        type: 'circuit-breaker',
        agent: 'risk-agent',
        reason: 'daily-loss-limit-reached',
        totalDailyLoss: riskState.totalDailyLoss,
        maxDailyLoss: riskState.maxDailyLoss,
        timestamp: new Date().toISOString(),
      }));
    }
  }
}

async function handleOrderRequest(data: any): Promise<void> {
  // Pre-trade risk check
  const symbol = data.symbol ?? '';
  if (riskState.blockedSymbols.has(symbol)) {
    await redis.publish(TOPICS.RISK_SIGNAL, JSON.stringify({
      type: 'pre-trade-blocked',
      agent: 'risk-agent',
      symbol,
      reason: 'symbol-blocked',
      timestamp: new Date().toISOString(),
    }));
  }
}

async function handleConcentrationEvent(data: any): Promise<void> {
  // Propagate concentration halt events to RISK_SIGNAL for COO / downstream consumers
  if (data.type === 'concentration-halt') {
    riskState.blockedSymbols.add(data.symbol);
    await redis.publish(TOPICS.RISK_SIGNAL, JSON.stringify({
      type: 'concentration-halt',
      agent: 'risk-agent',
      symbol: data.symbol,
      share: data.share,
      totalNotional: data.totalNotional,
      reason: data.reason,
      timestamp: new Date().toISOString(),
    }));
    logger.info(`[concentration] halted ${data.symbol} at ${data.share}% — propagated to RISK_SIGNAL`);
  }
}

// ── HTTP API ───────────────────────────────────────────────────────────────────
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    agent: 'risk-agent',
    totalDailyLoss: riskState.totalDailyLoss,
    maxDailyLoss: riskState.maxDailyLoss,
    openPositions: riskState.openPositions,
    totalNotional: riskState.totalNotional,
    blockedSymbols: Array.from(riskState.blockedSymbols),
  });
});

app.post('/api/block-symbol', express.json(), (req, res) => {
  const { symbol, reason } = req.body as { symbol: string; reason?: string };
  if (!symbol) { res.status(400).json({ error: 'symbol required' }); return; }
  riskState.blockedSymbols.add(symbol);
  logger.info(`Blocked symbol ${symbol}: ${reason ?? 'no reason'}`);
  res.json({ ok: true, blocked: symbol });
});

app.post('/api/unblock-symbol', express.json(), (req, res) => {
  const { symbol } = req.body as { symbol: string };
  if (!symbol) { res.status(400).json({ error: 'symbol required' }); return; }
  riskState.blockedSymbols.delete(symbol);
  logger.info(`Unblocked symbol ${symbol}`);
  res.json({ ok: true, unblocked: symbol });
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Risk Agent listening on port ${PORT}`);
});
