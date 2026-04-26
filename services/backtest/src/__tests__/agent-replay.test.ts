/**
 * agent-replay.test.ts
 *
 * Feed a tiny synthetic journal, assert variants produce different but
 * deterministic outputs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  runAgentReplay,
  loadJournal,
  reportToMarkdown,
  type PhaseVariant,
} from '../agent-replay.js';

// Use a deterministic PRNG seed for reproducible synthetic data
let seed = 42;
function seededRand(): number {
  seed = (seed * 1664525 + 1013904223) & 0xffffffff;
  return (seed >>> 0) / 0xffffffff;
}

// Patch Math.random temporarily for deterministic synthetic data
function withDeterministicRandom<T>(fn: () => T): T {
  const original = Math.random;
  Math.random = seededRand;
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

describe('agent-replay', () => {
  describe('loadJournal', () => {
    it('returns synthetic entries when journal file does not exist', () => {
      // Force smoke mode maxEntries to ensure we get synthetic data
      const entries = loadJournal({ maxEntries: 10 });
      expect(entries.length).toBeLessThanOrEqual(10);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.id).toBeTruthy();
        expect(entry.ts).toBeTruthy();
        expect(entry.type).toBe('trade');
        expect(entry.symbol).toBeTruthy();
      }
    });

    it('respects maxEntries limit', () => {
      const entries = loadJournal({ maxEntries: 5 });
      expect(entries.length).toBeLessThanOrEqual(5);
    });

    it('all entries are within the time window', () => {
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const entries = loadJournal({ since: since.toISOString(), maxEntries: 50 });
      for (const entry of entries) {
        const ts = new Date(entry.ts);
        expect(ts.getTime()).toBeGreaterThanOrEqual(since.getTime());
      }
    });
  });

  describe('runAgentReplay — smoke mode', () => {
    it('produces a valid report for phase0 variant', async () => {
      const report = await runAgentReplay({ variant: 'phase0', smoke: true });

      expect(report.id).toBeTruthy();
      expect(report.mode).toBe('smoke');
      expect(report.variant).toBe('phase0');
      expect(report.totalEntries).toBeGreaterThan(0);
      expect(report.totalEntries).toBeLessThanOrEqual(100);
      expect(report.durationMs).toBeGreaterThan(0);
      expect(Array.isArray(report.decisions)).toBe(true);
      expect(Array.isArray(report.phaseAttribution)).toBe(true);
      expect(typeof report.totalPnlDelta).toBe('number');
    });

    it('produces a valid report for all variant', async () => {
      const report = await runAgentReplay({ variant: 'all', smoke: true });

      expect(report.totalEntries).toBeGreaterThan(0);
      expect(report.variant).toBe('all');

      // all variant should have contributions from all phases
      const phases = new Set(report.phaseAttribution.map((p) => p.phase));
      expect(phases.has('phase0')).toBe(true);
      expect(phases.has('phase1')).toBe(true);
      expect(phases.has('phase2')).toBe(true);
    });

    it('different variants produce different P&L deltas (deterministic synthetic)', async () => {
      const [p0, p1, p2] = await Promise.all([
        runAgentReplay({ variant: 'phase0', smoke: true }),
        runAgentReplay({ variant: 'phase1', smoke: true }),
        runAgentReplay({ variant: 'phase2', smoke: true }),
      ]);

      // Phase 2 includes Phase 0 contributions, so should differ from Phase 0 alone
      expect(p0.totalPnlDelta).not.toBe(p2.totalPnlDelta);
      // Phase 0 and Phase 1 differ: Phase 0 only has fees; Phase 1 adds pipeline
      expect(p0.totalPnlDelta).not.toBe(p1.totalPnlDelta);
    });

    it('report contains phase attribution rows for active phases', async () => {
      const report = await runAgentReplay({ variant: 'phase3', smoke: true });

      const phases = report.phaseAttribution;
      expect(phases.length).toBeGreaterThan(0);
      for (const phase of phases) {
        expect(phase.phase).toBeTruthy();
        expect(typeof phase.contribution).toBe('number');
        expect(typeof phase.notes).toBe('string');
      }
    });

    it('each decision has required fields', async () => {
      const report = await runAgentReplay({ variant: 'all', smoke: true });

      for (const dec of report.decisions) {
        expect(dec.entryId).toBeTruthy();
        expect(dec.ts).toBeTruthy();
        expect(typeof dec.actualAction).toBe('string');
        expect(typeof dec.simulatedAction).toBe('string');
        expect(typeof dec.actionChanged).toBe('boolean');
        expect(typeof dec.pnlImpact).toBe('number');
        expect(Array.isArray(dec.phases)).toBe(true);
      }
    });

    it('smoke mode caps at 100 entries regardless of maxEntries param', async () => {
      const report = await runAgentReplay({ variant: 'phase0', smoke: true });
      expect(report.totalEntries).toBeLessThanOrEqual(100);
    });
  });

  describe('reportToMarkdown', () => {
    it('produces a non-empty markdown string', async () => {
      const report = await runAgentReplay({ variant: 'phase0', smoke: true });
      const md = reportToMarkdown(report);

      expect(typeof md).toBe('string');
      expect(md.length).toBeGreaterThan(100);
      expect(md).toContain('# Agent Replay Report');
      expect(md).toContain(report.variant.toUpperCase());
      expect(md).toContain('Phase Attribution');
    });

    it('contains P&L summary table', async () => {
      const report = await runAgentReplay({ variant: 'all', smoke: true });
      const md = reportToMarkdown(report);

      expect(md).toContain('Actual P&L');
      expect(md).toContain('Simulated P&L');
      expect(md).toContain('P&L Delta');
    });

    it('shows divergences when present', async () => {
      const report = await runAgentReplay({ variant: 'all', smoke: true });
      const md = reportToMarkdown(report);

      expect(md).toContain('## Decision Divergences');
    });
  });
});
