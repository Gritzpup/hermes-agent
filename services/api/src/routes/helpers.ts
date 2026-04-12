/**
 * API Route Helpers
 *
 * Shared utility functions used across API routes.
 * Extracted from index.ts to keep the main file under 1000 lines.
 */

import type {
  BrokerAccountSnapshot,
  ExecutionReport,
  MarketSnapshot,
  OverviewSnapshot,
  PositionSnapshot,
  ResearchCandidate,
  ServiceHealth,
  TradeJournalEntry
} from '@hermes/contracts';

// ─── Generic Utilities ───

export function round(value: number, decimals: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}

export function normalizeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function textField(source: unknown, paths: string[]): string | null {
  const record = asRecord(source);
  for (const p of paths) {
    const val = deepGet(record, p);
    if (typeof val === 'string' && val.length > 0) return val;
  }
  return null;
}

export function numberField(source: unknown, paths: string[]): number | null {
  const record = asRecord(source);
  for (const p of paths) {
    const val = deepGet(record, p);
    const num = typeof val === 'number' ? val : typeof val === 'string' ? Number(val) : NaN;
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function deepGet(source: Record<string, unknown>, pathName: string): unknown {
  const parts = pathName.split('.');
  let current: unknown = source;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function peak(values: number[]): number {
  return values.length > 0 ? Math.max(...values) : 0;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function previewText(value: string | undefined, limit = 120): string {
  if (!value) return '';
  return value.length <= limit ? value : value.slice(0, limit) + '…';
}

// ─── Dedup Helpers ───

export function dedupePositions(positions: PositionSnapshot[]): PositionSnapshot[] {
  const seen = new Map<string, PositionSnapshot>();
  for (const p of positions) {
    const key = `${p.broker}:${p.symbol}`;
    if (!seen.has(key) || (p.quantity > (seen.get(key)?.quantity ?? 0))) {
      seen.set(key, p);
    }
  }
  return Array.from(seen.values());
}

export function dedupeReports(reports: ExecutionReport[]): ExecutionReport[] {
  const seen = new Set<string>();
  return reports.filter((r) => { const k = r.id; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function dedupeJournal(entries: TradeJournalEntry[]): TradeJournalEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => { const k = e.id; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function dedupeMarketSnapshots(snapshots: MarketSnapshot[]): MarketSnapshot[] {
  const seen = new Map<string, MarketSnapshot>();
  for (const s of snapshots) {
    seen.set(s.symbol, s);
  }
  return Array.from(seen.values());
}

// ─── Service Health ───

export async function pingService(name: string, portNumber: number, baseUrl: string): Promise<ServiceHealth> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (response.ok) {
      const data = await response.json() as Record<string, unknown>;
      return {
        name,
        port: portNumber,
        status: 'healthy' as ServiceHealth['status'],
        message: typeof data.status === 'string' ? data.status : 'ok'
      };
    }
    return { name, port: portNumber, status: 'degraded' as ServiceHealth['status'], message: `HTTP ${response.status}` };
  } catch {
    return { name, port: portNumber, status: 'critical' as ServiceHealth['status'], message: 'unreachable' };
  }
}

export async function fetchJson<T>(baseUrl: string, pathname: string, timeoutMs = 5_000): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${baseUrl}${pathname}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

export async function fetchArrayJson<T>(baseUrl: string, pathname: string): Promise<T[]> {
  const result = await fetchJson<T[]>(baseUrl, pathname);
  return Array.isArray(result) ? result : [];
}

// ─── Research ───

export function buildResearchCandidates(snapshots: MarketSnapshot[]): ResearchCandidate[] {
  return snapshots
    .filter((s) => s.status === 'live' && s.source !== 'mock' && s.source !== 'simulated')
    .sort((a, b) => researchPriority(b) - researchPriority(a) || (b.liquidityScore - a.liquidityScore) || (a.spreadBps - b.spreadBps))
    .slice(0, 8)
    .map((s, i) => {
      const live = s.status === 'live';
      const session = s.session ?? (s.assetClass === 'equity' ? 'unknown' : 'regular');
      const tradable = live && s.tradable !== false && (s.assetClass !== 'equity' || session === 'regular');
      const derivedScore = Math.max(0, s.liquidityScore - s.spreadBps * 6 + Math.abs(s.changePct) * 10);
      return {
        id: `research-${s.symbol}-${i}`,
        symbol: s.symbol,
        strategy: s.symbol.endsWith('-USD') ? 'Crypto Tape Scan' : 'Equity Momentum Scan',
        score: round(derivedScore, 1),
        expectedEdgeBps: round(Math.max(0, s.liquidityScore / 8 - s.spreadBps), 1),
        catalyst: `${s.status} data, ${s.changePct.toFixed(2)}% move, ${s.spreadBps.toFixed(2)} bps spread.`,
        aiVerdict: tradable ? 'Live data, eligible for paper monitoring.' : 'Blocked by quality/session rules.',
        riskStatus: (tradable && s.spreadBps <= 5 && s.liquidityScore >= 85 ? 'approved' : live ? 'review' : 'blocked') as ResearchCandidate['riskStatus'],
        broker: s.symbol.endsWith('-USD') ? 'coinbase-live' as const : 'alpaca-paper' as const
      };
    });
}

function researchPriority(snapshot: MarketSnapshot): number {
  return (snapshot.liquidityScore ?? 0) * 0.4
    + Math.abs(snapshot.changePct ?? 0) * 0.3
    + Math.min((snapshot.volume ?? 0) / 1_000_000, 10) * 0.3;
}

export function mapBrokerStatus(status: string): BrokerAccountSnapshot['status'] {
  if (status === 'healthy' || status === 'connected' || status === 'ok') return 'connected';
  if (status === 'degraded' || status === 'partial') return 'degraded';
  return 'disconnected';
}

export function sumCoinbaseCash(account: Record<string, unknown>): number {
  const accounts = normalizeArray(account.accounts);
  return round(accounts.reduce<number>((sum, item) => {
    const record = asRecord(item);
    const currency = textField(record, ['currency']) ?? '';
    if (currency !== 'USD' && currency !== 'USDC') return sum;
    return sum + (numberField(record, ['available_balance.value', 'balance.amount']) ?? 0);
  }, 0), 2);
}

export function compactTerminalLines(lines: Array<string | null | undefined>): string[] {
  return lines.filter((l): l is string => typeof l === 'string' && l.trim().length > 0);
}
