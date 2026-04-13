// @ts-nocheck
import { round } from '../paper-engine-utils.js';

export function getTapeQualityBlock(engine: any, symbol: any): string | null {
  if (symbol.price <= 0) return 'no market price';
  if (symbol.spreadBps > 100) return `spread too wide (${symbol.spreadBps.toFixed(1)}bps)`;

  const ageMs = Date.now() - new Date(symbol.updatedAt).getTime();

  // OANDA commodities (Gold, Silver, Oil, etc.) and forex are closed from
  // Friday ~21:00 UTC to Sunday ~21:00 UTC. When the market is genuinely
  // closed the feed stops updating — that's expected, not a data fault.
  // Show "market closed" instead of the misleading "market data stale".
  const isOandaAsset = symbol.assetClass === 'commodity' || symbol.assetClass === 'forex' || symbol.assetClass === 'bond';
  if (isOandaAsset && ageMs > 120_000) {
    const now = new Date();
    const utcDay = now.getUTCDay();   // 0 = Sunday, 6 = Saturday
    const utcHour = now.getUTCHours();
    // OANDA forex/commodity markets close Friday ~21:00 UTC, reopen Sunday ~21:00 UTC
    const weekendClosed =
      utcDay === 6                                 // all Saturday
      || (utcDay === 5 && utcHour >= 21)           // Friday after 21:00 UTC
      || (utcDay === 0 && utcHour < 21);           // Sunday before 21:00 UTC
    if (weekendClosed) {
      return `${symbol.symbol} market closed (OANDA weekend)`;
    }
  }

  // OANDA polls less frequently than WebSocket feeds; allow up to 120 s
  // before flagging staleness for non-equity broker-fed assets.
  const staleThresholdMs = isOandaAsset ? 120_000 : 60_000;
  if (ageMs > staleThresholdMs) return 'market data stale';

  return null;
}

export function getPrecisionBlock(engine: any, agent: any, symbol: any): string | null {
  // Logic to prevent entry if precision requirement isn't met
  return null;
}

export function getRouteBlock(engine: any, agent: any, symbol: any): string | null {
  // Logic to prevent entry based on broker route status
  return null;
}

export function getManagerBlock(engine: any, agent: any, symbol: any): string | null {
  // Centralized manager desk kills/blocks
  return null;
}

export function getAdaptiveCooldown(engine: any, agent: any, symbol: any): number {
  const outcomes = agent.recentOutcomes ?? [];
  const consecutiveLosses = engine.countConsecutiveLosses(outcomes);
  const base = agent.config.cooldownTicks ?? 10;
  if (consecutiveLosses >= 2) return base * 3;
  if (consecutiveLosses >= 1) return base * 2;
  return base;
}

export function canUseBrokerRulesFastPath(engine: any, agent: any, symbol: any, score: number, aiDecision: any): boolean {
  // Determine if manager rules are strong enough to skip AI vote
  return score >= 8 && aiDecision?.status !== 'rejected';
}

export function fastPathThreshold(engine: any, style: string): number {
  if (style === 'momentum') return 9;
  return 12;
}

export function estimatedBrokerRoundTripCostBps(engine: any, symbol: any): number {
  const fee = (engine.getFeeRate(symbol.assetClass) ?? 0.0003) * 2;
  return fee * 10_000 + (symbol.spreadBps ?? 4);
}
