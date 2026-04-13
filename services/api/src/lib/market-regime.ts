import type { SidecarLaneControlState } from './types-routes.js';

export function classifyMarketRegime(symbols: string[], snapshots: Array<{ symbol: string; spreadBps?: number; changePct?: number }>): string {
  const relevant = snapshots.filter((snapshot) => symbols.includes(snapshot.symbol));
  if (relevant.length === 0) return 'unknown';
  const avgSpread = relevant.reduce((sum, snapshot) => sum + (snapshot.spreadBps ?? 0), 0) / relevant.length;
  const avgMove = relevant.reduce((sum, snapshot) => sum + Math.abs(snapshot.changePct ?? 0), 0) / relevant.length;
  if (avgSpread >= 6 || avgMove >= 2.5) return 'panic';
  if (avgMove >= 1.1) return 'trend';
  if (avgSpread <= 1.2 && avgMove <= 0.4) return 'compression';
  return 'chop';
}

export interface LaneControlDeps {
  newsIntel: {
    getMacroSignal(): any;
    getSignal(symbol: string): any;
  };
  eventCalendar: {
    getEmbargo(symbol: string): any;
  };
}

export function buildSidecarLaneControl(
  deps: LaneControlDeps,
  strategyId: string,
  strategy: string,
  lane: 'pairs' | 'grid' | 'maker',
  symbols: string[],
  riskState: { killSwitchArmed?: boolean; blockedSymbols?: string[] },
  snapshots: Array<{ symbol: string; spreadBps?: number; changePct?: number }>,
  learningDecision?: {
    enabled: boolean;
    allocationMultiplier: number;
    recentTrades: number;
    posteriorWinRate: number;
    profitFactor: number;
    reason: string;
  }
): SidecarLaneControlState {
  const macro = deps.newsIntel.getMacroSignal();
  const blockedSymbols = riskState.blockedSymbols ?? [];
  const embargoed = symbols.some((symbol) => blockedSymbols.includes(symbol) || deps.eventCalendar.getEmbargo(symbol).blocked);
  const newsBlocked = symbols.some((symbol) => deps.newsIntel.getSignal(symbol).veto);

  let enabled = learningDecision?.enabled ?? true;
  let blockedReason = learningDecision?.reason ?? 'Lane enabled.';

  if (embargoed) {
    enabled = false;
    blockedReason = 'Embargo or local block active.';
  } else if (newsBlocked) {
    enabled = false;
    blockedReason = 'Strategy vetoed by news intelligence.';
  } else if (macro.sentiment === 'extreme-fear' || macro.sentiment === 'panic') {
    enabled = false;
    blockedReason = `Macro sentiment gate: ${macro.sentiment}`;
  } else if (riskState.killSwitchArmed) {
    enabled = false;
    blockedReason = 'Risk engine kill-switch armed.';
  }

  return {
    strategyId,
    strategy,
    lane,
    symbols,
    enabled,
    blockedReason,
    allocationMultiplier: learningDecision?.allocationMultiplier ?? 1.0,
    recentTrades: learningDecision?.recentTrades ?? 0,
    recentWinRate: learningDecision?.posteriorWinRate ?? 0,
    recentProfitFactor: learningDecision?.profitFactor ?? 0,
    lastReviewAt: new Date().toISOString(),
    lastAdjustment: enabled ? 'Normal operations' : 'Blocked by safety gate'
  };
}
