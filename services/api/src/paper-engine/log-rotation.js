import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
const ROTATE_FILES = [
    'journal.jsonl',
    'events.jsonl',
    'fills.jsonl',
    'ai-council-traces.jsonl',
    'lane-learning-log.jsonl',
    'triple-barrier.jsonl',
    'learning-log.jsonl',
    'strategy-director-log.jsonl'
];
const ROTATE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const RETAIN_DAYS = 30;
export function rotateLogs(runtimeDir) {
    const rotated = [];
    const purged = [];
    for (const name of ROTATE_FILES) {
        const file = path.join(runtimeDir, name);
        if (!fs.existsSync(file))
            continue;
        const stat = fs.statSync(file);
        if (stat.size < ROTATE_SIZE_BYTES)
            continue;
        const ts = new Date().toISOString().slice(0, 10);
        const rotatedPath = `${file}.${ts}.gz`;
        try {
            const raw = fs.readFileSync(file);
            const gz = zlib.gzipSync(raw);
            fs.writeFileSync(rotatedPath, gz);
            fs.truncateSync(file, 0);
            rotated.push(rotatedPath);
        }
        catch (err) {
            console.error(`[log-rotation] failed to rotate ${name}`, err);
        }
    }
    // Purge > RETAIN_DAYS
    const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
    try {
        for (const f of fs.readdirSync(runtimeDir)) {
            if (!f.endsWith('.gz'))
                continue;
            const stat = fs.statSync(path.join(runtimeDir, f));
            if (stat.mtimeMs < cutoff) {
                fs.unlinkSync(path.join(runtimeDir, f));
                purged.push(f);
            }
        }
    }
    catch (err) {
        console.error('[log-rotation] purge scan failed', err);
    }
    return { rotated, purged };
}
