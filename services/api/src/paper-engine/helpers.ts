/**
 * Paper Engine Helpers
 *
 * Small pure utility functions used across the engine.
 * No shared state — all inputs passed as parameters.
 */

import type { AssetClass, BrokerId, TradeJournalEntry } from '@hermes/contracts';
import type { SessionBucket, SymbolState, PerformanceSummary } from './types.js';
import { HISTORY_LIMIT } from './types.js';
import { round } from '../paper-engine-utils.js';

export function getSessionBucket(isoTs = new Date().toISOString()): SessionBucket {
  const hour = new Date(isoTs).getUTCHours();
  if (hour >= 0 && hour <= 6) return 'asia';
  if (hour >= 7 && hour <= 12) return 'europe';
  if (hour >= 13 && hour <= 20) return 'us';
  return 'off';
}

export function getVolatilityBucket(volatility: number): 'low' | 'medium' | 'high' {
  if (volatility >= 0.02) return 'high';
  if (volatility >= 0.008) return 'medium';
  return 'low';
}

type SymbolCluster = 'crypto' | 'equity' | 'forex' | 'bond' | 'commodity';

export function getSymbolCluster(assetClass: AssetClass): SymbolCluster {
  if (assetClass === 'commodity' || assetClass === 'commodity-proxy') return 'commodity';
  if (assetClass === 'crypto') return 'crypto';
  if (assetClass === 'equity') return 'equity';
  if (assetClass === 'bond') return 'bond';
  return 'forex';
}

export function getClusterLimitPct(cluster: SymbolCluster): number {
  if (cluster === 'crypto') return 45;
  if (cluster === 'equity') return 35;
  if (cluster === 'forex') return 40;
  if (cluster === 'bond') return 30;
  return 25;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? 0;
}

export function formatBrokerLabel(broker: BrokerId): string {
  if (broker === 'alpaca-paper') return 'Alpaca paper';
  if (broker === 'oanda-rest') return 'OANDA practice';
  if (broker === 'coinbase-live') return 'Coinbase paper';
  return broker;
}

export function summarizePerformance(entries: TradeJournalEntry[]): PerformanceSummary {
  const sampleCount = entries.length;
  const wins = entries.filter((e) => e.realizedPnl > 0).length;
  const losses = entries.filter((e) => e.realizedPnl < 0).length;
  const winRate = sampleCount > 0 ? (wins / sampleCount) * 100 : 0;
  const grossWins = entries.filter((e) => e.realizedPnl > 0).reduce((s, e) => s + e.realizedPnl, 0);
  const grossLosses = Math.abs(entries.filter((e) => e.realizedPnl < 0).reduce((s, e) => s + e.realizedPnl, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0;
  const expectancy = sampleCount > 0 ? entries.reduce((s, e) => s + e.realizedPnl, 0) / sampleCount : 0;
  return { sampleCount, wins, losses, winRate, profitFactor, expectancy };
}

export function pushPoint(target: number[], value: number, limit = HISTORY_LIMIT): void {
  target.push(round(value, 2));
  if (target.length > limit) {
    target.shift();
  }
}
