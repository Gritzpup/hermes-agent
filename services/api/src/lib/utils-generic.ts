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

export function deepGet(source: Record<string, unknown>, pathName: string): unknown {
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

export function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

export function peak(values: number[]): number {
  return values.reduce((max, value) => Math.max(max, value), values[0] ?? 1);
}
