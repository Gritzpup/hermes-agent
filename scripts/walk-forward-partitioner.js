/**
 * Walk-Forward Partitioner
 *
 * Phase G4 — Walk-Forward Validation
 *
 * Implements the purged expanding-window walk-forward pattern:
 * - Expanding train window [0, T], validation window [T, T + ΔT]
 * - ΔT = 2 weeks of trading (≈ 2,000–3,000 trades per fold)
 * - Run 4–5 folds per challenger before acceptance
 * - Purge: drop trades in the last PURGE_BUFFER_MS of each training window whose
 *   exit overlaps the next validation window (prevents information leakage)
 *
 * This module is pure and stateless — all I/O (fetching candles, running backtests)
 * is delegated to the caller so this can be used from both CLI scripts and the API.
 */
// ── Constants ─────────────────────────────────────────────────────────────────
/**
 * Validation window duration: 2 weeks in milliseconds.
 * ΔT = 2 weeks ≈ 2,000–3,000 trades per fold (for BTC-USD 1-min candles).
 */
export const WF_VALIDATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Minimum train window: 4 weeks.
 * Required to ensure enough history for the backtest engine to generate signals.
 */
export const WF_MIN_TRAIN_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;
/**
 * Purge buffer: last 60 minutes of each training window.
 * Trades whose exit timestamp falls into the next validation window are dropped
 * to prevent information leakage from overlapping holds.
 */
export const WF_PURGE_BUFFER_MS = 60 * 60 * 1000;
/**
 * Minimum number of folds to run. Folds are skipped if insufficient data remains.
 */
export const WF_MIN_FOLDS = 4;
/**
 * Maximum number of folds to run (expanding window caps naturally).
 */
export const WF_MAX_FOLDS = 5;
// ── Core partitioner: build fold windows ──────────────────────────────────────
/**
 * Given a full candle series, build the expanding-window fold partitions.
 *
 * Algorithm:
 * 1. Scan the data to find T_max (last timestamp with enough trailing candles for val).
 * 2. Starting from the earliest point that supports train + val + purge, work backwards
 *    to fit as many folds as possible (up to WF_MAX_FOLDS).
 * 3. Each fold: train = [fold_base, fold_base + train_window], val = [train_end, train_end + ΔT]
 *
 * @param candles     Sorted candle array (ascending by timestamp)
 * @param numFolds    Number of folds to attempt (default WF_MAX_FOLDS)
 * @returns Array of fold window descriptors (most recent fold first)
 */
export function buildFoldWindows(candles, numFolds = WF_MAX_FOLDS) {
    if (candles.length === 0)
        return [];
    const firstTs = new Date(candles[0].timestamp).getTime();
    const lastTs = new Date(candles[candles.length - 1].timestamp).getTime();
    // Total available window
    const totalSpan = lastTs - firstTs;
    // Minimum required: train_min + purge + val + enough data for val to have ~100 candles
    const minRequired = WF_MIN_TRAIN_WINDOW_MS + WF_PURGE_BUFFER_MS + WF_VALIDATION_WINDOW_MS;
    if (totalSpan < minRequired) {
        console.warn(`[wf-partitioner] Insufficient data: ${(totalSpan / 86400000).toFixed(1)}d < ${(minRequired / 86400000).toFixed(1)}d required`);
        return [];
    }
    // How many folds can we fit?
    // Expanding window: each fold's train window starts at the same point but grows.
    // For simplicity, we anchor each fold's train-end at a different point and run val forward.
    // The most recent fold's val window ends at the data's end.
    const foldWindows = [];
    // Work backwards from the most recent fold
    // Fold 0 (most recent): train expands from firstTs to some point; val = [train_end, train_end + ΔT]
    // To maximise fold count, we use fixed train start (firstTs) and slide trainEnd backward.
    // Actually, for expanding window, trainStart stays fixed at firstTs and trainEnd grows.
    // But for walk-forward with limited history, it's more practical to have trainStart also grow.
    // Standard approach: train = [firstTs + i*step, firstTs + i*step + min_train], val = [train_end, train_end + ΔT]
    // where i increments to create overlapping expanding windows.
    //
    // Simpler approach used here:
    // - Each fold i: trainStart = firstTs, trainEnd = lastTs - (numFolds - 1 - i) * valWindow
    //   This means the most recent fold has the largest train window.
    // - valStart = trainEnd, valEnd = valStart + valWindow
    //
    // Better approach (truer expanding window):
    // - Fold 0: train = [T0, T0 + min_train], val = [T0 + min_train, T0 + min_train + ΔT]
    // - Fold 1: train = [T0, T0 + min_train + step], val = [T0 + min_train + step, ...]
    // - Fold N: train = [T0, T0 + min_train + N*step], val = [trainEnd, trainEnd + ΔT]
    //
    // We use step = ΔT (no overlap between val windows) for clarity.
    // Folds are built from earliest to most recent.
    const step = WF_VALIDATION_WINDOW_MS;
    const trainWindowFixed = WF_MIN_TRAIN_WINDOW_MS;
    for (let i = 0; i < numFolds; i++) {
        // The i-th fold (from earliest): trainEnd grows by i * step
        const offsetMs = i * step;
        const trainEnd = firstTs + trainWindowFixed + offsetMs;
        // Val window immediately follows train
        const valStart = trainEnd;
        const valEnd = valStart + WF_VALIDATION_WINDOW_MS;
        // Purge cutoff: trainEnd - purge buffer
        const purgeCutoff = new Date(trainEnd - WF_PURGE_BUFFER_MS).toISOString();
        // Skip if valEnd exceeds data end
        if (valEnd > lastTs + 60000)
            break;
        foldWindows.push({
            foldIndex: i,
            trainStart: new Date(firstTs).toISOString(),
            trainEnd: new Date(trainEnd).toISOString(),
            valStart: new Date(valStart).toISOString(),
            valEnd: new Date(valEnd).toISOString(),
            purgeCutoff,
        });
    }
    // Reverse so most recent fold is first
    return foldWindows.reverse();
}
// ── Purge logic ───────────────────────────────────────────────────────────────
/**
 * Apply purge buffer to a set of fills.
 *
 * The purge buffer is the last WF_PURGE_BUFFER_MS of the training window.
 * Any fill whose exit timestamp falls AFTER purgeCutoff is removed because
 * its holding period could overlap with the validation window.
 *
 * @param fills       All fills from the training window
 * @param purgeCutoff ISO timestamp: drop fills with timestamp >= purgeCutoff
 * @returns Purge result with removed counts
 */
export function applyPurge(fills, purgeCutoff) {
    const cutoffMs = new Date(purgeCutoff).getTime();
    const totalCount = fills.length;
    const purgedFills = fills.filter((f) => {
        const ts = new Date(f.timestamp).getTime();
        // Drop fills at or after the purge cutoff (they could overlap with val window)
        return ts < cutoffMs;
    });
    const purgedCount = totalCount - purgedFills.length;
    return { purgedFills, purgedCount, totalCount };
}
/**
 * Extract fills from a backtest result that fall within a time window.
 */
export function extractFillsInWindow(fills, windowStart, windowEnd) {
    const startMs = new Date(windowStart).getTime();
    const endMs = new Date(windowEnd).getTime();
    return fills.filter((f) => {
        const ts = new Date(f.timestamp).getTime();
        return ts >= startMs && ts <= endMs;
    });
}
// ── Backtest result helpers ───────────────────────────────────────────────────
/**
 * Compute expectancy from a list of fills.
 * Expectancy = sum(pnl) / (count * startingEquity)  [in R units, R = 1]
 */
export function computeExpectancy(fills, startingEquity = 100_000) {
    if (fills.length === 0 || startingEquity === 0)
        return 0;
    const totalPnl = fills.reduce((sum, f) => sum + f.pnl, 0);
    return totalPnl / startingEquity;
}
/**
 * Compute win rate from fills (excluding scratches where pnl ≈ 0).
 */
export function computeWinRate(fills) {
    const closed = fills.filter((f) => Math.abs(f.pnl) > 0.001);
    if (closed.length === 0)
        return 0;
    const wins = closed.filter((f) => f.pnl > 0).length;
    return (wins / closed.length) * 100;
}
/**
 * Compute profit factor from fills.
 */
export function computeProfitFactor(fills) {
    const grossWins = fills.filter((f) => f.pnl > 0).reduce((s, f) => s + f.pnl, 0);
    const grossLosses = Math.abs(fills.filter((f) => f.pnl < 0).reduce((s, f) => s + f.pnl, 0));
    if (grossLosses === 0)
        return grossWins > 0 ? 9.99 : 0;
    return Number((grossWins / grossLosses).toFixed(3));
}
// ── Config hash for caching ───────────────────────────────────────────────────
/**
 * Stable hash of a backtest config for cache-key generation.
 */
export function hashConfig(config) {
    const fields = [
        config.style,
        config.targetBps,
        config.stopBps,
        config.maxHoldTicks,
        config.cooldownTicks,
        config.sizeFraction,
        config.spreadLimitBps,
        config.entryThresholdMultiplier ?? 1,
        config.exitThresholdMultiplier ?? 1,
    ];
    const str = fields.join('|');
    // Simple djb2 hash
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
}
/**
 * Classify a candle window into a market regime.
 *
 * Uses rolling volatility and trend-strength heuristics (replay-safe):
 * - panic: high spread (>6 bps) OR extreme move (>2.5%)
 * - trend: sustained directional move (>1.1%)
 * - compression: tight range, low volatility
 * - chop: moderate move + moderate volatility (normal conditions)
 * - unknown: insufficient data
 *
 * @param candles  Sorted candle array for the window
 * @returns RegimeLabel
 */
export function classifyRegime(candles) {
    if (candles.length < 20)
        return 'unknown';
    const prices = candles.map((c) => c.close);
    const lastPrice = prices[prices.length - 1];
    const firstPrice = prices[0];
    // Total return over window
    const totalReturn = Math.abs((lastPrice - firstPrice) / firstPrice) * 100;
    // Average spread proxy: high-low range
    let totalRange = 0;
    for (const c of candles) {
        totalRange += (c.high - c.low) / c.close;
    }
    const avgRange = (totalRange / candles.length) * 100;
    // Average daily range ≈ 20 candles per day at 1-min
    const avgDailyRange = avgRange * Math.sqrt(Math.min(20, candles.length));
    if (avgDailyRange >= 6 || totalReturn >= 2.5)
        return 'panic';
    if (totalReturn >= 1.1)
        return 'trend';
    if (avgDailyRange <= 1.2 && totalReturn <= 0.4)
        return 'compression';
    return 'chop';
}
