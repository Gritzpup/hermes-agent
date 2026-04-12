/**
 * Ledger I/O Module
 *
 * Async file write queue, ledger append/rewrite, and log rotation.
 * Standalone — no dependency on engine state.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EVENT_LOG_PATH, FILL_LEDGER_PATH, JOURNAL_LEDGER_PATH } from './types.js';

const fileQueues = new Map<string, Promise<void>>();

/** Enqueue an async write operation for a file path (serialized, non-blocking). */
export function enqueueWrite(filePath: string, operation: () => Promise<void> | void): void {
  const queue = fileQueues.get(filePath) ?? Promise.resolve();
  fileQueues.set(
    filePath,
    queue.then(async () => {
      try {
        await operation();
      } catch (error) {
        console.error(`[paper-engine] I/O failure on ${filePath}`, error);
      }
    })
  );
}

/** Append a single JSON payload to a ledger file. */
export function appendLedger(filePath: string, payload: unknown): void {
  enqueueWrite(filePath, async () => {
    await fs.promises.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  });
}

/** Rewrite an entire ledger file with the given entries. */
export function rewriteLedger(filePath: string, entries: unknown[]): void {
  enqueueWrite(filePath, async () => {
    const content = entries.map((entry) => JSON.stringify(entry)).join('\n');
    await fs.promises.writeFile(filePath, content.length > 0 ? `${content}\n` : '', 'utf8');
  });
}

/** Rotate a log file when it exceeds maxMB. Keeps one .bak backup. */
export function maybeRotateLog(filePath: string, maxMB: number): void {
  enqueueWrite(filePath, async () => {
    try {
      if (!fs.existsSync(filePath)) return;
      const stat = await fs.promises.stat(filePath);
      if (stat.size > maxMB * 1024 * 1024) {
        const bakPath = `${filePath}.bak`;
        await fs.promises.rename(filePath, bakPath);
        console.log(`[paper-engine] Rotated ${path.basename(filePath)} (${(stat.size / 1024 / 1024).toFixed(1)} MB -> .bak)`);
      }
    } catch {
      // Rotation is best-effort
    }
  });
}

/** Rotate all standard ledger log files. */
export function rotateAllLogs(): void {
  maybeRotateLog(EVENT_LOG_PATH, 50);
  maybeRotateLog(FILL_LEDGER_PATH, 25);
  maybeRotateLog(JOURNAL_LEDGER_PATH, 25);
}

/** Deduplicate entries by ID, keeping the latest by exitAt. */
export function dedupeById<T extends { id: string }>(entries: T[]): T[] {
  const byId = new Map<string, T>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }
  return Array.from(byId.values()).sort((left, right) => {
    const leftTime = 'exitAt' in left && typeof left.exitAt === 'string' ? Date.parse(left.exitAt) : 0;
    const rightTime = 'exitAt' in right && typeof right.exitAt === 'string' ? Date.parse(right.exitAt) : 0;
    return rightTime - leftTime;
  });
}
