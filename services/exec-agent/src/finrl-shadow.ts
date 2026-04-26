/**
 * FinRL-X shadow logger.
 *
 * Wraps finrl-inference. When a rule-based decision is made, this module
 * logs the proposed RL action alongside the rule-based action to Redis with
 * TTL 14 days. Execution stays with the rule-based path.
 *
 * The 14-day shadow log feeds Phase 5's backtest before any live promotion.
 */

import { redis } from "@hermes/infra";

// ── ULID generation (no external dep) ─────────────────────────────────────────
// ULID: 10-char timestamp ( Crockford Base32 ) + 16 random chars = 26 total.

const _ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function _encodeTime(nowMs: number): string {
  let t = Math.floor(nowMs / 1000);
  const chars: string[] = [];
  for (let i = 9; i >= 0; i--) {
    const idx = t % 32;
    chars[i] = _ULID_CHARS[idx] ?? "0";
    t = Math.floor(t / 32);
  }
  return chars.join("");
}

function _randomPart(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => _ULID_CHARS[b % 32] ?? "0")
    .join("");
}

function ulid(): string {
  return _encodeTime(Date.now()) + _randomPart();
}

const SHADOW_KEY_PREFIX = "hermes:finrl:shadow:";
const SHADOW_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days

export interface ShadowDecision {
  /** ULID for this decision */
  id: string;
  symbol: string;
  /** Unix ms timestamp */
  ts: number;
  /** RL edge score from FinRL-X (0–1) */
  recommendedEdgeScore: number | null;
  /** Rule-based action taken (e.g. "market_buy", "hold") */
  ruleBasedAction: string;
  /** Symbol price at decision time */
  price: number;
  /** Order-book imbalance */
  bookImb: number;
  /** Position at decision time */
  position: number;
  /** Cash at decision time */
  cash: number;
  /** Whether the shadow logger fired (finrl-shadow=on) */
  shadowEnabled: boolean;
  /** Whether FinRL-X server was reachable */
  finrlServerUp: boolean;
}

// ── Record ─────────────────────────────────────────────────────────────────────

/**
 * Record a shadow decision asynchronously (fire-and-forget).
 * Does NOT block the rule-based execution path.
 */
export async function recordShadowDecision(
  decision: Omit<ShadowDecision, "id" | "ts">,
): Promise<void> {
  if (!isShadowEnabled()) return;

  const id = ulid();
  const ts = Date.now();
  const key = `${SHADOW_KEY_PREFIX}${id}`;

  const record: ShadowDecision = {
    id,
    ts,
    ...decision,
  };

  try {
    await redis.setex(key, SHADOW_TTL_SECONDS, JSON.stringify(record));
    console.info(
      `[finrl-shadow] logged ${id} symbol=${decision.symbol} rule=${decision.ruleBasedAction} edge=${decision.recommendedEdgeScore}`,
    );
  } catch (err) {
    // Fire-and-forget: never block the main path
    console.warn(`[finrl-shadow] Redis write failed for ${id}:`, err instanceof Error ? err.message : String(err));
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

/** Whether shadow logging is active (HERMES_FINRL_SHADOW=on). */
export function isShadowEnabled(): boolean {
  return process.env.HERMES_FINRL_SHADOW?.toLowerCase() === "on";
}

// ── Query (for backtest / analysis) ─────────────────────────────────────────

/**
 * Fetch recent shadow decisions for a symbol (last N entries).
 */
export async function getRecentShadowDecisions(
  symbol: string,
  limit = 100,
): Promise<ShadowDecision[]> {
  const pattern = `${SHADOW_KEY_PREFIX}*`;
  const decisions: ShadowDecision[] = [];
  let cursor = "0";

  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100,
    );
    cursor = nextCursor;

    for (const key of keys) {
      if (decisions.length >= limit) break;
      const raw = await redis.get(key);
      if (!raw) continue;
      try {
        const record = JSON.parse(raw) as ShadowDecision;
        if (record.symbol === symbol) {
          decisions.push(record);
        }
      } catch {
        // Corrupt entry — skip
      }
    }
  } while (cursor !== "0" && decisions.length < limit);

  return decisions.sort((a, b) => a.ts - b.ts);
}
