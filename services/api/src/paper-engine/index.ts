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

// Risk guards
export { SymbolGuardManager } from './risk-guards.js';

// Direction resolution
export { resolveDirection, type DirectionContext } from './direction.js';

// Exit logic
export {
  computeDynamicStop,
  computeDynamicTarget,
  getTrailingStopParams,
  getCatastrophicStopPct,
  entryNote,
  estimatedBrokerRoundTripCostBps
} from './exit-logic.js';

// Helpers
export {
  getSessionBucket,
  getVolatilityBucket,
  getSymbolCluster,
  getClusterLimitPct,
  percentile,
  formatBrokerLabel,
  summarizePerformance,
  pushPoint
} from './helpers.js';
