/**
 * Coinbase public WebSocket feed.
 *
 * Uses public market-data channels only. No Coinbase Pro upgrade and no auth required.
 * Channels:
 * - ticker   -> last price, best bid/ask, 24h volume
 * - level2   -> full book snapshot + incremental updates
 */

import { EventEmitter } from 'node:events';

const WS_URL = 'wss://advanced-trade-ws.coinbase.com';
const RECONNECT_DELAY_MS = 3_000;
const DEFAULT_DEPTH_LEVELS = 12;

export interface TickerUpdate {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  volume24h: number;
  timestamp: string;
}

export interface Level2Snapshot {
  symbol: string;
  bidDepth: number;
  askDepth: number;
  imbalancePct: number;
  queueImbalancePct: number;
  pressureImbalancePct: number;
  microPrice: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  spreadBps: number;
  spreadStableMs: number;
  bidSlopeBps: number;
  askSlopeBps: number;
  aggressiveBuyVolume: number;
  aggressiveSellVolume: number;
  tradeImbalancePct: number;
  bidAddNotional: number;
  bidRemoveNotional: number;
  askAddNotional: number;
  askRemoveNotional: number;
  recentTradeCount: number;
  depthLevels: number;
  updatedAt: string;
}

type WsBookSide = Map<number, number>;

interface BookState {
  bids: WsBookSide;
  asks: WsBookSide;
  updatedAt: string;
}

interface TradeRecord {
  side: 'BUY' | 'SELL';
  size: number;
  time: number;
}

interface BookDeltaRecord {
  side: 'bid' | 'ask';
  action: 'add' | 'remove';
  notional: number;
  time: number;
}

interface SpreadState {
  spread: number;
  since: number;
}

export class CoinbaseWebSocketFeed extends EventEmitter {
  private ws: import('ws').WebSocket | null = null;
  private readonly symbols: string[];
  private readonly depthLevels: number;
  private connected = false;
  private reconnecting = false;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly books = new Map<string, BookState>();
  private readonly tickers = new Map<string, TickerUpdate>();
  private readonly trades = new Map<string, TradeRecord[]>();
  private readonly bookDeltas = new Map<string, BookDeltaRecord[]>();
  private readonly spreadStates = new Map<string, SpreadState>();

  constructor(symbols: string[], depthLevels = DEFAULT_DEPTH_LEVELS) {
    super();
    this.symbols = symbols;
    this.depthLevels = depthLevels;
  }

  async start(): Promise<void> {
    if (this.connected) return;
    this.stopped = false;
    try {
      const wsModule = await import('ws');
      this.connect(wsModule.default);
    } catch (error) {
      console.error('[ws-feed] Failed to load ws module:', error);
    }
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    this.reconnecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === 1;
  }

  getTicker(symbol: string): TickerUpdate | null {
    return this.tickers.get(symbol) ?? null;
  }

  getTickers(): TickerUpdate[] {
    return Array.from(this.tickers.values());
  }

  getMicrostructure(symbol: string): Level2Snapshot | null {
    const book = this.books.get(symbol);
    if (!book) return null;
    return this.computeSnapshot(symbol, book);
  }

  getAllMicrostructure(): Level2Snapshot[] {
    return Array.from(this.books.entries())
      .map(([symbol, book]) => this.computeSnapshot(symbol, book))
      .filter((snapshot): snapshot is Level2Snapshot => snapshot !== null);
  }

  private connect(WebSocket: typeof import('ws').default): void {
    if (this.stopped || (this.connected && this.ws?.readyState === 1)) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      if (this.stopped) {
        this.ws?.close();
        return;
      }
      this.connected = true;
      this.reconnecting = false;
      console.log(`[ws-feed] Connected to Coinbase public WebSocket for ${this.symbols.join(', ')}`);
      this.subscribe();
      this.emit('status', { connected: true, timestamp: new Date().toISOString() });
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          channel?: string;
          events?: Array<Record<string, unknown>>;
        };

        if (msg.channel === 'ticker') {
          this.handleTicker(msg.events ?? []);
        } else if (msg.channel === 'l2_data') {
          this.handleLevel2(msg.events ?? []);
        } else if (msg.channel === 'market_trades') {
          this.handleTrades(msg.events ?? []);
        }
      } catch {
        // Ignore parse errors from unexpected control messages.
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.emit('status', { connected: false, timestamp: new Date().toISOString() });
      if (this.stopped) return;
      if (!this.reconnecting) {
        this.reconnecting = true;
        console.warn('[ws-feed] Coinbase WebSocket disconnected. Reconnecting...');
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect(WebSocket);
        }, RECONNECT_DELAY_MS);
      }
    });

    this.ws.on('error', (error: Error) => {
      console.error('[ws-feed] Coinbase WebSocket error:', error.message);
    });
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== 1) return;

    const payloads = [
      { type: 'subscribe', product_ids: this.symbols, channel: 'ticker' },
      { type: 'subscribe', product_ids: this.symbols, channel: 'level2' },
      { type: 'subscribe', product_ids: this.symbols, channel: 'market_trades' }
    ];

    for (const payload of payloads) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private handleTicker(events: Array<Record<string, unknown>>): void {
    for (const event of events) {
      const tickers = Array.isArray(event.tickers) ? event.tickers as Array<Record<string, unknown>> : [];
      for (const ticker of tickers) {
        const symbol = text(ticker.product_id);
        const price = number(ticker.price);
        if (!symbol || price <= 0) continue;
        const update: TickerUpdate = {
          symbol,
          price,
          bid: number(ticker.best_bid) || price,
          ask: number(ticker.best_ask) || price,
          volume24h: number(ticker.volume_24_h),
          timestamp: new Date().toISOString()
        };
        this.tickers.set(symbol, update);
        this.emit('ticker', update);
      }
    }
  }

  private handleLevel2(events: Array<Record<string, unknown>>): void {
    for (const event of events) {
      const symbol = text(event.product_id);
      if (!symbol) continue;
      const updates = Array.isArray(event.updates) ? event.updates as Array<Record<string, unknown>> : [];
      const type = text(event.type);
      const book = this.books.get(symbol) ?? {
        bids: new Map<number, number>(),
        asks: new Map<number, number>(),
        updatedAt: new Date().toISOString()
      };

      if (type === 'snapshot') {
        book.bids.clear();
        book.asks.clear();
      }

      for (const update of updates) {
        const sideRaw = text(update.side).toLowerCase();
        const side = sideRaw === 'offer' ? 'ask' : sideRaw === 'bid' ? 'bid' : '';
        const price = number(update.price_level);
        const qty = number(update.new_quantity);
        if (!side || price <= 0 || qty < 0) continue;
        const target = side === 'bid' ? book.bids : book.asks;
        const previousQty = target.get(price) ?? 0;
        const deltaQty = qty - previousQty;
        const deltas = this.bookDeltas.get(symbol) ?? [];
        if (deltaQty > 0) {
          deltas.push({ side, action: 'add', notional: price * deltaQty, time: Date.now() });
        } else if (deltaQty < 0) {
          deltas.push({ side, action: 'remove', notional: price * Math.abs(deltaQty), time: Date.now() });
        }
        const cutoff = Date.now() - 60_000;
        while (deltas.length > 0 && deltas[0]!.time < cutoff) {
          deltas.shift();
        }
        this.bookDeltas.set(symbol, deltas);
        if (qty === 0) {
          target.delete(price);
        } else {
          target.set(price, qty);
        }
      }

      book.updatedAt = new Date().toISOString();
      this.books.set(symbol, book);
      const snapshot = this.computeSnapshot(symbol, book);
      if (snapshot) {
        this.emit('level2', snapshot);
      }
    }
  }

  private handleTrades(events: Array<Record<string, unknown>>): void {
    for (const event of events) {
      const trades = Array.isArray(event.trades) ? event.trades as Array<Record<string, unknown>> : [];
      for (const trade of trades) {
        const symbol = text(trade.product_id);
        const side = text(trade.side).toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
        const size = number(trade.size);
        const timeText = text(trade.time);
        const time = Number.isFinite(Date.parse(timeText)) ? Date.parse(timeText) : Date.now();
        if (!symbol || size <= 0) continue;
        const bucket = this.trades.get(symbol) ?? [];
        bucket.push({ side, size, time });
        const cutoff = Date.now() - 60_000;
        while (bucket.length > 0 && bucket[0]!.time < cutoff) {
          bucket.shift();
        }
        this.trades.set(symbol, bucket);
        const book = this.books.get(symbol);
        if (book) {
          const snapshot = this.computeSnapshot(symbol, book);
          if (snapshot) {
            this.emit('level2', snapshot);
          }
        }
      }
    }
  }

  private computeSnapshot(symbol: string, book: BookState): Level2Snapshot | null {
    const bids = Array.from(book.bids.entries())
      .sort((left, right) => right[0] - left[0])
      .slice(0, this.depthLevels);
    const asks = Array.from(book.asks.entries())
      .sort((left, right) => left[0] - right[0])
      .slice(0, this.depthLevels);
    if (bids.length === 0 || asks.length === 0) return null;

    const bestBid = bids[0]![0];
    const bestAsk = asks[0]![0];
    const spread = Math.max(0, bestAsk - bestBid);
    const mid = (bestBid + bestAsk) / 2;
    const spreadBps = mid > 0 ? (spread / mid) * 10_000 : 0;
    const existingSpread = this.spreadStates.get(symbol);
    if (!existingSpread || Math.abs(existingSpread.spread - spread) > 1e-9) {
      this.spreadStates.set(symbol, { spread, since: Date.now() });
    }
    const spreadStableMs = Date.now() - (this.spreadStates.get(symbol)?.since ?? Date.now());
    const bidDepth = bids.reduce((sum, [price, qty]) => sum + price * qty, 0);
    const askDepth = asks.reduce((sum, [price, qty]) => sum + price * qty, 0);
    const totalDepth = bidDepth + askDepth;
    const imbalancePct = totalDepth > 0 ? ((bidDepth - askDepth) / totalDepth) * 100 : 0;
    const bestBidQty = bids[0]![1];
    const bestAskQty = asks[0]![1];
    const queueImbalancePct = (bestBidQty + bestAskQty) > 0 ? ((bestBidQty - bestAskQty) / (bestBidQty + bestAskQty)) * 100 : 0;
    const microPrice = (bestAsk * bestBidQty + bestBid * bestAskQty) / Math.max(bestBidQty + bestAskQty, Number.EPSILON);
    const bidSlopeBps = computeSlopeBps(bids, bestBid, 'bid');
    const askSlopeBps = computeSlopeBps(asks, bestAsk, 'ask');
    const recentTrades = this.trades.get(symbol) ?? [];
    const aggressiveBuyVolume = recentTrades.filter((trade) => trade.side === 'BUY').reduce((sum, trade) => sum + trade.size, 0);
    const aggressiveSellVolume = recentTrades.filter((trade) => trade.side === 'SELL').reduce((sum, trade) => sum + trade.size, 0);
    const tradeTotal = aggressiveBuyVolume + aggressiveSellVolume;
    const tradeImbalancePct = tradeTotal > 0 ? ((aggressiveBuyVolume - aggressiveSellVolume) / tradeTotal) * 100 : 0;
    const bookDeltas = this.bookDeltas.get(symbol) ?? [];
    const bidAddNotional = bookDeltas.filter((delta) => delta.side === 'bid' && delta.action === 'add').reduce((sum, delta) => sum + delta.notional, 0);
    const bidRemoveNotional = bookDeltas.filter((delta) => delta.side === 'bid' && delta.action === 'remove').reduce((sum, delta) => sum + delta.notional, 0);
    const askAddNotional = bookDeltas.filter((delta) => delta.side === 'ask' && delta.action === 'add').reduce((sum, delta) => sum + delta.notional, 0);
    const askRemoveNotional = bookDeltas.filter((delta) => delta.side === 'ask' && delta.action === 'remove').reduce((sum, delta) => sum + delta.notional, 0);
    const bullishPressure = bidAddNotional + askRemoveNotional;
    const bearishPressure = askAddNotional + bidRemoveNotional;
    const pressureTotal = bullishPressure + bearishPressure;
    const pressureImbalancePct = pressureTotal > 0 ? ((bullishPressure - bearishPressure) / pressureTotal) * 100 : 0;

    return {
      symbol,
      bidDepth: round(bidDepth, 2),
      askDepth: round(askDepth, 2),
      imbalancePct: round(imbalancePct, 2),
      queueImbalancePct: round(queueImbalancePct, 2),
      pressureImbalancePct: round(pressureImbalancePct, 2),
      microPrice: round(microPrice, 2),
      bestBid: round(bestBid, 2),
      bestAsk: round(bestAsk, 2),
      spread: round(spread, 6),
      spreadBps: round(spreadBps, 3),
      spreadStableMs,
      bidSlopeBps: round(bidSlopeBps, 3),
      askSlopeBps: round(askSlopeBps, 3),
      aggressiveBuyVolume: round(aggressiveBuyVolume, 6),
      aggressiveSellVolume: round(aggressiveSellVolume, 6),
      tradeImbalancePct: round(tradeImbalancePct, 2),
      bidAddNotional: round(bidAddNotional, 2),
      bidRemoveNotional: round(bidRemoveNotional, 2),
      askAddNotional: round(askAddNotional, 2),
      askRemoveNotional: round(askRemoveNotional, 2),
      recentTradeCount: recentTrades.length,
      depthLevels: this.depthLevels,
      updatedAt: book.updatedAt
    };
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number {
  return typeof value === 'string'
    ? Number(value)
    : typeof value === 'number'
      ? value
      : 0;
}

function computeSlopeBps(levels: Array<[number, number]>, best: number, side: 'bid' | 'ask'): number {
  if (levels.length === 0 || best <= 0) return 0;
  let weightedDistance = 0;
  let totalQty = 0;
  for (const [price, qty] of levels) {
    const distanceBps = side === 'bid'
      ? ((best - price) / best) * 10_000
      : ((price - best) / best) * 10_000;
    weightedDistance += distanceBps * qty;
    totalQty += qty;
  }
  return totalQty > 0 ? weightedDistance / totalQty : 0;
}

function round(value: number, decimals: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}
