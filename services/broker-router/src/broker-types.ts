// @ts-nocheck
import type { OrderStatus, RiskCheck, PositionSnapshot } from '@hermes/contracts';

export type VenueId = 'alpaca-paper' | 'coinbase-live' | 'oanda-rest';
export type SyncStatus = 'healthy' | 'degraded' | 'missing-credentials' | 'error';

export interface BrokerAccountSnapshot {
  broker: VenueId;
  venue: 'alpaca' | 'coinbase' | 'oanda';
  status: SyncStatus;
  asOf: string;
  account: unknown;
  positions: unknown[];
  fills: unknown[];
  orders: unknown[];
  errors: string[];
}

export interface BrokerRuntimeState {
  asOf: string;
  lastSyncAt: string | null;
  brokers: Record<VenueId, BrokerAccountSnapshot>;
  reports: BrokerRouteReport[];
}

export interface BrokerRouteReport {
  id: string;
  orderId: string;
  broker: VenueId;
  symbol: string;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice: number;
  slippageBps: number;
  latencyMs: number;
  message: string;
  timestamp: string;
  brokerMode: VenueId;
  mode: 'paper' | 'live';
  venue: 'alpaca' | 'coinbase' | 'oanda';
  riskCheck: RiskCheck | null;
  source: 'broker' | 'simulated' | 'mock';
  eventSource: 'route' | 'sync';
  details: string;
  errors: string[];
  accountSnapshot: unknown;
  positionsSnapshot: unknown[];
  fillsSnapshot: unknown[];
  ordersSnapshot: unknown[];
}

export interface NormalizedOrder {
  id: string;
  symbol: string;
  broker: VenueId;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  notional: number;
  quantity: number;
  limitPrice?: number | undefined;
  timeInForce?: 'day' | 'gtc' | 'ioc' | 'fok' | undefined;
  postOnly?: boolean | undefined;
  strategy: string;
  mode: 'paper' | 'live';
  thesis: string;
}

export interface RouteReportPatch {
  orderId?: string;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice: number;
  slippageBps: number;
  message: string;
  riskCheck: RiskCheck | null;
  eventSource: 'route' | 'sync';
  details: string;
  errors: string[];
  accountSnapshot?: unknown;
  positionsSnapshot?: unknown[];
  fillsSnapshot?: unknown[];
  ordersSnapshot?: unknown[];
}

export { OrderStatus, RiskCheck, PositionSnapshot };
