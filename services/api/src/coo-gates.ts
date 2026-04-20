// coo-gates: singleton in-memory state tracking COO-issued strategy pauses/amplifications.
// Mutated by POST /api/coo/{pause,amplify}-strategy handlers. Read by grid-engine /
// maker-engine before opening new positions. Seeded from coo-directives.jsonl at startup.

import fs from 'node:fs';
import path from 'node:path';

const pausedStrategies = new Set<string>();
const amplifiedStrategies = new Map<string, number>();

export function pauseStrategy(id: string): void {
  if (!id) return;
  pausedStrategies.add(id);
  amplifiedStrategies.delete(id);
}

export function amplifyStrategy(id: string, factor: number = 1.25): void {
  if (!id) return;
  amplifiedStrategies.set(id, factor);
  pausedStrategies.delete(id);
}

export function resumeStrategy(id: string): void {
  pausedStrategies.delete(id);
  amplifiedStrategies.delete(id);
}

export function isStrategyPaused(id: string): boolean {
  return pausedStrategies.has(id);
}

export function getAmplification(id: string): number {
  return amplifiedStrategies.get(id) ?? 1.0;
}

export function listGates(): { paused: string[]; amplified: Array<{ id: string; factor: number }> } {
  return {
    paused: Array.from(pausedStrategies),
    amplified: Array.from(amplifiedStrategies.entries()).map(([id, factor]) => ({ id, factor })),
  };
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
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* file read failed — start empty */ }
}

// Convenience: default path for the firm's coo-directives file.
export const DEFAULT_DIRECTIVES_PATH = path.resolve(
  '/mnt/Storage/github/hermes-trading-firm/services/api/.runtime/paper-ledger/coo-directives.jsonl'
);
