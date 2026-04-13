// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createSign, createPrivateKey } from 'node:crypto';
import type { OrderStatus, RiskCheck } from '@hermes/contracts';
import type {
  VenueId,
  SyncStatus,
  BrokerAccountSnapshot,
  BrokerRouteReport,
  NormalizedOrder,
  RouteReportPatch
} from './broker-types.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ── Environment loading ──────────────────────────────────────────────

export const projectEnv = loadProjectEnv();
export const legacyEnv = loadLegacyEnv();

function loadProjectEnv(): Record<string, string> {
  const filePath = path.resolve(moduleDir, '../../../.env');
  return parseEnvFile(filePath);
}

function loadLegacyEnv(): Record<string, string> {
  const files = [
    path.resolve(moduleDir, '../../../../project-sanctuary/hermes-trading-post/backend/.env'),
    path.resolve(moduleDir, '../../../../project-sanctuary/hermes-trading-post/backend/live-bots/.env'),
    path.resolve(moduleDir, '../../../../project-sanctuary/hermes-trading-post/backend/live-ai-bots/.env')
  ];
  const values: Record<string, string> = {};
  for (const filePath of files) {
    const parsed = parseEnvFile(filePath);
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in values)) {
        values[key] = value;
      }
    }
  }
  return values;
}

function parseEnvFile(filePath: string): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    if (!fs.existsSync(filePath)) {
      return values;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }
      const separator = line.indexOf('=');
      if (separator <= 0) {
        continue;
      }
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !(key in values)) {
        values[key] = value;
      }
    }
  } catch {
    // Ignore env read failures.
  }
  return values;
}

export function readEnv(names: string[], normalizeNewlines = false): string {
  for (const name of names) {
    const value = process.env[name] ?? projectEnv[name] ?? legacyEnv[name];
    if (!value) {
      continue;
    }
    const normalized = normalizeNewlines ? value.replace(/\\n/g, '\n') : value;
    const trimmed = normalized.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return '';
}

// ── Generic helpers ──────────────────────────────────────────────────

export function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['data', 'items', 'accounts', 'positions', 'fills', 'orders', 'results']) {
      const candidate = record[key];
      if (Array.isArray(candidate)) return candidate;
    }
  }
  return [];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function textField(source: unknown, paths: string[]): string | null {
  const record = asRecord(source);
  for (const pathName of paths) {
    const value = deepGet(record, pathName);
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

export function numberField(source: unknown, paths: string[]): number | null {
  const record = asRecord(source);
  for (const pathName of paths) {
    const value = deepGet(record, pathName);
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export function booleanField(source: unknown, paths: string[]): boolean | null {
  const record = asRecord(source);
  for (const pathName of paths) {
    const value = deepGet(record, pathName);
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
    }
  }
  return null;
}

function deepGet(source: Record<string, unknown>, pathName: string): unknown {
  const segments = pathName.split('.');
  let current: unknown = source;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function extractErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string' && payload.trim().length > 0) {
    return payload;
  }
  const record = asRecord(payload);
  for (const key of ['message', 'error', 'error_message', 'errorMessage']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return fallback;
}

export function normalizeOrderStatus(value: string | null, fallback: OrderStatus): OrderStatus {
  switch ((value ?? '').toLowerCase()) {
    case 'accepted':
    case 'new':
    case 'pending':
    case 'open':
      return 'accepted';
    case 'filled':
      return 'filled';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    case 'rejected':
    case 'expired':
      return 'rejected';
    default:
      return fallback;
  }
}

export function collectFetchErrors(responses: Array<{ ok: boolean; status: number; data: unknown }>): string[] {
  const errors: string[] = [];
  for (const response of responses) {
    if (!response.ok) {
      errors.push(extractErrorMessage(response.data, `HTTP ${response.status}`));
    }
  }
  return errors;
}

export function emptyBrokerSnapshot(broker: VenueId, venue: 'alpaca' | 'coinbase' | 'oanda'): BrokerAccountSnapshot {
  return {
    broker,
    venue,
    status: 'missing-credentials',
    asOf: new Date().toISOString(),
    account: null,
    positions: [],
    fills: [],
    orders: [],
    errors: []
  };
}

export function buildRouteReport(
  order: NormalizedOrder,
  patch: RouteReportPatch,
  startedAt: number
): BrokerRouteReport {
  return {
    id: randomUUID(),
    orderId: patch.orderId ?? order.id,
    broker: order.broker,
    brokerMode: order.broker,
    venue: order.broker === 'alpaca-paper' ? 'alpaca' : order.broker === 'coinbase-live' ? 'coinbase' : 'oanda',
    symbol: order.symbol,
    status: patch.status,
    filledQty: patch.filledQty,
    avgFillPrice: patch.avgFillPrice,
    slippageBps: patch.slippageBps,
    latencyMs: Date.now() - startedAt,
    message: patch.message,
    timestamp: new Date().toISOString(),
    mode: order.mode,
    source: 'broker',
    riskCheck: patch.riskCheck,
    eventSource: patch.eventSource,
    details: patch.details,
    errors: patch.errors,
    accountSnapshot: patch.accountSnapshot ?? null,
    positionsSnapshot: patch.positionsSnapshot ?? [],
    fillsSnapshot: patch.fillsSnapshot ?? [],
    ordersSnapshot: patch.ordersSnapshot ?? []
  };
}

export async function requestJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
  requestTimeoutMs = 20_000
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? requestTimeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    const text = await response.text();
    let data: unknown = text;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

export function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
