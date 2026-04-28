import fs from 'node:fs';
import type { TradeJournalEntry } from '@hermes/contracts';
import { QUARANTINED_EXIT_REASONS } from '@hermes/contracts';
import { STRATEGY_JOURNAL_PATH, STRATEGY_EVENT_LOG_PATH } from './constants.js';

export function readSharedJournalEntries(): TradeJournalEntry[] {
  try {
    if (!fs.existsSync(STRATEGY_JOURNAL_PATH)) return [];
    // Phase H2: Filter quarantined entries for analytics to avoid KPI pollution.
    return fs.readFileSync(STRATEGY_JOURNAL_PATH, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as TradeJournalEntry)
      .filter((entry) => !entry.exitReason || !QUARANTINED_EXIT_REASONS.has(entry.exitReason));
  } catch {
    return [];
  }
}

export function appendStrategyJournal(entry: TradeJournalEntry): void {
  try {
    const entryWithTimestamp = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    fs.appendFileSync(STRATEGY_JOURNAL_PATH, `${JSON.stringify(entryWithTimestamp)}\n`);
  } catch (error) {
    console.error('[persistence] Failed to append journal entry:', error);
  }
}

export function appendStrategyEvent(type: string, payload: Record<string, unknown>): void {
  try {
    const event = {
      timestamp: new Date().toISOString(),
      type,
      ...payload
    };
    fs.appendFileSync(STRATEGY_EVENT_LOG_PATH, `${JSON.stringify(event)}\n`);
  } catch (error) {
    console.error('[persistence] Failed to append strategy event:', error);
  }
}
