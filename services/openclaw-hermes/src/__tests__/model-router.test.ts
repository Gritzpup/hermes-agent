/**
 * model-router.test.ts — Tier routing matrix, fall-up, escalate, rate limit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TIER,
  type PipelineStage,
  type Tier,
  routeAndCall,
  stageRouter,
  tierLabel,
} from '../model-router.js';
import * as ollamaClient from '../ollama-client.js';
import * as kimiClient from '../kimi-client.js';
import * as acpClient from '../acp-client.js';

vi.mock('../ollama-client.js', () => ({
  ollamaChat: vi.fn().mockResolvedValue('ollama-response'),
}));

vi.mock('../kimi-client.js', () => ({
  chatCompletion: vi.fn().mockResolvedValue('kimi-response'),
}));

vi.mock('../acp-client.js', () => ({
  askCooAcp: vi.fn().mockResolvedValue({ summary: 'test', actions: [] }),
}));

const ollamaChat = vi.mocked(ollamaClient.ollamaChat);
const chatCompletion = vi.mocked(kimiClient.chatCompletion);
const askCooAcp = vi.mocked(acpClient.askCooAcp);

const MESSAGES = [{ role: 'user' as const, content: 'hello' }];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Tier routing matrix ────────────────────────────────────────────────────────

describe('tier routing matrix', () => {
  const CASES: Array<{ stage: PipelineStage; expectedTier: Tier }> = [
    { stage: 'fast-path-check', expectedTier: TIER.MENIAL },
    { stage: 'sentiment',       expectedTier: TIER.MENIAL },
    { stage: 'arbiter',         expectedTier: TIER.MENIAL },
    { stage: 'analyst',        expectedTier: TIER.OPS },
    { stage: 'research',       expectedTier: TIER.OPS },
    { stage: 'trader',         expectedTier: TIER.OPS },
    { stage: 'risk',           expectedTier: TIER.OPS },
    { stage: 'portfolio',      expectedTier: TIER.CRITICAL },
  ];

  for (const { stage, expectedTier } of CASES) {
    it(`stage '${stage}' → Tier ${expectedTier}`, async () => {
      await routeAndCall({ stage }, MESSAGES);
      if (expectedTier === TIER.MENIAL) expect(ollamaChat).toHaveBeenCalled();
      else if (expectedTier === TIER.OPS) expect(chatCompletion).toHaveBeenCalled();
      else expect(askCooAcp).toHaveBeenCalled();
    });
  }
});

// ── Fall-up on low confidence ─────────────────────────────────────────────────

describe('fall-up on low confidence', () => {
  it('Tier-0 with confidence < 0.4 auto-escalates to Tier-1', async () => {
    const result = await routeAndCall({ stage: 'fast-path-check', confidence: 0.2 }, MESSAGES);
    // Should have gone to Tier-1 (Kimi) because confidence < 0.4
    expect(chatCompletion).toHaveBeenCalled();
    expect(ollamaChat).not.toHaveBeenCalled();
    expect(result.tier).toBe(TIER.OPS);
  });

  it('Tier-0 with confidence >= 0.4 stays at Tier-0', async () => {
    const result = await routeAndCall({ stage: 'fast-path-check', confidence: 0.6 }, MESSAGES);
    expect(ollamaChat).toHaveBeenCalled();
    expect(result.tier).toBe(TIER.MENIAL);
  });

  it('Tier-0 with confidence === 0.4 stays at Tier-0 (threshold is exclusive)', async () => {
    const result = await routeAndCall({ stage: 'fast-path-check', confidence: 0.4 }, MESSAGES);
    expect(ollamaChat).toHaveBeenCalled();
    expect(result.tier).toBe(TIER.MENIAL);
  });
});

// ── Escalate flag ─────────────────────────────────────────────────────────────

describe('escalate flag', () => {
  it('Tier-1 stage with escalate=true routes to Tier-2', async () => {
    const result = await routeAndCall({ stage: 'research', escalate: true }, MESSAGES);
    expect(askCooAcp).toHaveBeenCalled();
    expect(result.tier).toBe(TIER.CRITICAL);
  });

  it('Tier-1 stage without escalate stays at Tier-1', async () => {
    const result = await routeAndCall({ stage: 'research', escalate: false }, MESSAGES);
    expect(chatCompletion).toHaveBeenCalled();
    expect(result.tier).toBe(TIER.OPS);
  });

  it('Tier-1 stage without escalate flag stays at Tier-1', async () => {
    const result = await routeAndCall({ stage: 'analyst' }, MESSAGES);
    expect(chatCompletion).toHaveBeenCalled();
    expect(result.tier).toBe(TIER.OPS);
  });
});

// ── Force tier override ───────────────────────────────────────────────────────

describe('forceTier override', () => {
  it('forceTier=Tier-0 bypasses routing table', async () => {
    const result = await routeAndCall({ stage: 'portfolio', forceTier: TIER.MENIAL }, MESSAGES);
    expect(ollamaChat).toHaveBeenCalled();
    expect(result.tier).toBe(TIER.MENIAL);
  });

  it('forceTier=Tier-2 on analyst bypasses to critical', async () => {
    const result = await routeAndCall({ stage: 'analyst', forceTier: TIER.CRITICAL }, MESSAGES);
    expect(askCooAcp).toHaveBeenCalled();
    expect(result.tier).toBe(TIER.CRITICAL);
  });
});

// ── Rate limit enforcement ────────────────────────────────────────────────────

describe('rate limit enforcement', () => {
  it('Tier-0 enforces 10 calls/sec minimum interval', async () => {
    vi.useFakeTimers();

    // First call — no delay needed
    const p1 = routeAndCall({ stage: 'fast-path-check' }, MESSAGES);
    await vi.advanceTimersByTimeAsync(0);
    expect(ollamaChat).toHaveBeenCalledTimes(1);

    // Second call immediately — rate limiter should add delay (100ms)
    const p2 = routeAndCall({ stage: 'sentiment' }, MESSAGES);
    await vi.advanceTimersByTimeAsync(0); // not enough time yet
    // After advancing past the 100ms gate, second call proceeds
    await vi.advanceTimersByTimeAsync(110);
    expect(ollamaChat).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    await expect(p1).resolves.toBeTruthy();
    await expect(p2).resolves.toBeTruthy();
  });

  it('Tier-1 enforces 2 calls/sec minimum interval', async () => {
    vi.useFakeTimers();

    const p1 = routeAndCall({ stage: 'analyst' }, MESSAGES);
    await vi.advanceTimersByTimeAsync(0);
    expect(chatCompletion).toHaveBeenCalledTimes(1);

    const p2 = routeAndCall({ stage: 'analyst' }, MESSAGES);
    await vi.advanceTimersByTimeAsync(0); // not enough time yet (needs 500ms gap)
    await vi.advanceTimersByTimeAsync(510); // advance past the 500ms gate
    expect(chatCompletion).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    await expect(p1).resolves.toBeTruthy();
    await expect(p2).resolves.toBeTruthy();
  });
});

// ── tierLabel ────────────────────────────────────────────────────────────────

describe('tierLabel', () => {
  it('returns correct labels', () => {
    expect(tierLabel(TIER.MENIAL)).toBe('ollama');
    expect(tierLabel(TIER.OPS)).toBe('kimi');
    expect(tierLabel(TIER.CRITICAL)).toBe('opus');
  });
});

// ── stageRouter shortcuts ─────────────────────────────────────────────────────

describe('stageRouter', () => {
  it('analyst routes to Tier-1', async () => {
    await stageRouter.analyst(MESSAGES);
    expect(chatCompletion).toHaveBeenCalled();
  });

  it('portfolio routes to Tier-2', async () => {
    await stageRouter.portfolio(MESSAGES);
    expect(askCooAcp).toHaveBeenCalled();
  });

  it('sentiment routes to Tier-0', async () => {
    await stageRouter.sentiment(MESSAGES);
    expect(ollamaChat).toHaveBeenCalled();
  });
});
