/**
 * 3-Tier Model Router — services/openclaw-hermes/src/model-router.ts
 *
 * Extends the Phase 1 model-router with a 3-tier routing system:
 *
 *   Tier 0 (menial)  — Ollama (Qwen 2.5, Llama, DeepSeek)
 *   Tier 1 (ops)     — Kimi via direct OpenAI-compat HTTP
 *   Tier 2 (critical)— Opus via ACP (Agent Client Protocol)
 *
 * Routing table:
 *   stage             | tier | client
 *   ------------------|------|---------------
 *   fast-path-check   |  0   | ollama-client
 *   sentiment         |  0   | ollama-client
 *   arbiter           |  0   | ollama-client  (with confidence escalation)
 *   analyst           |  1   | kimi-client
 *   research          |  1   | kimi-client   (initial pass; escalate=true → tier 2)
 *   trader            |  1   | kimi-client
 *   risk              |  1   | kimi-client
 *   portfolio         |  2   | acp-client
 *
 * Fall-up policy:
 *   - Tier 0 confidence < 0.4 → auto-escalate to Tier 1
 *   - Tier 1 escalate=true    → route to Tier 2 for next call
 *
 * Rate limits (token bucket):
 *   - Tier 0: 10/sec  (ollama-client.ts manages its own 5/sec gate)
 *   - Tier 1:  2/sec  (kimi-client.ts manages its own 2/sec gate)
 *   - Tier 2: 0.5/sec (ACP managed per-session; we add a global 2s floor)
 *
 * All callers (slow-path, pipeline) migrate to routeAndCall() — not direct
 * kimi-client calls.
 *
 * MiniMax: NOT a runtime tier in firm v2.0. Config constants are preserved
 * in config.ts for backward compat only.
 */

import { logger } from '@hermes/logger';
import { ollamaChat, type OllamaMessage } from './ollama-client.js';
import { chatCompletion } from './kimi-client.js';
import { askCooAcp } from './acp-client.js';
import type { CooResponse } from './openclaw-client.js';

// ── Tier definitions ───────────────────────────────────────────────────────────

export const TIER = {
  MENIAL:    0,
  OPS:       1,
  CRITICAL:  2,
} as const;

export type Tier = typeof TIER[keyof typeof TIER];

// ── Route intent ───────────────────────────────────────────────────────────────

export type PipelineStage =
  | 'analyst'
  | 'research'
  | 'trader'
  | 'risk'
  | 'portfolio'
  | 'fast-path-check'
  | 'sentiment'
  | 'arbiter';

export interface RouteIntent {
  /** Pipeline or operation stage */
  stage: PipelineStage;
  /** Confidence score from a prior tier result (0–1); fall-up triggers below this */
  confidence?: number;
  /** Set by Tier-1 stage to request Tier-2 for the next call */
  escalate?: boolean;
  /** Optional override — bypass routing table, use specified tier directly */
  forceTier?: Tier;
}

// ── Routing table ──────────────────────────────────────────────────────────────

const STAGE_TIER_MAP: Record<PipelineStage, Tier> = {
  'fast-path-check': TIER.MENIAL,
  'sentiment':       TIER.MENIAL,
  'arbiter':         TIER.MENIAL,
  'analyst':         TIER.OPS,
  'research':        TIER.OPS,
  'trader':          TIER.OPS,
  'risk':            TIER.OPS,
  'portfolio':       TIER.CRITICAL,
};

// Confidence threshold below which Tier-0 results trigger auto-escalation
const FALLUP_CONFIDENCE_THRESHOLD = 0.4;

// ── Rate limiter — global guard per tier ──────────────────────────────────────
// These complement (not replace) the per-client rate limiters already in
// ollama-client.ts and kimi-client.ts.

class TierRateLimiter {
  private lastCall = 0;
  private readonly minIntervalMs: number;

  constructor(callsPerSec: number) {
    this.minIntervalMs = Math.ceil(1000 / callsPerSec);
  }

  async gate(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCall;
    if (elapsed < this.minIntervalMs) {
      await new Promise(r => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastCall = Date.now();
  }
}

const tierLimiters: Record<Tier, TierRateLimiter> = {
  [TIER.MENIAL]:    new TierRateLimiter(10),  // 10 calls/sec global
  [TIER.OPS]:       new TierRateLimiter(2),   // 2 calls/sec global
  [TIER.CRITICAL]:  new TierRateLimiter(0.5), // 0.5 calls/sec global
};

// ── Stage → tier resolution ───────────────────────────────────────────────────

function resolveTier(intent: RouteIntent): Tier {
  if (intent.forceTier !== undefined) return intent.forceTier;

  const baseTier = STAGE_TIER_MAP[intent.stage] ?? TIER.OPS;

  // Tier-0 fall-up: confidence below threshold escalates to Tier 1
  if (baseTier === TIER.MENIAL && intent.confidence !== undefined && intent.confidence < FALLUP_CONFIDENCE_THRESHOLD) {
    logger.info(
      { stage: intent.stage, confidence: intent.confidence, threshold: FALLUP_CONFIDENCE_THRESHOLD },
      'model-router: Tier-0 confidence below threshold — fall-up to Tier-1',
    );
    return TIER.OPS;
  }

  // Tier-1 escalate flag routes to Tier 2
  if (baseTier === TIER.OPS && intent.escalate === true) {
    logger.info({ stage: intent.stage }, 'model-router: escalate=true — routing to Tier-2');
    return TIER.CRITICAL;
  }

  return baseTier;
}

// ── Tier → client dispatch ─────────────────────────────────────────────────────

interface TierResult {
  text: string | null;
  /** Estimated confidence 0–1; null if unable to estimate */
  confidence: number | null;
  tier: Tier;
  stage: PipelineStage;
}

async function callTier0(
  messages: OllamaMessage[],
  stage: PipelineStage,
  opts?: { temperature?: number; maxTokens?: number },
): Promise<TierResult> {
  await tierLimiters[TIER.MENIAL].gate();

  const start = Date.now();
  const text = await ollamaChat({
    messages,
    temperature: opts?.temperature ?? 0.3,
    max_tokens: opts?.maxTokens ?? 2048,
  });
  const elapsed = Date.now() - start;

  if (text === null) {
    logger.warn({ stage, elapsed }, 'model-router: Tier-0 returned null');
    return { text: null, confidence: null, tier: TIER.MENIAL, stage };
  }

  // Estimate confidence heuristically: lower temperature + faster response
  // suggests higher confidence. A real implementation would parse a structured
  // confidence field from the model output.
  const temp = opts?.temperature ?? 0.3;
  const conf = text.length > 50 ? Math.min(0.95, 0.5 + (temp < 0.5 ? 0.3 : 0)) : 0.3;

  logger.info({ stage, elapsed, textLen: text.length, conf }, 'model-router: Tier-0 succeeded');
  return { text, confidence: conf, tier: TIER.MENIAL, stage };
}

async function callTier1(
  messages: OllamaMessage[],
  stage: PipelineStage,
  opts?: { temperature?: number; maxTokens?: number },
): Promise<TierResult> {
  await tierLimiters[TIER.OPS].gate();

  const start = Date.now();
  const text = await chatCompletion(messages);
  const elapsed = Date.now() - start;

  if (text === null) {
    logger.warn({ stage, elapsed }, 'model-router: Tier-1 returned null');
    return { text: null, confidence: null, tier: TIER.OPS, stage };
  }

  logger.info({ stage, elapsed, textLen: text.length }, 'model-router: Tier-1 succeeded');
  // Tier-1 (Kimi) gets a higher base confidence than Tier-0
  return { text, confidence: 0.8, tier: TIER.OPS, stage };
}

async function callTier2(
  messages: OllamaMessage[],
  stage: PipelineStage,
  opts?: { temperature?: number; maxTokens?: number },
): Promise<TierResult> {
  void opts; // ACP ignores temperature/maxTokens — governed by session config
  await tierLimiters[TIER.CRITICAL].gate();

  const start = Date.now();
  // askCooAcp takes events[] + rollingContext; we pass the messages as one event
  const resp: CooResponse | null = await askCooAcp(messages as unknown[], {});

  // ACP returns CooResponse; extract the JSON text
  let text: string | null = null;
  if (resp) {
    // askCooAcp returns a parsed CooResponse; serialize it back to a prompt string
    // for downstream consumers that expect plain text.
    text = JSON.stringify(resp);
  }

  const elapsed = Date.now() - start;

  if (text === null) {
    logger.warn({ stage, elapsed }, 'model-router: Tier-2 returned null');
    return { text: null, confidence: null, tier: TIER.CRITICAL, stage };
  }

  logger.info({ stage, elapsed, textLen: text.length }, 'model-router: Tier-2 succeeded');
  // Tier-2 (Opus) has the highest confidence
  return { text, confidence: 0.95, tier: TIER.CRITICAL, stage };
}

// ── Public: route + call ───────────────────────────────────────────────────────

export interface RouteAndCallOptions {
  temperature?: number;
  maxTokens?: number;
  /** Override the stage-to-tier mapping */
  forceTier?: Tier;
  /** Fall-up even when confidence >= threshold (for explicit re-runs) */
  forceEscalate?: boolean;
}

/**
 * Main entry point for all LLM calls in the bridge.
 *
 * Routes `intent.stage` → tier → client, applies fall-up policy, returns text.
 *
 * Migrating callers:
 *   Before: chatCompletion(messages)
 *   After:  (await routeAndCall({ stage: 'analyst' }, messages)).text
 */
export async function routeAndCall(
  intent: RouteIntent,
  messages: OllamaMessage[],
  opts: RouteAndCallOptions = {},
): Promise<TierResult> {
  const effectiveIntent: RouteIntent = {
    ...intent,
    escalate: intent.escalate === true || opts.forceEscalate === true ? true : false,
    ...(opts.forceTier !== undefined ? { forceTier: opts.forceTier } : {}),
  };

  const tier = resolveTier(effectiveIntent);
  logger.info({ stage: intent.stage, tier, confidence: intent.confidence, escalate: effectiveIntent.escalate }, 'model-router: routing');

  const callOpts = {
    temperature: opts.temperature ?? 0.3,
    maxTokens: opts.maxTokens ?? 4096,
  };

  switch (tier) {
    case TIER.MENIAL:
      return callTier0(messages, intent.stage, callOpts);
    case TIER.OPS:
      return callTier1(messages, intent.stage, callOpts);
    case TIER.CRITICAL:
      return callTier2(messages, intent.stage, callOpts);
  }
}

/**
 * Convenience: route a single stage without managing confidence/escalate.
 * Use this for one-shot calls where the caller doesn't need TierResult.
 */
export async function route(
  stage: PipelineStage,
  messages: OllamaMessage[],
  opts?: RouteAndCallOptions,
): Promise<string | null> {
  const result = await routeAndCall({ stage }, messages, opts);
  return result.text;
}

// ── Backward-compatible router object ───────────────────────────────────────
// openclaw-client.ts uses router.minimax() — keep same API for zero-regression.
// MiniMax: NOT a runtime tier in firm v2.0. This alias falls through to Kimi (ops tier).
// @deprecated Use stageRouter or routeAndCall() directly instead.

export const router = {
  fast:      (msgs: OllamaMessage[], o?: Omit<RouteAndCallOptions, 'forceTier'>) => route('fast-path-check', msgs, o),
  reasoning: (msgs: OllamaMessage[], o?: Omit<RouteAndCallOptions, 'forceTier'>) => route('arbiter', msgs, o),
  heavy:     (msgs: OllamaMessage[], o?: Omit<RouteAndCallOptions, 'forceTier'>) => route('analyst', msgs, o),
  minimax:  async (msgs: OllamaMessage[], o?: Omit<RouteAndCallOptions, 'forceTier'>) => {
    logger.warn('router.minimax: MiniMax is NOT a runtime tier in firm v2.0. Routing to Tier-1 (Kimi).');
    return route('analyst', msgs, o);
  },
  raw: routeAndCall,
};

// ── Convenience shortcuts per stage ───────────────────────────────────────────

export const stageRouter = {
  analyst:       (msgs: OllamaMessage[], o?: RouteAndCallOptions) => route('analyst', msgs, o),
  research:      (msgs: OllamaMessage[], o?: RouteAndCallOptions) => route('research', msgs, o),
  trader:        (msgs: OllamaMessage[], o?: RouteAndCallOptions) => route('trader', msgs, o),
  risk:          (msgs: OllamaMessage[], o?: RouteAndCallOptions) => route('risk', msgs, o),
  portfolio:     (msgs: OllamaMessage[], o?: RouteAndCallOptions) => route('portfolio', msgs, o),
  sentiment:     (msgs: OllamaMessage[], o?: RouteAndCallOptions) => route('sentiment', msgs, o),
  fastPathCheck: (msgs: OllamaMessage[], o?: RouteAndCallOptions) => route('fast-path-check', msgs, o),
  arbiter:       (msgs: OllamaMessage[], o?: RouteAndCallOptions) => route('arbiter', msgs, o),
};

// ── Tier summary (for health / debugging) ─────────────────────────────────────

export function tierLabel(tier: Tier): string {
  return [TIER.MENIAL, TIER.OPS, TIER.CRITICAL].indexOf(tier) === 0
    ? 'ollama'
    : tier === TIER.OPS
    ? 'kimi'
    : 'opus';
}
