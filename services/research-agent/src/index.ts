// @ts-nocheck
/**
 * Research Agent — per-lane specialist for symbol/market research.
 *
 * Responsibilities:
 * - Monitor tradable universe for new catalysts (news, on-chain, macro)
 * - Score symbols by fundamental/momentum conviction
 * - Publish candidate opportunities to Redis for the Strategy Director
 *
 * Listens on: TOPICS.REGIME_UPDATE, TOPICS.MARKET_TICK
 * Publishes to: TOPICS.REGIME_UPDATE
 */

import express from 'express';
import { redis, TOPICS } from '@hermes/infra';
import { bootstrapCollections } from './qdrant.js';
import { startMemoryScheduler, triggerWeeklySummary } from './memory.js';

const app = express();
const PORT = Number(process.env.RESEARCH_AGENT_PORT ?? 4310);
const logger = { info: (...a: any[]) => console.log(`[research-agent]`, ...a), error: (...a: any[]) => console.error(`[research-agent]`, ...a) };

// ── Redis subscriber for regime/market tick updates ─────────────────────────────
const sub = redis.duplicate();

sub.subscribe(TOPICS.REGIME_UPDATE, TOPICS.MARKET_TICK, (err: any) => {
  if (err) logger.error('subscribe error:', err);
});

sub.on('message', async (channel: string, message: string) => {
  try {
    const data = JSON.parse(message);
    if (channel === TOPICS.MARKET_TICK) {
      await handleMarketTick(data);
    } else if (channel === TOPICS.REGIME_UPDATE) {
      await handleRegimeUpdate(data);
    }
  } catch (err) {
    logger.error('message parse error:', err instanceof Error ? err.message : String(err));
  }
});

// ── Symbol research scoring ─────────────────────────────────────────────────────
interface SymbolScore {
  symbol: string;
  score: number;           // 0-100 conviction score
  catalystType: string;    // news|on-chain|macro|technical
  catalystDetail: string;
  updatedAt: string;
}

const symbolScores = new Map<string, SymbolScore>();

async function handleMarketTick(data: any): Promise<void> {
  const { prices } = data;
  if (!prices) return;

  for (const [symbol, info] of Object.entries(prices as Record<string, any>)) {
    const priceInfo = info as any;
    const prev = symbolScores.get(symbol);

    // Simple momentum scoring: 20-day return + spread quality
    const priceChange = priceInfo.changePct ?? 0;
    const spreadBps = priceInfo.spreadBps ?? 0;
    const score = Math.round(
      Math.min(100, Math.max(0,
        50 + (priceChange * 10) - (spreadBps * 0.5)
      ))
    );

    const updated: SymbolScore = {
      symbol,
      score,
      catalystType: 'technical',
      catalystDetail: `price=${priceInfo.price} changePct=${priceChange} spreadBps=${spreadBps}`,
      updatedAt: new Date().toISOString(),
    };

    // Only publish if score changed meaningfully
    if (!prev || Math.abs(updated.score - prev.score) >= 5) {
      symbolScores.set(symbol, updated);
      await redis.publish(TOPICS.REGIME_UPDATE, JSON.stringify({
        type: 'research-candidate',
        agent: 'research-agent',
        ...updated,
      }));
    }
  }
}

async function handleRegimeUpdate(data: any): Promise<void> {
  // Handle external regime update (e.g. from openclaw-hermes)
  logger.info('regime update received:', data);
}

// ── HTTP API ───────────────────────────────────────────────────────────────────
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: 'research-agent', scores: symbolScores.size });
});

app.get('/api/scores', (_req, res) => {
  res.json({ asOf: new Date().toISOString(), scores: Array.from(symbolScores.values()) });
});

// ── Memory agent endpoints ──────────────────────────────────────────────────────

/** Manually trigger weekly summaries for one strategy or all active strategies. */
app.post('/api/memory/weekly', async (req, res) => {
  try {
    const { strategyId } = req.body as { strategyId?: string };
    const summaries = await triggerWeeklySummary(strategyId);
    res.json({ ok: true, count: summaries.length, summaries });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'memory/weekly failed');
    res.status(500).json({ ok: false, error: msg });
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  await bootstrapCollections();
  startMemoryScheduler();
}

void bootstrap().catch((e) => logger.error({ e }, 'research-agent bootstrap failed'));

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Research Agent listening on port ${PORT}`);
});
