/**
 * Write Queue — offload synchronous journal/fill/event appends from the hot path.
 *
 * Trades are enqueued as single-line JSON and flushed in batches of up to 64
 * entries per tick.  Multiple paths are coalesced so a single appendFile call
 * writes all pending lines for one file.  The queue drains itself recursively
 * until empty, then waits for new work.
 *
 * On shutdown call flushWriteQueue() to drain all pending writes before exit.
 */

import fs from 'node:fs';

type WriteTask = { path: string; line: string };
const queue: WriteTask[] = [];
let flushing = false;

/** Add a line to the write queue.  Truncating \\n is the caller's responsibility. */
export function enqueueAppend(path: string, line: string): void {
  queue.push({ path, line: line.endsWith('\n') ? line : line + '\n' });
  if (!flushing) void flush();
}

async function flush(): Promise<void> {
  flushing = true;
  try {
    while (queue.length > 0) {
      const batch = queue.splice(0, 64);
      const byPath = new Map<string, string>();
      for (const t of batch) {
        byPath.set(t.path, (byPath.get(t.path) ?? '') + t.line);
      }
      for (const [path, block] of byPath.entries()) {
        await fs.promises.appendFile(path, block, 'utf8');
      }
    }
  } catch (err) {
    console.error('[write-queue] flush failed', err);
  } finally {
    flushing = false;
    if (queue.length > 0) void flush();
  }
}

/** Block until the queue is completely drained.  Call on shutdown. */
export async function flushWriteQueue(): Promise<void> {
  while (queue.length > 0 || flushing) {
    await new Promise((r) => setTimeout(r, 25));
  }
}
