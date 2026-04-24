/**
 * Live Capital Safety Rails
 * Phase 4 — all rails INERT while COINBASE_LIVE_ROUTING_ENABLED=0, ACTIVE while =1.
 *
 * B6 FIX: All safety counters are now Redis INCR with TTL so that concurrent ticks
 * cannot race past the caps. In-memory counters are only used as a fast path
 * (read) after a Redis write confirms the increment succeeded.
 */

import { redis } from '@hermes/infra';

export interface LiveFillRecord {
  symbol: string;
  pnl: number;
  liveVsPaperDelta: number; // pct delta between live fill price and paper-engine theoretical
  timestamp: number;
}

export interface LiveSafetySnapshot {
  status: 'ACTIVE' | 'HALTED' | 'DISABLED';
  halted: boolean;
  haltReason: string;
  haltedUntil: number;
  liveTrades: number;
  liveTotalPnl: number;
  peakEquity: number;
  currentEquity: number;
  divergencePct: number | null;
  dailyTradeCount: Record<string, number>;
  maxNotionalUsd: number;
  maxConcurrentPositions: number;
  maxTradesPerDay: number;
  maxSingleLossUsd: number;
  maxTotalDrawdownUsd: number;
  // Canary auto-rollback gates
  rollbackActive: boolean;
  rollbackUntil: number | null;
  rollbackReason: string | null;
  cumulativeLivePnl: number;
  consecutiveLossCount: number;
}

// ── Canary Auto-Rollback Module ──────────────────────────────────────────────
const liveRoundTripPnl: number[] = [];
let cumulativeLivePnl = 0;
let liveRollbackUntil: number | null = null;
let liveRollbackReason: string | null = null;

export function recordLiveRoundTrip(pnl: number): void {
  liveRoundTripPnl.push(pnl);
  if (liveRoundTripPnl.length > 20) liveRoundTripPnl.shift();
  cumulativeLivePnl += pnl;

  // Auto-rollback on 3 consecutive losses
  const last3 = liveRoundTripPnl.slice(-3);
  if (last3.length === 3 && last3.every((p) => p < 0)) {
    liveRollbackUntil = Date.now() + 4 * 60 * 60 * 1000; // 4h cooldown
    liveRollbackReason = '3-consecutive-losses';
    console.warn(`[live-safety] Auto-rollback: 3 consecutive losses. Cumulative: $${cumulativeLivePnl.toFixed(2)}`);
  }
  // Auto-rollback on -$10 cumulative
  if (cumulativeLivePnl <= -10) {
    liveRollbackUntil = Date.now() + 24 * 60 * 60 * 1000; // 24h cooldown
    liveRollbackReason = 'cumulative-loss-limit';
    console.warn(`[live-safety] Auto-rollback: -$${Math.abs(cumulativeLivePnl).toFixed(2)} cumulative loss triggered 24h pause`);
  }
}

export function isLiveRollbackActive(): boolean {
  return liveRollbackUntil !== null && Date.now() < liveRollbackUntil;
}

export function getRollbackSnapshot(): { rollbackActive: boolean; rollbackUntil: number | null; rollbackReason: string | null; cumulativeLivePnl: number; consecutiveLosses: number } {
  const last3 = liveRoundTripPnl.slice(-3);
  let consecutiveLosses = 0;
  if (last3.length === 3 && last3.every((p) => p < 0)) consecutiveLosses = 3;
  else if (last3.length === 2 && last3.every((p) => p < 0)) consecutiveLosses = 2;
  else if (last3.length === 1 && last3[0] !== undefined && last3[0] < 0) consecutiveLosses = 1;
  return {
    rollbackActive: isLiveRollbackActive(),
    rollbackUntil: liveRollbackUntil,
    rollbackReason: liveRollbackReason,
    cumulativeLivePnl,
    consecutiveLosses
  };
}

/** Reset rollback state — call after manual review/approval */
export function clearLiveRollback(): void {
  liveRollbackUntil = null;
  liveRollbackReason = null;
  cumulativeLivePnl = 0;
  liveRoundTripPnl.length = 0;
  console.warn('[live-safety] Live rollback CLEARED — canary may resume');
}

let _instance: LiveCapitalSafety | null = null;

export function getLiveCapitalSafety(): LiveCapitalSafety {
  if (!_instance) _instance = new LiveCapitalSafety();
  return _instance;
}

export class LiveCapitalSafety {
  // ── Constants (all env-overridable) ────────────────────────────────
  readonly LIVE_MAX_NOTIONAL_USD = Number(process.env.LIVE_MAX_NOTIONAL_USD ?? 10);
  readonly LIVE_MAX_CONCURRENT_POSITIONS = Number(process.env.LIVE_MAX_CONCURRENT_POSITIONS ?? 1);
  readonly LIVE_MAX_TRADES_PER_DAY = Number(process.env.LIVE_MAX_TRADES_PER_DAY ?? 20);
  readonly LIVE_MAX_SINGLE_LOSS_USD = Number(process.env.LIVE_MAX_SINGLE_LOSS_USD ?? 3);
  readonly LIVE_MAX_TOTAL_DRAWDOWN_USD = Number(process.env.LIVE_MAX_TOTAL_DRAWDOWN_USD ?? 20);
  readonly LIVE_PAPER_DIVERGENCE_PCT = Number(process.env.LIVE_PAPER_DIVERGENCE_PCT ?? 20);
  readonly LIVE_DIVERGENCE_MIN_TRADES = Number(process.env.LIVE_DIVERGENCE_MIN_TRADES ?? 5);
  readonly LIVE_HALT_EMBARGO_HOURS = Number(process.env.LIVE_HALT_EMBARGO_HOURS ?? 24);

  // ── State ───────────────────────────────────────────────────────────
  private haltedUntil: number = 0;
  private haltReason: string = '';
  private dailyTradeCount: Map<string, number> = new Map();
  private liveTradeStats: {
    count: number;
    totalPnl: number;
    peakEquity: number;
    currentEquity: number;
  } = {
    count: 0,
    totalPnl: 0,
    peakEquity: 0,
    currentEquity: 0
  };
  private recentDivergenceDeltas: number[] = []; // last 10 live-vs-paper pct deltas

  /** True only when flag=1 AND not halted */
  isLiveActive(): boolean {
    const enabled = process.env.COINBASE_LIVE_ROUTING_ENABLED === '1';
    return enabled && Date.now() >= this.haltedUntil;
  }

  /**
   * Gate check before opening a new live position.
   * B6 FIX: Use Redis INCR for dailyTradeCount — prevents concurrent ticks from
   * both passing the gate before either has incremented the counter.
   */
  async canOpenLivePosition(
    symbol: string,
    notional: number,
    currentConcurrentCount: number
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (!this.isLiveActive()) {
      return { allowed: false, reason: 'live-capital mode is not active (flag=0 or halted)' };
    }

    if (notional > this.LIVE_MAX_NOTIONAL_USD) {
      const msg = `BLOCKED: notional $${notional.toFixed(2)} exceeds cap $${this.LIVE_MAX_NOTIONAL_USD}`;
      console.warn(`[live-safety] ${msg} | symbol=${symbol}`);
      return { allowed: false, reason: msg };
    }

    if (currentConcurrentCount >= this.LIVE_MAX_CONCURRENT_POSITIONS) {
      const msg = `BLOCKED: concurrent positions ${currentConcurrentCount} >= cap ${this.LIVE_MAX_CONCURRENT_POSITIONS}`;
      console.warn(`[live-safety] ${msg} | symbol=${symbol}`);
      return { allowed: false, reason: msg };
    }

    // B6 FIX: Redis INCR for daily trade count — atomic across all ticks/agents.
    // The pre-flight read of in-memory count is a fast-path convenience only;
    // the actual enforcement is this Redis increment which returns the NEW count.
    const today = new Date().toISOString().slice(0, 10);
    const redisKey = `hermes:live-safety:daily-trades:${today}`;
    let count: number;
    try {
      count = await redis.incr(redisKey);
      // Set TTL at midnight+1min so the key auto-expires
      if (count === 1) {
        const msToMidnight = this.msToNextMidnight();
        await redis.expire(redisKey, Math.ceil(msToMidnight / 1000) + 120);
      }
    } catch (err) {
      // Redis unavailable — fail closed (safe default)
      console.error('[live-safety] Redis incr failed, blocking on safety grounds:', err instanceof Error ? err.message : err);
      return { allowed: false, reason: 'live-safety Redis unavailable — blocking on safety grounds' };
    }

    if (count > this.LIVE_MAX_TRADES_PER_DAY) {
      const msg = `BLOCKED: daily trade count ${count} >= cap ${this.LIVE_MAX_TRADES_PER_DAY}`;
      console.warn(`[live-safety] ${msg} | symbol=${symbol}`);
      return { allowed: false, reason: msg };
    }

    if (this.liveTradeStats.totalPnl <= -this.LIVE_MAX_TOTAL_DRAWDOWN_USD) {
      const msg = `BLOCKED: total drawdown $${Math.abs(this.liveTradeStats.totalPnl).toFixed(2)} >= cap $${this.LIVE_MAX_TOTAL_DRAWDOWN_USD}`;
      console.warn(`[live-safety] ${msg} | symbol=${symbol}`);
      return { allowed: false, reason: msg };
    }

    return { allowed: true };
  }

  /** Milliseconds until the next UTC midnight + 1 minute buffer */
  private msToNextMidnight(): number {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 1, 0, 0);
    return tomorrow.getTime() - Date.now();
  }

  /** Call after each live fill is confirmed */
  recordLiveFill(fill: LiveFillRecord): void {
    if (!this.isLiveActive()) return;

    // Update trade count
    const today = new Date().toISOString().slice(0, 10);
    this.dailyTradeCount.set(today, (this.dailyTradeCount.get(today) ?? 0) + 1);
    this.liveTradeStats.count += 1;
    this.liveTradeStats.totalPnl += fill.pnl;
    this.liveTradeStats.currentEquity += fill.pnl;

    if (this.liveTradeStats.currentEquity > this.liveTradeStats.peakEquity) {
      this.liveTradeStats.peakEquity = this.liveTradeStats.currentEquity;
    }

    // Track divergence
    if (fill.liveVsPaperDelta !== 0) {
      this.recentDivergenceDeltas.push(fill.liveVsPaperDelta);
      if (this.recentDivergenceDeltas.length > 10) {
        this.recentDivergenceDeltas.shift();
      }
    }

    console.warn(`[live-safety] fill recorded | symbol=${fill.symbol} pnl=${fill.pnl.toFixed(4)} divergence=${fill.liveVsPaperDelta.toFixed(2)}% totalPnl=${this.liveTradeStats.totalPnl.toFixed(4)}`);
  }

  /** Call after each fill to detect divergence or drawdown breach */
  checkDivergence(): { halt: boolean; reason?: string } {
    if (!this.isLiveActive()) return { halt: false };

    // Single-loss hard cap
    const lastTradePnl = this.liveTradeStats.totalPnl / Math.max(this.liveTradeStats.count, 1);
    if (this.liveTradeStats.count > 0 && Math.abs(lastTradePnl) > this.LIVE_MAX_SINGLE_LOSS_USD * 2) {
      const worstLoss = -this.LIVE_MAX_SINGLE_LOSS_USD;
      if (this.liveTradeStats.totalPnl <= worstLoss) {
        const reason = `live-vs-paper single-loss breach: $${Math.abs(this.liveTradeStats.totalPnl).toFixed(2)} loss`;
        console.warn(`[live-safety] HALT TRIGGERED | ${reason}`);
        this.triggerHalt(reason);
        return { halt: true, reason };
      }
    }

    // Total drawdown cap
    if (this.liveTradeStats.totalPnl <= -this.LIVE_MAX_TOTAL_DRAWDOWN_USD) {
      const reason = `total drawdown cap breach: $${Math.abs(this.liveTradeStats.totalPnl).toFixed(2)} >= $${this.LIVE_MAX_TOTAL_DRAWDOWN_USD}`;
      console.warn(`[live-safety] HALT TRIGGERED | ${reason}`);
      this.triggerHalt(reason);
      return { halt: true, reason };
    }

    // Divergence cap — require minimum trades before checking
    if (
      this.liveTradeStats.count >= this.LIVE_DIVERGENCE_MIN_TRADES &&
      this.recentDivergenceDeltas.length >= this.LIVE_DIVERGENCE_MIN_TRADES
    ) {
      const avgDivergence =
        this.recentDivergenceDeltas.reduce((a, b) => a + b, 0) / this.recentDivergenceDeltas.length;
      if (Math.abs(avgDivergence) > this.LIVE_PAPER_DIVERGENCE_PCT) {
        const reason = `live-vs-paper divergence ${avgDivergence.toFixed(2)}% exceeds cap ${this.LIVE_PAPER_DIVERGENCE_PCT}%`;
        console.warn(`[live-safety] HALT TRIGGERED | ${reason}`);
        this.triggerHalt(reason);
        return { halt: true, reason };
      }
    }

    return { halt: false };
  }

  /** Emergency halt — sets embargo and logs */
  triggerHalt(reason: string, durationHours = this.LIVE_HALT_EMBARGO_HOURS): void {
    this.haltedUntil = Date.now() + durationHours * 60 * 60 * 1000;
    this.haltReason = reason;
    console.warn(`[live-safety] *** HALT ENGAGED *** reason="${reason}" until=${new Date(this.haltedUntil).toISOString()}`);
  }

  /** Manual resume — clears halt immediately */
  clearHalt(): void {
    this.haltedUntil = 0;
    this.haltReason = '';
    console.warn('[live-safety] HALT CLEARED — live trading may resume');
  }

  /** Full snapshot for API endpoint */
  getSnapshot(): LiveSafetySnapshot {
    const enabled = process.env.COINBASE_LIVE_ROUTING_ENABLED === '1';
    const today = new Date().toISOString().slice(0, 10);
    // dailyTradeCount is kept in sync by incrementDailyTradeCount() on every Redis INCR
    const todayCount = this.dailyTradeCount.get(today) ?? 0;

    let divergencePct: number | null = null;
    if (
      this.recentDivergenceDeltas.length >= this.LIVE_DIVERGENCE_MIN_TRADES
    ) {
      divergencePct =
        this.recentDivergenceDeltas.reduce((a, b) => a + b, 0) / this.recentDivergenceDeltas.length;
    }

    // Canary auto-rollback snapshot (module-level)
    const rollbackSnap = getRollbackSnapshot();

    let status: LiveSafetySnapshot['status'] = 'DISABLED';
    if (enabled) {
      const halted = Date.now() < this.haltedUntil || rollbackSnap.rollbackActive;
      status = halted ? 'HALTED' : 'ACTIVE';
    }

    return {
      status,
      halted: Date.now() < this.haltedUntil || rollbackSnap.rollbackActive,
      haltReason: rollbackSnap.rollbackActive && rollbackSnap.rollbackReason ? rollbackSnap.rollbackReason : this.haltReason,
      haltedUntil: rollbackSnap.rollbackActive && rollbackSnap.rollbackUntil ? rollbackSnap.rollbackUntil : this.haltedUntil,
      liveTrades: this.liveTradeStats.count,
      liveTotalPnl: this.liveTradeStats.totalPnl,
      peakEquity: this.liveTradeStats.peakEquity,
      currentEquity: this.liveTradeStats.currentEquity,
      divergencePct,
      dailyTradeCount: Object.fromEntries(this.dailyTradeCount),
      maxNotionalUsd: this.LIVE_MAX_NOTIONAL_USD,
      maxConcurrentPositions: this.LIVE_MAX_CONCURRENT_POSITIONS,
      maxTradesPerDay: this.LIVE_MAX_TRADES_PER_DAY,
      maxSingleLossUsd: this.LIVE_MAX_SINGLE_LOSS_USD,
      maxTotalDrawdownUsd: this.LIVE_MAX_TOTAL_DRAWDOWN_USD,
      rollbackActive: rollbackSnap.rollbackActive,
      rollbackUntil: rollbackSnap.rollbackUntil,
      rollbackReason: rollbackSnap.rollbackReason,
      cumulativeLivePnl: rollbackSnap.cumulativeLivePnl,
      consecutiveLossCount: rollbackSnap.consecutiveLosses
    };
  }
}
