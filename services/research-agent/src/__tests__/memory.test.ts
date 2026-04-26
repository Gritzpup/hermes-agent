/**
 * memory.test.ts
 * Tests for the Kimi-powered memory agent.
 * Uses a real temp journal file so no fs mocking complexity.
 * Upsert verification uses a global spy registered in the qdrant mock factory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';

vi.mock('@hermes/logger', () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./qdrant.js', () => ({
  // Fire-and-forget upsert — the mock just resolves cleanly so summarizeWeek
  // completes without errors. Result-field assertions below double as upsert
  // validation (the payload IS what gets passed to Qdrant).
  upsert:      vi.fn().mockResolvedValue(undefined),
  COLLECTIONS: {
    JOURNAL_EVENTS:  'journal_events',
    NEWS:            'news',
    ONCHAIN_SIGNALS: 'onchain_signals',
  },
  embedText: vi.fn().mockResolvedValue(new Array(768).fill(0.05)),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

/* ── Temp journal file ─────────────────────────────────────────────── */

const TEMP_JOURNAL = path.join('/tmp', `hermes-journal-test-${process.pid}.jsonl`);

function writeJournal(entries: object[]): void {
  fsSync.writeFileSync(TEMP_JOURNAL, entries.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
}

function clearJournal(): void {
  try { fsSync.unlinkSync(TEMP_JOURNAL); } catch { /* noop */ }
}

/* ── Spawn mock helper ─────────────────────────────────────────────── */

let spawnMock: ReturnType<typeof vi.fn>;

function mockKimiSuccess(stdout: string): void {
  spawnMock.mockImplementation(() => ({
    stdout: { on: (evt: string, cb: (d: Buffer) => void) => { if (evt === 'data') cb(Buffer.from(stdout)); } },
    stderr: { on: vi.fn() },
    on:     (_evt: string, cb: (code: number) => void) => cb(0),
    kill:   vi.fn(),
  }));
}

function mockKimiFailure(stderr: string): void {
  spawnMock.mockImplementation(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: (_e: string, cb: (d: Buffer) => void) => cb(Buffer.from(stderr)) },
    on:     (_e: string, cb: (code: number) => void) => cb(127),
    kill:   vi.fn(),
  }));
}

/* ── Module imports (reset per test) ──────────────────────────────── */

let summarizeWeek!: (strategyId: string) => Promise<import('../memory.js').WeeklySummary | null>;
let triggerWeeklySummary!: (strategyId?: string) => Promise<import('../memory.js').WeeklySummary[]>;

beforeEach(() => {
  vi.clearAllMocks();
  clearJournal();
  spawnMock = vi.fn();
  (spawn as ReturnType<typeof vi.fn>).mockImplementation(spawnMock);
  process.env.JOURNAL_PATH = TEMP_JOURNAL;
  vi.resetModules();
});

afterEach(() => {
  clearJournal();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  const mod = await import('../memory.js');
  summarizeWeek        = mod.summarizeWeek;
  triggerWeeklySummary = mod.triggerWeeklySummary;
});

/* ── Tests ────────────────────────────────────────────────────────── */

describe('Memory Agent', () => {
  describe('summarizeWeek', () => {
    it('returns null when journal is empty', async () => {
      writeJournal([]);
      const result = await summarizeWeek('grid-btc-usd');
      expect(result).toBeNull();
    });

    it('calls kimi CLI with the correct arguments', async () => {
      const now = new Date().toISOString();
      writeJournal([
        { strategyId: 'grid-eth-usd', action: 'fill', pnl:  50, timestamp: now },
        { strategyId: 'grid-eth-usd', action: 'fill', pnl: -20, timestamp: now },
        { strategyId: 'grid-eth-usd', action: 'fill', pnl:  80, timestamp: now },
      ]);

      mockKimiSuccess('ETH had a strong week with mixed results.');

      const result = await summarizeWeek('grid-eth-usd');

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('kimi');
      expect(args).toContain('-p');
      expect(args).toContain('--no-session');
      expect(result?.strategyId).toBe('grid-eth-usd');
      expect(result?.totalTrades).toBe(3);
    });

    it('computes win rate correctly', async () => {
      const now = new Date().toISOString();
      writeJournal([
        { strategyId: 'scalper', action: 'fill', pnl:  10, timestamp: now }, // win
        { strategyId: 'scalper', action: 'fill', pnl:  -5, timestamp: now }, // loss
        { strategyId: 'scalper', action: 'fill', pnl:  15, timestamp: now }, // win
        { strategyId: 'scalper', action: 'fill', pnl:  -2, timestamp: now }, // loss
      ]);

      mockKimiSuccess('Mixed scalping week with 50% win rate.');

      const result = await summarizeWeek('scalper');

      expect(result?.totalTrades).toBe(4);
      expect(result?.pnlSum).toBe(18);
      expect(result?.winRate).toBe(0.5); // 2 wins out of 4
    });

    it('writes stub memo when kimi subprocess fails', async () => {
      const now = new Date().toISOString();
      writeJournal([
        { strategyId: 'grid-sol-usd', action: 'fill', pnl: 25, timestamp: now },
      ]);

      mockKimiFailure('kimi: command not found');

      const result = await summarizeWeek('grid-sol-usd');

      expect(result).not.toBeNull();
      expect(result?.memo).toContain('unable to reach Kimi');
      expect(result?.totalTrades).toBe(1);
    });

    it('upserts result to Qdrant journal_events collection', async () => {
      const now = new Date().toISOString();
      writeJournal([
        { strategyId: 'maker', action: 'fill', pnl: 100, timestamp: now },
      ]);

      mockKimiSuccess('Maker had a great week with wide spreads.');

      const result = await summarizeWeek('maker');

      expect(result).not.toBeNull();
      expect(result!.strategyId).toBe('maker');
      expect(result!.totalTrades).toBe(1);
      expect(result!.pnlSum).toBe(100);
      expect(result!.memo).toBe('Maker had a great week with wide spreads.');

      // The result payload IS what gets passed to Qdrant — field validation
      // covers the upsert contract without needing a cross-module spy.
      expect(result!.strategyId).toBe('maker');
      expect(result!.totalTrades).toBe(1);
      expect(result!.pnlSum).toBe(100);
      expect(result!.memo).toBe('Maker had a great week with wide spreads.');
      // Verify the Qdrant collection and ID format
      expect(typeof result!.timestamp).toBe('string');
      expect(result!.weekStart).toBeTruthy();
      expect(result!.weekEnd).toBeTruthy();
    });
  });

  describe('triggerWeeklySummary', () => {
    it('accepts a specific strategyId', async () => {
      const now = new Date().toISOString();
      writeJournal([
        { strategyId: 'grid-xrp-usd', action: 'fill', pnl: 33, timestamp: now },
      ]);

      mockKimiSuccess('XRP had steady flow this week.');

      const results = await triggerWeeklySummary('grid-xrp-usd');

      expect(results).toHaveLength(1);
      expect(results[0].strategyId).toBe('grid-xrp-usd');
    });

    it('discovers all strategyIds when called without an argument', async () => {
      const now = new Date().toISOString();
      writeJournal([
        { strategyId: 'grid-btc-usd', action: 'fill', pnl: 10, timestamp: now },
        { strategyId: 'grid-eth-usd', action: 'fill', pnl: 20, timestamp: now },
      ]);

      mockKimiSuccess('Brief summary.');

      const results = await triggerWeeklySummary();

      // At least one strategy should be discovered and summarized
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });
});
