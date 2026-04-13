import type { BrokerAccountSnapshot, BrokerId, ServiceHealthStatus } from '@hermes/contracts';

export type NormalizedBrokerStatus = 'connected' | 'degraded' | 'disconnected';

export function normalizeBrokerStatus(status?: string | null): NormalizedBrokerStatus {
  const value = status?.toLowerCase();
  switch (value) {
    case 'healthy':
    case 'connected':
    case 'ready':
    case 'active':
    case 'ok':
    case 'live':
      return 'connected';
    case 'degraded':
    case 'warning':
    case 'partial':
    case 'stale':
    case 'delayed':
    case 'error':
      return 'degraded';
    default:
      return 'disconnected';
  }
}

export function normalizeServiceHealthStatus(status?: ServiceHealthStatus | null): NormalizedBrokerStatus {
  switch (status) {
    case 'healthy':
      return 'connected';
    case 'warning':
      return 'degraded';
    default:
      return 'disconnected';
  }
}

export function isBrokerConnected(status?: string | null): boolean {
  return normalizeBrokerStatus(status) === 'connected';
}

export function brokerStatusTone(status?: string | null): 'healthy' | 'warning' | 'critical' {
  const normalized = normalizeBrokerStatus(status);
  if (normalized === 'connected') return 'healthy';
  if (normalized === 'degraded') return 'warning';
  return 'critical';
}

export function createSyntheticLiveRouteAccount(
  broker: Extract<BrokerId, 'alpaca-paper' | 'oanda-rest'>,
  serviceStatus: ServiceHealthStatus | undefined,
  updatedAt: string
): BrokerAccountSnapshot {
  return {
    broker,
    mode: 'live',
    accountId: `${broker}-live-route`,
    currency: 'USD',
    cash: 0,
    buyingPower: 0,
    equity: 0,
    status: normalizeServiceHealthStatus(serviceStatus),
    source: 'mock',
    updatedAt,
    availableToTrade: 0
  };
}
