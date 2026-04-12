/**
 * Analytics Sub-Engine
 *
 * Pure computation functions for mistake profiling, adaptive tuning,
 * live readiness assessment, and forensics attribution.
 * Most functions have zero or minimal this. dependencies.
 */

import type { AgentFillEvent, TradeJournalEntry, BrokerId } from '@hermes/contracts';
import type {
  AgentState, AgentConfig, SymbolState, MistakeLearningProfile,
  PerformanceSummary, WalkForwardResult, TradeForensicsRow, BrokerPaperAccountState
} from './types.js';
import { round, average, clamp, pickLast } from '../paper-engine-utils.js';

/**
 * Build mistake profile for an agent based on recent trade outcomes.
 * PURE — zero this. references.
 */
export function buildMistakeProfile(
  recentOutcomes: number[],
  recentHoldTicks: number[],
  recentEntries: TradeJournalEntry[]
): MistakeLearningProfile {
  const outcomes = pickLast(recentOutcomes, 12);
  const holdTicks = pickLast(recentHoldTicks, 12);
  const winners = outcomes.filter((v) => v > 0);
  const losers = outcomes.filter((v) => v < 0);
  const sampleCount = outcomes.length;
  const winnerCount = winners.length;
  const loserCount = losers.length;

  if (sampleCount < 4) {
    return { sampleCount, winnerCount, loserCount, dominant: 'clean', severity: 0, summary: 'Insufficient data.', avgWinnerHoldTicks: 0, avgLoserHoldTicks: 0, avgWinnerSpreadBps: 0, avgLoserSpreadBps: 0, avgWinnerConfidencePct: 0, avgLoserConfidencePct: 0 };
  }

  const avgWinnerHold = winners.length > 0 ? average(holdTicks.filter((_, i) => outcomes[i]! > 0)) : 0;
  const avgLoserHold = losers.length > 0 ? average(holdTicks.filter((_, i) => (outcomes[i] ?? 0) < 0)) : 0;

  const winEntries = recentEntries.filter((e) => e.realizedPnl > 0);
  const loseEntries = recentEntries.filter((e) => e.realizedPnl < 0);
  const avgWinnerSpread = winEntries.length > 0 ? average(winEntries.map((e) => e.spreadBps ?? 0)) : 0;
  const avgLoserSpread = loseEntries.length > 0 ? average(loseEntries.map((e) => e.spreadBps ?? 0)) : 0;
  const avgWinnerConf = winEntries.length > 0 ? average(winEntries.map((e) => e.confidencePct ?? 50)) : 0;
  const avgLoserConf = loseEntries.length > 0 ? average(loseEntries.map((e) => e.confidencePct ?? 50)) : 0;

  // Classify dominant mistake
  let dominant: MistakeLearningProfile['dominant'] = 'clean';
  let severity = 0;

  if (avgLoserSpread > avgWinnerSpread * 1.5 && avgLoserSpread > 3) {
    dominant = 'spread-leakage';
    severity = round(avgLoserSpread - avgWinnerSpread, 1);
  } else if (avgLoserHold < avgWinnerHold * 0.4 && loserCount > winnerCount) {
    dominant = 'premature-exit';
    severity = round(avgWinnerHold - avgLoserHold, 1);
  } else if (avgLoserHold > avgWinnerHold * 2.5) {
    dominant = 'overstay';
    severity = round(avgLoserHold - avgWinnerHold, 1);
  } else if (avgLoserConf < 40 && loserCount > winnerCount * 1.5) {
    dominant = 'noise-chasing';
    severity = round(50 - avgLoserConf, 1);
  }

  const summary = dominant === 'clean'
    ? `Clean pattern across ${sampleCount} exits.`
    : `${dominant}: severity ${severity.toFixed(1)} (${winnerCount}W/${loserCount}L).`;

  return {
    sampleCount, winnerCount, loserCount, dominant, severity, summary,
    avgWinnerHoldTicks: round(avgWinnerHold, 1),
    avgLoserHoldTicks: round(avgLoserHold, 1),
    avgWinnerSpreadBps: round(avgWinnerSpread, 1),
    avgLoserSpreadBps: round(avgLoserSpread, 1),
    avgWinnerConfidencePct: round(avgWinnerConf, 1),
    avgLoserConfidencePct: round(avgLoserConf, 1)
  };
}

/**
 * Apply mistake-driven refinement to agent parameters.
 * PURE — zero this. references.
 */
export function applyMistakeDrivenRefinement(
  profile: MistakeLearningProfile,
  config: AgentConfig,
  improvementBias: AgentState['improvementBias']
): { bias: AgentState['improvementBias']; note: string } {
  if (profile.dominant === 'clean') {
    return { bias: 'hold-steady', note: 'No dominant mistake pattern.' };
  }

  let bias: AgentState['improvementBias'] = improvementBias;
  let note = '';

  switch (profile.dominant) {
    case 'spread-leakage':
      bias = 'tighten-risk';
      note = `Spread leakage: losers avg ${profile.avgLoserSpreadBps.toFixed(1)}bps vs winners ${profile.avgWinnerSpreadBps.toFixed(1)}bps. Tighten spread limit.`;
      break;
    case 'premature-exit':
      bias = 'press-edge';
      note = `Premature exits: losers hold ${profile.avgLoserHoldTicks.toFixed(0)} ticks vs winners ${profile.avgWinnerHoldTicks.toFixed(0)}. Widen stops.`;
      break;
    case 'overstay':
      bias = 'tighten-risk';
      note = `Overstay: losers hold ${profile.avgLoserHoldTicks.toFixed(0)} ticks vs winners ${profile.avgWinnerHoldTicks.toFixed(0)}. Reduce maxHoldTicks.`;
      break;
    case 'noise-chasing':
      bias = 'tighten-risk';
      note = `Noise-chasing: loser confidence avg ${profile.avgLoserConfidencePct.toFixed(0)}%. Raise entry quality floor.`;
      break;
    default:
      note = `${profile.dominant}: severity ${profile.severity.toFixed(1)}.`;
  }

  return { bias, note };
}

/**
 * Convert broker account data to paper account state.
 * PURE — zero this. references.
 */
export function toBrokerPaperAccountState(
  account: Record<string, unknown>,
  broker: BrokerId
): BrokerPaperAccountState {
  if (broker === 'coinbase-live') {
    const accounts = Array.isArray(account.accounts) ? account.accounts : [];
    const cash = round(accounts.reduce((sum: number, item: unknown) => {
      const record = typeof item === 'object' && item ? item as Record<string, unknown> : {};
      const currency = typeof record.currency === 'string' ? record.currency : '';
      if (currency !== 'USD' && currency !== 'USDC') return sum;
      const val = record.available_balance as Record<string, unknown> | undefined;
      return sum + (typeof val?.value === 'string' ? parseFloat(val.value) : 0);
    }, 0), 2);
    return { asOf: new Date().toISOString(), status: 'connected', cash, equity: cash, dayBaseline: cash, buyingPower: cash };
  }

  const equity = parseFloat(String(account.equity ?? account.NAV ?? account.balance ?? '0')) || 0;
  const cash = parseFloat(String(account.cash ?? account.balance ?? '0')) || 0;
  const buyingPower = parseFloat(String(account.buying_power ?? account.buyingPower ?? cash)) || cash;
  const dayBaseline = parseFloat(String(account.last_equity ?? account.initial_margin_requirement ?? equity)) || equity;

  return {
    asOf: new Date().toISOString(),
    status: 'connected',
    cash: round(cash, 2),
    equity: round(equity, 2),
    dayBaseline: round(dayBaseline, 2),
    buyingPower: round(buyingPower, 2)
  };
}
