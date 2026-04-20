type Direction = 'strong-buy' | 'buy' | 'neutral' | 'sell' | 'strong-sell';

export interface MakerMarketSnapshot {
  symbol: string;
  bestBid: number;
  bestAsk: number;
  microPrice: number;
  spreadBps: number;
  spreadStableMs: number;
  queueImbalancePct: number;
  tradeImbalancePct: number;
  pressureImbalancePct: number;
}

export interface MakerQuoteState {
  symbol: string;
  mode: 'maker' | 'taker-watch' | 'paused';
  reason: string;
  bidQuote: number | null;
  askQuote: number | null;
  widthBps: number;
  inventoryQty: number;
  inventoryNotional: number;
  avgEntryPrice: number;
  realizedPnl: number;
  roundTrips: number;
  adverseScore: number;
  adverseSelectionScore: number;  // rolling-avg PnLBps of last-N round-trips; negative = adverse
  symbolBlocked: boolean;
  symbolBlockReason: string;
  bidCapReached: boolean;
  askCapReached: boolean;
  inventoryCaps: { maxLongNotional: number; maxShortNotional: number };
  spreadStableMs: number;
  pressureImbalancePct: number;
  updatedAt: string;
}

export interface MakerRoundTripFill {
  id: string;
  symbol: string;
  entryAt: string;
  exitAt: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  reason: string;
  widthBps: number;
}

export interface ExternalMakerFill {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  fee: number;
  timestamp: string;
  reason: string;
}

interface MakerStateInternal extends MakerQuoteState {
  cash: number;
  lastEntryAt: string | null;
  lastFillAtMs: number;
  _pendingPnlEntryPrice: number; // preserved entry price for pnlBps after avgEntryPrice resets
}

// Coinbase Advanced Trade at $100K-$1M/30d volume: maker ~2bps (rebate).
// We model 2bps/side = 4bps round-trip net cost. Conservative for thin markets.
const FEE_BPS_PER_SIDE = 2;
const MAX_INVENTORY_PCT = 0.35;
const ORDER_NOTIONAL_PCT = 0.05;
const MIN_ACTION_INTERVAL_MS = 4_000;

// ── Per-symbol notional inventory caps (USD equivalent) ──────────────────────
const MAKER_INVENTORY_CAPS: Record<string, { maxLongNotional: number; maxShortNotional: number }> = {
  'BTC-USD': { maxLongNotional: 500, maxShortNotional: 500 },
  'ETH-USD': { maxLongNotional: 400, maxShortNotional: 400 },
  'XRP-USD': { maxLongNotional: 300, maxShortNotional: 300 },
  'SOL-USD': { maxLongNotional: 250, maxShortNotional: 250 }
};
// Pairs whose spreads are permanently too thin for maker economics in current market.
// These pairs stay in taker-watch; their grid lanes absorb the capital instead.
const TAKER_WATCH_ONLY_PAIRS = new Set(['BTC-USD', 'ETH-USD']);

const ADVERSE_SELECTION_THRESHOLD_BPS = 2;    // round-trips losing >2bps on average → circuit breaker
const ADVERSE_SELECTION_WINDOW = 10;          // last N round-trips to track (tightened from 20)
const RECOVERY_CONSECUTIVE_ROUNDS = 5;       // consecutive good rounds to clear circuit breaker

function round(value: number, decimals: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class MakerEngine {
  private readonly states = new Map<string, MakerStateInternal>();
  private readonly fills: MakerRoundTripFill[] = [];
  private drainedFillCount = 0;
  private readonly capitalPerSymbol: number;
  private brokerExecutionMode = false;
  // Fee tier downgrade guard — set via setMakerBlocked() when makerBps >= takerBps
  private _makerBlocked = false;
  private _makerBlockReason = '';
  // ── Per-symbol adverse-selection tracking ──────────────────────────────────
  private readonly _pnlBpsBySymbol = new Map<string, number[]>();   // rolling window
  private readonly _symbolBlocks = new Map<string, string>();       // symbol → block reason
  private readonly _recoveryCounters = new Map<string, number>();  // consecutive good rounds

  constructor(symbols: string[], capitalPerSymbol = 5_000) {
    this.capitalPerSymbol = capitalPerSymbol;
    for (const symbol of symbols) {
      this.states.set(symbol, {
        symbol,
        mode: 'paused',
        reason: 'Waiting for first market snapshot.',
        bidQuote: null,
        askQuote: null,
        widthBps: 0,
        inventoryQty: 0,
        inventoryNotional: 0,
        avgEntryPrice: 0,
        realizedPnl: 0,
        roundTrips: 0,
        adverseScore: 0,
        adverseSelectionScore: 0,
        symbolBlocked: false,
        symbolBlockReason: '',
        bidCapReached: false,
        askCapReached: false,
        inventoryCaps: MAKER_INVENTORY_CAPS[symbol] ?? { maxLongNotional: 500, maxShortNotional: 500 },
        spreadStableMs: 0,
        pressureImbalancePct: 0,
        updatedAt: new Date().toISOString(),
        cash: capitalPerSymbol,
        lastEntryAt: null,
        lastFillAtMs: 0,
        _pendingPnlEntryPrice: 0
      });
    }
  }

  setBrokerExecutionMode(enabled: boolean): void {
    this.brokerExecutionMode = enabled;
  }

  /**
   * Set the maker blocked flag. Call this when Coinbase fee tier is downgraded
   * (makerBps >= takerBps). When blocked, all maker quoting is suspended.
   */
  setMakerBlocked(blocked: boolean, reason = ''): void {
    if (this._makerBlocked !== blocked) {
      this._makerBlocked = blocked;
      this._makerBlockReason = reason;
      if (blocked) {
        console.error(
          `[MAKER-ENGINE] ⚠️  MAKER STRATEGIES BLOCKED: ${reason}\n` +
          `  All maker quoting suspended until Coinbase fee tier is restored.\n` +
          `  Time: ${new Date().toISOString()}`
        );
      } else {
        console.log(`[MAKER-ENGINE] ✓ Maker strategies restored. Coinbase fee tier OK.`);
      }
    }
  }

  isMakerBlocked(): boolean {
    return this._makerBlocked;
  }

  private _recordPnlBps(symbol: string, entryPrice: number, exitPrice: number): void {
    if (entryPrice <= 0 || exitPrice <= 0) return;
    const pnlBps = round(((exitPrice - entryPrice) / entryPrice) * 10_000, 2);
    const window = this._pnlBpsBySymbol.get(symbol) ?? [];
    window.push(pnlBps);
    if (window.length > ADVERSE_SELECTION_WINDOW) window.shift();
    this._pnlBpsBySymbol.set(symbol, window);
  }

  update(
    market: MakerMarketSnapshot,
    intel: { direction: Direction; confidence: number; rsi14?: number | null },
    guard?: { blocked: boolean; reason: string }
  ): void {
    const state = this.states.get(market.symbol);
    if (!state || market.bestBid <= 0 || market.bestAsk <= 0) return;

    // ── Coinbase fee tier downgrade gate — no quoting if maker rebate is gone ──
    if (this._makerBlocked) {
      state.mode = 'paused';
      state.reason = this._makerBlockReason || 'Maker strategies blocked: Coinbase fee tier downgraded (makerBps >= takerBps).';
      state.bidQuote = null;
      state.askQuote = null;
      return;
    }

    // ── Regime filter: no quoting when RSI(14) is overbought (>70) or oversold (<30) ──
    const rsi14 = intel.rsi14;
    if (rsi14 !== undefined && rsi14 !== null && (rsi14 > 70 || rsi14 < 30)) {
      state.mode = 'taker-watch';
      state.reason = `RSI regime unsafe (${rsi14.toFixed(1)}). ${rsi14 > 70 ? 'Overbought — trend likely to reverse' : 'Oversold — trend likely to reverse'}. Watching only.`;
      state.bidQuote = null;
      state.askQuote = null;
      state.updatedAt = new Date().toISOString();
      return;
    }

    const now = Date.now();
    const mid = market.microPrice > 0 ? market.microPrice : (market.bestBid + market.bestAsk) / 2;
    const adverseScore = round(
      Math.abs(market.tradeImbalancePct) * 0.5
      + Math.abs(market.queueImbalancePct) * 0.2
      + Math.abs(market.pressureImbalancePct) * 0.2
      + (market.spreadStableMs < 2_500 ? 20 : 0)
      + market.spreadBps * 2,
      2
    );
    // WIDENED: BTC maker $0.07/trade and ETH maker $0.05/trade are razor thin.
    // 2.2× was barely covering fees on a round-trip. 3.0× captures ~36% more spread
    // per fill — adverse selection breaker (line ~215) already caps downside.
    // Ensure minimum 5 bps width so BTC/ETH with tiny bps spreads but meaningful
    // dollar spreads still get adequate protection against being picked off.
    const baseWidthBps = Math.max(market.spreadBps * 3.0, 2.5 + adverseScore * 0.03 + (market.spreadStableMs < 2_500 ? 0.6 : 0), 5);
    const inventoryNotional = state.inventoryQty * mid;
    const inventoryPct = this.capitalPerSymbol > 0 ? inventoryNotional / this.capitalPerSymbol : 0;
    const inventorySkewBps = clamp(inventoryPct * 25, -8, 8);

    // ── Per-symbol adverse-selection circuit breaker ──────────────────────────
    {
      const window = this._pnlBpsBySymbol.get(market.symbol) ?? [];
      const adverseSelectionScore = window.length > 0
        ? round(window.reduce((a, b) => a + b, 0) / window.length, 2)
        : 0;
      state.adverseSelectionScore = adverseSelectionScore;

      const blocked = this._symbolBlocks.get(market.symbol);
      if (blocked) {
        // Recovery logic: 5 consecutive rounds ≥ threshold clears breaker
        if (adverseSelectionScore >= -ADVERSE_SELECTION_THRESHOLD_BPS) {
          const cnt = (this._recoveryCounters.get(market.symbol) ?? 0) + 1;
          this._recoveryCounters.set(market.symbol, cnt);
          if (cnt >= RECOVERY_CONSECUTIVE_ROUNDS) {
            this._symbolBlocks.delete(market.symbol);
            this._recoveryCounters.delete(market.symbol);
            // Only clear global maker-blocked if it was set for adverse-selection
            if (this._makerBlockReason.startsWith('adverse-selection-breach')) {
              this._makerBlocked = false;
              this._makerBlockReason = '';
            }
            console.log(`[MAKER-ENGINE] ✓ Adverse-selection circuit CLEARED for ${market.symbol} after ${cnt} consecutive recovery rounds.`);
          }
        } else {
          this._recoveryCounters.set(market.symbol, 0);
        }
      } else if (adverseSelectionScore < -ADVERSE_SELECTION_THRESHOLD_BPS && window.length >= ADVERSE_SELECTION_WINDOW) {
        this._symbolBlocks.set(market.symbol, 'adverse-selection-breach');
        this._makerBlocked = true;
        this._makerBlockReason = `adverse-selection-breach:${market.symbol}`;
        console.error(
          `[MAKER-ENGINE] ⚠️  ADVERSE-SELECTION CIRCUIT BREAKER TRIPPED for ${market.symbol}\n` +
          `  Rolling avg PnLBps: ${adverseSelectionScore.toFixed(2)} (threshold: -${ADVERSE_SELECTION_THRESHOLD_BPS}bps)\n` +
          `  Window: ${window.length} rounds | Time: ${new Date().toISOString()}`
        );
      }
      state.symbolBlocked = this._symbolBlocks.has(market.symbol);
      state.symbolBlockReason = this._symbolBlocks.get(market.symbol) ?? '';
    }

    if (guard?.blocked) {
      state.mode = 'paused';
      state.reason = guard.reason;
      state.bidQuote = null;
      state.askQuote = null;
      state.widthBps = round(baseWidthBps, 3);
      state.inventoryNotional = round(inventoryNotional, 2);
      state.adverseScore = adverseScore;
      state.spreadStableMs = market.spreadStableMs;
      state.pressureImbalancePct = round(market.pressureImbalancePct, 2);
      state.updatedAt = new Date().toISOString();
      return;
    }

    // ── Per-symbol, per-side inventory cap checks ─────────────────────────────
    const caps = state.inventoryCaps;
    const longNotional = inventoryNotional > 0 ? inventoryNotional : 0;
    const shortNotional = inventoryNotional < 0 ? Math.abs(inventoryNotional) : 0;
    const longAtCap = longNotional >= caps.maxLongNotional;
    const shortAtCap = shortNotional >= caps.maxShortNotional;
    state.bidCapReached = longAtCap;
    state.askCapReached = shortAtCap;

    const perSymbolBlocked = this._symbolBlocks.has(market.symbol);
    const buySuppressed = market.tradeImbalancePct < -60 || market.pressureImbalancePct <= -35
      || (intel.direction === 'sell' || intel.direction === 'strong-sell') && intel.confidence >= 45;
    const sellSuppressed = market.tradeImbalancePct > 60 || market.pressureImbalancePct >= 35
      || (intel.direction === 'buy' || intel.direction === 'strong-buy') && intel.confidence >= 45;

    // Block if spread cannot cover fees (breakeven = dollarSpread >= dollarFee)
    const dollarSpreadPer100K = (market.bestAsk - market.bestBid) / market.midPrice * 100000;
    const dollarFeePer100K = 2 * FEE_BPS_PER_SIDE / 10000 * 100000;
    const spreadCoversFees = dollarSpreadPer100K >= dollarFeePer100K;
    // Permanently exclude pairs with fundamentally too-thin spreads for maker economics.
    // BTC-USD: ~0.001 bps spread = $7.40/100K — cannot cover $40 round-trip fee.
    // ETH-USD: ~0.044 bps spread = $79/100K — still below $40 fee threshold at 2bps/side.
    // These pairs are better served by their grid lanes.
    const spreadTooThinForMaker = TAKER_WATCH_ONLY_PAIRS.has(market.symbol);
    state.mode = spreadTooThinForMaker || (!spreadCoversFees) || perSymbolBlocked || adverseScore >= 85 || market.spreadStableMs < 1_500 ? 'taker-watch' : 'maker';
    state.reason = spreadTooThinForMaker
      ? `Maker permanently disabled: ${market.symbol} spread (${market.spreadBps} bps) too thin for 2bps/side fee economics. Grid lane absorbs capital.`
      : !spreadCoversFees
        ? `Spread $${dollarSpreadPer100K.toFixed(2)}/100K too thin vs $${dollarFeePer100K.toFixed(2)}/100K fee.`
        : perSymbolBlocked
          ? `Per-symbol adverse-selection breaker active: ${state.symbolBlockReason}.`
          : adverseScore >= 85
            ? `Adverse selection elevated (${adverseScore}). Watching only.`
            : market.spreadStableMs < 1_500
              ? `Quotes too unstable (${market.spreadStableMs} ms spread age).`
              : 'Quoting both sides with inventory skew.';
    state.widthBps = round(baseWidthBps, 3);

    // Bid suppressed by long-side cap or global capital cap
    if (buySuppressed || state.mode !== 'maker' || inventoryNotional >= this.capitalPerSymbol * MAX_INVENTORY_PCT) {
      state.bidQuote = null;
    } else if (longAtCap) {
      state.bidQuote = null;
      state.reason = `${state.reason} [reason:inventory-cap-reached]`;
      console.log(`[MAKER-ENGINE] ${market.symbol} bid suppressed: long inventory cap reached (${round(longNotional, 2)}/${caps.maxLongNotional}).`);
    } else {
      state.bidQuote = round(mid * (1 - (baseWidthBps + Math.max(inventorySkewBps, 0)) / 10_000), 2);
    }

    // Ask suppressed by short-side cap or broker mode
    if (sellSuppressed || state.mode !== 'maker' || (this.brokerExecutionMode && state.inventoryQty <= 0)) {
      state.askQuote = null;
    } else if (shortAtCap) {
      state.askQuote = null;
      state.reason = `${state.reason} [reason:inventory-cap-reached]`;
      console.log(`[MAKER-ENGINE] ${market.symbol} ask suppressed: short inventory cap reached (${round(shortNotional, 2)}/${caps.maxShortNotional}).`);
    } else {
      state.askQuote = round(mid * (1 + (baseWidthBps + Math.max(-inventorySkewBps, 0)) / 10_000), 2);
    }

    state.inventoryNotional = round(inventoryNotional, 2);
    state.adverseScore = adverseScore;
    state.spreadStableMs = market.spreadStableMs;
    state.pressureImbalancePct = round(market.pressureImbalancePct, 2);
    state.updatedAt = new Date().toISOString();

    if (this.brokerExecutionMode) {
      return;
    }

    if (now - state.lastFillAtMs < MIN_ACTION_INTERVAL_MS) {
      return;
    }

    const orderNotional = this.capitalPerSymbol * ORDER_NOTIONAL_PCT;
    const maxInventoryNotional = this.capitalPerSymbol * MAX_INVENTORY_PCT;

    if (state.bidQuote && market.tradeImbalancePct <= -35 && state.inventoryNotional < maxInventoryNotional) {
      const qty = orderNotional / Math.max(state.bidQuote, Number.EPSILON);
      const nextInventory = state.inventoryQty + qty;
      state.avgEntryPrice = state.inventoryQty > 0
        ? ((state.avgEntryPrice * state.inventoryQty) + (state.bidQuote * qty)) / nextInventory
        : state.bidQuote;
      state.inventoryQty = round(nextInventory, 6);
      state.inventoryNotional = round(state.inventoryQty * mid, 2);
      state.cash = round(state.cash - state.bidQuote * qty, 2);
      state.lastEntryAt = new Date().toISOString();
      state._pendingPnlEntryPrice = state.bidQuote;
      state.lastFillAtMs = now;
      return;
    }

    if (state.askQuote && state.inventoryQty > 0 && market.tradeImbalancePct >= 35) {
      const qty = Math.min(state.inventoryQty, orderNotional / Math.max(state.askQuote, Number.EPSILON));
      if (qty <= 0) return;

      // ── Record pnlBps BEFORE avgEntryPrice resets ─────────────────────────
      const entryPx = state.avgEntryPrice;
      const exitPx = round(state.askQuote, 2);
      this._recordPnlBps(market.symbol, entryPx, exitPx);

      const grossPnl = (state.askQuote - state.avgEntryPrice) * qty;
      const fees = (state.avgEntryPrice * qty + state.askQuote * qty) * (FEE_BPS_PER_SIDE / 10_000);
      const realized = grossPnl - fees;
      state.inventoryQty = round(Math.max(0, state.inventoryQty - qty), 6);
      state.inventoryNotional = round(state.inventoryQty * mid, 2);
      state.cash = round(state.cash + state.askQuote * qty, 2);
      state.realizedPnl = round(state.realizedPnl + realized, 2);
      state.roundTrips += 1;
      state.lastFillAtMs = now;
      this.fills.push({
        id: `agent-mk-${market.symbol.toLowerCase()}-${now}-${state.roundTrips}`,
        symbol: market.symbol,
        entryAt: state.lastEntryAt ?? new Date().toISOString(),
        exitAt: new Date().toISOString(),
        entryPrice: round(state.avgEntryPrice, 2),
        exitPrice: round(state.askQuote, 2),
        quantity: round(qty, 6),
        pnl: round(realized, 2),
        reason: adverseScore >= 65 ? 'inventory-release-under-pressure' : 'maker-round-trip',
        widthBps: state.widthBps
      });
      if (this.fills.length > 200) this.fills.shift();
      if (state.inventoryQty === 0) {
        state.avgEntryPrice = 0;
        state.lastEntryAt = null;
        state._pendingPnlEntryPrice = 0;
      }
    }
  }

  applyExternalFill(fill: ExternalMakerFill): void {
    const state = this.states.get(fill.symbol);
    if (!state || fill.price <= 0 || fill.quantity <= 0) {
      return;
    }

    const timestamp = fill.timestamp || new Date().toISOString();
    state.lastFillAtMs = Date.now();

    if (fill.side === 'buy') {
      const nextInventory = state.inventoryQty + fill.quantity;
      state.avgEntryPrice = state.inventoryQty > 0
        ? ((state.avgEntryPrice * state.inventoryQty) + (fill.price * fill.quantity) + fill.fee) / nextInventory
        : (fill.price * fill.quantity + fill.fee) / fill.quantity;
      state.inventoryQty = round(nextInventory, 6);
      state.inventoryNotional = round(state.inventoryQty * state.avgEntryPrice, 2);
      state.cash = round(state.cash - (fill.price * fill.quantity + fill.fee), 2);
      state.lastEntryAt = timestamp;
      state.updatedAt = timestamp;
      // Set _pendingPnlEntryPrice to the actual fill price — survives sell close-out resets
      state._pendingPnlEntryPrice = fill.price;
      return;
    }

    const quantity = Math.min(state.inventoryQty, fill.quantity);
    if (quantity <= 0) {
      return;
    }

    // ── Record pnlBps BEFORE avgEntryPrice resets ─────────────────────────
    // Prefer _pendingPnlEntryPrice (the price at which inventory was accumulated)
    // so pnlBps reflects true market exit vs. entry, not the fee-weighted avg
    const entryPx = state._pendingPnlEntryPrice > 0 ? state._pendingPnlEntryPrice : state.avgEntryPrice;
    this._recordPnlBps(fill.symbol, entryPx, fill.price);

    const grossPnl = (fill.price - state.avgEntryPrice) * quantity;
    const realized = grossPnl - fill.fee;
    state.inventoryQty = round(Math.max(0, state.inventoryQty - quantity), 6);
    state.inventoryNotional = round(state.inventoryQty * Math.max(state.avgEntryPrice, 0), 2);
    state.cash = round(state.cash + (fill.price * quantity - fill.fee), 2);
    state.realizedPnl = round(state.realizedPnl + realized, 2);
    state.roundTrips += 1;
    state.updatedAt = timestamp;
    this.fills.push({
      id: fill.id,
      symbol: fill.symbol,
      entryAt: state.lastEntryAt ?? timestamp,
      exitAt: timestamp,
      entryPrice: round(state.avgEntryPrice, 2),
      exitPrice: round(fill.price, 2),
      quantity: round(quantity, 6),
      pnl: round(realized, 2),
      reason: fill.reason,
      widthBps: state.widthBps
    });
    if (this.fills.length > 200) this.fills.shift();
    if (state.inventoryQty === 0) {
      state.avgEntryPrice = 0;
      state.lastEntryAt = null;
      state._pendingPnlEntryPrice = 0;
    }
  }

  getSnapshot(): { asOf: string; states: MakerQuoteState[]; fills: MakerRoundTripFill[] } {
    return {
      asOf: new Date().toISOString(),
      states: Array.from(this.states.values()).map((state) => ({
        symbol: state.symbol,
        mode: state.mode,
        reason: state.reason,
        bidQuote: state.bidQuote,
        askQuote: state.askQuote,
        widthBps: state.widthBps,
        inventoryQty: state.inventoryQty,
        inventoryNotional: state.inventoryNotional,
        avgEntryPrice: round(state.avgEntryPrice, 2),
        realizedPnl: state.realizedPnl,
        roundTrips: state.roundTrips,
        adverseScore: state.adverseScore,
        adverseSelectionScore: state.adverseSelectionScore,
        symbolBlocked: state.symbolBlocked,
        symbolBlockReason: state.symbolBlockReason,
        bidCapReached: state.bidCapReached,
        askCapReached: state.askCapReached,
        inventoryCaps: state.inventoryCaps,
        spreadStableMs: state.spreadStableMs,
        pressureImbalancePct: state.pressureImbalancePct,
        updatedAt: state.updatedAt
      })),
      fills: this.fills.slice(-30)
    };
  }

  drainClosedFills(): MakerRoundTripFill[] {
    const next = this.fills.slice(this.drainedFillCount);
    this.drainedFillCount = this.fills.length;
    return next;
  }
}
