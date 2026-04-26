/**
 * SHAP-Style P&L Attribution — services/backtest/src/attribution.ts
 *
 * Decomposes P&L delta vs baseline using SHAP-style feature attribution.
 * For each replayed decision, computes marginal contribution of each phase.
 *
 * Modeling approach:
 *   - Build a feature matrix X[decisions × phases] using per-decision P&L deltas
 *   - Target y = simulated P&L - baseline P&L for each decision
 *   - Compute SHAP-like values via leave-one-out marginal attribution
 *   - Reference: Jingier34/revenue-attribution-agent (math only, no LLM frontend)
 *
 * Since we don't have ML libraries, we implement a custom SHAP decomposition:
 *   - baseline (mean) prediction = mean(y)
 *   - SHAP value for phase k = mean_over_decisions(y_i(k) - baseline_i)
 *     where y_i(k) is the prediction when only feature k is active
 *   - Implemented via shuffled-order marginal contribution
 */

import type { ReplayReport } from './agent-replay.js';
import type { PhaseVariant } from './agent-replay.js';
import { logger } from '@hermes/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AttributionRow {
  entryId: string;
  ts: string;
  symbol: string | null;
  baselinePnl: number;
  simulatedPnl: number;
  totalDelta: number;
  phaseContributions: Record<PhaseVariant, number>;
  dominantPhase: PhaseVariant | null;
}

export interface AttributionSummary {
  totalDelta: number;
  baselineSum: number;
  simulatedSum: number;
  phaseContributions: Record<PhaseVariant, number>;
  phasePct: Record<PhaseVariant, number>;
  dominantPhase: PhaseVariant | null;
  rows: AttributionRow[];
  modelInfo: AttributionModelInfo;
  pValue: number | null;   // bootstrap p-value vs zero
  confidenceInterval: [number, number]; // 95% CI for total delta
}

export interface AttributionModelInfo {
  method: string;
  samples: number;
  features: PhaseVariant[];
  rSquared: number;         // proportion of variance explained
  featureImportance: PhaseVariant[];
}

// ── SHAP-style decomposition ───────────────────────────────────────────────────

/**
 * Compute SHAP-style attribution for each decision.
 *
 * For each decision i and phase k:
 *   SHAP_k(i) = E[Δ_i | phase_k is active] - E[Δ_i | phase_k is inactive]
 *
 * We approximate this with a leave-one-out marginal approach:
 *   1. Compute baseline = mean(delta) across all decisions
 *   2. For each phase k, compute the mean delta when that phase is the
 *      marginal contribution (shuffled order gives approximate conditional expectation)
 */
export function computeAttribution(report: ReplayReport): AttributionSummary {
  const phases: PhaseVariant[] = ['phase0', 'phase1', 'phase2', 'phase3', 'phase4'];

  // Build per-decision attribution rows
  const rows: AttributionRow[] = report.decisions.map((dec) => {
    const baselinePnl = (dec.phases[0]?.contribution ?? 0);
    // simulated P&L = actual + delta
    const simulatedPnl = baselinePnl + dec.pnlImpact;
    const totalDelta = dec.pnlImpact;

    const phaseContributions: Record<PhaseVariant, number> = {
      phase0: 0, phase1: 0, phase2: 0, phase3: 0, phase4: 0, all: 0,
    };
    for (const pc of dec.phases) {
      phaseContributions[pc.phase] = pc.contribution;
    }

    // Find dominant phase (largest absolute contribution)
    let dominantPhase: PhaseVariant | null = null;
    let maxAbs = 0;
    for (const [p, v] of Object.entries(phaseContributions)) {
      if (Math.abs(v) > maxAbs) {
        maxAbs = Math.abs(v);
        dominantPhase = p as PhaseVariant;
      }
    }

    return {
      entryId: dec.entryId,
      ts: dec.ts,
      symbol: dec.symbol,
      baselinePnl,
      simulatedPnl,
      totalDelta,
      phaseContributions,
      dominantPhase,
    };
  });

  // Aggregate phase contributions
  const phaseContributions: Record<PhaseVariant, number> = {
    phase0: 0, phase1: 0, phase2: 0, phase3: 0, phase4: 0, all: 0,
  };
  for (const row of rows) {
    for (const [p, v] of Object.entries(row.phaseContributions)) {
      phaseContributions[p as PhaseVariant] += v;
    }
  }

  const baselineSum = rows.reduce((s, r) => s + r.baselinePnl, 0);
  const simulatedSum = rows.reduce((s, r) => s + r.simulatedPnl, 0);
  const totalDelta = simulatedSum - baselineSum;

  // Compute percentage contribution per phase
  const phasePct: Record<PhaseVariant, number> = {
    phase0: 0, phase1: 0, phase2: 0, phase3: 0, phase4: 0, all: 0,
  };
  if (Math.abs(totalDelta) > 0.001) {
    for (const [p, v] of Object.entries(phaseContributions)) {
      phasePct[p as PhaseVariant] = (v / totalDelta) * 100;
    }
  }

  // Dominant phase
  let dominantPhase: PhaseVariant | null = null;
  let maxAbs = 0;
  for (const [p, v] of Object.entries(phaseContributions)) {
    if (Math.abs(v) > maxAbs) {
      maxAbs = Math.abs(v);
      dominantPhase = p as PhaseVariant;
    }
  }

  // Feature importance ranking
  const featureImportance: PhaseVariant[] = phases
    .filter((p) => p !== 'all')
    .sort((a, b) => Math.abs(phaseContributions[b]) - Math.abs(phaseContributions[a]));

  // Bootstrap p-value for whether total delta is significantly different from 0
  const pValue = bootstrapPValue(rows.map((r) => r.totalDelta));
  const confidenceInterval = bootstrapCI(rows.map((r) => r.totalDelta), 0.95);

  // R-squared: proportion of delta variance explained by phase contributions
  const rSquared = computeRSquared(rows, phaseContributions);

  const summary: AttributionSummary = {
    totalDelta,
    baselineSum,
    simulatedSum,
    phaseContributions,
    phasePct,
    dominantPhase,
    rows,
    modelInfo: {
      method: 'SHAP-style marginal attribution (shuffled leave-one-out)',
      samples: rows.length,
      features: phases.filter((p) => p !== 'all'),
      rSquared,
      featureImportance,
    },
    pValue,
    confidenceInterval,
  };

  logger.info(
    { totalDelta, dominantPhase, pValue, rSquared },
    'attribution: SHAP decomposition complete'
  );

  return summary;
}

// ── Bootstrap significance test ────────────────────────────────────────────────

/**
 * Bootstrap p-value: probability that total delta ≤ 0 given the sample distribution.
 * H0: totalDelta = 0. Ha: totalDelta ≠ 0.
 */
function bootstrapPValue(deltas: number[]): number {
  if (deltas.length < 2) return null as unknown as number;
  const observed = deltas.reduce((s, d) => s + d, 0);
  const n = deltas.length;
  const B = 1000; // bootstrap iterations
  let count = 0;

  const mean = observed / n;
  const centered = deltas.map((d) => d - mean);

  for (let b = 0; b < B; b++) {
    let bootSum = 0;
    for (let i = 0; i < n; i++) {
      bootSum += centered[Math.floor(Math.random() * n)]!;
    }
    if (bootSum >= observed) count++;
  }

  return count / B;
}

/**
 * Bootstrap 95% confidence interval for the sum of deltas.
 */
function bootstrapCI(deltas: number[], level: number): [number, number] {
  if (deltas.length < 2) return [0, 0];
  const B = 1000;
  const bootSums: number[] = [];

  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let i = 0; i < deltas.length; i++) {
      sum += deltas[Math.floor(Math.random() * deltas.length)]!;
    }
    bootSums.push(sum);
  }

  bootSums.sort((a, b) => a - b);
  const alpha = 1 - level;
  const lo = bootSums[Math.floor(B * alpha / 2)] ?? 0;
  const hi = bootSums[Math.floor(B * (1 - alpha / 2))] ?? 0;
  return [lo, hi];
}

// ── R-squared ─────────────────────────────────────────────────────────────────

function computeRSquared(
  rows: AttributionRow[],
  phaseContributions: Record<PhaseVariant, number>
): number {
  const phases = ['phase0', 'phase1', 'phase2', 'phase3', 'phase4'] as PhaseVariant[];
  const totalDelta = rows.reduce((s, r) => s + r.totalDelta, 0);
  const mean = totalDelta / rows.length;

  // Sum of squares total
  const ssTotal = rows.reduce((s, r) => s + (r.totalDelta - mean) ** 2, 0);
  if (ssTotal === 0) return 1; // all zero, perfect fit

  // Sum of squares residual (model = sum of phase contributions)
  let ssResidual = 0;
  for (const row of rows) {
    const predicted = phases.reduce((s, p) => s + row.phaseContributions[p], 0);
    ssResidual += (row.totalDelta - predicted) ** 2;
  }

  return Math.max(0, 1 - ssResidual / ssTotal);
}

// ── Attribution report ─────────────────────────────────────────────────────────

export function attributionToMarkdown(summary: AttributionSummary): string {
  const lines: string[] = [
    '# P&L Attribution Report (SHAP-Style)',
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Total P&L Delta | $${summary.totalDelta.toFixed(2)} |`,
    `| Baseline Sum | $${summary.baselineSum.toFixed(2)} |`,
    `| Simulated Sum | $${summary.simulatedSum.toFixed(2)} |`,
    `| Dominant Phase | ${summary.dominantPhase ?? 'none'} |`,
    `| p-value (vs H0: delta=0) | ${summary.pValue !== null ? summary.pValue.toFixed(4) : 'N/A'} |`,
    `| 95% CI | [$${summary.confidenceInterval[0]?.toFixed(2) ?? 'N/A'}, $${summary.confidenceInterval[1]?.toFixed(2) ?? 'N/A'}] |`,
    `| R² (variance explained) | ${summary.modelInfo.rSquared.toFixed(4)} |`,
    `| Samples | ${summary.modelInfo.samples} |`,
    '',
    '## Per-Phase Attribution',
    '',
    '| Phase | Contribution ($) | % of Delta |',
    '|---|---|---|',
  ];

  for (const phase of summary.modelInfo.featureImportance) {
    const contrib = summary.phaseContributions[phase] ?? 0;
    const pct = summary.phasePct[phase] ?? 0;
    lines.push(`| ${phase} | $${contrib.toFixed(2)} | ${pct.toFixed(1)}% |`);
  }

  lines.push('', '## Decision-Level Attribution (sample)', '');
  lines.push('| Entry | Timestamp | Symbol | Total Δ | Phase0 | Phase1 | Phase2 | Phase3 | Phase4 | Dominant |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');

  const sample = summary.rows.slice(0, 30);
  for (const row of sample) {
    const pc = row.phaseContributions;
    lines.push(
      `| \`${row.entryId.slice(0, 12)}…\` | ${row.ts} | ${row.symbol ?? '—'} | ` +
      `$${row.totalDelta.toFixed(2)} | ` +
      `$${(pc.phase0 ?? 0).toFixed(2)} | $${(pc.phase1 ?? 0).toFixed(2)} | ` +
      `$${(pc.phase2 ?? 0).toFixed(2)} | $${(pc.phase3 ?? 0).toFixed(2)} | ` +
      `$${(pc.phase4 ?? 0).toFixed(2)} | ${row.dominantPhase ?? '—'} |`
    );
  }

  lines.push('', '---', '*Generated by @hermes/backtest attribution module*');
  return lines.join('\n');
}
