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

// Atomic paired writes (journal + events sync)
export {
  enqueueAppend,
  enqueueAppendPaired,
  flushWriteQueue,
  replayOrphanedPairs
} from './write-queue.js';

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

// Broker seeding
export { seedFromBrokerHistory } from './broker-seeding.js';

// Entry filters
export {
  isTimeBlocked,
  isVwapBlocked,
  isRsi2Blocked,
  isRsi14Blocked,
  isFallingKnifeBlocked
} from './entry-filters.js';

// Engine context interface
export type { EngineReadContext } from './engine-context.js';

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

// Engine views (extracted read-only methods)
export {
  getExecutionQualityByBroker,
  buildMarketTape,
  analyzeSignals,
  getDataSources,
  toLiveReadiness,
  toAgentSnapshot
} from './engine-views.js';
export { formatBrokerLabel as formatBrokerLabelView } from './engine-views.js';
