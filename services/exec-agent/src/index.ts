// @ts-nocheck
/**
 * Exec Agent — per-lane specialist for execution quality and fill analytics.
 *
 * Responsibilities:
 * - Monitor fill quality: slippage, latency, rejection rates per broker/symbol
 * - Track execution quality metrics and publish alerts
 * - Maintain per-broker fill statistics for the Strategy Director
 *
 * Listens on: TOPICS.ORDER_STATUS, TOPICS.MARKET_TICK
 * Publishes to: TOPICS.ORDER_STATUS (exec quality reports)
 */

import express from 'express';
import { redis, TOPICS } from '@hermes/infra';

const app = express();
const PORT = Number(process.env.EXEC_AGENT_PORT ?? 4312);
const logger = { info: (...a: any[]) => console.log(`[exec-agent]`, ...a), error: (...a: any[]) => console.error(`[exec-agent]`, ...a) };

// ── Execution quality metrics ──────────────────────────────────────────────────
interface BrokerMetrics {
  fills: number;
  rejections: number;
  totalSlippageBps: number;
  avgLatencyMs: number;
  lastUpdate: string;
}

const brokerMetrics = new Map<string, BrokerMetrics>();

function getMetrics(broker: string): BrokerMetrics {
  if (!brokerMetrics.has(broker)) {
    brokerMetrics.set(broker, { fills: 0, rejections: 0, totalSlippageBps: 0, avgLatencyMs: 0, lastUpdate: '' });
  }
  return brokerMetrics.get(broker)!;
}

// ── Redis subscriber ──────────────────────────────────────────────────────────
const sub = redis.duplicate();
sub.subscribe(TOPICS.ORDER_STATUS, (err: any) => {
  if (err) logger.error('subscribe error:', err);
});

sub.on('message', async (_channel: string, message: string) => {
  try {
    const data = JSON.parse(message);
    await handleOrderStatus(data);
  } catch (err) {
    logger.error('message parse error:', err instanceof Error ? err.message : String(err));
  }
});

async function handleOrderStatus(data: any): Promise<void> {
  const broker = data.broker ?? 'unknown';
  const m = getMetrics(broker);

  if (data.status === 'filled') {
    m.fills += 1;
    m.totalSlippageBps += data.slippageBps ?? 0;
    m.avgLatencyMs = m.avgLatencyMs === 0
      ? (data.latencyMs ?? 0)
      : m.avgLatencyMs * 0.9 + (data.latencyMs ?? 0) * 0.1;
    m.lastUpdate = new Date().toISOString();

    // Alert if slippage exceeds 15 bps
    if ((data.slippageBps ?? 0) > 15) {
      await redis.publish(TOPICS.ORDER_STATUS, JSON.stringify({
        type: 'exec-quality-alert',
        agent: 'exec-agent',
        broker,
        symbol: data.symbol,
        slippageBps: data.slippageBps,
        latencyMs: data.latencyMs,
        avgLatencyMs: m.avgLatencyMs,
        timestamp: new Date().toISOString(),
      }));
    }
  } else if (data.status === 'rejected') {
    m.rejections += 1;
    m.lastUpdate = new Date().toISOString();
  }

  brokerMetrics.set(broker, m);
}

// ── HTTP API ───────────────────────────────────────────────────────────────────
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: 'exec-agent', brokers: brokerMetrics.size });
});

app.get('/api/metrics', (_req, res) => {
  const result: Record<string, BrokerMetrics> = {};
  for (const [broker, m] of brokerMetrics.entries()) {
    result[broker] = {
      ...m,
      avgSlippageBps: m.fills > 0 ? m.totalSlippageBps / m.fills : 0,
    };
  }
  res.json({ asOf: new Date().toISOString(), brokers: result });
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Exec Agent listening on port ${PORT}`);
});
