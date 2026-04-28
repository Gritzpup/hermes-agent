// coo-gates: singleton in-memory state tracking COO-issued strategy pauses/amplifications.
// Mutated by POST /api/coo/{pause,amplify}-strategy handlers. Read by grid-engine /
// maker-engine before opening new positions. Seeded from coo-directives.jsonl at startup.

import fs from 'node:fs';
import path from 'node:path';

const RUNTIME_DIR = '/mnt/Storage/github/hermes-trading-firm/services/api/.runtime';
const GATES_FILE = path.join(RUNTIME_DIR, 'coo-gates.json');

const pausedStrategies = new Set<string>();
const amplifiedStrategies = new Map<string, number>();
const pendingForceCloseSymbols = new Set<string>();
const maxPositionsCaps = new Map<string, number>();

// ── Persistence ───────────────────────────────────────────────────────────────
function saveGates(): void {
  try {
    if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(GATES_FILE, JSON.stringify({
      paused: Array.from(pausedStrategies),
      amplified: Array.from(amplifiedStrategies.entries()),
      pendingForceClose: Array.from(pendingForceCloseSymbols),
      maxPositions: Array.from(maxPositionsCaps.entries()),
    }, null, 2));
  } catch {}
}

function loadGates(): void {
  try {
    if (!fs.existsSync(GATES_FILE)) return;
    const data = JSON.parse(fs.readFileSync(GATES_FILE, 'utf8'));
    data.paused?.forEach((id: string) => pausedStrategies.add(id));
    data.amplified?.forEach(([id, factor]: [string, number]) => amplifiedStrategies.set(id, factor));
    data.pendingForceClose?.forEach((s: string) => pendingForceCloseSymbols.add(s));
    data.maxPositions?.forEach(([k, v]: [string, number]) => maxPositionsCaps.set(k, v));
  } catch {}
}

loadGates();

export function pauseStrategy(id: string): void {
  if (!id) return;
  pausedStrategies.add(id);
  amplifiedStrategies.delete(id);
  saveGates();
}

export function amplifyStrategy(id: string, factor: number = 1.25): void {
  if (!id) return;
  amplifiedStrategies.set(id, factor);
  pausedStrategies.delete(id);
  saveGates();
}

export function resumeStrategy(id: string): void {
  pausedStrategies.delete(id);
  amplifiedStrategies.delete(id);
  saveGates();
}

export function isStrategyPaused(id: string): boolean {
  return pausedStrategies.has(id);
}

export function getAmplification(id: string): number {
  return amplifiedStrategies.get(id) ?? 1.0;
}

export function listGates(): {
  paused: string[];
  amplified: Array<{ id: string; factor: number }>;
  pendingForceClose: string[];
  maxPositions: Array<{ key: string; max: number }>;
} {
  return {
    paused: Array.from(pausedStrategies),
    amplified: Array.from(amplifiedStrategies.entries()).map(([id, factor]) => ({ id, factor })),
    pendingForceClose: Array.from(pendingForceCloseSymbols),
    maxPositions: Array.from(maxPositionsCaps.entries()).map(([key, max]) => ({ key, max })),
  };
}

// One-shot flag: engines call consumeForceCloseSymbol(symbol) during their tick and
// immediately clear it so the flatten happens exactly once.
export function requestForceCloseSymbol(symbol: string): void {
  if (symbol) { pendingForceCloseSymbols.add(symbol); saveGates(); }
}

export function consumeForceCloseSymbol(symbol: string): boolean {
  if (pendingForceCloseSymbols.has(symbol)) {
    pendingForceCloseSymbols.delete(symbol);
    saveGates();
    return true;
  }
  return false;
}

export function setMaxPositions(scope: 'firm' | 'strategy', strategy: string | null, max: number): void {
  const key = scope === 'firm' ? 'firm' : `strategy:${strategy ?? ''}`;
  maxPositionsCaps.set(key, Math.max(0, Math.floor(max)));
  saveGates();
}

export function getMaxPositions(scope: 'firm' | 'strategy', strategy?: string): number {
  const key = scope === 'firm' ? 'firm' : `strategy:${strategy ?? ''}`;
  return maxPositionsCaps.get(key) ?? Infinity;
}

// Operator escape hatches: clear stale/test gate state without restarting the api.
export function clearPendingForceClose(symbol?: string): number {
  if (symbol) {
    return pendingForceCloseSymbols.delete(symbol) ? 1 : 0;
  }
  const n = pendingForceCloseSymbols.size;
  pendingForceCloseSymbols.clear();
  return n;
}

export function clearMaxPositions(scope?: 'firm' | 'strategy', strategy?: string): number {
  if (!scope) {
    const n = maxPositionsCaps.size;
    maxPositionsCaps.clear();
    return n;
  }
  const key = scope === 'firm' ? 'firm' : `strategy:${strategy ?? ''}`;
  return maxPositionsCaps.delete(key) ? 1 : 0;
}

// Seed from persisted directives so pause state survives api restart.
export function seedFromDirectivesFile(directivesPath: string): void {
  try {
    if (!fs.existsSync(directivesPath)) return;
    const lines = fs.readFileSync(directivesPath, 'utf8').split('\n').filter(Boolean);
    // Process chronologically so later events override earlier ones.
    for (const line of lines) {
      try {
        const d = JSON.parse(line) as { type?: string; strategy?: string; factor?: number };
        if (d.type === 'coo-pause-strategy' && typeof d.strategy === 'string') {
          pauseStrategy(d.strategy);
        } else if (d.type === 'coo-amplify-strategy' && typeof d.strategy === 'string') {
          amplifyStrategy(d.strategy, typeof d.factor === 'number' ? d.factor : 1.25);
        } else if (d.type === 'coo-set-max-positions') {
          const dd = d as { scope?: 'firm' | 'strategy'; strategy?: string | null; max?: number };
          if ((dd.scope === 'firm' || dd.scope === 'strategy') && typeof dd.max === 'number') {
            setMaxPositions(dd.scope, dd.strategy ?? null, dd.max);
          }
        }
        // Note: force-close is one-shot and deliberately not replayed from disk —
        // replaying an old "flatten XRP" directive on api restart would be dangerous.
      } catch { /* skip malformed line */ }
    }
  } catch { /* file read failed — start empty */ }
}

// Convenience: default path for the firm's coo-directives file.
export const DEFAULT_DIRECTIVES_PATH = path.resolve(
  '/mnt/Storage/github/hermes-trading-firm/services/api/.runtime/paper-ledger/coo-directives.jsonl'
);
