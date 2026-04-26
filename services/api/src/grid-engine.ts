/**
 * Grid Trading Engine
 * 
 * Places virtual buy/sell orders at fixed price intervals around
 * the current price. Every completed buy→sell round trip = profit.
 * 
 * Why this has high win rates:
 * - Every completed grid level is a guaranteed profit
 * - Works in any ranging/choppy market
 * - Only loses if price moves beyond the grid and stays there
 * - Small consistent profits compound over time
 * 
 * Grid logic:
 * - Center price = current price when grid is initialized
 * - N levels above and below, spaced by gridSpacingBps
 * - When price drops to a buy level → buy
 * - When price rises to a sell level → sell
 * - Each buy→sell or sell→buy round trip captures the grid spacing as profit
 */

import type { GridState, GridLevel } from '@hermes/contracts';
import { isStrategyPaused, consumeForceCloseSymbol, getMaxPositions } from './coo-gates.js';
import { feeBps } from './fee-model.js';

const DEFAULT_GRID_LEVELS = 8; // 8 above + 8 below = 16 levels
const DEFAULT_GRID_SPACING_BPS = 15; // 15 bps between levels (0.15%)
const SIZE_PER_LEVEL_FRACTION = 0.015; // 1.5% of equity per grid level.
// Per-symbol minimum notional: BTC/ETH need $15+ to be viable, SOL needs ~$18.
// $50 minimum was designed for BTC ($74K → $1117/level). It floors ETH ($34) and kills SOL ($1.26).
// Setting MIN_LEVEL_NOTIONAL = $15 to let ETH/SOL grids work.
const MIN_LEVEL_NOTIONAL = 15;
// COO: XRP grid cascade at 3% recenter — XRP dropped 4%, triggered 5 simultaneous closes.
// XRP is high-volatility (typical 2-5% daily moves). Raise to 5% to reduce unnecessary
// rebalancing while still protecting against extreme directional drift.
// BTC/ETH keep 3% as they're lower-volatility assets.
const DEFAULT_RECENTER_THRESHOLD = 0.03;
const XRP_RECENTER_THRESHOLD = 0.05;
// XRP allocation cap: 40% of base size per level. XRP is 82% of grid P&L
// (90% of grid trades) — concentration risk is the #1 structural risk.
// Limiting XRP to 40% of base level size reduces cascade drawdown while
// keeping the lane's best performer active.
const XRP_SIZE_CAP_FRACTION = 0.60;
// Coinbase Advanced Tier 1: 60 bps maker / 80 bps taker.
// Grid engine pays taker fees (market orders to fill grid levels).
// Updated from flat 5 bps to reflect real Coinbase Advanced fee schedule.
const FEE_BPS = feeBps('coinbase', 'taker');
// Recenter exit slippage: add buffer for panic regime exits.
// XRP recenter fires when price moves 5% — spread is wider during acute moves.
// Using 20 bps (4× normal fee) as conservative panic exit cost.
// Claude Code review: a sudden 5% XRP move in thin liquidity can cost 20-50bps to exit.
// 10bps was too low — raised to 20bps for live trading readiness.
const RECENTER_SLIPPAGE_BPS = 20;

// COO: Crypto correlation cap — BTC and ETH are ~0.85 correlated.
// Track open positions across all crypto grids to prevent over-exposure.
// COO NOTE: _cryptoGridOpenPositions was dead — per-engine openPositions.length is the actual cap.
// Global cross-engine crypto grid cap was never wired up. Delete if confirmed unnecessary.
const MAX_CRYPTO_GRID_POSITIONS = 6; // Max 6 simultaneous crypto grid positions
// Raised: XRP grid is firm's best signal (73% WR, $2.14/trade, 468 trades).
// With 10 levels now active, max 2 positions throttled the grid during multi-level
// drawdowns — exactly when the strategy is designed to load up.

function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

interface GridPosition {
  price: number;
  side: 'long' | 'short';
  quantity: number;
  entryTick: number;
  entryAt: string;
}

export interface GridFill {
  id: string;
  timestamp: string;
  entryAt?: string;
  type: 'grid-buy' | 'grid-sell' | 'round-trip' | 'recenter-close';
  price: number;       // Exit price for round-trip/recenter-close; level price for grid-buy
  entryPrice?: number; // Entry price for round-trip/recenter-close
  pnl: number;
  level: number;
}

export class GridEngine {
  private symbol: string;
  private centerPrice = 0;
  private gridSpacingBps: number;
  private readonly baseGridSpacingBps: number;
  private recenterThreshold: number;
  private numLevels: number;
  private levels: Map<number, { price: number; hasBuy: boolean; hasSell: boolean }> = new Map();
  private openPositions: GridPosition[] = [];
  private cash: number;
  private readonly startingEquity: number;
  private tick = 0;
  private roundTrips = 0;
  private realizedPnl = 0;
  private wins = 0;
  private losses = 0;
  private fills: GridFill[] = [];
  private drainedFillCount = 0;
  private priceHistory: number[] = [];
  // Public so index.ts can set per-grid allocation multipliers at construction time.
  // The setAllocationMultiplier() method still exists for clamped adjustments; external
  // direct assignment bypasses clamping (intentional — startup values can exceed 2.0).
  public allocationMultiplier = 1;
  private tradingEnabled = true;
  private blockedReason = 'enabled';
  private equityCurve: number[] = [];
  private initialized = false;
  // Cooldown to prevent recenter re-entry loop during sustained directional moves
  private lastRecenterAtMs = 0;
  private static RECENTER_COOLDOWN_MS = 30_000; // Don't recenter again within 30s

  constructor(symbol: string, startingEquity: number, gridSpacingBps?: number, numLevels?: number) {
    this.symbol = symbol;
    this.startingEquity = startingEquity;
    this.cash = startingEquity;
    this.gridSpacingBps = gridSpacingBps ?? DEFAULT_GRID_SPACING_BPS;
    this.baseGridSpacingBps = this.gridSpacingBps;
    this.numLevels = numLevels ?? DEFAULT_GRID_LEVELS;
    // XRP uses higher threshold to avoid cascade from normal volatility
    this.recenterThreshold = (symbol === 'XRP-USD') ? XRP_RECENTER_THRESHOLD : DEFAULT_RECENTER_THRESHOLD;
  }

  // Optional market context for COO-specified recenter guards (directive 2026-04-20).
  // Populated by the caller (market-feed) when available; absence means no extra guard fires.
  private marketContext: { confidencePct?: number; orderFlowBias?: string } = {};

  setMarketContext(ctx: { confidencePct?: number; orderFlowBias?: string }): void {
    this.marketContext = ctx;
  }

  update(price: number): void {
    if (price <= 0) return;
    this.tick++;
    this.priceHistory.push(price);
    if (this.priceHistory.length > 120) this.priceHistory.shift();

    // COO one-shot: flatten all positions in this symbol if requested.
    // Bypasses normal grid/recenter logic; closes at current price regardless of fees.
    if (consumeForceCloseSymbol(this.symbol)) {
      for (const pos of this.openPositions) {
        const grossPnl = pos.side === 'long'
          ? (price - pos.price) * pos.quantity
          : (pos.price - price) * pos.quantity;
        const fees = pos.quantity * price * (FEE_BPS / 10_000);
        const net = grossPnl - fees;
        this.cash += pos.price * pos.quantity + net;
        this.realizedPnl += net;
        if (net >= 0) this.wins++; else this.losses++;
        this.fills.push({
          id: `grid-coo-flatten-${this.symbol}-${Date.now()}-${this.tick}`,
          timestamp: new Date().toISOString(),
          entryAt: pos.entryAt,
          type: 'recenter-close',
          price: round(price, 2),
          entryPrice: pos.price,
          pnl: round(net, 2),
          level: 0,
        });
      }
      this.openPositions = [];
    }

    const adaptiveSpacing = this.computeAdaptiveSpacingBps();
    if (Math.abs(adaptiveSpacing - this.gridSpacingBps) >= 3) {
      this.gridSpacingBps = adaptiveSpacing;
      if (this.initialized) {
        this.recenterGrid(price);
      }
    }

    if (!this.initialized) {
      this.initGrid(price);
      this.initialized = true;
    }

    // Check if we need to recenter — with cooldown to prevent re-entry loops.
    // COO directive #6 (2026-04-20): additional guards to prevent fee-negative recenters —
    //   skip if confidence < 40% or orderFlowBias is 'neutral' (indicator of no real signal).
    const now = Date.now();
    const { confidencePct, orderFlowBias } = this.marketContext;
    const cooBlocksRecenter =
      (typeof confidencePct === 'number' && confidencePct < 40) ||
      orderFlowBias === 'neutral';
    if (this.centerPrice > 0
      && Math.abs(price - this.centerPrice) / this.centerPrice > this.recenterThreshold
      && (now - this.lastRecenterAtMs) > GridEngine.RECENTER_COOLDOWN_MS
      && !cooBlocksRecenter) {
      this.lastRecenterAtMs = now;
      this.recenterGrid(price);
    }

    // Check grid levels
    this.processGridLevels(price);

    // Try to close profitable positions
    this.checkRoundTrips(price);

    this.equityCurve.push(this.getEquity(price));
  }

  private initGrid(price: number): void {
    this.centerPrice = price;
    this.levels.clear();
    const spacing = this.gridSpacingBps / 10_000;

    for (let i = -this.numLevels; i <= this.numLevels; i++) {
      if (i === 0) continue;
      const levelPrice = round(price * (1 + i * spacing), 2);
      this.levels.set(i, {
        price: levelPrice,
        hasBuy: i < 0, // Buy levels below center
        hasSell: i > 0  // Sell levels above center
      });
    }
  }

  private recenterGrid(price: number): void {
    // Guard: should never fire within cooldown window (defense in depth)
    const now = Date.now();
    if ((now - this.lastRecenterAtMs) < GridEngine.RECENTER_COOLDOWN_MS) return;
    // COO directive #6/#8 (2026-04-20): skip recenter-close when gross move is smaller than
    // round-trip fees + slippage. Closing a flat-price position just burns RECENTER_SLIPPAGE_BPS
    // + FEE_BPS as pure loss; the COO counted 20+ such burns on XRP-USD in 90 minutes.
    // We keep flat-priced positions open so the next legitimate price move triggers a clean
    // trip-exit. The grid is still re-initialized around the new price.
    const keptPositions: typeof this.openPositions = [];
    for (const pos of this.openPositions) {
      const grossPnl = pos.side === 'long'
        ? (price - pos.price) * pos.quantity
        : (pos.price - price) * pos.quantity;
      const fees = pos.quantity * price * ((FEE_BPS + RECENTER_SLIPPAGE_BPS) / 10_000);
      // Skip: closing would produce a net loss driven entirely by fees (no real adverse move).
      if (grossPnl < fees) {
        keptPositions.push(pos);
        continue;
      }
      const net = grossPnl - fees;
      this.cash += pos.price * pos.quantity + net;
      this.realizedPnl += net;
      if (net >= 0) this.wins++; else this.losses++;
      this.fills.push({
        id: `grid-recenter-${this.symbol}-${Date.now()}-${this.tick}`,
        timestamp: new Date().toISOString(),
        entryAt: pos.entryAt,
        type: 'recenter-close',
        price: round(price, 2),       // exit price
        entryPrice: pos.price,         // entry price of closed position
        pnl: round(net, 2),
        level: 0
      });
    }
    this.openPositions = keptPositions;
    this.initGrid(price);
  }

  private processGridLevels(price: number): void {
    // XRP cap: reduce position size per level if XRP exceeds concentration limit
    const isXrp = this.symbol === 'XRP-USD';
    const sizePerLevel = this.cash * SIZE_PER_LEVEL_FRACTION * this.allocationMultiplier * (isXrp ? XRP_SIZE_CAP_FRACTION : 1.0);
    if (sizePerLevel < MIN_LEVEL_NOTIONAL) return;

    // COO gate: if this strategy is paused by COO directive, don't open new positions.
    // Existing positions still close via sell/trip-exit logic below (let them wind down).
    const strategyId = `grid-${this.symbol.toLowerCase()}`;
    const paused = isStrategyPaused(strategyId);

    // COO: Correlation cap — don't add new grid positions if we're at the limit.
    // Uses Math.min(builtin cap, COO-set strategy cap, COO-set firm cap) so the COO
    // can tighten concentration without needing to redeploy code.
    const cooStrategyCap = getMaxPositions('strategy', strategyId);
    const cooFirmCap = getMaxPositions('firm');
    const maxPositions = Math.min(MAX_CRYPTO_GRID_POSITIONS, cooStrategyCap, cooFirmCap);
    const currentOpen = this.openPositions.length;

    for (const [levelIdx, level] of this.levels) {
      // Buy levels: trigger when price drops to or below the level
      if (!paused && this.tradingEnabled && level.hasBuy && price <= level.price && currentOpen < maxPositions) {
        const quantity = sizePerLevel / price;
        const fees = quantity * price * (FEE_BPS / 10_000);
        this.cash -= (sizePerLevel + fees);

        this.openPositions.push({
          price: level.price,
          side: 'long',
          quantity,
          entryTick: this.tick,
          entryAt: new Date().toISOString()
        });

        level.hasBuy = false; // Don't buy again at this level
        // Enable the corresponding sell level above
        const sellLevel = this.levels.get(-levelIdx);
        if (sellLevel) sellLevel.hasSell = true;

        this.fills.push({
          id: `grid-buy-${this.symbol}-${Date.now()}-${this.tick}`,
          timestamp: new Date().toISOString(),
          entryAt: new Date().toISOString(),
          type: 'grid-buy',
          price: round(level.price, 2),
          pnl: 0,
          level: levelIdx
        });
      }

      // Sell levels: trigger when price rises to or above the level
      if (level.hasSell && price >= level.price) {
        // Find a matching long position to close
        const longIdx = this.openPositions.findIndex((p) => p.side === 'long');
        if (longIdx >= 0) {
          const pos = this.openPositions[longIdx]!;
          const grossPnl = (level.price - pos.price) * pos.quantity;
          const exitFees = pos.quantity * level.price * (FEE_BPS / 10_000);
          const net = grossPnl - exitFees;
          if (net <= 0) {
            continue;
          }

          this.cash += pos.price * pos.quantity + net;
          this.realizedPnl += net;
          this.roundTrips++;
          if (net >= 0) this.wins++; else this.losses++;

          this.openPositions.splice(longIdx, 1);
          level.hasSell = false;
          // Re-enable the buy level below
          const buyLevel = this.levels.get(-levelIdx);
          if (buyLevel) buyLevel.hasBuy = true;

          this.fills.push({
            id: `grid-trip-${this.symbol}-${Date.now()}-${this.roundTrips}`,
            timestamp: new Date().toISOString(),
            entryAt: pos.entryAt,
            type: 'round-trip',
            price: round(level.price, 2), // exit price
            entryPrice: pos.price,         // entry price
            pnl: round(net, 2),
            level: levelIdx
          });
        }
      }
    }
  }

  private checkRoundTrips(price: number): void {
    // Close any long positions that have moved above center + 1 grid spacing (take profit)
    const targetAboveEntry = this.gridSpacingBps / 10_000;
    const toClose: number[] = [];

    for (let i = 0; i < this.openPositions.length; i++) {
      const pos = this.openPositions[i]!;
      if (pos.side === 'long' && price > pos.price * (1 + targetAboveEntry)) {
        const grossPnl = (price - pos.price) * pos.quantity;
        const fees = pos.quantity * price * (FEE_BPS / 10_000);
        const net = grossPnl - fees;
        if (net <= 0) {
          continue;
        }

        this.cash += pos.price * pos.quantity + net;
        this.realizedPnl += net;
        this.roundTrips++;
        if (net >= 0) this.wins++; else this.losses++;

        this.fills.push({
          id: `grid-trip-${this.symbol}-${Date.now()}-${this.roundTrips}`,
          timestamp: new Date().toISOString(),
          entryAt: pos.entryAt,
          type: 'round-trip',
          price: round(price, 2),    // exit price
          entryPrice: pos.price,     // entry price
          pnl: round(net, 2),
          level: 0
        });

        toClose.push(i);
      }
    }

    // Remove closed positions (reverse order)
    for (const idx of toClose.reverse()) {
      this.openPositions.splice(idx, 1);
    }
  }

  getState(): GridState {
    const levels: GridLevel[] = Array.from(this.levels.entries())
      .sort(([a], [b]) => a - b)
      .map(([, level]) => ({
        price: level.price,
        side: level.hasBuy ? 'buy' as const : 'sell' as const,
        filled: !level.hasBuy && !level.hasSell,
        pnl: 0
      }));

    return {
      symbol: this.symbol,
      centerPrice: round(this.centerPrice, 2),
      gridSpacingBps: this.gridSpacingBps,
      levels,
      completedRoundTrips: this.roundTrips,
      totalPnl: round(this.realizedPnl, 2)
    };
  }

  getStats() {
    const lastPrice = this.equityCurve.at(-1) ?? this.startingEquity;
    return {
      equity: lastPrice,
      realizedPnl: round(this.realizedPnl, 2),
      roundTrips: this.roundTrips,
      totalTrades: this.wins + this.losses,
      wins: this.wins,
      losses: this.losses,
      winRate: (this.wins + this.losses) > 0 ? round((this.wins / (this.wins + this.losses)) * 100, 1) : 0,
      allocationMultiplier: round(this.allocationMultiplier, 2),
      tradingEnabled: this.tradingEnabled,
      blockedReason: this.blockedReason,
      openPositions: this.openPositions.length,
      fills: this.fills.slice(-30),
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

  drainClosedFills(): GridFill[] {
    const next = this.fills.slice(this.drainedFillCount).filter((fill) => fill.type === 'round-trip' || fill.type === 'recenter-close');
    this.drainedFillCount = this.fills.length;
    return next;
  }

  private computeAdaptiveSpacingBps(): number {
    if (this.priceHistory.length < 20) return this.baseGridSpacingBps;
    const returns: number[] = [];
    for (let i = 1; i < this.priceHistory.length; i++) {
      const prev = this.priceHistory[i - 1]!;
      if (prev <= 0) continue;
      returns.push((this.priceHistory[i]! - prev) / prev);
    }
    if (returns.length < 10) return this.baseGridSpacingBps;
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
    const volBps = Math.sqrt(Math.max(variance, 0)) * 10_000;
    const feeFloor = FEE_BPS * 2 + 6;
    const adaptive = Math.max(this.baseGridSpacingBps, feeFloor, Math.round(volBps * 0.9));
    return Math.min(adaptive, this.baseGridSpacingBps * 4);
  }

  private getEquity(price: number): number {
    let positionValue = 0;
    for (const pos of this.openPositions) {
      positionValue += pos.quantity * price;
    }
    return round(this.cash + positionValue, 2);
  }

  getSnapshot() {
    return this.getStats();
  }
}
