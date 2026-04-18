import type {
  AssetClass,
  CapitalAllocatorSnapshot,
  CapitalSleeveAllocation,
  CopySleeveBacktestResult,
  CopySleevePortfolioSnapshot,
  LiveReadinessReport,
  MacroPreservationBacktestResult,
  MacroPreservationPortfolioSnapshot,
  PaperDeskSnapshot,
  StrategyMode,
  StrategyOpportunity,
  StrategyRoutePlan,
  StrategySnapshot
} from '@hermes/contracts';
import { inferAssetClassFromSymbol } from './fee-model.js';
import { evaluateKpiGate } from './kpi-gates.js';

export interface CapitalAllocatorContext {
  asOf: string;
  capital: number;
  paperDesk: PaperDeskSnapshot;
  liveReadiness: LiveReadinessReport;
  opportunityPlan: StrategyRoutePlan;
  strategySnapshots: StrategySnapshot[];
  copySleeve: CopySleevePortfolioSnapshot | null;
  copyBacktest: CopySleeveBacktestResult | null;
  macroSnapshot: MacroPreservationPortfolioSnapshot | null;
  macroBacktest: MacroPreservationBacktestResult | null;
}

interface RankedSleeve {
  allocation: CapitalSleeveAllocation;
  liveEligible: boolean;
  score: number;
}

const SCALPING_WEIGHT_CAPS: Record<AssetClass, number> = {
  crypto: 24,
  equity: 18,
  'commodity-proxy': 12,
  forex: 10,
  bond: 8,
  commodity: 10
};

const ASSET_CLASS_CROWDING_CAP: Record<AssetClass, number> = {
  crypto: 35,
  equity: 40,
  forex: 15,
  bond: 20,
  'commodity-proxy': 15,
  commodity: 10
};

const SYMBOL_POLICY: Record<string, { multiplier: number; note: string }> = {
  'BTC-USD': { multiplier: 0.25, note: 'CEO gate: 0.10 R:R trap — cap until tail risk is fixed' },
  'XRP-USD': { multiplier: 2.0,  note: 'CEO gate: strongest realized expectancy (+$1093 on 538 trades)' },
  'GBP_USD': { multiplier: 0.0,  note: 'CEO gate: unresolved double-flatten data-integrity issue 2026-04-17' },
  'EUR_USD': { multiplier: 0.0,  note: 'CEO gate: broker-reconciliation fill-synthesis bug — 13 trades with identical $111.83 PnL, no entry prices' }
};

function getSymbolPolicyMultiplier(symbols: string[]): { multiplier: number; notes: string[] } {
  let multiplier = 1.0;
  const notes: string[] = [];
  for (const symbol of symbols) {
    const policy = SYMBOL_POLICY[symbol];
    if (!policy) continue;
    multiplier = Math.min(multiplier, policy.multiplier);
    notes.push(`${symbol}: ×${policy.multiplier.toFixed(2)} — ${policy.note}`);
  }
  return { multiplier, notes };
}

function strategyWeightCap(kind: 'pairs' | 'grid' | 'maker' | 'copy' | 'macro'): number {
  switch (kind) {
    case 'pairs': return 14;
    case 'grid': return 12;
    case 'maker': return 14;
    case 'copy': return 10;
    case 'macro': return 14;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals = 3): number {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function bestBy<T>(items: T[], scorer: (item: T) => number): T | null {
  let best: T | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const score = scorer(item);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

function assetClassLabel(assetClass: AssetClass): string {
  switch (assetClass) {
    case 'crypto': return 'Crypto';
    case 'equity': return 'Equity';
    case 'commodity-proxy': return 'Commodity Proxy';
    case 'forex': return 'Forex';
    case 'bond': return 'Bond';
    case 'commodity': return 'Commodity';
  }
}

function strategyStatusLabel(status: StrategySnapshot['status'] | 'staged' | 'blocked'): CapitalSleeveAllocation['status'] {
  if (status === 'blocked') return 'blocked';
  if (status === 'warming' || status === 'active') return 'paper';
  return 'staged';
}

function pickBestOpportunity(opportunities: StrategyOpportunity[], assetClass: AssetClass): StrategyOpportunity | null {
  const candidates = opportunities.filter((candidate) => candidate.assetClass === assetClass);
  return bestBy(candidates, (candidate) => {
    const selectedBonus = candidate.selected ? 25 : 0;
    const enabledBonus = candidate.enabled ? 10 : -40;
    const edge = candidate.expectedNetEdgeBps;
    const confidence = candidate.confidencePct / 4;
    const support = candidate.support / 3;
    const expectancy = candidate.expectancy * 8;
    return edge + confidence + support + expectancy + selectedBonus + enabledBonus;
  });
}

function pickBestReadiness(readiness: LiveReadinessReport, assetClass: AssetClass): LiveReadinessReport['agents'][number] | null {
  const candidates = readiness.agents.filter((agent) => inferAssetClassFromSymbol(agent.symbol) === assetClass);
  return bestBy(candidates, (agent) => {
    const eligibleBonus = agent.eligible ? 18 : -35;
    const modeBonus = agent.mode === 'candidate' ? 12 : agent.mode === 'paper-only' ? -12 : -24;
    const kpiBonus = agent.kpiRatio / 4;
    const profitFactor = agent.profitFactor * 7;
    const expectancy = agent.expectancy * 10;
    const winRate = agent.winRate / 3.5;
    const trades = Math.min(agent.trades, 16) * 0.5;
    return eligibleBonus + modeBonus + kpiBonus + profitFactor + expectancy + winRate + trades;
  });
}

function evaluateStrategyLaneKpiRatio(best: StrategySnapshot | null): number {
  if (!best) {
    return 0;
  }

  const pnlScore = clamp(50 + (best.dailyPnl / 4), 0, 100);
  const statusScore = best.status === 'active' ? 80 : best.status === 'warming' ? 65 : 40;
  const stageScore = best.stage === 'live' ? 95 : best.stage === 'shadow-live' ? 85 : best.stage === 'paper' ? 60 : 40;
  return round((pnlScore * 0.35) + (statusScore * 0.25) + (stageScore * 0.4), 1);
}

function evaluateCopyKpiRatio(backtest: CopySleeveBacktestResult | null): number {
  if (!backtest) {
    return 0;
  }

  const absoluteReturn = clamp(50 + (backtest.netReturnPct * 4), 0, 100);
  const relativeReturn = clamp(50 + ((backtest.benchmarkReturnPct - backtest.netReturnPct) * 4), 0, 100);
  const coverage = clamp(backtest.resolvedCoveragePct, 0, 100);
  const drawdown = clamp(100 - (backtest.maxDrawdownPct * 2.5), 0, 100);
  return round((absoluteReturn * 0.34) + (relativeReturn * 0.26) + (coverage * 0.2) + (drawdown * 0.2), 1);
}

function evaluateMacroKpiRatio(snapshot: MacroPreservationPortfolioSnapshot | null, backtest: MacroPreservationBacktestResult | null): number {
  if (!backtest) {
    return snapshot?.inflationHot ? 60 : 45;
  }

  const totalReturn = clamp(50 + (backtest.netReturnPct / 2), 0, 100);
  const inflationAlpha = clamp(50 + ((backtest.inflationReturnPct - backtest.inflationBenchmarkReturnPct) * 4), 0, 100);
  const drawdown = clamp(100 - (backtest.maxDrawdownPct * 2.5), 0, 100);
  const coverage = clamp(40 + backtest.inflationPeriodCount, 0, 100);
  const regime = snapshot?.inflationHot ? 70 : 55;
  return round((totalReturn * 0.25) + (inflationAlpha * 0.3) + (drawdown * 0.2) + (coverage * 0.15) + (regime * 0.1), 1);
}

function buildScalpingSleeve(context: CapitalAllocatorContext, assetClass: AssetClass): RankedSleeve {
  const opportunity = pickBestOpportunity(context.opportunityPlan.candidates, assetClass);
  const readiness = pickBestReadiness(context.liveReadiness, assetClass);
  const assetLabel = assetClassLabel(assetClass);
  const venue = opportunity?.venue ?? (assetClass === 'forex' || assetClass === 'bond' ? 'oanda-rest' : assetClass === 'equity' ? 'alpaca-paper' : 'coinbase-live');
  const expectedNetEdgeBps = opportunity?.expectedNetEdgeBps ?? 0;
  const confidencePct = opportunity?.confidencePct ?? 0;
  const kpiGate = evaluateKpiGate({
    scope: 'sleeve',
    sampleCount: readiness?.trades ?? 0,
    winRatePct: readiness?.winRate ?? 0,
    profitFactor: readiness?.profitFactor ?? 0,
    expectancy: readiness?.expectancy,
    netEdgeBps: opportunity?.expectedNetEdgeBps,
    confidencePct: opportunity?.confidencePct,
    drawdownPct: undefined
  });
  const liveEligible = Boolean(
    opportunity
    && readiness
    && opportunity.enabled
    && opportunity.selected
    && opportunity.expectedNetEdgeBps > 0
    && readiness.eligible
    && readiness.mode === 'candidate'
    && assetClass !== 'forex'
    && assetClass !== 'bond'
    && kpiGate.passed
  );
  const paperOnly = assetClass === 'forex' || assetClass === 'bond' || readiness?.mode === 'paper-only' || readiness?.mode === 'blocked';
  const staged = !liveEligible;
  const kpiRatio = kpiGate.ratioPct;
  const readinessBonus = readiness ? readiness.kpiRatio / 2 : 0;
  const score = liveEligible
    ? Math.max(0, expectedNetEdgeBps) + kpiRatio + (confidencePct / 10) + readinessBonus
    : Math.max(0, expectedNetEdgeBps) + (kpiRatio / 2) + (confidencePct / 20) + (readinessBonus / 2);
  const symbolList = opportunity ? opportunity.symbols : readiness ? [readiness.symbol] : [];
  const symbolPolicy = getSymbolPolicyMultiplier(symbolList);
  const adjustedScore = score * symbolPolicy.multiplier;
  const liveEligibleAdjusted = liveEligible && symbolPolicy.multiplier > 0;
  const maxWeightPct = SCALPING_WEIGHT_CAPS[assetClass];
  const reason = opportunity
    ? liveEligible
      ? `${assetLabel} scalper ${opportunity.strategy} clears the KPI gate at ${kpiRatio.toFixed(1)}% and stays positive-net (${opportunity.expectedNetEdgeBps.toFixed(1)}bps).`
      : `${assetLabel} scalper ${opportunity.strategy} is visible but staged. ${assetClass === 'forex' || assetClass === 'bond' ? 'Venue parity is still incomplete.' : kpiGate.summary}`
    : `${assetLabel} has no positive-net live candidate right now.`;

  return {
    liveEligible: liveEligibleAdjusted,
    score: adjustedScore,
    allocation: {
      id: `scalping-${assetClass}`,
      name: `${assetLabel} Scalping`,
      kind: 'scalping',
      assetClass,
      symbols: opportunity ? opportunity.symbols : readiness ? [readiness.symbol] : [],
      venue,
      status: liveEligibleAdjusted ? 'live' : opportunity ? 'staged' : readiness ? 'blocked' : 'blocked',
      liveEligible: liveEligibleAdjusted,
      paperOnly,
      staged: !liveEligibleAdjusted,
      confidencePct: round(confidencePct, 1),
      expectedNetEdgeBps: round(expectedNetEdgeBps, 3),
      score: round(adjustedScore, 3),
      kpiRatio: round(kpiRatio, 1),
      targetWeightPct: 0,
      maxWeightPct,
      reason,
      notes: [
        readiness ? `${readiness.agentName}: KPI ${readiness.kpiRatio.toFixed(1)}%, PF ${readiness.profitFactor.toFixed(2)}, win ${readiness.winRate.toFixed(1)}%, expectancy ${readiness.expectancy.toFixed(2)}.` : 'No matching readiness agent found.',
        opportunity ? `Route: gross ${opportunity.expectedGrossEdgeBps.toFixed(1)}bps, cost ${opportunity.estimatedCostBps.toFixed(1)}bps, net ${opportunity.expectedNetEdgeBps.toFixed(1)}bps. KPI ${kpiRatio.toFixed(1)}%.` : 'No route-plan candidate found.',
        `Gate: ${kpiGate.summary}`,
        ...symbolPolicy.notes
      ]
    }
  };
}

function buildStrategySleeve(context: CapitalAllocatorContext, kind: 'pairs' | 'grid' | 'maker' | 'copy' | 'macro'): RankedSleeve {
  const maxWeightPct = strategyWeightCap(kind);

  if (kind === 'copy') {
    const backtest = context.copyBacktest;
    const kpiRatio = evaluateCopyKpiRatio(backtest);
    const liveEligible = Boolean(backtest && backtest.netReturnPct > 0 && backtest.resolvedCoveragePct >= 80 && backtest.maxDrawdownPct <= 15);
    const score = backtest
      ? Math.max(0, backtest.netReturnPct) + Math.max(0, backtest.benchmarkReturnPct - backtest.netReturnPct) + (backtest.resolvedCoveragePct / 20) + (kpiRatio / 10)
      : 0;
    const symbols = context.copySleeve?.latestFiling?.holdings
      .filter((holding) => holding.resolved && holding.symbol)
      .slice(0, 5)
      .map((holding) => holding.symbol!)
      ?? ['AAPL', 'AXP', 'BAC'];
    const managerName = context.copySleeve?.managerName ?? 'Copy Sleeve';
    const reason = backtest
      ? liveEligible
        ? `${managerName} copy sleeve clears the absolute-return gate with ${backtest.netReturnPct.toFixed(2)}% net, ${backtest.resolvedCoveragePct.toFixed(1)}% resolution coverage, and a ${kpiRatio.toFixed(1)}% KPI ratio.`
        : `${managerName} copy sleeve is still paper-only: net ${backtest.netReturnPct.toFixed(2)}% vs SPY ${backtest.benchmarkReturnPct.toFixed(2)}%, KPI ${kpiRatio.toFixed(1)}%, so it does not yet earn live capital.`
      : 'Copy sleeve backtest is unavailable.';

    return {
      liveEligible,
      score,
      allocation: {
        id: kind,
        name: 'Copy Sleeve',
        kind,
        symbols,
        venue: 'mixed',
        status: liveEligible ? 'live' : 'paper',
        liveEligible,
        paperOnly: !liveEligible,
        staged: !liveEligible,
        confidencePct: round(backtest?.resolvedCoveragePct ?? 0, 1),
        expectedNetEdgeBps: round(score, 3),
        score: round(score, 3),
        kpiRatio,
        targetWeightPct: 0,
        maxWeightPct,
        reason,
        notes: backtest
          ? [
              `Benchmark ${backtest.benchmarkSymbol} returned ${backtest.benchmarkReturnPct.toFixed(2)}% during the same window.`,
              `Fees ${backtest.totalFeesUsd.toFixed(2)} across ${backtest.periods.length} rebalance periods.`,
              `KPI ratio ${kpiRatio.toFixed(1)}% from return, coverage, and drawdown.`
            ]
          : ['No copy sleeve backtest available.']
      }
    };
  }

  if (kind === 'macro') {
    const snapshot = context.macroSnapshot;
    const backtest = context.macroBacktest;
    const kpiRatio = evaluateMacroKpiRatio(snapshot, backtest);
    const liveEligible = Boolean(snapshot?.inflationHot && backtest && backtest.netReturnPct > 0 && backtest.inflationReturnPct > backtest.inflationBenchmarkReturnPct && backtest.maxDrawdownPct <= 20);
    const score = snapshot
      ? snapshot.inflationHot && backtest
        ? Math.max(0, backtest.inflationReturnPct - backtest.inflationBenchmarkReturnPct) + (backtest.inflationPeriodCount / 3) + (kpiRatio / 10)
        : kpiRatio / 2
      : 0;
    const reason = snapshot
      ? snapshot.inflationHot
        ? liveEligible
          ? `Inflation regime is active and the real-asset basket is positive after costs with a ${kpiRatio.toFixed(1)}% KPI ratio.`
          : `Inflation is active but the macro sleeve still needs stronger inflation alpha, lower drawdown, or a higher KPI ratio before it earns live capital.`
        : `CPI ${snapshot.latestObservation ? snapshot.latestObservation.yoyPct.toFixed(2) : 'n/a'}% is below threshold; stay in cash.`
      : 'Macro snapshot is unavailable.';

    return {
      liveEligible,
      score,
      allocation: {
        id: kind,
        name: 'Macro Preservation',
        kind,
        symbols: snapshot ? snapshot.selectedAllocations.map((allocation) => allocation.symbol) : ['GLD', 'SLV', 'USO', 'DBC', 'BIL'],
        venue: 'mixed',
        status: liveEligible ? 'live' : snapshot && snapshot.inflationHot ? 'paper' : 'cash',
        liveEligible,
        paperOnly: !liveEligible,
        staged: !liveEligible,
        confidencePct: round(snapshot?.inflationThresholdPct ?? 0, 1),
        expectedNetEdgeBps: round(score, 3),
        score: round(score, 3),
        kpiRatio,
        targetWeightPct: 0,
        maxWeightPct,
        reason,
        notes: backtest
          ? [
              `Inflation-period return ${backtest.inflationReturnPct.toFixed(2)}% vs SPY ${backtest.inflationBenchmarkReturnPct.toFixed(2)}%.`,
              `Inflation periods seen: ${backtest.inflationPeriodCount}.`,
              `KPI ratio ${kpiRatio.toFixed(1)}% from inflation alpha, total return, coverage, and drawdown.`
            ]
          : ['No macro backtest available.']
      }
    };
  }

  const snapshots = context.strategySnapshots.filter((snapshot) => snapshot.lane === kind);
  const best = bestBy(snapshots, (snapshot) => {
    const pnl = Math.max(snapshot.dailyPnl, 0);
    const stateBonus = snapshot.status === 'active' ? 12 : snapshot.status === 'warming' ? 5 : snapshot.status === 'blocked' ? -30 : 0;
    const stageBonus = snapshot.stage === 'shadow-live' ? 10 : snapshot.stage === 'live' ? 14 : snapshot.stage === 'paper' ? 2 : 0;
    return pnl / 75 + stateBonus + stageBonus;
  });

  const kpiRatio = evaluateStrategyLaneKpiRatio(best);
  const liveEligible = Boolean(best && best.stage !== 'paper' && best.status === 'active' && kpiRatio >= 70);
  const venue = best?.broker ?? 'coinbase-live';
  const performance = best ? Math.max(best.dailyPnl, 0) : 0;
  const score = performance / 80 + (best?.status === 'active' ? 8 : best?.status === 'warming' ? 3 : 0) + (best?.stage === 'shadow-live' ? 6 : 0) + (kpiRatio / 10);
  const reason = best
    ? liveEligible
      ? `${best.name} clears the KPI gate at ${kpiRatio.toFixed(1)}% and is eligible for live allocation. ${best.summary}`
      : `${best.name} is still paper-only. ${best.summary} KPI ${kpiRatio.toFixed(1)}%.`
    : `No ${kind} strategy snapshot is available.`;

  return {
    liveEligible,
    score,
    allocation: {
      id: kind,
      name: kind === 'pairs' ? 'Pairs' : kind === 'grid' ? 'Grid' : 'Maker',
      kind,
      symbols: snapshots.flatMap((snapshot) => snapshot.symbols),
      venue,
      status: best?.status === 'blocked' ? 'blocked' : liveEligible ? 'live' : 'paper',
      liveEligible,
      paperOnly: !liveEligible,
      staged: !liveEligible,
      confidencePct: round(best ? Math.min(100, 35 + Math.max(best.dailyPnl, 0) / 30 + (best.status === 'active' ? 10 : 0)) : 0, 1),
      expectedNetEdgeBps: round(score, 3),
      score: round(score, 3),
      kpiRatio,
      targetWeightPct: 0,
      maxWeightPct,
      reason,
      notes: best
        ? [
            `${best.name}: ${best.status}, stage ${best.stage}, daily ${best.dailyPnl.toFixed(2)}.`,
            `KPI ratio ${kpiRatio.toFixed(1)}%.`,
            liveEligible ? 'Eligible for live allocation; preserve audit trail and execution parity.' : 'Paper/staged until live parity is proven.'
          ]
        : ['No strategy snapshot available.']
    }
  };
}

function buildCashSleeve(): CapitalSleeveAllocation {
  return {
    id: 'cash',
    name: 'Cash / T-Bill Reserve',
    kind: 'cash',
    symbols: [],
    venue: 'multi',
    status: 'cash',
    liveEligible: true,
    paperOnly: false,
    staged: false,
    confidencePct: 100,
    expectedNetEdgeBps: 0,
    score: 1,
    kpiRatio: 100,
    targetWeightPct: 0,
    maxWeightPct: 100,
    reason: 'Default reserve when no sleeve clears the gate.',
    notes: ['Capital preservation wins when edge is not proven.']
  };
}

function normalizeTargets(sleeves: RankedSleeve[], deployablePct: number): CapitalSleeveAllocation[] {
  const liveSleeves = sleeves.filter((entry) => entry.liveEligible && entry.score > 0);
  const totalScore = sum(liveSleeves.map((entry) => entry.score));
  const targetById = new Map<string, number>();
  if (liveSleeves.length > 0 && totalScore > 0 && deployablePct > 0) {
    for (const entry of liveSleeves) {
      const rawWeight = (entry.score / totalScore) * deployablePct;
      targetById.set(entry.allocation.id, Math.max(0, Math.min(rawWeight, entry.allocation.maxWeightPct)));
    }
  }

  // --- Portfolio crowding cap: cap total weight per asset class ---
  const byClass = new Map<AssetClass, number>();
  for (const entry of sleeves) {
    const cls = entry.allocation.assetClass;
    if (!cls) continue;
    byClass.set(cls, (byClass.get(cls) ?? 0) + (targetById.get(entry.allocation.id) ?? 0));
  }
  for (const [cls, total] of byClass.entries()) {
    const cap = ASSET_CLASS_CROWDING_CAP[cls];
    if (total > cap) {
      const scale = cap / total;
      for (const entry of sleeves) {
        if (entry.allocation.assetClass !== cls) continue;
        const current = targetById.get(entry.allocation.id) ?? 0;
        targetById.set(entry.allocation.id, current * scale);
      }
    }
  }
  // --- end crowding cap ---

  const assigned = sum(Array.from(targetById.values()));
  const cash = buildCashSleeve();
  cash.targetWeightPct = round(Math.max(0, 100 - assigned), 3);
  const ordered = sleeves
    .map((entry) => ({ ...entry.allocation, targetWeightPct: round(targetById.get(entry.allocation.id) ?? 0, 3) }))
    .sort((left, right) => right.targetWeightPct - left.targetWeightPct || right.score - left.score);
  ordered.push(cash);
  return ordered;
}

export function buildCapitalAllocatorSnapshot(context: CapitalAllocatorContext): CapitalAllocatorSnapshot {
  const sleeves: RankedSleeve[] = [
    buildScalpingSleeve(context, 'crypto'),
    buildScalpingSleeve(context, 'equity'),
    buildScalpingSleeve(context, 'commodity-proxy'),
    buildScalpingSleeve(context, 'commodity'),
    buildScalpingSleeve(context, 'forex'),
    buildScalpingSleeve(context, 'bond'),
    buildStrategySleeve(context, 'pairs'),
    buildStrategySleeve(context, 'grid'),
    buildStrategySleeve(context, 'maker'),
    buildStrategySleeve(context, 'copy'),
    buildStrategySleeve(context, 'macro')
  ];

  const liveEligible = sleeves.filter((entry) => entry.liveEligible && entry.score > 0);
  const bestLiveScore = liveEligible.length > 0 ? Math.max(...liveEligible.map((entry) => entry.score)) : 0;
  const bestLiveKpiRatio = liveEligible.length > 0 ? Math.max(...liveEligible.map((entry) => entry.allocation.kpiRatio)) : 0;
  const deskExpectancy = ((context.paperDesk.analytics.recentWinRate / 100) * context.paperDesk.analytics.avgWinner)
    - ((1 - (context.paperDesk.analytics.recentWinRate / 100)) * context.paperDesk.analytics.avgLoser);
  const deskGate = evaluateKpiGate({
    scope: 'desk',
    sampleCount: context.paperDesk.totalTrades,
    winRatePct: context.paperDesk.winRate,
    profitFactor: context.paperDesk.analytics.profitFactor,
    expectancy: deskExpectancy,
    netEdgeBps: undefined,
    confidencePct: context.paperDesk.analytics.recentWinRate,
    drawdownPct: undefined
  });
  const firmKpiRatio = liveEligible.length === 0
    ? round(deskGate.ratioPct, 1)
    : round(clamp((deskGate.ratioPct * 0.45) + (bestLiveKpiRatio * 0.55), 0, 100), 1);
  const rawDeployablePct = liveEligible.length === 0
    ? 0
    : clamp(25 + (liveEligible.length * 7) + Math.min(bestLiveScore, 30) / 2 + clamp((context.paperDesk.analytics.profitFactor - 1) * 10, 0, 10), 20, 80);
  const deployablePct = liveEligible.length === 0 ? 0 : round(rawDeployablePct * (firmKpiRatio / 100), 3);
  const allocations = normalizeTargets(sleeves, deployablePct);
  const reservePct = round(allocations.find((allocation) => allocation.kind === 'cash')?.targetWeightPct ?? 0, 3);
  const deployableActualPct = round(sum(allocations.filter((allocation) => allocation.kind !== 'cash').map((allocation) => allocation.targetWeightPct)), 3);
  const notes = [
    `Live sleeves eligible: ${liveEligible.length}.`,
    `Desk KPI ratio ${deskGate.ratioPct.toFixed(1)}% (${deskGate.grade}).`,
    `Best live sleeve KPI ratio ${bestLiveKpiRatio.toFixed(1)}%.`,
    `Firm KPI ratio ${firmKpiRatio.toFixed(1)}% gates the deployable budget.`,
    context.liveReadiness.overallEligible ? 'Overall readiness is positive, but allocation is still governed by sleeve-level gates.' : 'Overall readiness is not yet strong enough to scale broadly.',
    context.copyBacktest ? `Copy sleeve net ${context.copyBacktest.netReturnPct.toFixed(2)}% vs SPY ${context.copyBacktest.benchmarkReturnPct.toFixed(2)}%.` : 'Copy sleeve backtest unavailable.',
    context.macroSnapshot?.inflationHot ? 'Macro preservation sleeve is allowed to deploy if the real-asset basket remains positive after costs.' : 'Macro preservation sleeve remains in cash until inflation is hot.',
    'Forex and bond sleeves remain staged until venue parity and live-parity gates are crossed.'
  ];

  return {
    asOf: context.asOf,
    capital: round(context.capital, 2),
    deployablePct: deployableActualPct,
    reservePct,
    firmKpiRatio,
    sleeves: allocations,
    notes
  };
}
