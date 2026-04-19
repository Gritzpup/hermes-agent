/**
 * Write Queue — offload synchronous journal/fill/event appends from the hot path.
 *
 * Trades are enqueued as single-line JSON and flushed in batches of up to 64
 * entries per tick.  Multiple paths are coalesced so a single appendFile call
 * writes all pending lines for one file.  The queue drains itself recursively
 * until empty, then waits for new work.
 *
 * On shutdown call flushWriteQueue() to drain all pending writes before exit.
 *
 * PAIRED WRITES (enqueueAppendPaired):
 * Journal + events must stay in sync.  Paired tasks share a pairId and are
 * written atomically — if one file throws, the other is rolled back and the
 * missing half is retried on the next flush.  On crash, pending pairs are
 * persisted to a recovery file and replayed on startup.
 */
import fs from 'node:fs';
import path from 'node:path';
const queue = [];
let flushing = false;
// Track pairs that completed successfully this session — used for orphan detection
const completedPairs = new Set();
// Pairs that were partially written (one file succeeded, other failed)
// Format: Map<pairId, { pathA, lineA, pathB, lineB }>
const pendingPairs = new Map();
// Recovery file path — persists pending pairs across crashes
const RECOVERY_FILE = '.write-queue-recovery.jsonl';
/** Persist pending pairs to recovery file for crash recovery. */
function persistRecoveryState() {
    try {
        if (pendingPairs.size === 0) {
            // No orphans — remove recovery file if it exists
            if (fs.existsSync(RECOVERY_FILE)) {
                fs.unlinkSync(RECOVERY_FILE);
            }
            return;
        }
        // Write each pending pair as a JSON line
        const lines = Array.from(pendingPairs.entries())
            .map(([pairId, pair]) => JSON.stringify({ pairId, ...pair }))
            .join('\n') + '\n';
        fs.writeFileSync(RECOVERY_FILE, lines, 'utf8');
    }
    catch (err) {
        console.error('[write-queue] Failed to persist recovery state', err);
    }
}
/**
 * Replay any orphaned pairs that were partially written before a crash.
 * Call on startup before processing new requests.
 */
export function replayOrphanedPairs() {
    if (!fs.existsSync(RECOVERY_FILE))
        return;
    try {
        const content = fs.readFileSync(RECOVERY_FILE, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines) {
            const record = JSON.parse(line);
            const { pairId, pathA, lineA, pathB, lineB } = record;
            console.warn(`[write-queue] Replaying orphaned pair ${pairId}: ${path.basename(pathA)}`);
            const journalExists = fs.existsSync(pathA);
            const eventExists = fs.existsSync(pathB);
            if (!journalExists) {
                console.error(`[write-queue] Journal missing, cannot recover pair ${pairId}`);
                continue;
            }
            // Check what already exists in each file
            const journalContent = fs.readFileSync(pathA, 'utf8');
            const journalLastLine = journalContent.split('\n').filter(Boolean).slice(-1)[0];
            const journalHasEntry = journalLastLine?.includes(lineA.replace('\n', ''));
            const eventHasEntry = eventExists && (() => {
                const eventContent = fs.readFileSync(pathB, 'utf8');
                const eventLastLine = eventContent.split('\n').filter(Boolean).slice(-1)[0];
                return eventLastLine?.includes(lineB.replace('\n', ''));
            })();
            // Both have entries - already completed, skip
            if (journalHasEntry && eventHasEntry) {
                console.log(`[write-queue] Pair ${pairId} already completed, skipping`);
                continue;
            }
            // Only journal has entry - replay just the event
            if (journalHasEntry && !eventHasEntry) {
                console.log(`[write-queue] Replaying missing event for pair ${pairId}`);
                enqueueAppend(pathB, lineB);
                continue;
            }
            // Neither has entry (shouldn't happen in normal crash, but handle it)
            if (!journalHasEntry && !eventHasEntry) {
                console.log(`[write-queue] Full replay needed for pair ${pairId}`);
                enqueueAppendPaired(pathA, lineA, pathB, lineB);
                continue;
            }
            // Only event has entry (inconsistent state - log warning and replay both)
            if (!journalHasEntry && eventHasEntry) {
                console.warn(`[write-queue] Inconsistent state: event exists but journal missing for pair ${pairId}, replaying both`);
                enqueueAppendPaired(pathA, lineA, pathB, lineB);
            }
        }
    }
    catch (err) {
        console.error('[write-queue] Failed to replay orphaned pairs', err);
    }
    // Clear recovery file after replay attempt
    try {
        if (fs.existsSync(RECOVERY_FILE)) {
            fs.unlinkSync(RECOVERY_FILE);
        }
    }
    catch { /* ignore */ }
}
/** Add a line to the write queue.  Truncating \\n is the caller's responsibility. */
export function enqueueAppend(path, line) {
    queue.push({ path, line: line.endsWith('\n') ? line : line + '\n' });
    if (!flushing)
        void flush();
}
/**
 * Enqueue two lines that must be written together (journal + events).
 * Uses pairId to group them; on flush failure, the incomplete pair is retried.
 */
export function enqueueAppendPaired(pathA, lineA, pathB, lineB) {
    const pairId = `p${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    queue.push({
        path: pathA,
        line: lineA.endsWith('\n') ? lineA : lineA + '\n',
        pairId
    });
    queue.push({
        path: pathB,
        line: lineB.endsWith('\n') ? lineB : lineB + '\n',
        pairId
    });
    if (!flushing)
        void flush();
}
async function flush() {
    flushing = true;
    try {
        while (queue.length > 0) {
            const batch = queue.splice(0, 64);
            // Group by pairId to identify paired writes
            const pairedTasks = new Map();
            const soloTasks = [];
            for (const t of batch) {
                if (t.pairId) {
                    const existing = pairedTasks.get(t.pairId) ?? [];
                    existing.push(t);
                    pairedTasks.set(t.pairId, existing);
                }
                else {
                    soloTasks.push(t);
                }
            }
            // Process paired writes atomically
            for (const [pairId, tasks] of pairedTasks) {
                if (tasks.length !== 2) {
                    console.error(`[write-queue] Malformed pair ${pairId}: ${tasks.length} tasks`);
                    continue;
                }
                const taskA = tasks[0];
                const taskB = tasks[1];
                // Store pending pair in case one write succeeds and other fails
                pendingPairs.set(pairId, {
                    pathA: taskA.path,
                    lineA: taskA.line,
                    pathB: taskB.path,
                    lineB: taskB.line
                });
                // Persist to recovery file immediately for crash safety
                persistRecoveryState();
                try {
                    // Write to both files in same tick
                    await fs.promises.appendFile(taskA.path, taskA.line, 'utf8');
                    await fs.promises.appendFile(taskB.path, taskB.line, 'utf8');
                    completedPairs.add(pairId);
                    pendingPairs.delete(pairId);
                    // Update recovery file to remove completed pair
                    persistRecoveryState();
                }
                catch (err) {
                    // One succeeded, one failed — leave in pendingPairs for retry
                    console.error(`[write-queue] Paired write ${pairId} partially failed`, err);
                    // Don't re-throw; let the orphaned entry be retried next flush
                }
            }
            // Process solo writes normally (coalesced by path)
            const byPath = new Map();
            for (const t of soloTasks) {
                byPath.set(t.path, (byPath.get(t.path) ?? '') + t.line);
            }
            for (const [filePath, block] of byPath.entries()) {
                try {
                    await fs.promises.appendFile(filePath, block, 'utf8');
                }
                catch (err) {
                    console.error(`[write-queue] append failed for ${filePath}`, err);
                }
            }
        }
    }
    catch (err) {
        console.error('[write-queue] flush failed', err);
    }
    finally {
        flushing = false;
        if (queue.length > 0)
            void flush();
    }
}
/** Block until the queue is completely drained.  Call on shutdown. */
export async function flushWriteQueue() {
    while (queue.length > 0 || flushing) {
        await new Promise((r) => setTimeout(r, 25));
    }
    // After draining, clear completedPairs so restart detection works
    completedPairs.clear();
}
