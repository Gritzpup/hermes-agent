/**
 * API Route Helpers
 *
 * Shared utility functions used across API routes.
 * Extracted from index.ts to keep the main file under 1000 lines.
 */
import { normalizeBrokerConnectionStatus } from '../lib/utils-normalization.js';
// ─── Generic Utilities ───
export function round(value, decimals) {
    return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}
export function normalizeArray(value) {
    return Array.isArray(value) ? value : [];
}
export function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : {};
}
export function textField(source, paths) {
    const record = asRecord(source);
    for (const p of paths) {
        const val = deepGet(record, p);
        if (typeof val === 'string' && val.length > 0)
            return val;
    }
    return null;
}
export function numberField(source, paths) {
    const record = asRecord(source);
    for (const p of paths) {
        const val = deepGet(record, p);
        const num = typeof val === 'number' ? val : typeof val === 'string' ? Number(val) : NaN;
        if (Number.isFinite(num))
            return num;
    }
    return null;
}
function deepGet(source, pathName) {
    const parts = pathName.split('.');
    let current = source;
    for (const part of parts) {
        if (typeof current !== 'object' || current === null)
            return undefined;
        current = current[part];
    }
    return current;
}
export function peak(values) {
    return values.length > 0 ? Math.max(...values) : 0;
}
export function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
export function previewText(value, limit = 120) {
    if (!value)
        return '';
    return value.length <= limit ? value : value.slice(0, limit) + '…';
}
// ─── Dedup Helpers ───
export function dedupePositions(positions) {
    const seen = new Map();
    for (const p of positions) {
        const key = `${p.broker}:${p.symbol}`;
        if (!seen.has(key) || (p.quantity > (seen.get(key)?.quantity ?? 0))) {
            seen.set(key, p);
        }
    }
    return Array.from(seen.values());
}
export function dedupeReports(reports) {
    const seen = new Set();
    return reports.filter((r) => { const k = r.id; if (seen.has(k))
        return false; seen.add(k); return true; });
}
export function dedupeJournal(entries) {
    const seen = new Set();
    return entries.filter((e) => { const k = e.id; if (seen.has(k))
        return false; seen.add(k); return true; });
}
export function dedupeMarketSnapshots(snapshots) {
    const seen = new Map();
    for (const s of snapshots) {
        seen.set(s.symbol, s);
    }
    return Array.from(seen.values());
}
// ─── Service Health ───
export async function pingService(name, portNumber, baseUrl) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3_000);
        const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
        clearTimeout(timeout);
        if (response.ok) {
            const data = await response.json();
            return {
                name,
                port: portNumber,
                status: 'healthy',
                message: typeof data.status === 'string' ? data.status : 'ok'
            };
        }
        return { name, port: portNumber, status: 'degraded', message: `HTTP ${response.status}` };
    }
    catch {
        return { name, port: portNumber, status: 'critical', message: 'unreachable' };
    }
}
export async function fetchJson(baseUrl, pathname, timeoutMs = 5_000) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(`${baseUrl}${pathname}`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok)
            return null;
        return await response.json();
    }
    catch {
        return null;
    }
}
export async function fetchArrayJson(baseUrl, pathname) {
    const result = await fetchJson(baseUrl, pathname);
    return Array.isArray(result) ? result : [];
}
// ─── Research ───
export function buildResearchCandidates(snapshots) {
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
            riskStatus: (tradable && s.spreadBps <= 5 && s.liquidityScore >= 85 ? 'approved' : live ? 'review' : 'blocked'),
            broker: s.symbol.endsWith('-USD') ? 'coinbase-live' : 'alpaca-paper'
        };
    });
}
function researchPriority(snapshot) {
    return (snapshot.liquidityScore ?? 0) * 0.4
        + Math.abs(snapshot.changePct ?? 0) * 0.3
        + Math.min((snapshot.volume ?? 0) / 1_000_000, 10) * 0.3;
}
export function mapBrokerStatus(status) {
    return normalizeBrokerConnectionStatus(status);
}
export function sumCoinbaseCash(account) {
    const accounts = normalizeArray(account.accounts);
    return round(accounts.reduce((sum, item) => {
        const record = asRecord(item);
        const currency = textField(record, ['currency']) ?? '';
        if (currency !== 'USD' && currency !== 'USDC')
            return sum;
        return sum + (numberField(record, ['available_balance.value', 'balance.amount']) ?? 0);
    }, 0), 2);
}
export function compactTerminalLines(lines) {
    return lines.filter((l) => typeof l === 'string' && l.trim().length > 0);
}
