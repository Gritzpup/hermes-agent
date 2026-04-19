/**
 * Strategy Lane Management
 *
 * Handles sidecar lane controls (pairs, grid, maker) and strategy journal recording.
 * Receives engine dependencies via constructor injection.
 */
import fs from 'node:fs';
import { QUARANTINED_EXIT_REASONS } from '@hermes/contracts';
import { round } from './helpers.js';
// Phase H2: Filter quarantined entries for analytics to avoid KPI pollution.
export function readSharedJournalEntries(journalPath) {
    try {
        if (!fs.existsSync(journalPath))
            return [];
        return fs.readFileSync(journalPath, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line))
            .filter((entry) => !entry.exitReason || !QUARANTINED_EXIT_REASONS.has(entry.exitReason));
    }
    catch {
        return [];
    }
}
export function classifyMarketRegime(symbols, snapshots) {
    const relevant = snapshots.filter((s) => symbols.includes(s.symbol));
    if (relevant.length === 0)
        return 'unknown';
    const avgSpread = relevant.reduce((sum, s) => sum + (s.spreadBps ?? 0), 0) / relevant.length;
    const avgMove = relevant.reduce((sum, s) => sum + Math.abs(s.changePct ?? 0), 0) / relevant.length;
    if (avgSpread >= 6 || avgMove >= 2.5)
        return 'panic';
    if (avgMove >= 1.1)
        return 'trend';
    if (avgSpread <= 1.2 && avgMove <= 0.4)
        return 'compression';
    return 'chop';
}
export function appendStrategyJournal(journalPath, entry) {
    try {
        fs.mkdirSync(fs.realpathSync(journalPath + '/..'), { recursive: true });
    }
    catch { /* dir exists */ }
    try {
        fs.appendFileSync(journalPath, `${JSON.stringify(entry)}\n`, 'utf8');
    }
    catch (error) {
        console.error('[strategy-lanes] journal append failed', error);
    }
}
export function appendStrategyEvent(eventLogPath, type, payload) {
    try {
        fs.appendFileSync(eventLogPath, `${JSON.stringify({ timestamp: new Date().toISOString(), type, ...payload })}\n`, 'utf8');
    }
    catch (error) {
        console.error('[strategy-lanes] event append failed', error);
    }
}
const lastEmittedState = new Map();
export function emitStrategyStateIfChanged(strategyId, payload, signalBus) {
    const hash = JSON.stringify(payload);
    if (lastEmittedState.get(strategyId) === hash)
        return;
    lastEmittedState.set(strategyId, hash);
    try {
        signalBus.emit({ type: 'strategy-state', symbol: strategyId, ...payload, timestamp: new Date().toISOString() });
    }
    catch { /* non-critical */ }
}
