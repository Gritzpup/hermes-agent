// @ts-nocheck
import type { MarketSnapshot, MarketDataSourceState, MarketDataSnapshotResponse, BrokerId } from '@hermes/contracts';

export type HealthStatus = 'healthy' | 'warning' | 'critical';
export type SourceStatus = 'live' | 'degraded' | 'stale';
export type MarketSession = 'regular' | 'extended' | 'unknown';

export type { MarketSnapshot, MarketDataSourceState, MarketDataSnapshotResponse, BrokerId };
