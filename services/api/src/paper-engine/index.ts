/**
 * Paper Engine Module Index
 *
 * Re-exports all types, functions, and utilities from the paper-engine modules.
 * Import from here instead of reaching into individual module files.
 */

// Types & constants
export * from './types.js';

// Pure functions — position sizing
export {
  computeHalfKelly,
  countConsecutiveLosses,
  relativeMove,
  computeAdaptiveCooldown,
  computeFngSizeMultiplier,
  computeStreakMultiplier
} from './sizing.js';

// Pure functions — entry scoring
export {
  computeEntryScore,
  getFeeRate,
  roundTripFeeBps
} from './scoring.js';

// Ledger I/O
export {
  enqueueWrite,
  appendLedger,
  rewriteLedger,
  maybeRotateLog,
  rotateAllLogs,
  dedupeById
} from './ledger.js';
