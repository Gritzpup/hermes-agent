// @ts-nocheck
import type { TradeJournalEntry } from '@hermes/contracts';
import type { SymbolState } from './types.js';
import {
  CRYPTO_MAX_ENTRY_SPREAD_BPS,
  CRYPTO_MAX_EST_SLIPPAGE_BPS,
  CRYPTO_MIN_BOOK_DEPTH_NOTIONAL,
  DAILY_CIRCUIT_BREAKER_DD_PCT,
  WEEKLY_CIRCUIT_BREAKER_DD_PCT,
  PER_PAIR_DAILY_LOSS_LIMIT_USD,
  EQUITY_DRAWDOWN_CIRCUIT_BREAKER_PCT,
} from './types.js';
import { round } from '../paper-engine-utils.js';

// COO FIX #1: Get current UTC date string for daily reset
export function getTodayUtc(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export function noteTradeOutcome(
  engine: any,
  agent: any,
  symbol: SymbolState,
  realized: number,
  reason: string
): void {
  // Reset daily PnL tracker at UTC midnight
  const today = getTodayUtc();
  if (engine.dailyLossResetDate !== today) {
    engine.dailyPnLBySymbol.clear();
    engine.dailyLossResetDate = today;
  }

  // COO FIX #1: Track per-symbol daily PnL and apply kill switch if limit exceeded
  if (realized < 0) {
    const currentLoss = engine.dailyPnLBySymbol.get(symbol.symbol) ?? 0;
    const newLoss = currentLoss + realized;
    engine.dailyPnLBySymbol.set(symbol.symbol, newLoss);

    if (newLoss <= -PER_PAIR_DAILY_LOSS_LIMIT_USD) {
      // Symbol hit daily loss limit — apply kill switch until tomorrow 00:00 UTC
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tomorrow.setUTCHours(0, 0, 0, 0);
      agent.symbolKillSwitchUntil = tomorrow.toISOString();
      agent.lastAction = `Daily loss limit hit: ${symbol.symbol} down \$${Math.abs(newLoss).toFixed(2)} > \$${PER_PAIR_DAILY_LOSS_LIMIT_USD} today. Paused until tomorrow.`;
      engine.recordEvent('daily-loss-limit-hit', {
        symbol: symbol.symbol,
        realized,
        dailyLoss: newLoss,
        limit: PER_PAIR_DAILY_LOSS_LIMIT_USD,
        agentId: agent.config.id
      });
    }
  }

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

    // COO FIX #2: Spread shock — only apply if it doesn't shorten an existing block.
    // If agent.symbolKillSwitchUntil (daily loss limit) is already set beyond 30 min,
    // keep the longer block in place.
    if (spreadShock) {
      const proposedBlockedMs = Date.now() + 30 * 60_000;
      // Don't shorten a block that's already longer (e.g. from daily loss limit)
      const symbolKillSwitchMs = agent.symbolKillSwitchUntil ? new Date(agent.symbolKillSwitchUntil).getTime() : 0;
      if (blockedUntilMs < proposedBlockedMs && (!symbolKillSwitchMs || proposedBlockedMs >= symbolKillSwitchMs)) {
        blockedUntilMs = proposedBlockedMs;
        blockReason = `Spread shock guard: ${symbol.spreadBps.toFixed(2)}bps on ${symbol.symbol}.`;
      }
    }

    // COO FIX #2: Loss streak — only block if it doesn't shorten an existing longer block.
    // If agent.symbolKillSwitchUntil (daily loss limit, e.g. ~24h) is already set, keep it.
    if (consecutiveLosses >= 3) {
      const proposedBlockedMs = Date.now() + 2 * 60 * 60_000;
      const symbolKillSwitchMs = agent.symbolKillSwitchUntil ? new Date(agent.symbolKillSwitchUntil).getTime() : 0;
      // Only apply the 2h streak block if it doesn't cut into the longer daily-loss block
      if (!symbolKillSwitchMs || proposedBlockedMs >= symbolKillSwitchMs) {
        blockedUntilMs = proposedBlockedMs;
        blockReason = `Loss streak guard: ${consecutiveLosses} consecutive losses on ${symbol.symbol} (${reason}).`;
      } else {
        // symbolKillSwitchUntil is longer — keep it and don't stack the 60-min block on top
        blockReason = blockReason || `Loss streak noted but superseded by daily loss limit on ${symbol.symbol}.`;
      }
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

// Half-threshold for auto-unlatch: recovery above this closes the gap enough to re-arm
const AUTO_UNLATCH_RECOVERY_PCT = 1.5;
const AUTO_UNLATCH_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Flattens all open positions synchronously when the circuit breaker fires. */
function flattenAllPositions(engine: any, reason: string): void {
  for (const agent of engine.agents.values()) {
    if (!agent.position) continue;
    const symbol = engine.market.get(agent.config.symbol);
    if (!symbol) continue;
    engine.closePosition(agent, symbol, reason);
  }
}

export function evaluatePortfolioCircuitBreaker(engine: any): void {
  // COO FIX #5: Equity-curve circuit breaker — flatten all if real broker equity drops >10% from HWM.
  // COO FIX: Only use REAL broker equity (Alpaca + OANDA) — Coinbase is paper-simulated.
  // COO FIX: Added 5min warmup to avoid false positives during broker sync initialization.
  const ENGINE_WARMUP_MS = 5 * 60 * 1000;
  if (engine.startedAt && Date.now() - new Date(engine.startedAt).getTime() < ENGINE_WARMUP_MS) {
    return; // Still in warmup — skip equity circuit breaker evaluation
  }
  // B3 FIX: Compute equity EXCLUDING Coinbase paper-simulated agents.
  // The old code used getDeskEquity() which sums all agent equity (including coinbase-live
  // paper-simulated agents), inflating the HWM by ~$100K of fake Coinbase paper profit.
  // This caused the circuit breaker to fire ~$5K late on a $300K book.
  // Filter out coinbase-live agents — their equity is simulated, not real broker equity.
  const deskEquity = Math.max(
    Array.from((engine as any).agents.values())
      .filter((a: any) => a.config.broker !== 'coinbase-live')
      .reduce((sum: number, a: any) => sum + engine.getAgentEquity(a), 0),
    1
  );
  // Update high-water mark only upward (never tracks losses down)
  engine.equityHighWaterMark = Math.max(engine.equityHighWaterMark, deskEquity);
  const drawdownPct = ((engine.equityHighWaterMark - deskEquity) / engine.equityHighWaterMark) * 100;
  if (drawdownPct >= EQUITY_DRAWDOWN_CIRCUIT_BREAKER_PCT && !engine.circuitBreakerLatched) {
    engine.circuitBreakerLatched = true;
    engine.circuitBreakerScope = 'operational';
    engine.circuitBreakerReason = `Equity drawdown circuit breaker: ${drawdownPct.toFixed(2)}% loss from high-water $${engine.equityHighWaterMark.toFixed(2)} (equity=$${deskEquity.toFixed(2)}).`;
    engine.circuitBreakerArmedAt = new Date().toISOString();
    engine.circuitBreakerReviewed = false;
    engine.recordEvent('equity-drawdown-circuit-breaker', {
      drawdownPct: Math.round(drawdownPct * 100) / 100,
      equity: deskEquity,
      highWater: engine.equityHighWaterMark
    });
    flattenAllPositions(engine, 'equity-drawdown circuit breaker flatten (all positions)');
    return;
  }

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
  const dayLossPct = (-dayPnl / deskEquity) * 100;
  const weekLossPct = (-weekPnl / deskEquity) * 100;

  // ── Auto-unlatch: 24h elapsed AND drawdown has recovered to < half the trigger threshold ──
  if (engine.circuitBreakerLatched && engine.circuitBreakerArmedAt) {
    const elapsedMs = now.getTime() - new Date(engine.circuitBreakerArmedAt).getTime();
    const isRecovered =
      (engine.circuitBreakerScope === 'daily' && dayLossPct < AUTO_UNLATCH_RECOVERY_PCT) ||
      (engine.circuitBreakerScope === 'weekly' && weekLossPct < AUTO_UNLATCH_RECOVERY_PCT) ||
      (engine.circuitBreakerScope === 'operational');
    if (elapsedMs >= AUTO_UNLATCH_GRACE_MS && isRecovered) {
      engine.circuitBreakerLatched = false;
      engine.circuitBreakerScope = 'none';
      engine.circuitBreakerReason = '';
      engine.circuitBreakerArmedAt = null;
      engine.circuitBreakerReviewed = false;
      engine.recordEvent('circuit-breaker-auto-unlatch', {
        scope: engine.circuitBreakerScope,
        elapsedMs,
        dayLossPct: round(dayLossPct, 2),
        weekLossPct: round(weekLossPct, 2)
      });
      return;
    }
  }

  // ── Latch on breach ──
  if (!engine.circuitBreakerLatched && dayLossPct >= DAILY_CIRCUIT_BREAKER_DD_PCT) {
    engine.circuitBreakerLatched = true;
    engine.circuitBreakerScope = 'daily';
    engine.circuitBreakerReason = `Daily drawdown exceeded ${DAILY_CIRCUIT_BREAKER_DD_PCT.toFixed(1)}% (${dayLossPct.toFixed(2)}%).`;
    engine.circuitBreakerArmedAt = new Date().toISOString();
    engine.circuitBreakerReviewed = false;
    engine.recordEvent('circuit-breaker', { scope: 'daily', reason: engine.circuitBreakerReason, dayLossPct: round(dayLossPct, 2) });
    flattenAllPositions(engine, 'circuit-breaker flatten (daily)');
    return;
  }

  if (!engine.circuitBreakerLatched && weekLossPct >= WEEKLY_CIRCUIT_BREAKER_DD_PCT) {
    engine.circuitBreakerLatched = true;
    engine.circuitBreakerScope = 'weekly';
    engine.circuitBreakerReason = `Weekly drawdown exceeded ${WEEKLY_CIRCUIT_BREAKER_DD_PCT.toFixed(1)}% (${weekLossPct.toFixed(2)}%).`;
    engine.circuitBreakerArmedAt = new Date().toISOString();
    engine.circuitBreakerReviewed = false;
    engine.recordEvent('circuit-breaker', { scope: 'weekly', reason: engine.circuitBreakerReason, weekLossPct: round(weekLossPct, 2) });
    flattenAllPositions(engine, 'circuit-breaker flatten (weekly)');
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
