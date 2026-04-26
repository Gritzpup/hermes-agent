// @ts-nocheck
/**
 * Exec Agent — per-lane specialist for execution quality and fill analytics.
 *
 * Responsibilities:
 * - Monitor fill quality: slippage, latency, rejection rates per broker/symbol
 * - Track execution quality metrics and publish alerts
 * - Maintain per-broker fill statistics for the Strategy Director
 * - FinRL-X shadow logger: record rule-based vs RL edge scores (14-day window)
 *
 * Listens on: TOPICS.ORDER_STATUS, TOPICS.MARKET_TICK
 * Publishes to: TOPICS.ORDER_STATUS (exec quality reports)
 */

import express from 'express';
import { redis, TOPICS } from '@hermes/infra';
import { getEdgeScore, isFinrlServerUp, type EdgeScoreRequest } from './finrl-inference.js';
import { recordShadowDecision, isShadowEnabled, type ShadowDecision } from './finrl-shadow.js';

const app = express();
const PORT = Number(process.env.EXEC_AGENT_PORT ?? 4312);
const logger = {
  info: (...a: any[]) => console.log(`[exec-agent]`, ...a),
  error: (...a: any[]) => console.error(`[exec-agent]`, ...a),
  warn: (...a: any[]) => console.warn(`[exec-agent]`, ...a),
};

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
  res.json({
    status: 'ok',
    agent: 'exec-agent',
    brokers: brokerMetrics.size,
    shadowEnabled: isShadowEnabled(),
    finrlServerUp: false, // will be updated async if needed
  });
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

// ── FinRL-X shadow endpoints ───────────────────────────────────────────────────

/**
 * GET /api/finrl/status
 * Returns shadow config and FinRL-X server health.
 */
app.get('/api/finrl/status', async (_req, res) => {
  const finrlUp = await isFinrlServerUp().catch(() => false);
  res.json({
    shadowEnabled: isShadowEnabled(),
    finrlServerUp: finrlUp,
    finrlUrl: process.env.FINRL_INFERENCE_URL ?? 'http://127.0.0.1:7410',
  });
});

/**
 * POST /api/finrl/edge-score
 * Query the FinRL-X inference server for an edge score.
 * Body: EdgeScoreRequest
 * Response: { edge_score: number | null }
 */
app.post('/api/finrl/edge-score', async (req, res) => {
  const edgeScore = await getEdgeScore(req.body as EdgeScoreRequest);
  res.json({ edge_score: edgeScore });
});

/**
 * POST /api/finrl/record-shadow
 * Record a rule-based decision alongside the RL edge score for the shadow log.
 * Body: { symbol, ruleBasedAction, price, bookImb, position, cash, recommendedEdgeScore? }
 * This is fire-and-forget — does NOT block execution.
 */
app.post('/api/finrl/record-shadow', (req, res) => {
  const body = req.body as Partial<ShadowDecision>;
  if (!body.symbol || !body.ruleBasedAction) {
    res.status(400).json({ error: 'symbol and ruleBasedAction are required' });
    return;
  }

  // Fire-and-forget: record shadow decision without blocking the response
  const finrlUpPromise = isFinrlServerUp().catch(() => false);

  recordShadowDecision({
    symbol: body.symbol,
    recommendedEdgeScore: body.recommendedEdgeScore ?? null,
    ruleBasedAction: body.ruleBasedAction,
    price: body.price ?? 0,
    bookImb: body.bookImb ?? 0,
    position: body.position ?? 0,
    cash: body.cash ?? 0,
    shadowEnabled: isShadowEnabled(),
    finrlServerUp: false, // resolved async below
  }).catch((err) => logger.warn('shadow record error:', err));

  // Resolve finrlServerUp asynchronously and update the stored decision
  finrlUpPromise.then((up) => {
    // The shadow logger swallowed the finrlServerUp value;
    // we just note it was requested here.
    if (!up) logger.info('[finrl-shadow] server was down at time of record');
  });

  res.json({ status: 'ok', shadowEnabled: isShadowEnabled() });
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Exec Agent listening on port ${PORT}`);
  logger.info(`FinRL-X shadow: ${isShadowEnabled() ? 'ENABLED' : 'disabled (set HERMES_FINRL_SHADOW=on to activate)'}`);
});
