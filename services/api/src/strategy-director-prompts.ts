// @ts-nocheck
/**
 * Strategy Director — Prompt building and response parsing.
 * Extracted from strategy-director.ts for maintainability.
 */

import { getHistoricalContext } from './historical-context.js';
import type { MarketRegime } from './strategy-playbook.js';
import type { PlaybookApplication } from './strategy-director.js';

/**
 * Build the full prompt sent to Claude / Gemini for the strategy director cycle.
 */
export function buildDirectorPrompt(
  ctx: Record<string, unknown>,
  regime: MarketRegime,
  playbookApplications: PlaybookApplication[]
): string {
  const playbookSummary = playbookApplications.length > 0
    ? `PLAYBOOK SWITCHES ALREADY APPLIED THIS CYCLE:\n${playbookApplications.map((p) =>
        `  - ${p.agentId}: switched to template '${p.templateName}' (${p.regime}) — ${p.reason}`
      ).join('\n')}`
    : 'PLAYBOOK: No template switches this cycle (regime unchanged or params already aligned).';

  const lines = [
    'You are the Strategy Director for Hermes Trading Firm — a multi-asset paper trading system.',
    'You review the portfolio every 30 minutes. The Strategy Playbook has already been applied (see below).',
    'Your job is to make INCREMENTAL FINE-TUNING adjustments on top of the playbook, based on news and performance.',
    '',
    `DETECTED FIRM-WIDE REGIME: ${regime.toUpperCase()}`,
    '',
    playbookSummary,
    '',
    'REGIME GUIDANCE:',
    regime === 'compression'
      ? 'COMPRESSION ACTIVE: BTC momentum is near zero, flat short-term returns. Agents have been switched to mean-reversion / grid templates with smaller size and extended cooldowns. Do NOT suggest momentum or breakout strategies. Suggest going to near-zero size if scores remain near zero.'
      : regime === 'trending-up'
      ? 'TRENDING UP: Momentum is the correct approach. Agents have been switched to dual-momentum templates. Increase sizeFraction for agents with high win rates. Use wider targets.'
      : regime === 'trending-down'
      ? 'TRENDING DOWN: Be defensive. Agents are in reduced-size mean-reversion mode. Suggest reducing size further if vol is increasing.'
      : regime === 'volatile'
      ? 'VOLATILE: Wide stops, small size, mean-reversion at extremes only. Do not suggest momentum.'
      : regime === 'panic'
      ? 'PANIC: Survival mode. Suggest halt or near-zero size across all agents. No new entries.'
      : regime === 'news-driven'
      ? 'NEWS-DRIVEN: Embargo may be active. Suggest extended cooldowns and reduced size until news resolves.'
      : 'UNKNOWN REGIME: Be conservative. Suggest reducing size and waiting for clearer signals.',
    '',
    'CURRENT PORTFOLIO:',
    JSON.stringify(ctx.agents, null, 2),
    '',
    'AGENT CONFIGS (after playbook application):',
    JSON.stringify(ctx.configs, null, 2),
    '',
    `FIRM: equity=$${ctx.firmEquity} trades=${ctx.totalTrades} winRate=${ctx.winRate}% pnl=$${ctx.realizedPnl}`,
    '',
    'RECENT TRADES (last 10):',
    JSON.stringify(ctx.recentJournal, null, 2),
    '',
    'MACRO ECONOMIC CONTEXT (FRED + Fear/Greed history):',
    getHistoricalContext().getSnapshot().summary,
    '',
    'TECHNICAL INDICATORS (from MarketIntel composite signals):',
    JSON.stringify(
      ((ctx.market as Record<string, unknown>)?.compositeSignal as Array<Record<string, unknown>> ?? [])
        .slice(0, 8)
        .map((s) => ({
          symbol: s.symbol,
          direction: s.direction,
          confidence: s.confidence,
          rsi2: s.rsi2 ?? 'n/a',
          stochastic: s.stochastic ?? 'n/a',
          obiWeighted: s.obiWeighted ?? 'n/a',
          reasons: ((s.reasons as string[]) ?? []).slice(0, 3),
        })),
      null, 2
    ),
    '',
    'NEWS & INSIDER RADAR:',
    JSON.stringify(ctx.news, null, 2),
    '',
    'LOSS CLUSTERS (top 3):',
    JSON.stringify((ctx.lossClusters as Record<string, unknown>)?.lossClusters ? ((ctx.lossClusters as Record<string, unknown>).lossClusters as unknown[]).slice(0, 3) : [], null, 2),
    '',
    'FORWARD SIMULATION (bootstrap Monte Carlo — 500 scenarios):',
    JSON.stringify(ctx.forwardSimulation, null, 2),
    '',
    'RULES:',
    '- The playbook already switched styles. Do NOT re-apply style changes — only fine-tune targetBps/stopBps/sizeFraction/cooldownTicks/spreadLimitBps.',
    '- Max 20% change per parameter per cycle.',
    '- Be conservative. Small improvements compound.',
    '- If a metric is near zero and the agent is in compression, reduce sizeFraction to 0.01-0.02 to park it.',
    '- If something is working, leave it alone.',
    '- Only add symbols you believe have edge given the current regime.',
    '- Alpaca supports: crypto (BTC-USD,ETH-USD,SOL-USD,XRP-USD) + US stocks (SPY,QQQ,NVDA,AAPL,TSLA,MSFT,AMZN,VIXY)',
    '- OANDA supports: forex (EUR_USD,GBP_USD,USD_JPY,AUD_USD) + indices (SPX500_USD,NAS100_USD) + bonds (USB10Y_USD,USB30Y_USD) + commodities (XAU_USD,XAG_USD,BCO_USD,WTICO_USD)',
    '- TECHNICAL INDICATORS: RSI(2) < 10 = extreme oversold (high-prob bounce), > 90 = extreme overbought. Stochastic K/D crossover confirms entries. Weighted OBI > 0.3 = strong bid pressure. Use these to validate or override regime assumptions.',
    '- If RSI(2) is extreme on multiple assets, the regime detection may be lagging — flag it in reasoning.',
    '- Half-Kelly sizing is active: agents dynamically size based on rolling 30-trade win rate. Do NOT set sizeFraction below 0.01 unless halting.',
    '- INSIDER TRADING / COPY SLEEVE: Use "insiderSignals" to identify high-conviction moves. The "convictionReason" (derived by AI) explains the significance.',
    '  - If a signal is BULLISH and "convictionScore" > 0.7, add/update the "Shadow-Insider-Bot" agent to copy that symbol with significantly higher sizeFactor.',
    '  - If "convictionReason" mentions "Tax Sell" or "Routine", ignore the signal.',
    '  - If a BEARISH cluster is detected with "convictionScore" > 0.8, suggest a "defensive" riskPosture and downsize trend-following longs.',
    '  - WEIGHT: Heavily prioritize the AI-generated "convictionReason" over raw volume.',
    '',
    'Return ONLY valid JSON with this schema:',
    '{',
    '  "symbolChanges": [{"action":"add|remove|watch","symbol":"string","broker":"alpaca-paper|oanda-rest","assetClass":"string","reason":"string"}],',
    '  "agentAdjustments": [{"agentId":"string","field":"targetBps|stopBps|maxHoldTicks|cooldownTicks|sizeFraction|spreadLimitBps","newValue":number,"reason":"string"}],',
    '  "allocationShifts": [{"assetClass":"string","newMultiplier":number,"reason":"string"}],',
    '  "riskPosture": {"posture":"aggressive|normal|defensive|halt","reason":"string"},',
    '  "reasoning": "overall analysis summary"',
    '}',
    'No markdown. No code fences. JSON only.'
  ];
  return lines.join('\n');
}

/**
 * Parse the raw AI response string into a structured JSON object.
 */
export function parseDirectorResponse(raw: string): Record<string, unknown> {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in Claude response');
  }
  return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
}
