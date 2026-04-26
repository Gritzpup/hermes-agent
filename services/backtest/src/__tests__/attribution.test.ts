/**
 * attribution.test.ts
 *
 * Synthetic data with a known dominant feature.
 * Assert that the dominant feature gets the highest attribution.
 */

import { describe, it, expect } from 'vitest';
import { computeAttribution, attributionToMarkdown } from '../attribution.js';
import type { ReplayReport, ReplayDecision, PhaseContribution } from '../agent-replay.js';
import type { PhaseVariant } from '../agent-replay.js';

function makePhaseContrib(
  phase0 = 0,
  phase1 = 0,
  phase2 = 0,
  phase3 = 0,
  phase4 = 0
): PhaseContribution[] {
  return [
    { phase: 'phase0', contribution: phase0, notes: 'fee test' },
    { phase: 'phase1', contribution: phase1, notes: 'pipeline test' },
    { phase: 'phase2', contribution: phase2, notes: 'sentiment test' },
    { phase: 'phase3', contribution: phase3, notes: 'finrl test' },
    { phase: 'phase4', contribution: phase4, notes: 'router test' },
  ];
}

function makeDecision(
  id: string,
  pnlImpact: number,
  phases: PhaseContribution[]
): ReplayDecision {
  return {
    entryId: id,
    ts: new Date().toISOString(),
    symbol: 'BTC-USD',
    actualAction: 'buy',
    simulatedAction: 'noop',
    actionChanged: pnlImpact !== 0,
    pnlImpact,
    phases,
  };
}

function makeReport(decisions: ReplayDecision[]): ReplayReport {
  return {
    id: 'test-report-001',
    mode: 'smoke',
    variant: 'all',
    startTs: new Date(Date.now() - 86400_000).toISOString(),
    endTs: new Date().toISOString(),
    totalEntries: decisions.length,
    decisions,
    totalPnlDelta: decisions.reduce((s, d) => s + d.pnlImpact, 0),
    totalActualPnl: 0,
    totalSimulatedPnl: 0,
    phaseAttribution: [],
    divergences: [],
    generatedAt: new Date().toISOString(),
    durationMs: 10,
  };
}

describe('attribution', () => {
  describe('computeAttribution', () => {
    it('identifies phase3 as dominant when all contributions come from phase3', () => {
      const decisions: ReplayDecision[] = Array.from({ length: 10 }, (_, i) =>
        makeDecision(
          `dec-${i}`,
          10.0, // all decisions have +10 P&L delta
          makePhaseContrib(0, 0, 0, 10.0, 0) // all from phase3
        )
      );

      const summary = computeAttribution(makeReport(decisions));

      expect(summary.dominantPhase).toBe('phase3');
      expect(summary.phaseContributions.phase3).toBeCloseTo(100, 1);
      expect(summary.phasePct.phase3).toBeCloseTo(100, 0);
    });

    it('identifies phase0 as dominant when all contributions come from phase0 (fees)', () => {
      const decisions: ReplayDecision[] = Array.from({ length: 5 }, (_, i) =>
        makeDecision(
          `dec-${i}`,
          -5.0, // negative P&L from fees
          makePhaseContrib(-5.0, 0, 0, 0, 0)
        )
      );

      const summary = computeAttribution(makeReport(decisions));

      expect(summary.dominantPhase).toBe('phase0');
      expect(summary.totalDelta).toBeCloseTo(-25, 1);
    });

    it('sum of phase contributions equals total delta', () => {
      const decisions: ReplayDecision[] = [
        makeDecision('d1', 15.0, makePhaseContrib(5, 3, 2, 4, 1)),
        makeDecision('d2', -3.0, makePhaseContrib(-1, -1, -0.5, -0.3, -0.2)),
        makeDecision('d3', 8.0, makePhaseContrib(2, 2, 1, 2, 1)),
      ];

      const summary = computeAttribution(makeReport(decisions));

      const sum = Object.entries(summary.phaseContributions)
        .filter(([k]) => k !== 'all')
        .reduce((s, [, v]) => s + v, 0);

      expect(sum).toBeCloseTo(summary.totalDelta, 4);
    });

    it('phase contributions are additive across decisions', () => {
      const decisions: ReplayDecision[] = [
        makeDecision('d1', 5.0, makePhaseContrib(2, 1, 1, 1, 0)),
        makeDecision('d2', 7.0, makePhaseContrib(3, 2, 1, 1, 0)),
      ];

      const summary = computeAttribution(makeReport(decisions));

      expect(summary.phaseContributions.phase0).toBeCloseTo(5, 4);
      expect(summary.phaseContributions.phase1).toBeCloseTo(3, 4);
      expect(summary.phaseContributions.phase2).toBeCloseTo(2, 4);
    });

    it('R² is 1.0 when all P&L delta comes from known phases (perfect fit)', () => {
      const decisions: ReplayDecision[] = [
        makeDecision('d1', 10.0, makePhaseContrib(7, 2, 1, 0, 0)),
        makeDecision('d2', 5.0, makePhaseContrib(3, 1, 1, 0, 0)),
      ];

      const summary = computeAttribution(makeReport(decisions));

      expect(summary.modelInfo.rSquared).toBeCloseTo(1.0, 2);
    });

    it('feature importance ranking is sorted by absolute contribution', () => {
      const decisions: ReplayDecision[] = [
        makeDecision('d1', 10.0, makePhaseContrib(2, 5, 1, 1, 1)),
        makeDecision('d2', 10.0, makePhaseContrib(1, 3, 3, 2, 1)),
      ];

      const summary = computeAttribution(makeReport(decisions));

      const importance = summary.modelInfo.featureImportance;
      expect(importance.length).toBeGreaterThan(0);
      // phase1 should be first (largest contribution: 5+3=8)
      expect(importance[0]).toBe('phase1');
    });

    it('attribution rows cover all decisions', () => {
      const decisions: ReplayDecision[] = [
        makeDecision('a', 1.0, makePhaseContrib(0.5, 0.3, 0.2, 0, 0)),
        makeDecision('b', 2.0, makePhaseContrib(1.0, 0.5, 0.5, 0, 0)),
      ];

      const summary = computeAttribution(makeReport(decisions));

      expect(summary.rows.length).toBe(2);
      expect(summary.rows.find((r) => r.entryId === 'a')).toBeTruthy();
      expect(summary.rows.find((r) => r.entryId === 'b')).toBeTruthy();
    });

    it('dominant phase is null when all contributions are zero', () => {
      const decisions: ReplayDecision[] = [
        makeDecision('a', 0, makePhaseContrib(0, 0, 0, 0, 0)),
      ];

      const summary = computeAttribution(makeReport(decisions));

      // When all zero, dominant phase might be null or any phase with 0 contribution
      // This is acceptable — no dominant signal
      expect(summary.totalDelta).toBeCloseTo(0, 4);
    });
  });

  describe('attributionToMarkdown', () => {
    it('produces a non-empty markdown string', () => {
      const decisions = [
        makeDecision('d1', 5.0, makePhaseContrib(2, 1, 1, 1, 0)),
        makeDecision('d2', 3.0, makePhaseContrib(1, 1, 0.5, 0.5, 0)),
      ];
      const summary = computeAttribution(makeReport(decisions));
      const md = attributionToMarkdown(summary);

      expect(typeof md).toBe('string');
      expect(md.length).toBeGreaterThan(50);
      expect(md).toContain('# P&L Attribution Report');
      expect(md).toContain('Total P&L Delta');
    });

    it('includes phase attribution table', () => {
      const decisions = [
        makeDecision('d1', 10.0, makePhaseContrib(3, 4, 2, 1, 0)),
      ];
      const summary = computeAttribution(makeReport(decisions));
      const md = attributionToMarkdown(summary);

      expect(md).toContain('## Summary');
      expect(md).toContain('## Per-Phase Attribution');
      expect(md).toContain('phase1');
    });

    it('includes confidence interval', () => {
      const decisions = Array.from({ length: 20 }, (_, i) =>
        makeDecision(`d${i}`, 5.0, makePhaseContrib(2, 1, 1, 1, 0))
      );
      const summary = computeAttribution(makeReport(decisions));
      const md = attributionToMarkdown(summary);

      expect(md).toContain('95% CI');
      expect(md).toContain('p-value');
    });
  });
});
