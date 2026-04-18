/**
 * XAU/USD vs BTC/USD cross-asset ratio spread engine.
 *
 * Paper-mode journal entries are written directly to JOURNAL_LEDGER_PATH so
 * computeLaneRollups() in engine-views.ts picks them up (lane=pairs).
 *
 * NOTE: crossBrokerEnabled gates LIVE multi-broker execution only. In paper
 * mode the engine runs unblocked regardless of CROSS_BROKER_ENABLED.
 *
 * Mirrors PairsEngine structure but for the gold/bitcoin cross-asset spread.
 * Leg A: XAU_USD  (broker: oanda-rest)
 * Leg B: BTC-USD  (broker: coinbase-live)
 */

import fs from 'node:fs';
import type { PairsTradeState } from '@hermes/contracts';

const LOOKBACK = 200;
const ENTRY_Z_THRESHOLD = 1.8;
const EXIT_Z_THRESHOLD = 0.3;
const STOP_Z_THRESHOLD = 3.5;
const CORRELATION_FLOOR = 0.6;
const MAX_HOLD_TICKS = 180;
const SIZE_FRACTION = 0.04;
const FEE_BPS_PER_SIDE = 5;

interface PricePoint {
  xauPrice: number;
  btcPrice: number;
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
  entryXauPrice: number;
  entryBtcPrice: number;
  xauQuantity: number;
  btcQuantity: number;
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

export class PairsXauBtcEngine {
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
  private drainedFillCount = 0;
  private allocationMultiplier = 1;
  private tradingEnabled = true;
  private blockedReason = 'enabled';
  private equityCurve: number[] = [];
  private readonly disabledPairs = new Set<string>();
  private readonly journalLedgerPath: string;

  // crossBrokerEnabled gates LIVE multi-broker execution only.
  // In paper mode (LIVE_TRADING != '1') entries fire freely.
  private readonly crossBrokerEnabled = process.env.CROSS_BROKER_ENABLED === '1';
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

  update(xauPrice: number, btcPrice: number): void {
    if (xauPrice <= 0 || btcPrice <= 0) return;
    this.tick += 1;

    const prices = this.history.slice(-(LOOKBACK - 1));
    const xauSeries = [...prices.map((point) => point.xauPrice), xauPrice];
    const btcSeries = [...prices.map((point) => point.btcPrice), btcPrice];
    const ratio = xauPrice / btcPrice;
    const beta = computeLogBeta(xauSeries, btcSeries);
    const spread = Math.log(xauPrice) - beta * Math.log(btcPrice);
    const corr = computeReturnCorrelation(xauSeries, btcSeries);

    this.history.push({
      xauPrice,
      btcPrice,
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
      this.equityCurve.push(this.getEquity(xauPrice, btcPrice));
      return;
    }

    const window = this.history.slice(-LOOKBACK);
    const spreadSeries = window.map((point) => point.spread);
    const spreadMean = average(spreadSeries);
    const spreadStd = stddev(spreadSeries);
    const currentZ = spreadStd > 0 ? (spread - spreadMean) / spreadStd : 0;

    if (spreadStd < 0.0005 || corr < 0.1) {
      this.equityCurve.push(this.getEquity(xauPrice, btcPrice));
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
        this.closePosition(xauPrice, btcPrice, spread, currentZ, corr, reason);
      }
    } else if (this.tradingEnabled && !this.disabledPairs.has('pairs-xau-btc')) {
      // Gate only for live trading; paper mode always allowed.
      if (!this.crossBrokerEnabled && !this.paperMode) {
        this.equityCurve.push(this.getEquity(xauPrice, btcPrice));
        if (this.tick % 60 === 0) {
          console.log(`[pairs-xau-btc] tick=${this.tick} z=${currentZ.toFixed(2)} corr=${corr.toFixed(3)} — live execution gated (CROSS_BROKER_ENABLED not set)`);
        }
        return;
      }
      if (corr >= CORRELATION_FLOOR && currentZ >= ENTRY_Z_THRESHOLD) {
        this.openPosition('short-spread', xauPrice, btcPrice, ratio, spread, currentZ, beta, corr);
      } else if (corr >= CORRELATION_FLOOR && currentZ <= -ENTRY_Z_THRESHOLD) {
        this.openPosition('long-spread', xauPrice, btcPrice, ratio, spread, currentZ, beta, corr);
      } else {
        if (this.tick % 60 === 0) {
          console.log(`[pairs-xau-btc] tick=${this.tick} z=${currentZ.toFixed(2)} corr=${corr.toFixed(3)} XAU=${xauPrice} BTC=${btcPrice} — no entry, awaiting z >= ${ENTRY_Z_THRESHOLD} or <= ${-ENTRY_Z_THRESHOLD} with corr >= ${CORRELATION_FLOOR}`);
        }
      }
    }

    this.equityCurve.push(this.getEquity(xauPrice, btcPrice));
  }

  getState(xauPrice: number, btcPrice: number): PairsTradeState {
    const window = this.history.slice(-LOOKBACK);
    const ratios = window.map((point) => point.ratio);
    const spreads = window.map((point) => point.spread);
    const beta = window.at(-1)?.beta ?? 1;
    const corr = window.at(-1)?.correlation ?? 0;
    const ratio = xauPrice > 0 && btcPrice > 0 ? xauPrice / btcPrice : 0;
    const spread = xauPrice > 0 && btcPrice > 0 ? Math.log(xauPrice) - beta * Math.log(btcPrice) : 0;
    const spreadMean = average(spreads);
    const spreadStd = stddev(spreads);
    const zScore = spreadStd > 0 ? (spread - spreadMean) / spreadStd : 0;

    return {
      legA: 'XAU_USD',
      legB: 'BTC-USD',
      ratio: round(ratio, 4),
      meanRatio: round(average(ratios), 4),
      stdRatio: round(stddev(ratios), 4),
      zScore: round(zScore, 2),
      position: this.position?.direction ?? 'flat',
      entryZScore: this.position ? round(this.position.entryZScore, 2) : 0,
      entryRatio: this.position ? round(this.position.entryRatio, 4) : 0,
      unrealizedPnl: this.getUnrealizedPnl(xauPrice, btcPrice),
      hedgeRatio: round(beta, 4),
      correlation: round(corr, 4),
      spread: round(spread, 6),
      spreadMean: round(spreadMean, 6),
      spreadStd: round(spreadStd, 6)
    };
  }

  getStats() {
    return {
      equity: round(this.getEquity(this.history.at(-1)?.xauPrice ?? 0, this.history.at(-1)?.btcPrice ?? 0), 2),
      realizedPnl: round(this.realizedPnl, 2),
      totalTrades: this.totalTrades,
      wins: this.wins,
      losses: this.losses,
      winRate: this.totalTrades > 0 ? round((this.wins / this.totalTrades) * 100, 1) : 0,
      allocationMultiplier: round(this.allocationMultiplier, 2),
      tradingEnabled: this.tradingEnabled,
      blockedReason: this.blockedReason,
      fills: [...this.fills],
      equityCurve: this.equityCurve.slice(-200),
      // cross-broker status for monitoring
      crossBrokerEnabled: this.crossBrokerEnabled
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
    const next = this.fills.slice(this.drainedFillCount);
    this.drainedFillCount = this.fills.length;
    return next;
  }

  private openPosition(
    direction: 'long-spread' | 'short-spread',
    xauPrice: number,
    btcPrice: number,
    ratio: number,
    spread: number,
    zScore: number,
    beta: number,
    corr: number
  ): void {
    const legNotional = this.cash * SIZE_FRACTION * this.allocationMultiplier;
    if (legNotional < 100) return;

    const normalizedBeta = Math.max(0.2, Math.min(Math.abs(beta), 4));
    const xauQuantity = legNotional / xauPrice;
    const btcQuantity = (legNotional * normalizedBeta) / btcPrice;

    console.log(`[pairs-xau-btc] OPEN pairs-xau-btc direction=${direction} z=${zScore.toFixed(2)} corr=${corr.toFixed(3)} beta=${normalizedBeta.toFixed(3)} notional=${legNotional.toFixed(0)}`);
    this.cash -= legNotional * 2;
    this.position = {
      direction,
      entryRatio: ratio,
      entrySpread: spread,
      entryZScore: zScore,
      entryXauPrice: xauPrice,
      entryBtcPrice: btcPrice,
      xauQuantity,
      btcQuantity,
      beta: normalizedBeta,
      entryTick: this.tick,
      entryAt: new Date().toISOString(),
      legNotional
    };
  }

  private closePosition(
    xauPrice: number,
    btcPrice: number,
    exitSpread: number,
    exitZScore: number,
    corr: number,
    reason: string
  ): void {
    if (!this.position) return;
    const pos = this.position;
    const exitRatio = xauPrice / btcPrice;

    let xauPnl: number;
    let btcPnl: number;
    if (pos.direction === 'long-spread') {
      xauPnl = (xauPrice - pos.entryXauPrice) * pos.xauQuantity;
      btcPnl = (pos.entryBtcPrice - btcPrice) * pos.btcQuantity;
    } else {
      xauPnl = (pos.entryXauPrice - xauPrice) * pos.xauQuantity;
      btcPnl = (btcPrice - pos.entryBtcPrice) * pos.btcQuantity;
    }

    const fees = (pos.legNotional * 2) * (FEE_BPS_PER_SIDE / 10_000) * 2;
    const realized = xauPnl + btcPnl - fees;

    this.cash += pos.legNotional * 2 + realized;
    this.realizedPnl += realized;
    this.totalTrades += 1;
    if (realized >= 0) this.wins += 1;
    else this.losses += 1;

    const fillId = `pairs-xau-btc-${Date.now()}-${this.totalTrades}`;
    const pnlRounded = round(realized, 2);
    console.log(`[pairs-xau-btc] CLOSE pairs-xau-btc reason=${reason} pnl=${pnlRounded} zExit=${exitZScore.toFixed(2)} hold=${this.tick - pos.entryTick}ticks`);

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
        strategy: 'pairs-xau-btc',
        strategyId: 'pairs-xau-btc',
        lane: 'pairs',
        thesis: `XAU/BTC cross-asset spread — ${pos.direction} at z=${round(pos.entryZScore, 2)}, beta=${round(pos.beta, 3)}, corr=${round(corr, 3)}`,
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
        tags: ['pair-trade', 'pairs-xau-btc', reason],
        aiComment: `XAU/BTC spread exit ${reason}. Entry z=${round(pos.entryZScore, 2)}, exit z=${round(exitZScore, 2)}, beta=${round(pos.beta, 3)}, corr=${round(corr, 3)}.`,
        exitReason: reason,
        verdict: pnlRounded > 0 ? 'winner' : pnlRounded < 0 ? 'loser' : 'scratch',
        source: 'simulated'
      };
      try {
        fs.appendFileSync(this.journalLedgerPath, JSON.stringify(journalEntry) + '\n');
      } catch (err) {
        console.error('[pairs-xau-btc] Failed to write journal entry:', err);
      }
    }

    this.position = null;
  }

  private getUnrealizedPnl(xauPrice: number, btcPrice: number): number {
    if (!this.position) return 0;
    const pos = this.position;
    let xauPnl: number;
    let btcPnl: number;
    if (pos.direction === 'long-spread') {
      xauPnl = (xauPrice - pos.entryXauPrice) * pos.xauQuantity;
      btcPnl = (pos.entryBtcPrice - btcPrice) * pos.btcQuantity;
    } else {
      xauPnl = (pos.entryXauPrice - xauPrice) * pos.xauQuantity;
      btcPnl = (btcPrice - pos.entryBtcPrice) * pos.btcQuantity;
    }
    return round(xauPnl + btcPnl, 2);
  }

  private getEquity(xauPrice: number, btcPrice: number): number {
    return round(
      this.cash + (this.position
        ? this.position.legNotional * 2 + this.getUnrealizedPnl(xauPrice, btcPrice)
        : 0),
      2
    );
  }
}

function computeLogBeta(xauSeries: number[], btcSeries: number[]): number {
  const logXau = xauSeries.map((value) => Math.log(Math.max(value, Number.EPSILON)));
  const logBtc = btcSeries.map((value) => Math.log(Math.max(value, Number.EPSILON)));
  const varianceBtc = covariance(logBtc, logBtc);
  if (varianceBtc <= 0) return 1;
  return covariance(logXau, logBtc) / varianceBtc;
}

function computeReturnCorrelation(xauSeries: number[], btcSeries: number[]): number {
  if (xauSeries.length < 3 || btcSeries.length < 3) return 0;
  const xauReturns: number[] = [];
  const btcReturns: number[] = [];
  for (let i = 1; i < xauSeries.length; i++) {
    const prevXau = xauSeries[i - 1]!;
    const prevBtc = btcSeries[i - 1]!;
    if (prevXau <= 0 || prevBtc <= 0) continue;
    xauReturns.push((xauSeries[i]! - prevXau) / prevXau);
    btcReturns.push((btcSeries[i]! - prevBtc) / prevBtc);
  }
  return pearsonCorrelation(xauReturns, btcReturns);
}
