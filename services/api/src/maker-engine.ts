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
}

const FEE_BPS_PER_SIDE = 1.5;
const MAX_INVENTORY_PCT = 0.35;
const ORDER_NOTIONAL_PCT = 0.05;
const MIN_ACTION_INTERVAL_MS = 4_000;

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
        spreadStableMs: 0,
        pressureImbalancePct: 0,
        updatedAt: new Date().toISOString(),
        cash: capitalPerSymbol,
        lastEntryAt: null,
        lastFillAtMs: 0
      });
    }
  }

  setBrokerExecutionMode(enabled: boolean): void {
    this.brokerExecutionMode = enabled;
  }

  update(
    market: MakerMarketSnapshot,
    intel: { direction: Direction; confidence: number },
    guard?: { blocked: boolean; reason: string }
  ): void {
    const state = this.states.get(market.symbol);
    if (!state || market.bestBid <= 0 || market.bestAsk <= 0) return;

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
    const baseWidthBps = Math.max(market.spreadBps * 2.2, 1.25 + adverseScore * 0.03 + (market.spreadStableMs < 2_500 ? 0.6 : 0));
    const inventoryNotional = state.inventoryQty * mid;
    const inventoryPct = this.capitalPerSymbol > 0 ? inventoryNotional / this.capitalPerSymbol : 0;
    const inventorySkewBps = clamp(inventoryPct * 25, -8, 8);

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

    const buySuppressed = market.tradeImbalancePct < -60 || market.pressureImbalancePct <= -35 || (intel.direction === 'sell' || intel.direction === 'strong-sell') && intel.confidence >= 45;
    const sellSuppressed = market.tradeImbalancePct > 60 || market.pressureImbalancePct >= 35 || (intel.direction === 'buy' || intel.direction === 'strong-buy') && intel.confidence >= 45;

    state.mode = adverseScore >= 85 || market.spreadStableMs < 1_500 ? 'taker-watch' : 'maker';
    state.reason = adverseScore >= 85
      ? `Adverse selection elevated (${adverseScore}). Watching only.`
      : market.spreadStableMs < 1_500
        ? `Quotes too unstable (${market.spreadStableMs} ms spread age).`
        : 'Quoting both sides with inventory skew.';
    state.widthBps = round(baseWidthBps, 3);
    state.bidQuote = buySuppressed || state.mode !== 'maker' || inventoryNotional >= this.capitalPerSymbol * MAX_INVENTORY_PCT
      ? null
      : round(mid * (1 - (baseWidthBps + Math.max(inventorySkewBps, 0)) / 10_000), 2);
    state.askQuote = sellSuppressed || state.mode !== 'maker' || (this.brokerExecutionMode && state.inventoryQty <= 0)
      ? null
      : round(mid * (1 + (baseWidthBps + Math.max(-inventorySkewBps, 0)) / 10_000), 2);
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
      state.lastFillAtMs = now;
      return;
    }

    if (state.askQuote && state.inventoryQty > 0 && market.tradeImbalancePct >= 35) {
      const qty = Math.min(state.inventoryQty, orderNotional / Math.max(state.askQuote, Number.EPSILON));
      if (qty <= 0) return;
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
      return;
    }

    const quantity = Math.min(state.inventoryQty, fill.quantity);
    if (quantity <= 0) {
      return;
    }
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
