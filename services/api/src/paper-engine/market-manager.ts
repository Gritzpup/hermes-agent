/**
 * Market Manager Sub-Engine
 *
 * Handles market data synchronization, tape building, and data source management.
 */

import fs from 'node:fs';
import type { MarketSnapshot, MarketSession } from '@hermes/contracts';
import type { SymbolState, PersistedMarketDataState } from './types.js';
import { MARKET_DATA_RUNTIME_PATH } from './types.js';
import { getMarketIntel } from '../market-intel.js';
import { round } from '../paper-engine-utils.js';
import type { SharedState } from './shared-state.js';

export class MarketManager {
  constructor(private state: SharedState) {}

  /** Sync market data from the runtime JSON file written by market-data service */
  syncFromRuntime(recordHistory: boolean): boolean {
    const runtime = this.loadRuntime();
    if (!runtime) return false;

    this.state.marketDataSources = runtime.sources;
    const snapshotMap = new Map(runtime.snapshots.map((s) => [s.symbol, s]));

    for (const symbol of this.state.market.values()) {
      const snapshot = snapshotMap.get(symbol.symbol);
      if (snapshot) {
        this.applySnapshot(symbol, snapshot, recordHistory);
      } else {
        symbol.marketStatus = 'stale';
        symbol.sourceMode = 'service';
        symbol.tradable = false;
        symbol.qualityFlags = ['awaiting-market-data'];
        symbol.updatedAt = runtime.asOf;
      }
    }

    return snapshotMap.size > 0;
  }

  /** Check if a symbol has a tradable tape */
  hasTradableTape(symbol: SymbolState): boolean {
    return symbol.tradable && symbol.price > 0 && symbol.marketStatus === 'live';
  }

  /** Classify the regime for a symbol based on its recent behavior */
  classifyRegime(symbol: SymbolState): string {
    if (symbol.history.length < 10) return 'unknown';
    const recent = symbol.history.slice(-20);
    const volatility = symbol.volatility;
    const drift = Math.abs(symbol.drift);

    if (volatility >= 0.02 || drift >= 0.003) return 'panic';
    if (drift >= 0.0015) return 'trend';
    if (volatility <= 0.004 && drift <= 0.0005) return 'compression';
    return 'chop';
  }

  /** Build market tape snapshot for dashboard */
  buildTape(): Array<{
    symbol: string;
    broker: string;
    status: string;
    tradable: boolean;
    price: number;
    spreadBps: number;
    liquidityScore: number;
    qualityFlags: string[];
  }> {
    return Array.from(this.state.market.values()).map((s) => ({
      symbol: s.symbol,
      broker: s.broker,
      status: s.marketStatus,
      tradable: s.tradable,
      price: round(s.price, 2),
      spreadBps: round(s.spreadBps, 2),
      liquidityScore: Math.round(s.liquidityScore),
      qualityFlags: [...s.qualityFlags]
    }));
  }

  /** Get data source status for each venue */
  getDataSources() {
    return this.state.marketDataSources;
  }

  private loadRuntime(): PersistedMarketDataState | null {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (!fs.existsSync(MARKET_DATA_RUNTIME_PATH)) return null;
        const raw = fs.readFileSync(MARKET_DATA_RUNTIME_PATH, 'utf8');
        const parsed = JSON.parse(raw) as PersistedMarketDataState;
        if (!Array.isArray(parsed.snapshots)) return null;
        return {
          asOf: parsed.asOf ?? new Date().toISOString(),
          snapshots: parsed.snapshots,
          sources: Array.isArray(parsed.sources) ? parsed.sources : []
        };
      } catch {
        if (attempt < 2) continue;
        return null;
      }
    }
    return null;
  }

  private applySnapshot(symbol: SymbolState, snapshot: MarketSnapshot, recordHistory: boolean): void {
    // Don't overwrite good data with a zero-price snapshot from another broker
    if (snapshot.lastPrice <= 0 && symbol.price > 0 && symbol.tradable) return;

    const previousPrice = symbol.price;
    const nextPrice = snapshot.lastPrice > 0 ? snapshot.lastPrice : previousPrice;
    const openPrice = snapshot.changePct !== 0
      ? nextPrice / (1 + snapshot.changePct / 100)
      : symbol.openPrice > 0 ? symbol.openPrice : nextPrice;
    const nextReturn = previousPrice > 0 ? (nextPrice - previousPrice) / previousPrice : 0;
    const session = snapshot.session ?? (snapshot.assetClass === 'equity' ? 'unknown' : 'regular');
    const qualityFlags = Array.isArray(snapshot.qualityFlags) ? [...snapshot.qualityFlags] : [];
    const tradable = snapshot.tradable ?? (
      snapshot.status === 'live'
      && snapshot.source !== 'mock'
      && snapshot.source !== 'simulated'
      && nextPrice > 0
      && session === 'regular'
      && qualityFlags.length === 0
    );

    symbol.broker = snapshot.broker;
    symbol.assetClass = snapshot.assetClass;
    symbol.marketStatus = snapshot.status;
    symbol.sourceMode = snapshot.source ?? 'service';
    symbol.session = session;
    symbol.tradable = tradable;
    symbol.qualityFlags = qualityFlags;
    symbol.updatedAt = snapshot.updatedAt ?? new Date().toISOString();
    symbol.price = round(nextPrice, 2);
    symbol.openPrice = round(openPrice, 2);
    symbol.volume = snapshot.volume ?? symbol.volume;
    symbol.liquidityScore = snapshot.liquidityScore ?? symbol.liquidityScore;
    symbol.spreadBps = snapshot.spreadBps > 0 ? round(snapshot.spreadBps, 2) : symbol.spreadBps;
    symbol.baseSpreadBps = snapshot.spreadBps || symbol.baseSpreadBps;

    if (recordHistory && nextPrice > 0) {
      symbol.history.push(nextPrice);
      if (symbol.history.length > 200) symbol.history.shift();
      symbol.returns.push(nextReturn);
      if (symbol.returns.length > 200) symbol.returns.shift();
    }

    // Update rolling statistics
    if (symbol.history.length >= 5) {
      const recent = symbol.history.slice(-20);
      const avg = recent.reduce((s, v) => s + v, 0) / recent.length;
      symbol.meanAnchor = round(avg, 2);
      symbol.drift = round(nextReturn, 6);
      const variance = recent.reduce((s, v) => s + (v - avg) ** 2, 0) / recent.length;
      symbol.volatility = round(Math.sqrt(variance) / avg, 6);
      symbol.bias = round((nextPrice - avg) / avg, 6);
    }

    // Feed market intel with price data
    try {
      getMarketIntel().feedPrice(symbol.symbol, nextPrice, snapshot.volume);
    } catch { /* market-intel not ready */ }
  }
}
