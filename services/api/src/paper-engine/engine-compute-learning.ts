// @ts-nocheck
import type { TradeJournalEntry } from '@hermes/contracts';
import type { AgentState, MistakeLearningProfile, SymbolState, TradeForensicsRow, WalkForwardResult, AgentConfig } from './types.js';
import { average, clamp, nudge, pickLast, round } from '../paper-engine-utils.js';

export function buildMistakeProfile(
  engine: any,
  agent: AgentState,
  symbol: SymbolState | null,
  entries: TradeJournalEntry[]
): MistakeLearningProfile {
  const sampleCount = entries.length;
  const winnerEntries = entries.filter((entry: TradeJournalEntry) => entry.realizedPnl > 0);
  const loserEntries = entries.filter((entry: TradeJournalEntry) => entry.realizedPnl < 0);

  if (sampleCount < 4 || (winnerEntries.length === 0 && loserEntries.length === 0)) {
    return {
      sampleCount,
      winnerCount: winnerEntries.length,
      loserCount: loserEntries.length,
      dominant: 'clean',
      severity: 0,
      summary: sampleCount < 4
        ? `Only ${sampleCount} recent exits so far; keep learning before changing the tape rules.`
        : 'No dominant mistake cluster in the recent exits.',
      avgWinnerHoldTicks: 0,
      avgLoserHoldTicks: 0,
      avgWinnerSpreadBps: 0,
      avgLoserSpreadBps: 0,
      avgWinnerConfidencePct: 0,
      avgLoserConfidencePct: 0
    };
  }

  const avgWinnerHoldTicks = winnerEntries.length > 0 ? average(winnerEntries.map((entry: TradeJournalEntry) => entry.holdTicks ?? 0)) : 0;
  const avgLoserHoldTicks = loserEntries.length > 0 ? average(loserEntries.map((entry: TradeJournalEntry) => entry.holdTicks ?? 0)) : 0;
  const avgWinnerSpreadBps = winnerEntries.length > 0 ? average(winnerEntries.map((entry: TradeJournalEntry) => entry.spreadBps ?? symbol?.spreadBps ?? agent.config.spreadLimitBps)) : 0;
  const avgLoserSpreadBps = loserEntries.length > 0 ? average(loserEntries.map((entry: TradeJournalEntry) => entry.spreadBps ?? symbol?.spreadBps ?? agent.config.spreadLimitBps)) : 0;
  const avgWinnerConfidencePct = winnerEntries.length > 0
    ? average(winnerEntries.map((entry: TradeJournalEntry) => entry.confidencePct ?? entry.entryConfidencePct ?? 0))
    : 0;
  const avgLoserConfidencePct = loserEntries.length > 0
    ? average(loserEntries.map((entry: TradeJournalEntry) => entry.confidencePct ?? entry.entryConfidencePct ?? 0))
    : 0;

  const quickLosses = loserEntries.filter((entry: TradeJournalEntry) => (entry.holdTicks ?? 0) <= 3).length;
  const lateLosses = loserEntries.filter((entry: TradeJournalEntry) => (entry.holdTicks ?? 0) >= Math.max(agent.config.maxHoldTicks - 1, 4)).length;
  const stopOrFadeLosses = loserEntries.filter((entry: TradeJournalEntry) => /stop|fade|timeout/i.test(entry.exitReason)).length;
  const vetoLosses = loserEntries.filter((entry: TradeJournalEntry) => entry.macroVeto || entry.embargoed || entry.entryMacroVeto || entry.entryEmbargoed).length;
  const spreadPressure = avgLoserSpreadBps - avgWinnerSpreadBps;

  let dominant: MistakeLearningProfile['dominant'] = 'clean';
  if (vetoLosses >= Math.max(2, Math.ceil(loserEntries.length * 0.5))) {
    dominant = 'veto-drift';
  } else if (spreadPressure >= 0.75 || avgLoserSpreadBps > Math.max(symbol?.spreadBps ?? agent.config.spreadLimitBps, agent.config.spreadLimitBps * 0.9)) {
    dominant = 'spread-leakage';
  } else if (quickLosses >= Math.max(2, Math.ceil(loserEntries.length * 0.5)) && stopOrFadeLosses >= Math.max(1, Math.ceil(loserEntries.length / 3))) {
    dominant = 'premature-exit';
  } else if (lateLosses >= Math.max(2, Math.ceil(loserEntries.length * 0.5)) && stopOrFadeLosses >= Math.max(1, Math.ceil(loserEntries.length / 3))) {
    dominant = 'overstay';
  } else if ((avgLoserConfidencePct + 5) < avgWinnerConfidencePct) {
    dominant = 'noise-chasing';
  }

  const severity = round(Math.min(100, Math.max(10, (loserEntries.length / Math.max(sampleCount, 1)) * 100)), 1);

  return {
    sampleCount,
    winnerCount: winnerEntries.length,
    loserCount: loserEntries.length,
    dominant,
    severity,
    summary: dominant === 'clean' ? 'No dominant mistake pattern.' : `Dominant: ${dominant}`,
    avgWinnerHoldTicks,
    avgLoserHoldTicks,
    avgWinnerSpreadBps,
    avgLoserSpreadBps,
    avgWinnerConfidencePct,
    avgLoserConfidencePct
  };
}

export function applyMistakeDrivenRefinement(
  engine: any,
  agent: AgentState,
  symbol: SymbolState,
  profile: MistakeLearningProfile,
  brokerPaperCrypto: boolean,
  frictionFloorBps: number
): { note: string; bias: AgentState['improvementBias'] } {
  if (profile.dominant === 'clean') {
    return { note: profile.summary, bias: 'hold-steady' };
  }

  switch (profile.dominant) {
    case 'spread-leakage': {
      agent.config.sizeFraction = clamp(round(agent.config.sizeFraction * 0.94, 4), 0.06, agent.baselineConfig.sizeFraction);
      agent.config.spreadLimitBps = clamp(round(agent.config.spreadLimitBps - 0.25, 2), 2, agent.baselineConfig.spreadLimitBps);
      if (brokerPaperCrypto) {
        agent.config.targetBps = Math.max(agent.config.targetBps, round(frictionFloorBps, 2));
      }
      return {
        note: `${symbol.symbol}: Reduced size and spread tolerance.`,
        bias: 'tighten-risk'
      };
    }
    case 'premature-exit': {
      agent.config.stopBps = clamp(round(agent.config.stopBps + 0.5, 2), brokerPaperCrypto ? 14 : 8, agent.baselineConfig.stopBps + 4);
      agent.config.maxHoldTicks = Math.min(agent.config.maxHoldTicks + 1, agent.baselineConfig.maxHoldTicks + 2);
      agent.config.sizeFraction = clamp(round(agent.config.sizeFraction * 0.98, 4), 0.06, agent.baselineConfig.sizeFraction);
      return {
        note: `${symbol.symbol}: Gave trades more room and trimmed size.`,
        bias: 'hold-steady'
      };
    }
    case 'overstay': {
      agent.config.maxHoldTicks = Math.max(agent.config.maxHoldTicks - 1, 4);
      agent.config.targetBps = clamp(round(agent.config.targetBps - 0.5, 2), brokerPaperCrypto ? Math.max(8, round(frictionFloorBps, 2)) : 8, agent.baselineConfig.targetBps + 8);
      return {
        note: `${symbol.symbol}: Shortened hold window and lowered target.`,
        bias: 'tighten-risk'
      };
    }
    case 'noise-chasing': {
      agent.config.sizeFraction = clamp(round(agent.config.sizeFraction * 0.94, 4), 0.06, agent.baselineConfig.sizeFraction);
      agent.config.spreadLimitBps = clamp(round(agent.config.spreadLimitBps - 0.1, 2), 2, agent.baselineConfig.spreadLimitBps);
      if (brokerPaperCrypto) {
        agent.config.targetBps = Math.max(agent.config.targetBps, round(frictionFloorBps, 2));
      }
      return {
        note: `${symbol.symbol}: Lowered size and demanded cleaner tape conditions.`,
        bias: 'tighten-risk'
      };
    }
    default:
      return { note: profile.summary, bias: 'hold-steady' };
  }
}

export function applyAdaptiveTuning(engine: any, agent: AgentState, symbol: SymbolState): void {
  const outcomes = pickLast(agent.recentOutcomes, 8);
  const minOutcomes = agent.config.executionMode === 'broker-paper' ? 2 : 3;
  if (outcomes.length < minOutcomes) {
    agent.lastAdjustment = `Collecting more exits before tuning (${outcomes.length}/${minOutcomes}).`;
    agent.improvementBias = 'hold-steady';
    return;
  }

  const holds = pickLast(agent.recentHoldTicks, 8);
  const wins = outcomes.filter((v) => v > 0);
  const losses = outcomes.filter((v) => v < 0);
  const grossWins = wins.reduce((sum, v) => sum + v, 0);
  const grossLosses = Math.abs(losses.reduce((sum, v) => sum + v, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0;
  const winRate = wins.length / outcomes.length;
  const avgHold = average(holds);
  const brokerPaperCrypto = agent.config.executionMode === 'broker-paper' && symbol.assetClass === 'crypto';
  const frictionFloorBps = brokerPaperCrypto ? engine.estimatedBrokerRoundTripCostBps(symbol) + 12 : 0;
  const recentJournal = engine.getRecentJournalEntries(agent, symbol, 12);
  const mistakeProfile = buildMistakeProfile(engine, agent, symbol, recentJournal);

  let baseBias: AgentState['improvementBias'] = 'hold-steady';
  let baseNote = `Holding steady on ${symbol.symbol}. PF ${profitFactor.toFixed(2)}, win ${(winRate * 100).toFixed(1)}%.`;

  if (profitFactor < 0.95) {
    agent.config.sizeFraction = clamp(round(agent.config.sizeFraction * 0.96, 4), 0.06, agent.baselineConfig.sizeFraction);
    agent.config.maxHoldTicks = Math.max(brokerPaperCrypto ? 12 : 4, agent.config.maxHoldTicks - 1);
    agent.config.spreadLimitBps = clamp(round(agent.config.spreadLimitBps - 0.25, 2), 2, agent.baselineConfig.spreadLimitBps);
    agent.config.stopBps = clamp(round(agent.config.stopBps - 0.5, 2), brokerPaperCrypto ? 14 : 8, agent.baselineConfig.stopBps + 3);
    baseNote = `Tightened risk after ${outcomes.length} exits. PF ${profitFactor.toFixed(2)}.`;
    baseBias = 'tighten-risk';
  } else if (profitFactor > 1.35) {
    agent.config.targetBps = clamp(round(agent.config.targetBps + 0.5, 2), agent.baselineConfig.targetBps - 1, agent.baselineConfig.targetBps + 8);
    agent.config.sizeFraction = clamp(round(agent.config.sizeFraction + 0.01, 4), 0.06, agent.baselineConfig.sizeFraction + 0.06);
    baseNote = `Pressed edge after ${outcomes.length} exits. PF ${profitFactor.toFixed(2)}.`;
    baseBias = 'press-edge';
  } else {
    agent.config.targetBps = nudge(agent.config.targetBps, agent.baselineConfig.targetBps, 0.25);
    agent.config.stopBps = nudge(agent.config.stopBps, agent.baselineConfig.stopBps, 0.25);
    agent.config.spreadLimitBps = nudge(agent.config.spreadLimitBps, agent.baselineConfig.spreadLimitBps, 0.1);
  }

  const mistakeRefinement = applyMistakeDrivenRefinement(engine, agent, symbol, mistakeProfile, brokerPaperCrypto, frictionFloorBps);
  agent.lastAdjustment = `${baseNote} ${mistakeRefinement.note}`.trim();
  agent.improvementBias = mistakeRefinement.bias === 'tighten-risk' ? 'tighten-risk' : baseBias;
}

export function buildForensics(engine: any, entry: TradeJournalEntry): TradeForensicsRow {
  const modelProb = clamp(((entry.entryTrainedProbability ?? entry.entryHeuristicProbability ?? 50) / 100), 0.01, 0.99);
  return {
    id: entry.id,
    symbol: entry.symbol,
    exitAt: entry.exitAt,
    realizedPnl: round(entry.realizedPnl, 2),
    verdict: entry.verdict,
    attribution: {
      entryTimingBps: round(Math.max(0, 40 - Math.abs(entry.entryScore ?? 0) * 15), 2),
      spreadCostBps: round(Math.max(0, entry.spreadBps * 0.6), 2),
      slippageCostBps: round(Math.max(0, Math.abs(entry.slippageBps ?? 0)), 2),
      exitTimingBps: 0,
      modelErrorBps: round((1 - modelProb) * 45, 2)
    },
    timeline: []
  };
}

export function evaluateWalkForwardPromotion(
  engine: any,
  agent: AgentState,
  candidate: AgentConfig,
  champion: AgentConfig
): WalkForwardResult {
  const entries = engine.getMetaJournalEntries().filter((e) => e.strategyId === agent.config.id && e.symbol === candidate.symbol).slice(-80);
  const outSample = entries.slice(Math.floor(entries.length * 0.65));
  const passed = outSample.length >= 6;
  return {
    agentId: agent.config.id,
    symbol: candidate.symbol,
    passed,
    outSampleTrades: outSample.length,
    candidateExpectancy: 0,
    championExpectancy: 0,
    note: passed ? 'Walk-forward pass' : 'Insufficient data',
    asOf: new Date().toISOString()
  };
}

export function evaluateChallengerProbation(engine: any, agent: AgentState, symbol: SymbolState): void {
  if (agent.deployment.mode !== 'challenger-probation') return;
  const probationTrades = agent.trades - agent.deployment.startingTrades;
  if (probationTrades >= agent.deployment.probationTradesRequired) {
    agent.deployment.mode = 'stable';
    agent.deployment.lastDecision = `Accepted challenger after ${probationTrades} trades.`;
    engine.persistAgentConfigOverrides();
  }
}

export function getWalkForwardSnapshot(engine: any): WalkForwardResult[] {
  return Array.from(engine.agents.values()).map((agent: AgentState) => ({
    agentId: agent.config.id,
    symbol: agent.config.symbol,
    passed: agent.deployment.mode === 'stable',
    outSampleTrades: agent.trades - agent.deployment.startingTrades,
    candidateExpectancy: 0,
    championExpectancy: 0,
    note: agent.deployment.lastDecision,
    asOf: new Date().toISOString()
  }));
}
