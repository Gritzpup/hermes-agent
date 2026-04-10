import fs from 'node:fs';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function pickLast(values: number[], length: number): number[] {
  return values.slice(Math.max(values.length - length, 0));
}

export function formatAgo(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

export function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

export function nudge(current: number, baseline: number, step: number): number {
  if (Math.abs(current - baseline) <= step) {
    return baseline;
  }

  return current > baseline
    ? round(current - step, 4)
    : round(current + step, 4);
}

export function readJsonLines<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    console.error('[paper-engine] failed to read ledger file', filePath, error);
    return [];
  }
}

export function numberField(record: unknown, keys: string[]): number | null {
  if (!record || typeof record !== 'object') {
    return null;
  }

  for (const key of keys) {
    const value = (record as Record<string, unknown>)[key];
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

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

export function normalizeArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function textField(record: unknown, keys: string[]): string | null {
  const object = asRecord(record);

  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}
