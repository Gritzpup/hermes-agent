/**
 * Tool: read_journal_window
 * Tails recent journal entries from services/api/.runtime/paper-ledger/journal.jsonl
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolContext, ToolDef } from './index.js';
import { FIRM_JOURNAL_FILE } from '../config.js';

export interface JournalEntry {
  id: string;
  strategy: string;
  symbol: string;
  side: string;
  qty: number;
  entryPx: number;
  exitPx: number;
  realizedPnl: number;
  exitAt: string;
  broker: string;
  [key: string]: unknown;
}

export interface ReadJournalWindowResult {
  entries: JournalEntry[];
  count: number;
  fromFile: string;
  windowHours: number;
  ts: string;
}

async function readJournalWindow(
  _ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ReadJournalWindowResult> {
  const hours = typeof args.hours === 'number' ? args.hours : 24;
  const entries: JournalEntry[] = [];
  const cutoff = Date.now() - hours * 3_600_000;

  try {
    if (!fs.existsSync(FIRM_JOURNAL_FILE)) {
      return { entries: [], count: 0, fromFile: FIRM_JOURNAL_FILE, windowHours: hours, ts: new Date().toISOString() };
    }

    const data = fs.readFileSync(FIRM_JOURNAL_FILE, 'utf8');
    const lines = data.split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JournalEntry;
        const ts = entry.exitAt ?? (entry as Record<string, unknown>).ts as string | undefined;
        if (!ts) continue;
        const ms = new Date(ts).getTime();
        if (ms < cutoff) continue;
        entries.push(entry);
      } catch { /* skip malformed lines */ }
    }
  } catch (err) {
    // Non-fatal: return empty
  }

  return {
    entries,
    count: entries.length,
    fromFile: FIRM_JOURNAL_FILE,
    windowHours: hours,
    ts: new Date().toISOString(),
  };
}

export const READ_JOURNAL_WINDOW_TOOL: ToolDef = {
  name: 'read_journal_window',
  description: 'Tail recent journal entries from journal.jsonl. Returns entries within the given hours window.',
  inputSchema: {
    type: 'object',
    properties: {
      hours: { type: 'number', description: 'Number of hours to look back (default 24)', default: 24 },
    },
    additionalProperties: false,
  },
  fn: readJournalWindow,
};
