// @ts-nocheck
/**
 * AI Council — Prompt building and decision key generation.
 * Extracted from ai-council.ts
 */

import type { AiTradeCandidate } from './ai-council.js';

export type CouncilRole = 'claude' | 'codex' | 'gemini';

export function buildPrompt(candidate: AiTradeCandidate, role: CouncilRole): string {
  const roleLine = role === 'claude'
    ? 'You are the primary trade reviewer for Hermes.'
    : role === 'codex'
      ? 'You are the skeptical challenger reviewer for Hermes.'
      : 'You are the tertiary long-context reviewer for Hermes.';

  const roleFocus = role === 'claude'
    ? 'Optimize for precision and after-cost expectancy.'
    : role === 'codex'
      ? 'Challenge brittle heuristics, fee leakage, and overfitting.'
      : 'Look for cross-asset, macro, and regime contradictions.';

  return [
    roleLine,
    roleFocus,
    'Return JSON only with this schema:',
    '{"action":"approve|reject|review","confidence":0-100,"thesis":"short string","riskNote":"short string"}',
    'No markdown. No code fences. No extra commentary.',
    'Approve only if the setup has a clear after-cost edge and no material vetoes.',
    'Reject if spread, slippage, liquidity, macro, news, or regime risk is poor.',
    'Use review when the evidence is mixed or the setup is under-specified.',
    'Treat fresh critical macro or symbol-specific news as a reason to reject or review rather than force a scalp.',
    JSON.stringify(candidate)
  ].join('\n');
}

export function makeCouncilDecisionKey(candidate: AiTradeCandidate): string {
  const scoreBucket = candidate.score >= 8 ? 'high' : candidate.score >= 5 ? 'mid' : 'low';
  const shortBucket = candidate.shortReturnPct >= 0.15 ? 'up' : candidate.shortReturnPct <= -0.15 ? 'down' : 'flat';
  const spreadBucket = candidate.spreadBps <= 2.5 ? 'tight' : candidate.spreadBps <= 4.5 ? 'normal' : 'wide';
  return [candidate.symbol, candidate.agentId, candidate.style, scoreBucket, shortBucket, spreadBucket].join(':');
}

export function truncateTranscript(text: string, limit = 8_000): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;
}
