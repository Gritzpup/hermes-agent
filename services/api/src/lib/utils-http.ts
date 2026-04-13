import type { ServiceHealth } from '@hermes/contracts';
import {
  MARKET_DATA_URL,
  RISK_ENGINE_URL,
  BROKER_ROUTER_URL,
  REVIEW_LOOP_URL,
  BACKTEST_URL,
  STRATEGY_LAB_URL
} from './constants.js';

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function fetchJson<T>(baseUrl: string, pathname: string, timeoutMs = 5_000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${pathname}`, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return await response.json() as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchArrayJson<T>(baseUrl: string, pathname: string): Promise<T[]> {
  const value = await fetchJson<unknown>(baseUrl, pathname);
  return Array.isArray(value) ? value as T[] : [];
}

export async function pingService(name: string, portNumber: number, baseUrl: string): Promise<ServiceHealth> {
  const health = await fetchJson<Record<string, unknown>>(baseUrl, '/health', 5_000);
  if (!health) {
    return { name, port: portNumber, status: 'warning', message: 'Service unavailable or not configured' };
  }

  const status = health.status === 'healthy' ? 'healthy' : 'warning';
  const message = asString(health.message)
    ?? asString(health.detail)
    ?? (Array.isArray(health.brokers) ? `Configured brokers: ${health.brokers.length}` : 'Service responded');

  return { name, port: portNumber, status, message };
}

export async function getServiceHealthSnapshot(): Promise<ServiceHealth[]> {
  const checks = await Promise.all([
    pingService('market-data', 4302, MARKET_DATA_URL),
    pingService('risk-engine', 4301, RISK_ENGINE_URL),
    pingService('broker-router', 4303, BROKER_ROUTER_URL),
    pingService('review-loop', 4304, REVIEW_LOOP_URL),
    pingService('backtest', 4305, BACKTEST_URL),
    pingService('strategy-lab', 4306, STRATEGY_LAB_URL)
  ]);

  return [
    { name: 'api', port: 4300, status: 'healthy', message: 'Control plane online' },
    ...checks
  ];
}
