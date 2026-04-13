// @ts-nocheck
import type { TradeJournalEntry } from '@hermes/contracts';
import type { SymbolState } from './types.js';
import {
  CRYPTO_MAX_ENTRY_SPREAD_BPS,
  CRYPTO_MAX_EST_SLIPPAGE_BPS,
  CRYPTO_MIN_BOOK_DEPTH_NOTIONAL,
  DAILY_CIRCUIT_BREAKER_DD_PCT,
  WEEKLY_CIRCUIT_BREAKER_DD_PCT,
} from './types.js';
import { round } from '../paper-engine-utils.js';

export function noteTradeOutcome(
  engine: any,
  agent: any,
  symbol: SymbolState,
  realized: number,
  reason: string
): void {
  const spreadShock = symbol.spreadBps > Math.max(agent.config.spreadLimitBps * 1.8, symbol.baseSpreadBps * 2.2);
  engine.updateSymbolGuard(symbol.symbol, (state: any) => {
    if (realized > 0) {
      return {
        ...state,
        consecutiveLosses: 0,
        blockedUntilMs: state.blockedUntilMs > Date.now() ? state.blockedUntilMs : 0,
        blockReason: state.blockedUntilMs > Date.now() ? state.blockReason : ''
      };
    }

    const consecutiveLosses = state.consecutiveLosses + 1;
    let blockedUntilMs = state.blockedUntilMs;
    let blockReason = state.blockReason;

    if (spreadShock) {
      blockedUntilMs = Math.max(blockedUntilMs, Date.now() + 30 * 60_000);
      blockReason = `Spread shock guard: ${symbol.spreadBps.toFixed(2)}bps on ${symbol.symbol}.`;
    }

    if (consecutiveLosses >= 3) {
      blockedUntilMs = Math.max(blockedUntilMs, Date.now() + 2 * 60 * 60_000);
      blockReason = `Loss streak guard: ${consecutiveLosses} consecutive losses on ${symbol.symbol} (${reason}).`;
    }

    return { ...state, consecutiveLosses, blockedUntilMs, blockReason };
  });
}

export function getPortfolioRiskSnapshot(engine: any): any {
  const deskEquity = Math.max(engine.getDeskEquity(), 1);
  const byCluster = new Map<string, number>();
  let totalOpenNotional = 0;
  for (const agent of engine.agents.values()) {
    if (!agent.position) continue;
    const symbol = engine.market.get(agent.config.symbol);
    if (!symbol) continue;
    const notional = agent.position.entryPrice * agent.position.quantity;
    totalOpenNotional += notional;
    const cluster = engine.getSymbolCluster(symbol);
    byCluster.set(cluster, (byCluster.get(cluster) ?? 0) + notional);
  }
  const byClusterRows = Array.from(byCluster.entries()).map(([cluster, openNotional]) => ({
    cluster,
    openNotional: round(openNotional, 2),
    pct: round((openNotional / deskEquity) * 100, 2),
    limitPct: engine.getClusterLimitPct(cluster)
  }));
  const openRiskPct = (totalOpenNotional / deskEquity) * 100;
  return {
    totalOpenNotional: round(totalOpenNotional, 2),
    budgetPct: 85,
    openRiskPct: round(openRiskPct, 2),
    byCluster: byClusterRows
  };
}

export function evaluateSessionKpiGate(
  engine: any,
  symbol: SymbolState
): { pass: boolean; message: string } {
  const sessionBucket = engine.getSessionBucket();
  const entries = engine.getMetaJournalEntries()
    .filter((entry: TradeJournalEntry) => entry.symbol === symbol.symbol)
    .filter((entry: TradeJournalEntry) => {
      const tagged = entry.tags?.find((tag: string) => tag.startsWith('session-')) ?? '';
      const tagBucket = tagged.replace('session-', '');
      if (tagBucket.length > 0) return tagBucket === sessionBucket;
      return engine.getSessionBucket(entry.exitAt) === sessionBucket;
    })
    .slice(-40);
  if (entries.length < 20) {
    return { pass: true, message: `Session ${sessionBucket}: bootstrap ${entries.length}/20.` };
  }
  const wins = entries.filter((entry: TradeJournalEntry) => entry.realizedPnl > 0);
  const losses = entries.filter((entry: TradeJournalEntry) => entry.realizedPnl < 0);
  const grossWins = wins.reduce((sum: number, entry: TradeJournalEntry) => sum + entry.realizedPnl, 0);
  const grossLosses = Math.abs(losses.reduce((sum: number, entry: TradeJournalEntry) => sum + entry.realizedPnl, 0));
  const winRate = wins.length / Math.max(entries.length, 1);
  const pf = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0;
  const pass = winRate >= 0.45 && pf >= 0.95;
  return {
    pass,
    message: `Session ${sessionBucket}: win ${(winRate * 100).toFixed(1)}%, PF ${pf.toFixed(2)} (${entries.length} trades).`
  };
}

export function evaluatePortfolioCircuitBreaker(engine: any): void {
  const entries = engine.getMetaJournalEntries().slice(-600);
  if (entries.length < 8) return;
  const now = new Date();
  const dayKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
  const weekKey = `${now.getUTCFullYear()}-${Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(now.getUTCFullYear(), 0, 1)) / (7 * 86_400_000))}`;
  const dayEntries = entries.filter((entry: TradeJournalEntry) => {
    const d = new Date(entry.exitAt);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    return key === dayKey;
  });
  const weekEntries = entries.filter((entry: TradeJournalEntry) => {
    const d = new Date(entry.exitAt);
    const key = `${d.getUTCFullYear()}-${Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / (7 * 86_400_000))}`;
    return key === weekKey;
  });
  const dayPnl = dayEntries.reduce((sum: number, entry: TradeJournalEntry) => sum + entry.realizedPnl, 0);
  const weekPnl = weekEntries.reduce((sum: number, entry: TradeJournalEntry) => sum + entry.realizedPnl, 0);
  const deskEquity = Math.max(engine.getDeskEquity(), 1);
  const dayLossPct = (-dayPnl / deskEquity) * 100;
  const weekLossPct = (-weekPnl / deskEquity) * 100;

  if (!engine.circuitBreakerLatched && dayLossPct >= DAILY_CIRCUIT_BREAKER_DD_PCT) {
    engine.circuitBreakerLatched = true;
    engine.circuitBreakerScope = 'daily';
    engine.circuitBreakerReason = `Daily drawdown exceeded ${DAILY_CIRCUIT_BREAKER_DD_PCT.toFixed(1)}% (${dayLossPct.toFixed(2)}%).`;
    engine.circuitBreakerArmedAt = new Date().toISOString();
    engine.circuitBreakerReviewed = false;
    engine.recordEvent('circuit-breaker', { scope: 'daily', reason: engine.circuitBreakerReason, dayLossPct: round(dayLossPct, 2) });
  }

  if (!engine.circuitBreakerLatched && weekLossPct >= WEEKLY_CIRCUIT_BREAKER_DD_PCT) {
    engine.circuitBreakerLatched = true;
    engine.circuitBreakerScope = 'weekly';
    engine.circuitBreakerReason = `Weekly drawdown exceeded ${WEEKLY_CIRCUIT_BREAKER_DD_PCT.toFixed(1)}% (${weekLossPct.toFixed(2)}%).`;
    engine.circuitBreakerArmedAt = new Date().toISOString();
    engine.circuitBreakerReviewed = false;
    engine.recordEvent('circuit-breaker', { scope: 'weekly', reason: engine.circuitBreakerReason, weekLossPct: round(weekLossPct, 2) });
  }
}

export function evaluateCryptoExecutionGuard(
  engine: any,
  symbol: SymbolState,
  intel: { adverseSelectionRisk?: number; quoteStabilityMs?: number }
): { pass: boolean; reason: string } {
  const spreadCap = Math.min(CRYPTO_MAX_ENTRY_SPREAD_BPS, Math.max(1.5, symbol.baseSpreadBps * 1.8));
  if (symbol.spreadBps > spreadCap) {
    return { pass: false, reason: `Crypto spread guard: ${symbol.spreadBps.toFixed(2)}bps > ${spreadCap.toFixed(2)}bps.` };
  }
  const estSlippageBps = Math.max(symbol.spreadBps * 0.25, (intel.adverseSelectionRisk ?? 0) * 0.05);
  if (estSlippageBps > CRYPTO_MAX_EST_SLIPPAGE_BPS) {
    return { pass: false, reason: `Crypto slippage guard: est ${estSlippageBps.toFixed(2)}bps > ${CRYPTO_MAX_EST_SLIPPAGE_BPS.toFixed(2)}bps.` };
  }
  const depth = engine.getOrderFlowDepth(symbol.symbol);
  if (depth) {
    const minSideDepth = Math.min(depth.bidDepth, depth.askDepth);
    if (minSideDepth < CRYPTO_MIN_BOOK_DEPTH_NOTIONAL) {
      return {
        pass: false,
        reason: `Crypto depth guard: min side depth ${Math.round(minSideDepth)} < ${Math.round(CRYPTO_MIN_BOOK_DEPTH_NOTIONAL)}.`
      };
    }
  }
  return { pass: true, reason: 'Crypto execution guards passed.' };
}
