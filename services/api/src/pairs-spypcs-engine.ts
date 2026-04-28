/**
 * SPY vs QQQ cross-asset ratio spread engine.
 *
 * Paper-mode journal entries are written directly to JOURNAL_LEDGER_PATH so
 * computeLaneRollups() in engine-views.ts picks them up (lane=pairs).
 *
 * Leg A: SPY  (broker: alpaca-paper)
 * Leg B: QQQ  (broker: alpaca-paper)
 *
 * SPY and QQQ have ~0.97 correlation — excellent pair for mean-reversion.
 * SPY: S&P 500 ETF (broad market)
 * QQQ: Nasdaq 100 ETF (tech-heavy growth)
 *
 * The spread widens when tech outpaces/sells off relative to broad market,
 * and reverts when the relationship normalizes.
 */

import fs from 'node:fs';
import { enqueueAppend } from './paper-engine/write-queue.js';
import type { PairsTradeState } from '@hermes/contracts';
import { feeBps } from './fee-model.js';

const LOOKBACK = 200;
const ENTRY_Z_THRESHOLD = 1.8;
const EXIT_Z_THRESHOLD = 0.3;
const STOP_Z_THRESHOLD = 3.5;
const CORRELATION_FLOOR = 0.70;
const MAX_HOLD_TICKS = 180;
const SIZE_FRACTION = 0.04;
// Both legs (SPY + QQQ) trade on Alpaca: ~1 bps/side equity commission.
// TODO: verify with actual Alpaca equity subscription/pricing model.
const FEE_BPS_PER_SIDE = feeBps('alpaca', 'taker');

interface PricePoint {
  spyPrice: number;
  qqqPrice: number;
  ratio: number;
  spread: number;
  beta: number;
  correlation: number;
  timestamp: number;
}

interface PairsPosition {
  direction: 'long-spread' | 'short-spread';
  entryRatio: number;
  entrySpread: number;
  entryZScore: number;
  entrySpyPrice: number;
  entryQqqPrice: number;
  spyQuantity: number;
  qqqQuantity: number;
  beta: number;
  entryTick: number;
  entryAt: string;
  legNotional: number;
}

export interface PairsFill {
  id: string;
  timestamp: string;
  entryAt: string;
  direction: 'long-spread' | 'short-spread';
  entryRatio: number;
  exitRatio: number;
  entrySpread: number;
  exitSpread: number;
  hedgeRatio: number;
  correlation: number;
  zScoreAtEntry: number;
  zScoreAtExit: number;
  pnl: number;
  holdTicks: number;
  reason: string;
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function covariance(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2 || a.length !== b.length) return 0;
  const meanA = average(a);
  const meanB = average(b);
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    total += (a[i]! - meanA) * (b[i]! - meanB);
  }
  return total / (a.length - 1);
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const denom = stddev(a) * stddev(b);
  if (denom <= 0) return 0;
  return covariance(a, b) / denom;
}

function round(value: number, decimals: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}

export class PairsSpyPcsEngine {
  private history: PricePoint[] = [];
  private position: PairsPosition | null = null;
  private cash: number;
  private readonly startingEquity: number;
  private tick = 0;
  private wins = 0;
  private losses = 0;
  private totalTrades = 0;
  private realizedPnl = 0;
  private fills: PairsFill[] = [];
  private drainedFillIds = new Set<string>();
  private allocationMultiplier = 1;
  private tradingEnabled = true;
  private blockedReason = 'enabled';
  private equityCurve: number[] = [];
  private readonly disabledPairs = new Set<string>();
  private readonly journalLedgerPath: string;

  private readonly paperMode = process.env.LIVE_TRADING !== '1';

  constructor(startingEquity: number, journalLedgerPath?: string) {
    this.startingEquity = startingEquity;
    this.cash = startingEquity;
    this.journalLedgerPath = journalLedgerPath ?? '';
    const envDisabled = process.env.HERMES_DISABLE_PAIRS ?? '';
    envDisabled.split(',').map((p) => p.trim()).filter(Boolean).forEach((pair) => {
      this.disabledPairs.add(pair);
    });
  }

  update(spyPrice: number, qqqPrice: number): void {
    if (spyPrice <= 0 || qqqPrice <= 0) return;
    this.tick += 1;

    const prices = this.history.slice(-(LOOKBACK - 1));
    const spySeries = [...prices.map((point) => point.spyPrice), spyPrice];
    const qqqSeries = [...prices.map((point) => point.qqqPrice), qqqPrice];
    const ratio = spyPrice / qqqPrice;
    const beta = computeLogBeta(spySeries, qqqSeries);
    const spread = Math.log(spyPrice) - beta * Math.log(qqqPrice);
    const corr = computeReturnCorrelation(spySeries, qqqSeries);

    this.history.push({
      spyPrice,
      qqqPrice,
      ratio,
      spread,
      beta,
      correlation: corr,
      timestamp: Date.now()
    });
    if (this.history.length > LOOKBACK * 3) {
      this.history = this.history.slice(-LOOKBACK * 3);
    }

    if (this.history.length < LOOKBACK) {
      this.equityCurve.push(this.getEquity(spyPrice, qqqPrice));
      return;
    }

    const window = this.history.slice(-LOOKBACK);
    const spreadSeries = window.map((point) => point.spread);
    const spreadMean = average(spreadSeries);
    const spreadStd = stddev(spreadSeries);
    const currentZ = spreadStd > 0 ? (spread - spreadMean) / spreadStd : 0;

    if (spreadStd < 0.0001 || corr < CORRELATION_FLOOR) {
      this.equityCurve.push(this.getEquity(spyPrice, qqqPrice));
      return;
    }

    if (this.position) {
      const holdTicks = this.tick - this.position.entryTick;
      const reverted = Math.abs(currentZ) <= EXIT_Z_THRESHOLD;
      const stopped = Math.abs(currentZ) >= STOP_Z_THRESHOLD;
      const timedOut = holdTicks >= MAX_HOLD_TICKS;
      const correlationBreak = corr < (CORRELATION_FLOOR * 0.6);

      if (reverted || stopped || timedOut || correlationBreak) {
        const reason = reverted
          ? 'reversion'
          : stopped
            ? 'stop-loss'
            : timedOut
              ? 'timeout'
              : 'correlation-break';
        this.closePosition(spyPrice, qqqPrice, spread, currentZ, corr, reason);
      }
    } else if (this.tradingEnabled && !this.disabledPairs.has('pairs-spypcs')) {
      if (corr >= CORRELATION_FLOOR && currentZ >= ENTRY_Z_THRESHOLD) {
        this.openPosition('short-spread', spyPrice, qqqPrice, ratio, spread, currentZ, beta, corr);
      } else if (corr >= CORRELATION_FLOOR && currentZ <= -ENTRY_Z_THRESHOLD) {
        this.openPosition('long-spread', spyPrice, qqqPrice, ratio, spread, currentZ, beta, corr);
      }
    }

    this.equityCurve.push(this.getEquity(spyPrice, qqqPrice));
  }

  getState(spyPrice: number, qqqPrice: number): PairsTradeState {
    const window = this.history.slice(-LOOKBACK);
    const ratios = window.map((point) => point.ratio);
    const spreads = window.map((point) => point.spread);
    const beta = window.at(-1)?.beta ?? 1;
    const corr = window.at(-1)?.correlation ?? 0;
    const ratio = spyPrice > 0 && qqqPrice > 0 ? spyPrice / qqqPrice : 0;
    const spread = spyPrice > 0 && qqqPrice > 0 ? Math.log(spyPrice) - beta * Math.log(qqqPrice) : 0;
    const spreadMean = average(spreads);
    const spreadStd = stddev(spreads);
    const zScore = spreadStd > 0 ? (spread - spreadMean) / spreadStd : 0;

    return {
      legA: 'SPY',
      legB: 'QQQ',
      ratio: round(ratio, 4),
      meanRatio: round(average(ratios), 4),
      stdRatio: round(stddev(ratios), 4),
      zScore: round(zScore, 2),
      position: this.position?.direction ?? 'flat',
      entryZScore: this.position ? round(this.position.entryZScore, 2) : 0,
      entryRatio: this.position ? round(this.position.entryRatio, 4) : 0,
      unrealizedPnl: this.getUnrealizedPnl(spyPrice, qqqPrice),
      hedgeRatio: round(beta, 4),
      correlation: round(corr, 4),
      spread: round(spread, 6),
      spreadMean: round(spreadMean, 6),
      spreadStd: round(spreadStd, 6)
    };
  }

  getStats() {
    return {
      equity: round(this.getEquity(this.history.at(-1)?.spyPrice ?? 0, this.history.at(-1)?.qqqPrice ?? 0), 2),
      realizedPnl: round(this.realizedPnl, 2),
      totalTrades: this.totalTrades,
      wins: this.wins,
      losses: this.losses,
      winRate: this.totalTrades > 0 ? round((this.wins / this.totalTrades) * 100, 1) : 0,
      allocationMultiplier: round(this.allocationMultiplier, 2),
      tradingEnabled: this.tradingEnabled,
      blockedReason: this.blockedReason,
      fills: [...this.fills],
      equityCurve: this.equityCurve.slice(-200)
    };
  }

  setTradingEnabled(enabled: boolean, reason: string): void {
    this.tradingEnabled = enabled;
    this.blockedReason = reason;
  }

  setAllocationMultiplier(multiplier: number): void {
    this.allocationMultiplier = Math.max(0.25, Math.min(multiplier, 2));
  }

  drainClosedFills(): PairsFill[] {
    const next = this.fills.filter((f) => !this.drainedFillIds.has(f.id));
    next.forEach((f) => this.drainedFillIds.add(f.id));
    return next;
  }

  private openPosition(
    direction: 'long-spread' | 'short-spread',
    spyPrice: number,
    qqqPrice: number,
    ratio: number,
    spread: number,
    zScore: number,
    beta: number,
    corr: number
  ): void {
    const legNotional = this.cash * SIZE_FRACTION * this.allocationMultiplier;
    if (legNotional < 50) return;

    const normalizedBeta = Math.max(0.3, Math.min(Math.abs(beta), 4));
    const spyQuantity = legNotional / spyPrice;
    const qqqQuantity = (legNotional * normalizedBeta) / qqqPrice;

    console.log(`[pairs-spypcs] OPEN pairs-spypcs direction=${direction} z=${zScore.toFixed(2)} corr=${corr.toFixed(3)} beta=${normalizedBeta.toFixed(3)} notional=${legNotional.toFixed(0)}`);
    this.cash -= legNotional * 2;
    this.position = {
      direction,
      entryRatio: ratio,
      entrySpread: spread,
      entryZScore: zScore,
      entrySpyPrice: spyPrice,
      entryQqqPrice: qqqPrice,
      spyQuantity,
      qqqQuantity,
      beta: normalizedBeta,
      entryTick: this.tick,
      entryAt: new Date().toISOString(),
      legNotional
    };
  }

  private closePosition(
    spyPrice: number,
    qqqPrice: number,
    exitSpread: number,
    exitZScore: number,
    corr: number,
    reason: string
  ): void {
    if (!this.position) return;
    const pos = this.position;
    const exitRatio = spyPrice / qqqPrice;

    let spyPnl: number;
    let qqqPnl: number;
    if (pos.direction === 'long-spread') {
      spyPnl = (spyPrice - pos.entrySpyPrice) * pos.spyQuantity;
      qqqPnl = (pos.entryQqqPrice - qqqPrice) * pos.qqqQuantity;
    } else {
      spyPnl = (pos.entrySpyPrice - spyPrice) * pos.spyQuantity;
      qqqPnl = (qqqPrice - pos.entryQqqPrice) * pos.qqqQuantity;
    }

    const fees = (pos.legNotional * 2) * (FEE_BPS_PER_SIDE / 10_000) * 2;
    const realized = spyPnl + qqqPnl - fees;

    this.cash += pos.legNotional * 2 + realized;
    this.realizedPnl += realized;
    this.totalTrades += 1;
    if (realized >= 0) this.wins += 1;
    else this.losses += 1;

    const fillId = `pairs-spypcs-${Date.now()}-${this.totalTrades}`;
    const pnlRounded = round(realized, 2);
    console.log(`[pairs-spypcs] CLOSE pairs-spypcs reason=${reason} pnl=${pnlRounded} zExit=${exitZScore.toFixed(2)} hold=${this.tick - pos.entryTick}ticks`);

    this.fills.push({
      id: fillId,
      timestamp: new Date().toISOString(),
      entryAt: pos.entryAt,
      direction: pos.direction,
      entryRatio: round(pos.entryRatio, 4),
      exitRatio: round(exitRatio, 4),
      entrySpread: round(pos.entrySpread, 6),
      exitSpread: round(exitSpread, 6),
      hedgeRatio: round(pos.beta, 4),
      correlation: round(corr, 4),
      zScoreAtEntry: round(pos.entryZScore, 2),
      zScoreAtExit: round(exitZScore, 2),
      pnl: pnlRounded,
      holdTicks: this.tick - pos.entryTick,
      reason
    });
    if (this.fills.length > 50) this.fills.shift();

    if (this.journalLedgerPath) {
      const journalEntry = {
        id: `journal-${fillId}`,
        symbol: 'SPY',
        assetClass: 'equity',
        broker: 'alpaca-paper',
        strategy: 'pairs-spypcs',
        strategyId: 'pairs-spypcs',
        lane: 'pairs',
        thesis: `SPY/QQQ equity pairs spread — ${pos.direction} at z=${round(pos.entryZScore, 2)}, beta=${round(pos.beta, 3)}, corr=${round(corr, 3)}`,
        entryAt: pos.entryAt,
        entryTimestamp: pos.entryAt,
        exitAt: new Date().toISOString(),
        realizedPnl: pnlRounded,
        realizedPnlPct: 0,
        slippageBps: 0.2,
        spreadBps: 0,
        confidencePct: Math.min(round(Math.abs(corr) * 100, 1), 100),
        regime: 'normal',
        newsBias: 'neutral',
        orderFlowBias: 'neutral',
        macroVeto: false,
        embargoed: false,
        tags: ['pair-trade', 'pairs-spypcs', reason],
        aiComment: `SPY/QQQ spread exit ${reason}. Entry z=${round(pos.entryZScore, 2)}, exit z=${round(exitZScore, 2)}, beta=${round(pos.beta, 3)}, corr=${round(corr, 3)}.`,
        exitReason: reason,
        verdict: pnlRounded > 0 ? 'winner' : pnlRounded < 0 ? 'loser' : 'scratch',
        source: 'simulated'
      };
      enqueueAppend(this.journalLedgerPath, JSON.stringify(journalEntry));
    }

    this.position = null;
  }

  private getUnrealizedPnl(spyPrice: number, qqqPrice: number): number {
    if (!this.position) return 0;
    const pos = this.position;
    let spyPnl: number;
    let qqqPnl: number;
    if (pos.direction === 'long-spread') {
      spyPnl = (spyPrice - pos.entrySpyPrice) * pos.spyQuantity;
      qqqPnl = (pos.entryQqqPrice - qqqPrice) * pos.qqqQuantity;
    } else {
      spyPnl = (pos.entrySpyPrice - spyPrice) * pos.spyQuantity;
      qqqPnl = (qqqPrice - pos.entryQqqPrice) * pos.qqqQuantity;
    }
    return round(spyPnl + qqqPnl, 2);
  }

  private getEquity(spyPrice: number, qqqPrice: number): number {
    return round(
      this.cash + (this.position
        ? this.position.legNotional * 2 + this.getUnrealizedPnl(spyPrice, qqqPrice)
        : 0),
      2
    );
  }
}

function computeLogBeta(spySeries: number[], qqqSeries: number[]): number {
  const logSpy = spySeries.map((value) => Math.log(Math.max(value, Number.EPSILON)));
  const logQqq = qqqSeries.map((value) => Math.log(Math.max(value, Number.EPSILON)));
  const varianceQqq = covariance(logQqq, logQqq);
  if (varianceQqq <= 0) return 1;
  return covariance(logSpy, logQqq) / varianceQqq;
}

function computeReturnCorrelation(spySeries: number[], qqqSeries: number[]): number {
  if (spySeries.length < 3 || qqqSeries.length < 3) return 0;
  const spyReturns: number[] = [];
  const qqqReturns: number[] = [];
  for (let i = 1; i < spySeries.length; i++) {
    const prevSpy = spySeries[i - 1]!;
    const prevQqq = qqqSeries[i - 1]!;
    if (prevSpy <= 0 || prevQqq <= 0) continue;
    spyReturns.push((spySeries[i]! - prevSpy) / prevSpy);
    qqqReturns.push((qqqSeries[i]! - prevQqq) / prevQqq);
  }
  return pearsonCorrelation(spyReturns, qqqReturns);
}
