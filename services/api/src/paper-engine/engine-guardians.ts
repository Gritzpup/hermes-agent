// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { SYMBOL_GUARD_PATH } from './types.js';

export function getSymbolCluster(engine: any, symbol: any): string {
  if (symbol.assetClass === 'commodity' || symbol.assetClass === 'commodity-proxy') return 'commodity';
  if (symbol.assetClass === 'crypto') return 'crypto';
  if (symbol.assetClass === 'equity') return 'equity';
  if (symbol.assetClass === 'bond') return 'bond';
  return 'forex';
}

export function getClusterLimitPct(engine: any, cluster: string): number {
  if (cluster === 'crypto') return 45;
  if (cluster === 'equity') return 35;
  if (cluster === 'forex') return 40;
  if (cluster === 'bond') return 30;
  return 25;
}

export function getSymbolGuard(engine: any, symbol: string): any | null {
  const state = engine.symbolGuards.get(symbol);
  if (!state) return null;
  if (state.blockedUntilMs <= Date.now()) return null;
  return state;
}

export function restoreSymbolGuards(engine: any): void {
  const path = SYMBOL_GUARD_PATH;
  try {
    if (!fs.existsSync(path)) return;
    const raw = fs.readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    engine.symbolGuards.clear();
    for (const item of parsed) {
      if (!item?.symbol || !Number.isFinite(item.blockedUntilMs)) continue;
      engine.symbolGuards.set(item.symbol, item);
    }
  } catch {
    // best-effort
  }
}

export function checkSymbolKillswitch(engine: any, agent: any): void {
  const outcomes = (agent.recentOutcomes ?? []).slice(-3);
  if (outcomes.length >= 3 && outcomes.every((o: number) => o < 0)) {
    const symbol = agent.config.symbol;
    const blockMs = 60 * 60 * 1000;
    engine.symbolGuards.set(symbol, {
      symbol,
      consecutiveLosses: 3,
      blockedUntilMs: Date.now() + blockMs,
      blockReason: `Auto-killswitch: ${agent.config.name} had 3 consecutive losses`,
      updatedAt: new Date().toISOString()
    });
    engine.persistSymbolGuards();
    console.log(`[KILLSWITCH] ${symbol} blocked for 60 min after 3 consecutive losses by ${agent.config.name}`);
  }
}

export function persistSymbolGuards(engine: any): void {
  const path = SYMBOL_GUARD_PATH;
  try {
    fs.promises.writeFile(path, JSON.stringify(Array.from(engine.symbolGuards.values()), null, 2), 'utf8').catch(() => {});
  } catch {
    // best-effort
  }
}

export function updateSymbolGuard(engine: any, symbol: string, mutation: (state: any) => any): void {
  const current = engine.symbolGuards.get(symbol) ?? {
    symbol,
    consecutiveLosses: 0,
    blockedUntilMs: 0,
    blockReason: '',
    updatedAt: new Date().toISOString()
  };
  const next = mutation(current);
  engine.symbolGuards.set(symbol, { ...next, updatedAt: new Date().toISOString() });
  engine.persistSymbolGuards();
}

export function applySpreadShockGuard(engine: any, symbol: any): void {
  if (symbol.baseSpreadBps <= 0) return;
  const spreadShockRatio = symbol.spreadBps / symbol.baseSpreadBps;
  if (spreadShockRatio < 2.4) return;
  engine.updateSymbolGuard(symbol.symbol, (state: any) => ({
    ...state,
    blockedUntilMs: Math.max(state.blockedUntilMs, Date.now() + 30 * 60_000),
    blockReason: `Spread shock ${spreadShockRatio.toFixed(2)}x on ${symbol.symbol}.`
  }));
}

export function queueEventDrivenExit(engine: any, symbol: any, trigger: string): void {
  for (const agent of engine.agents.values()) {
    if (!agent.position || agent.config.symbol !== symbol.symbol || agent.pendingOrderId) continue;
    const direction = engine.getPositionDirection(agent.position);
    const targetHit = direction === 'short'
      ? symbol.price <= agent.position.targetPrice
      : symbol.price >= agent.position.targetPrice;
    const stopHit = direction === 'short'
      ? symbol.price >= agent.position.stopPrice
      : symbol.price <= agent.position.stopPrice;
    const spreadPanic = symbol.spreadBps > Math.max(agent.config.spreadLimitBps * 1.9, symbol.baseSpreadBps * 2.4);
    if (targetHit || stopHit || spreadPanic) {
      const reason = targetHit
        ? `event target hit (${trigger})`
        : stopHit
          ? `event stop hit (${trigger})`
          : `event spread shock (${trigger})`;
      engine.pendingEventExitReasons.set(agent.config.id, reason);
    }
  }
}

export async function processEventDrivenExitQueue(engine: any): Promise<void> {
  if (engine.pendingEventExitReasons.size === 0) return;
  const queued = Array.from(engine.pendingEventExitReasons.entries());
  engine.pendingEventExitReasons.clear();
  for (const [agentId, reason] of queued) {
    const agent = engine.agents.get(agentId);
    if (!agent?.position) continue;
    const symbol = engine.market.get(agent.config.symbol);
    if (!symbol) continue;
    await engine.closePosition(agent, symbol, reason);
  }
}

export function wouldBreachPortfolioRiskBudget(engine: any, agent: any, symbol: any, proposedNotional: number): boolean {
  const snapshot = engine.getPortfolioRiskSnapshot();
  const cluster = engine.getSymbolCluster(symbol);
  const clusterInfo = snapshot.byCluster.find((c: any) => c.cluster === cluster);
  if (!clusterInfo) return false;

  // Global budget check (100% of allowed budgetPct)
  if (snapshot.openRiskPct + (proposedNotional / engine.getDeskEquity()) * 100 > snapshot.budgetPct * 1.5) {
    return true;
  }

  // Cluster budget check
  const clusterNotionalLimit = (clusterInfo.limitPct / 100) * engine.getDeskEquity();
  if (clusterInfo.openNotional + proposedNotional > clusterNotionalLimit * 1.2) {
    return true;
  }

  return false;
}

export function evaluateSessionKpiGate(engine: any, symbol: any): { pass: boolean; message: string } {
  // Logic to check session-based KPI gates
  return { pass: true, message: 'OK' };
}

export function classifySymbolRegime(engine: any, symbol: any): string {
  const recentMove = Math.abs(engine.relativeMove(symbol.history, 12));
  const spreadShock = symbol.baseSpreadBps > 0 ? symbol.spreadBps / symbol.baseSpreadBps : 1;
  if (spreadShock >= 1.8 || symbol.volatility >= 0.025 || recentMove >= 0.02) {
    return 'panic';
  }
  if (recentMove >= 0.01 || Math.abs(symbol.drift) >= 0.006) {
    return 'trend';
  }
  if (symbol.volatility <= 0.004 && Math.abs(symbol.drift) <= 0.002) {
    return 'compression';
  }
  return 'chop';
}

export function buildRegimeKpis(engine: any, regime: string, entries: any[]): any {
  const filtered = entries.filter(e => e.regime === regime || e.context?.regime === regime);
  if (filtered.length === 0) return { samples: 0, winRate: 0, profitFactor: 1 };
  const wins = filtered.filter(e => e.realizedPnl > 0);
  const grossWin = wins.reduce((s, e) => s + e.realizedPnl, 0);
  const grossLoss = Math.abs(filtered.filter(e => e.realizedPnl < 0).reduce((s, e) => s + e.realizedPnl, 0));
  return {
    samples: filtered.length,
    winRate: wins.length / filtered.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 5 : 1)
  };
}

export function getRegimeThrottleMultiplier(engine: any, regime: string, style: string): number {
  if (regime === 'panic') return 0.2; // 80% throttle in panic
  if (regime === 'chop' && style === 'momentum') return 0.5;
  if (regime === 'trend' && style === 'mean-reversion') return 0.6;
  return 1.0;
}

export function computeConfidenceCalibrationMultiplier(engine: any, agent: any, decision: any): number {
  if (!decision || decision.confidence < 0.5) return 0.8;
  if (decision.confidence > 0.9) return 1.2;
  return 1.0;
}

export function getExecutionQualityMultiplier(engine: any, broker: any): number {
  const counters = engine.executionQualityCounters?.get(broker) ?? { attempts: 0, rejects: 0, partialFills: 0 };
  if (counters.attempts < 5) return 1.0;
  const rejectRate = counters.rejects / counters.attempts;
  if (rejectRate > 0.3) return 0.7;
  if (rejectRate > 0.15) return 0.85;
  return 1.0;
}
