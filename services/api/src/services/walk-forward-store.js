/**
 * Walk-Forward Store
 * Phase G4 — Walk-Forward Validation
 *
 * Persists best challenger parameters to disk between runs.
 * Uses the Hermes .runtime directory for storage.
 */
import fs from 'node:fs';
import path from 'node:path';
const WF_RUNTIME_DIR = '/mnt/Storage/github/hermes-trading-firm/services/api/.runtime/walk-forward';
const BEST_PARAMS_FILE = path.join(WF_RUNTIME_DIR, 'best-params.json');
const FOLD_RESULTS_FILE = path.join(WF_RUNTIME_DIR, 'fold-results.json');
function ensureDir() {
    if (!fs.existsSync(WF_RUNTIME_DIR)) {
        fs.mkdirSync(WF_RUNTIME_DIR, { recursive: true });
    }
}
export function loadBestParams() {
    try {
        ensureDir();
        if (!fs.existsSync(BEST_PARAMS_FILE))
            return null;
        const raw = fs.readFileSync(BEST_PARAMS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.profitFactor !== 'number')
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
export function saveBestParams(params) {
    ensureDir();
    fs.writeFileSync(BEST_PARAMS_FILE, JSON.stringify(params, null, 2));
}
export function loadFoldResults() {
    try {
        ensureDir();
        if (!fs.existsSync(FOLD_RESULTS_FILE))
            return [];
        const raw = fs.readFileSync(FOLD_RESULTS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed;
    }
    catch {
        return [];
    }
}
export function appendFoldResult(result) {
    const existing = loadFoldResults();
    // Replace if fold already exists, otherwise append
    const idx = existing.findIndex(r => r.fold === result.fold);
    if (idx >= 0) {
        existing[idx] = result;
    }
    else {
        existing.push(result);
    }
    ensureDir();
    fs.writeFileSync(FOLD_RESULTS_FILE, JSON.stringify(existing, null, 2));
}
export function clearWalkForwardState() {
    try {
        if (fs.existsSync(BEST_PARAMS_FILE))
            fs.unlinkSync(BEST_PARAMS_FILE);
        if (fs.existsSync(FOLD_RESULTS_FILE))
            fs.unlinkSync(FOLD_RESULTS_FILE);
    }
    catch {
        // Ignore errors during clear
    }
}
