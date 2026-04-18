// @ts-nocheck
/**
 * AI Council — Prompt building and decision key generation.
 * Extracted from ai-council.ts
 * 
 * IMPROVEMENTS v2:
 * - Added regime-aware instructions
 * - Added win-rate optimization guidance  
 * - Added symbol-specific heuristics from journal analysis
 * - Added cost-of-carry awareness for crypto
 */

import type { AiTradeCandidate } from './ai-council.js';

export type CouncilRole = 'claude' | 'codex' | 'gemini' | 'ollama';

// Symbol-specific performance data from journal analysis
// Win rates: XRP-USD (74%), ETH-USD (61%), SOL-USD (70%), BTC-USD (47%)
const SYMBOL_PERFORMANCE: Record<string, { winRate: number; pnl: number; trades: number; notes: string }> = {
  'XRP-USD': { winRate: 74, pnl: 166.05, trades: 78, notes: 'STAR PERFORMER - be more aggressive approving' },
  'ETH-USD': { winRate: 61, pnl: 31.24, trades: 320, notes: 'GOOD - maintain current standards' },
  'SOL-USD': { winRate: 70, pnl: 3.50, trades: 10, notes: 'PROMISING - need more data, use ETH-like standards' },
  'BTC-USD': { winRate: 47, pnl: -1105.92, trades: 470, notes: 'KILLING US - be EXTRA skeptical, reject borderline' },
};

function getSymbolGuidance(symbol: string): string {
  const perf = SYMBOL_PERFORMANCE[symbol];
  if (!perf) return '';
  return `\n\nSYMBOL CONTEXT: ${symbol} has ${perf.winRate}% win rate across ${perf.trades} trades. ${perf.notes}.`;
}

export function buildPrompt(candidate: AiTradeCandidate, role: CouncilRole): string {
  const roleLine = role === 'claude'
    ? 'You are the primary trade reviewer for Hermes.'
    : role === 'codex'
      ? 'You are the skeptical challenger reviewer for Hermes.'
      : 'You are the tertiary long-context reviewer for Hermes.';

  const roleFocus = role === 'claude'
    ? 'Optimize for precision and after-cost expectancy. Our goal is >55% win rate after costs.'
    : role === 'codex'
      ? 'Challenge brittle heuristics, fee leakage, and overfitting. Be the circuit breaker on bad trades.'
      : 'Look for cross-asset, macro, and regime contradictions. Find the edge cases the others miss.';

  const symbolGuidance = getSymbolGuidance(candidate.symbol);

  const regimeInstructions = `
\nREGIME-SPECIFIC RULES:
- panic: Require >65% confidence AND net edge >10bps. Reject all but highest conviction.
- trend: Allow entries with >55% confidence. Trend is your friend.
- compression: Reject unless RSI(2) < 10 or > 90 AND strong direction signal. No chop-chop.
- normal: Standard approval criteria apply.`;

  const winRateGuidance = `
\nWIN RATE OPTIMIZATION:
- Default to 'review' if confidence < 60%. Only 'approve' if strong setup.
- Default to 'reject' for BTC-USD unless confidence > 75% AND spread < 2bps.
- Approve XRP-USD more readily — it has 74% historical win rate.
- Reject if expected edge < 4bps after estimated costs (spread + slippage).
- Always 'reject' if risk/reward < 1.5:1 or expected loss > 2x expected gain.`;

  const cryptoGuidance = candidate.assetClass === 'crypto' ? `
\nCRYPTO-SPECIFIC:
- Check funding rates: High funding (>0.03%/8h) = shorts paying = bearish pressure
- Block entries if funding rate disagrees with direction
- In extreme fear (F&G < 20): Allow RSI(2) < 10 longs ONLY with Bollinger squeeze confirmation
- Watch for liquidity sweeps: Price spikes to stop levels then reverses = rejection signal` : '';

  return [
    roleLine,
    roleFocus,
    symbolGuidance,
    regimeInstructions,
    winRateGuidance,
    cryptoGuidance,
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
