/**
 * Walk-Forward Engine
 * Phase G4 — Walk-Forward Validation
 *
 * Orchestrates: fetch candles → partition → train → validate → persist best params.
 * Exports status for the API router.
 */
import { buildFoldWindows, WF_MAX_FOLDS } from '../../../../scripts/walk-forward-partitioner.js';
import { runTrainingFold, computeRegimeMetrics } from './walk-forward-trainer.js';
import { runValidationFold, summarizeValidation } from './walk-forward-validator.js';
import { loadBestParams, saveBestParams, appendFoldResult } from './walk-forward-store.js';
export { computeRegimeMetrics };
const BACKTEST_URL = process.env.BACKTEST_SERVICE_URL ?? 'http://localhost:4305';
const WF_SYMBOL = process.env.WF_SYMBOL ?? 'BTC-USD';
const REQUIRED_FOLDS_PASS = 4;
const PF_BEAT_RATIO = 1.15;
let wfStatus = {
    status: 'idle',
    startedAt: null,
    completedAt: null,
    foldsRun: 0,
    foldsTotal: 0,
    summary: null,
    bestParams: null,
    error: null
};
export function getWalkForwardStatus() {
    return { ...wfStatus, bestParams: loadBestParams() };
}
async function fetchCandles(symbol, startDate, endDate) {
    const url = `${BACKTEST_URL}/candles?symbol=${encodeURIComponent(symbol)}&startDate=${startDate}&endDate=${endDate}`;
    const response = await fetch(url);
    if (!response.ok)
        throw new Error(`Candle fetch failed: ${response.status}`);
    const data = await response.json();
    return data.candles ?? [];
}
export async function runWalkForwardCycle(challengerConfig, championPF = 1.0, startDate, endDate) {
    if (wfStatus.status === 'running') {
        return { ...wfStatus, error: 'Walk-forward already in progress' };
    }
    const end = endDate ?? new Date().toISOString().split('T')[0];
    const start = startDate ?? (() => {
        const d = new Date(end);
        d.setDate(d.getDate() - 90);
        return d.toISOString().split('T')[0];
    })();
    wfStatus = {
        status: 'running',
        startedAt: new Date().toISOString(),
        completedAt: null,
        foldsRun: 0,
        foldsTotal: WF_MAX_FOLDS,
        summary: null,
        bestParams: null,
        error: null
    };
    try {
        // ── Step 1: Fetch candles to determine data span ───────────────
        const candles = await fetchCandles(WF_SYMBOL, start, end);
        if (candles.length === 0) {
            wfStatus = { ...wfStatus, status: 'error', error: `No candle data for ${WF_SYMBOL} (${start} → ${end})` };
            return wfStatus;
        }
        // ── Step 2: Partition into expanding-window folds ─────────────
        const folds = buildFoldWindows(candles, WF_MAX_FOLDS);
        if (folds.length === 0) {
            wfStatus = { ...wfStatus, status: 'error', error: `Insufficient data for walk-forward: ${candles.length} candles` };
            return wfStatus;
        }
        wfStatus.foldsTotal = folds.length;
        const foldResults = [];
        // ── Step 3: Train + validate each fold ────────────────────────
        for (const fw of folds) {
            wfStatus.foldsRun++;
            let trainResult;
            try {
                trainResult = await runTrainingFold(challengerConfig, WF_SYMBOL, { fold: fw.foldIndex, trainStart: fw.trainStart, trainEnd: fw.trainEnd });
            }
            catch (err) {
                console.warn(`[walk-forward] train fold ${fw.foldIndex} failed, skipping:`, err);
                continue;
            }
            let valResult;
            try {
                valResult = await runValidationFold(challengerConfig, WF_SYMBOL, {
                    fold: fw.foldIndex,
                    trainStart: fw.trainStart,
                    trainEnd: fw.trainEnd,
                    valStart: fw.valStart,
                    valEnd: fw.valEnd,
                    purgeCutoff: fw.purgeCutoff
                });
            }
            catch (err) {
                console.warn(`[walk-forward] validate fold ${fw.foldIndex} failed, skipping:`, err);
                continue;
            }
            foldResults.push(valResult);
            appendFoldResult(valResult);
        }
        const summary = summarizeValidation(foldResults);
        wfStatus.summary = summary;
        // ── Step 4: Acceptance gate ───────────────────────────────────
        const beatsChampion = summary.avgProfitFactor >= championPF * PF_BEAT_RATIO;
        const passedEnough = summary.foldsPassed >= REQUIRED_FOLDS_PASS;
        if (beatsChampion && passedEnough) {
            const best = {
                agentConfig: challengerConfig,
                profitFactor: summary.avgProfitFactor,
                winRate: summary.avgWinRate,
                totalTrades: summary.totalTrades,
                savedAt: new Date().toISOString(),
                fold: foldResults.length
            };
            saveBestParams(best);
            wfStatus.bestParams = best;
            console.log(`[walk-forward] ACCEPTED — avgPF=${summary.avgProfitFactor.toFixed(3)}, passed=${summary.foldsPassed}/${summary.foldsTotal}`);
        }
        else {
            const reason = !beatsChampion
                ? `avgPF ${summary.avgProfitFactor.toFixed(3)} doesn't beat champion ${championPF.toFixed(3)} x ${PF_BEAT_RATIO}`
                : `only ${summary.foldsPassed} folds passed (need ${REQUIRED_FOLDS_PASS})`;
            wfStatus.error = reason;
            console.log(`[walk-forward] REJECTED — ${reason}`);
        }
        wfStatus = { ...wfStatus, status: 'complete', completedAt: new Date().toISOString() };
        return wfStatus;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        wfStatus = { ...wfStatus, status: 'error', error: message };
        return wfStatus;
    }
}
