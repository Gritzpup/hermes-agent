import fs from 'node:fs';
export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
export function average(values) {
    if (values.length === 0)
        return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
export function pickLast(values, length) {
    return values.slice(Math.max(values.length - length, 0));
}
export function formatAgo(minutesAgo) {
    return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}
export function round(value, decimals) {
    return Number(value.toFixed(decimals));
}
export function nudge(current, baseline, step) {
    if (Math.abs(current - baseline) <= step) {
        return baseline;
    }
    return current > baseline
        ? round(current - step, 4)
        : round(current + step, 4);
}
export function readJsonLines(filePath) {
    if (!fs.existsSync(filePath)) {
        return [];
    }
    try {
        return fs
            .readFileSync(filePath, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line));
    }
    catch (error) {
        console.error('[paper-engine] failed to read ledger file', filePath, error);
        return [];
    }
}
export function numberField(record, keys) {
    if (!record || typeof record !== 'object') {
        return null;
    }
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === 'string') {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
    }
    return null;
}
export function asRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return value;
}
export function normalizeArray(value) {
    return Array.isArray(value) ? value : [];
}
export function textField(record, keys) {
    const object = asRecord(record);
    for (const key of keys) {
        const value = object[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }
    return null;
}
export function dedupeById(entries) {
    const byId = new Map();
    for (const entry of entries) {
        byId.set(entry.id, entry);
    }
    return Array.from(byId.values()).sort((left, right) => {
        const leftTime = 'exitAt' in left && typeof left.exitAt === 'string' ? Date.parse(left.exitAt) : 0;
        const rightTime = 'exitAt' in right && typeof right.exitAt === 'string' ? Date.parse(right.exitAt) : 0;
        return rightTime - leftTime;
    });
}
