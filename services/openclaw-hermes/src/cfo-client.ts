/**
 * CFO client — fetches live alerts and can post requests back to the CFO.
 * Enables bidirectional COO↔CFO communication instead of the old
 * one-way file-based alert stream.
 */

import { CFO_URL } from './config.js';
import { logger } from '@hermes/logger';

export interface CfoAlert {
  severity: 'warning' | 'critical';
  metric: string;
  value: string;
  recommendation: string;
  timestamp: string;
}

export interface CfoAlertsPayload {
  alerts: CfoAlert[];
  updatedAt: string;
}

export async function fetchCfoAlerts(): Promise<CfoAlert[]> {
  const res = await fetch(`${CFO_URL}/alerts`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`CFO returned ${res.status}`);
  const data = await res.json() as CfoAlertsPayload;
  return data.alerts ?? [];
}

export async function fetchCfoMetrics(): Promise<unknown> {
  const res = await fetch(`${CFO_URL}/metrics`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`CFO metrics returned ${res.status}`);
  return res.json();
}

export async function sendCfoRequest(requestType: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`${CFO_URL}/coo-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestType, payload, sentAt: new Date().toISOString() }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) logger.warn({ status: res.status }, 'CFO coo-request returned non-OK');
    else logger.info({ requestType }, 'CFO request sent');
  } catch (err) {
    logger.warn({ err: String(err), requestType }, 'Failed to send CFO request');
  }
}
