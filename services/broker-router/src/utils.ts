/**
 * Broker Router Utilities
 *
 * Shared helper functions used across broker implementations.
 */

import type { BrokerId } from '@hermes/contracts';

export function readEnv(keys: string[], multiline = false): string {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim().length > 0) {
      return multiline ? value : value.trim();
    }
  }
  return '';
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function textField(source: unknown, paths: string[]): string | null {
  const record = asRecord(source);
  for (const p of paths) {
    const val = record[p];
    if (typeof val === 'string' && val.length > 0) return val;
  }
  return null;
}

export function numberField(source: unknown, paths: string[]): number | null {
  const record = asRecord(source);
  for (const p of paths) {
    const raw = record[p];
    const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(num)) return num;
  }
  return null;
}

export function normalizeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['data', 'items', 'positions', 'accounts', 'fills', 'orders', 'trades']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeOrderStatus(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (['filled', 'fill'].includes(lower)) return 'filled';
  if (['partially_filled', 'partial'].includes(lower)) return 'partially_filled';
  if (['canceled', 'cancelled', 'expired'].includes(lower)) return 'canceled';
  if (['rejected', 'error'].includes(lower)) return 'rejected';
  if (['new', 'accepted', 'pending_new'].includes(lower)) return 'accepted';
  return fallback;
}

export function parseBrokerId(value: unknown): BrokerId | null {
  const text = typeof value === 'string' ? value : Array.isArray(value) ? value[0] : '';
  if (text === 'alpaca-paper' || text === 'coinbase-live' || text === 'oanda-rest') {
    return text;
  }
  return null;
}

export function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function splitList(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

export function normalizeAlpacaSymbol(raw: string): string {
  return raw.replace('/', '-');
}
