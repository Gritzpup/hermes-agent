/**
 * Dynamic hedge-ratio pairs engine.
 *
 * Paper-mode journal entries are written directly to JOURNAL_LEDGER_PATH so
 * computeLaneRollups() in engine-views.ts picks them up (lane=pairs).
 *
 * Upgrades the simple BTC/ETH ratio trade to a rolling-regression spread trade:
 * - hedge ratio beta = cov(BTC, ETH) / var(ETH)
 * - spread = BTC - beta * ETH
 * - z-score measured on the spread, not raw ratio alone
 * - correlation gate prevents trades when pair cohesion breaks
 */

import fs from 'node:fs';
import { enqueueAppend } from './paper-engine/write-queue.js';
import type { PairsTradeState } from '@hermes/contracts';
import { feeBps } from './fee-model.js';

const LOOKBACK = 150;
const ENTRY_Z_THRESHOLD = 2.0;
const EXIT_Z_THRESHOLD = 0.35;
const STOP_Z_THRESHOLD = 4.2;
const MIN_CORRELATION = 0.55;
const MAX_HOLD_TICKS = 220;
const SIZE_FRACTION = 0.04;
// Coinbase Advanced Tier 1 taker: 80 bps/side. Pairs are market orders (taker).
// Updated from flat 5 bps to reflect real Coinbase Advanced fee schedule.
const FEE_BPS_PER_SIDE = feeBps('coinbase', 'taker');

interface PricePoint {
  btcPrice: number;
  ethPrice: number;
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
  entryBtcPrice: number;
  entryEthPrice: number;
  btcQuantity: number;
  ethQuantity: number;
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

function correlation(a: number[], b: number[]): number {
  const denom = stddev(a) * stddev(b);
  if (denom <= 0) return 0;
  return covariance(a, b) / denom;
}

function round(value: number, decimals: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}

export class PairsEngine {
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

  constructor(startingEquity: number, journalLedgerPath?: string) {
    this.startingEquity = startingEquity;
    this.cash = startingEquity;
    this.journalLedgerPath = journalLedgerPath ?? '';
    // Freeze agent-arb-btc due to structural 0% win rate over 145 trades.
    // BTC secular uptrend breaks BTC/ETH mean-reversion assumption.
    this.disabledPairs.add('agent-arb-btc');
    const envDisabled = process.env.HERMES_DISABLE_PAIRS ?? '';
    envDisabled.split(',').map((p) => p.trim()).filter(Boolean).forEach((pair) => {
      this.disabledPairs.add(pair);
    });
  }

  update(btcPrice: number, ethPrice: number): void {
    if (btcPrice <= 0 || ethPrice <= 0) return;
    this.tick += 1;

    const prices = this.history.slice(-(LOOKBACK - 1));
    const btcSeries = [...prices.map((point) => point.btcPrice), btcPrice];
    const ethSeries = [...prices.map((point) => point.ethPrice), ethPrice];
    const ratio = btcPrice / ethPrice;
    const beta = computeLogBeta(btcSeries, ethSeries);
    const spread = Math.log(btcPrice) - beta * Math.log(ethPrice);
    const corr = computeReturnCorrelation(btcSeries, ethSeries);

    this.history.push({
      btcPrice,
      ethPrice,
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
      this.equityCurve.push(this.getEquity(btcPrice, ethPrice));
      return;
    }

    const window = this.history.slice(-LOOKBACK);
    const spreadSeries = window.map((point) => point.spread);
    const spreadMean = average(spreadSeries);
    const spreadStd = stddev(spreadSeries);
    const currentZ = spreadStd > 0 ? (spread - spreadMean) / spreadStd : 0;

    if (spreadStd < 0.0005 || corr < 0.1) {
      this.equityCurve.push(this.getEquity(btcPrice, ethPrice));
      return;
    }

    if (this.position) {
      const holdTicks = this.tick - this.position.entryTick;
      const reverted = Math.abs(currentZ) <= EXIT_Z_THRESHOLD;
      const stopped = Math.abs(currentZ) >= STOP_Z_THRESHOLD;
      const timedOut = holdTicks >= MAX_HOLD_TICKS;
      const correlationBreak = corr < 0.35;

      if (reverted || stopped || timedOut || correlationBreak) {
        const reason = reverted
          ? 'reversion'
          : stopped
            ? 'stop-loss'
            : timedOut
              ? 'timeout'
              : 'correlation-break';
        this.closePosition(btcPrice, ethPrice, spread, currentZ, corr, reason);
      }
    } else if (this.tradingEnabled && !this.disabledPairs.has('pairs-btc-eth') && !this.disabledPairs.has('agent-arb-btc')) {
      if (corr >= MIN_CORRELATION && currentZ >= ENTRY_Z_THRESHOLD) {
        this.openPosition('short-spread', btcPrice, ethPrice, ratio, spread, currentZ, beta, corr);
      } else if (corr >= MIN_CORRELATION && currentZ <= -ENTRY_Z_THRESHOLD) {
        this.openPosition('long-spread', btcPrice, ethPrice, ratio, spread, currentZ, beta, corr);
      } else {
        // Log periodic evaluation so we know the engine is running
        if (this.tick % 60 === 0) {
          console.log(`[pairs-engine] tick=${this.tick} z=${currentZ.toFixed(2)} corr=${corr.toFixed(3)} BTC=${btcPrice} ETH=${ethPrice} — no entry, awaiting z >= ${ENTRY_Z_THRESHOLD} or <= ${-ENTRY_Z_THRESHOLD} with corr >= ${MIN_CORRELATION}`);
        }
      }
    }

    this.equityCurve.push(this.getEquity(btcPrice, ethPrice));
  }

  getState(btcPrice: number, ethPrice: number): PairsTradeState {
    const window = this.history.slice(-LOOKBACK);
    const ratios = window.map((point) => point.ratio);
    const spreads = window.map((point) => point.spread);
    const beta = window.at(-1)?.beta ?? 1;
    const corr = window.at(-1)?.correlation ?? 0;
    const ratio = btcPrice > 0 && ethPrice > 0 ? btcPrice / ethPrice : 0;
    const spread = btcPrice > 0 && ethPrice > 0 ? Math.log(btcPrice) - beta * Math.log(ethPrice) : 0;
    const spreadMean = average(spreads);
    const spreadStd = stddev(spreads);
    const zScore = spreadStd > 0 ? (spread - spreadMean) / spreadStd : 0;

    return {
      legA: 'BTC-USD',
      legB: 'ETH-USD',
      ratio: round(ratio, 4),
      meanRatio: round(average(ratios), 4),
      stdRatio: round(stddev(ratios), 4),
      zScore: round(zScore, 2),
      position: this.position?.direction ?? 'flat',
      entryZScore: this.position ? round(this.position.entryZScore, 2) : 0,
      entryRatio: this.position ? round(this.position.entryRatio, 4) : 0,
      unrealizedPnl: this.getUnrealizedPnl(btcPrice, ethPrice),
      hedgeRatio: round(beta, 4),
      correlation: round(corr, 4),
      spread: round(spread, 6),
      spreadMean: round(spreadMean, 6),
      spreadStd: round(spreadStd, 6)
    };
  }

  getStats() {
    return {
      equity: round(this.getEquity(this.history.at(-1)?.btcPrice ?? 0, this.history.at(-1)?.ethPrice ?? 0), 2),
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
    btcPrice: number,
    ethPrice: number,
    ratio: number,
    spread: number,
    zScore: number,
    beta: number,
    corr: number
  ): void {
    const legNotional = this.cash * SIZE_FRACTION * this.allocationMultiplier;
    if (legNotional < 100) return;

    const normalizedBeta = Math.max(0.2, Math.min(Math.abs(beta), 4));
    const btcQuantity = legNotional / btcPrice;
    const ethQuantity = (legNotional * normalizedBeta) / ethPrice;

    console.log(`[pairs-engine] OPEN pairs-btc-eth direction=${direction} z=${zScore.toFixed(2)} corr=${corr.toFixed(3)} beta=${normalizedBeta.toFixed(3)} notional=${legNotional.toFixed(0)}`);
    this.cash -= legNotional * 2;
    this.position = {
      direction,
      entryRatio: ratio,
      entrySpread: spread,
      entryZScore: zScore,
      entryBtcPrice: btcPrice,
      entryEthPrice: ethPrice,
      btcQuantity,
      ethQuantity,
      beta: normalizedBeta,
      entryTick: this.tick,
      entryAt: new Date().toISOString(),
      legNotional
    };
  }

  private closePosition(
    btcPrice: number,
    ethPrice: number,
    exitSpread: number,
    exitZScore: number,
    corr: number,
    reason: string
  ): void {
    if (!this.position) return;
    const pos = this.position;
    const exitRatio = btcPrice / ethPrice;

    let btcPnl: number;
    let ethPnl: number;
    if (pos.direction === 'long-spread') {
      btcPnl = (btcPrice - pos.entryBtcPrice) * pos.btcQuantity;
      ethPnl = (pos.entryEthPrice - ethPrice) * pos.ethQuantity;
    } else {
      btcPnl = (pos.entryBtcPrice - btcPrice) * pos.btcQuantity;
      ethPnl = (ethPrice - pos.entryEthPrice) * pos.ethQuantity;
    }

    const fees = (pos.legNotional * 2) * (FEE_BPS_PER_SIDE / 10_000) * 2;
    const realized = btcPnl + ethPnl - fees;

    this.cash += pos.legNotional * 2 + realized;
    this.realizedPnl += realized;
    this.totalTrades += 1;
    if (realized >= 0) this.wins += 1;
    else this.losses += 1;

    const fillId = `pairs-btc-eth-${Date.now()}-${this.totalTrades}`;
    const pnlRounded = round(realized, 2);
    console.log(`[pairs-engine] CLOSE pairs-btc-eth reason=${reason} pnl=${pnlRounded} zExit=${exitZScore.toFixed(2)} hold=${this.tick - pos.entryTick}ticks`);

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

    // Write directly to JOURNAL_LEDGER_PATH so computeLaneRollups() picks it up
    if (this.journalLedgerPath) {
      const journalEntry = {
        id: `journal-${fillId}`,
        symbol: 'BTC-USD',
        assetClass: 'crypto',
        broker: 'coinbase-live',
        strategy: 'pairs-btc-eth',
        strategyId: 'pairs-btc-eth',
        lane: 'pairs',
        thesis: `BTC/ETH dynamic hedge spread — ${pos.direction} at z=${round(pos.entryZScore, 2)}, beta=${round(pos.beta, 3)}, corr=${round(corr, 3)}`,
        entryAt: pos.entryAt,
        entryTimestamp: pos.entryAt,
        exitAt: new Date().toISOString(),
        realizedPnl: pnlRounded,
        realizedPnlPct: 0,
        slippageBps: 0.5,
        spreadBps: 0,
        confidencePct: Math.min(round(Math.abs(corr) * 100, 1), 100),
        regime: 'normal',
        newsBias: 'neutral',
        orderFlowBias: 'neutral',
        macroVeto: false,
        embargoed: false,
        tags: ['pair-trade', 'pairs-btc-eth', reason],
        aiComment: `BTC/ETH spread exit ${reason}. Entry z=${round(pos.entryZScore, 2)}, exit z=${round(exitZScore, 2)}, beta=${round(pos.beta, 3)}, corr=${round(corr, 3)}.`,
        exitReason: reason,
        verdict: pnlRounded > 0 ? 'winner' : pnlRounded < 0 ? 'loser' : 'scratch',
        source: 'simulated'
      };
      enqueueAppend(this.journalLedgerPath, JSON.stringify(journalEntry));
    }

    this.position = null;
  }

  private getUnrealizedPnl(btcPrice: number, ethPrice: number): number {
    if (!this.position) return 0;
    const pos = this.position;
    let btcPnl: number;
    let ethPnl: number;
    if (pos.direction === 'long-spread') {
      btcPnl = (btcPrice - pos.entryBtcPrice) * pos.btcQuantity;
      ethPnl = (pos.entryEthPrice - ethPrice) * pos.ethQuantity;
    } else {
      btcPnl = (pos.entryBtcPrice - btcPrice) * pos.btcQuantity;
      ethPnl = (ethPrice - pos.entryEthPrice) * pos.ethQuantity;
    }
    return round(btcPnl + ethPnl, 2);
  }

  private getEquity(btcPrice: number, ethPrice: number): number {
    return round(this.cash + (this.position ? this.position.legNotional * 2 + this.getUnrealizedPnl(btcPrice, ethPrice) : 0), 2);
  }
}

function computeLogBeta(btcSeries: number[], ethSeries: number[]): number {
  const logBtc = btcSeries.map((value) => Math.log(Math.max(value, Number.EPSILON)));
  const logEth = ethSeries.map((value) => Math.log(Math.max(value, Number.EPSILON)));
  const varianceEth = covariance(logEth, logEth);
  if (varianceEth <= 0) return 1;
  return covariance(logBtc, logEth) / varianceEth;
}

function computeReturnCorrelation(btcSeries: number[], ethSeries: number[]): number {
  if (btcSeries.length < 3 || ethSeries.length < 3) return 0;
  const btcReturns: number[] = [];
  const ethReturns: number[] = [];
  for (let i = 1; i < btcSeries.length; i++) {
    const prevBtc = btcSeries[i - 1]!;
    const prevEth = ethSeries[i - 1]!;
    if (prevBtc <= 0 || prevEth <= 0) continue;
    btcReturns.push((btcSeries[i]! - prevBtc) / prevBtc);
    ethReturns.push((ethSeries[i]! - prevEth) / prevEth);
  }
  return correlation(btcReturns, ethReturns);
}
