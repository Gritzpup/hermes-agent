import { clamp, round } from './paper-engine-utils.js';
const KPI_THRESHOLDS = {
    symbol: {
        minSampleCount: 8,
        targetSampleCount: 12,
        minWinRatePct: 58,
        targetWinRatePct: 66,
        minProfitFactor: 1.15,
        targetProfitFactor: 1.35,
        minExpectancy: 0,
        minNetEdgeBps: 0,
        targetNetEdgeBps: 4,
        minConfidencePct: 20,
        targetConfidencePct: 40,
        maxDrawdownPct: 12,
        minRatioPct: 72
    },
    asset: {
        minSampleCount: 12,
        targetSampleCount: 18,
        minWinRatePct: 58,
        targetWinRatePct: 64,
        minProfitFactor: 1.2,
        targetProfitFactor: 1.4,
        minExpectancy: 0,
        minNetEdgeBps: 0,
        targetNetEdgeBps: 4,
        minConfidencePct: 20,
        targetConfidencePct: 40,
        maxDrawdownPct: 10,
        minRatioPct: 72
    },
    agent: {
        minSampleCount: 20,
        targetSampleCount: 30,
        minWinRatePct: 55,
        targetWinRatePct: 62,
        minProfitFactor: 1.25,
        targetProfitFactor: 1.45,
        minExpectancy: 0,
        minNetEdgeBps: 0,
        targetNetEdgeBps: 6,
        minConfidencePct: 25,
        targetConfidencePct: 45,
        maxDrawdownPct: 10,
        minRatioPct: 70
    },
    sleeve: {
        minSampleCount: 20,
        targetSampleCount: 32,
        minWinRatePct: 58,
        targetWinRatePct: 65,
        minProfitFactor: 1.3,
        targetProfitFactor: 1.55,
        minExpectancy: 0,
        minNetEdgeBps: 0,
        targetNetEdgeBps: 6,
        minConfidencePct: 30,
        targetConfidencePct: 50,
        maxDrawdownPct: 8,
        minRatioPct: 75
    },
    desk: {
        minSampleCount: 40,
        targetSampleCount: 80,
        minWinRatePct: 55,
        targetWinRatePct: 60,
        minProfitFactor: 1.15,
        targetProfitFactor: 1.3,
        minExpectancy: 0,
        minNetEdgeBps: 0,
        targetNetEdgeBps: 4,
        minConfidencePct: 20,
        targetConfidencePct: 35,
        maxDrawdownPct: 15,
        minRatioPct: 65
    }
};
function scopeLabel(scope) {
    switch (scope) {
        case 'symbol': return 'Symbol';
        case 'asset': return 'Asset class';
        case 'agent': return 'Agent';
        case 'sleeve': return 'Sleeve';
        case 'desk': return 'Desk';
    }
}
function normalize(value, floor, target) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    if (target <= floor) {
        return value >= target ? 1 : 0;
    }
    return clamp((value - floor) / (target - floor), 0, 1);
}
function metricLine(input) {
    // COO FIX: handle undefined winRatePct/profitFactor
    const winRate = input.winRatePct ?? 0;
    const profitFactor = input.profitFactor ?? 0;
    const parts = [
        `sample ${Math.max(0, Math.round(input.sampleCount ?? 0))}`,
        `win ${winRate.toFixed(1)}%`,
        `PF ${profitFactor.toFixed(2)}`
    ];
    if (typeof input.expectancy === 'number') {
        parts.push(`exp ${input.expectancy.toFixed(2)}`);
    }
    if (typeof input.netEdgeBps === 'number') {
        parts.push(`edge ${input.netEdgeBps.toFixed(2)}bps`);
    }
    if (typeof input.confidencePct === 'number') {
        parts.push(`conf ${input.confidencePct.toFixed(1)}%`);
    }
    if (typeof input.drawdownPct === 'number') {
        parts.push(`dd ${input.drawdownPct.toFixed(1)}%`);
    }
    return parts.join(' · ');
}
export function evaluateKpiGate(input) {
    const thresholds = KPI_THRESHOLDS[input.scope];
    const blockers = [];
    const warnings = [];
    if (input.sampleCount < thresholds.minSampleCount) {
        blockers.push(`sample size ${input.sampleCount.toFixed(0)} < ${thresholds.minSampleCount}`);
    }
    if (typeof input.winRatePct === 'number' && input.winRatePct < thresholds.minWinRatePct) {
        blockers.push(`win rate ${input.winRatePct.toFixed(1)}% < ${thresholds.minWinRatePct.toFixed(1)}%`);
    }
    if (typeof input.profitFactor === 'number' && input.profitFactor < thresholds.minProfitFactor) {
        blockers.push(`profit factor ${input.profitFactor.toFixed(2)} < ${thresholds.minProfitFactor.toFixed(2)}`);
    }
    if (typeof input.expectancy === 'number' && input.expectancy <= thresholds.minExpectancy) {
        blockers.push(`expectancy ${input.expectancy.toFixed(2)} <= ${thresholds.minExpectancy.toFixed(2)}`);
    }
    if (typeof input.netEdgeBps === 'number' && input.netEdgeBps <= thresholds.minNetEdgeBps) {
        blockers.push(`net edge ${input.netEdgeBps.toFixed(2)}bps <= ${thresholds.minNetEdgeBps.toFixed(2)}bps`);
    }
    if (typeof input.confidencePct === 'number' && input.confidencePct < thresholds.minConfidencePct) {
        blockers.push(`confidence ${input.confidencePct.toFixed(1)}% < ${thresholds.minConfidencePct.toFixed(1)}%`);
    }
    if (typeof input.drawdownPct === 'number' && input.drawdownPct > thresholds.maxDrawdownPct) {
        blockers.push(`drawdown ${input.drawdownPct.toFixed(1)}% > ${thresholds.maxDrawdownPct.toFixed(1)}%`);
    }
    const componentEntries = [
        { weight: 0.28, value: normalize(input.sampleCount, thresholds.minSampleCount, thresholds.targetSampleCount) },
        { weight: 0.3, value: normalize(input.winRatePct ?? 0, thresholds.minWinRatePct, thresholds.targetWinRatePct) },
        { weight: 0.24, value: normalize(input.profitFactor ?? 0, thresholds.minProfitFactor, thresholds.targetProfitFactor) }
    ];
    if (typeof input.netEdgeBps === 'number') {
        componentEntries.push({ weight: 0.1, value: normalize(input.netEdgeBps, thresholds.minNetEdgeBps, thresholds.targetNetEdgeBps) });
    }
    if (typeof input.confidencePct === 'number') {
        componentEntries.push({ weight: 0.08, value: normalize(input.confidencePct, thresholds.minConfidencePct, thresholds.targetConfidencePct) });
    }
    if (typeof input.expectancy === 'number') {
        componentEntries.push({ weight: 0.04, value: input.expectancy > thresholds.minExpectancy ? 1 : 0 });
    }
    const componentWeight = componentEntries.reduce((sum, component) => sum + component.weight, 0) || 1;
    let ratioPct = componentEntries.reduce((sum, component) => sum + component.value * component.weight, 0) / componentWeight * 100;
    if (typeof input.drawdownPct === 'number' && Number.isFinite(input.drawdownPct)) {
        const drawdownPenalty = clamp(1 - (input.drawdownPct / Math.max(thresholds.maxDrawdownPct, 0.1)), 0.35, 1);
        ratioPct *= drawdownPenalty;
    }
    ratioPct = round(clamp(ratioPct, 0, 100), 1);
    if (ratioPct < thresholds.minRatioPct) {
        blockers.push(`kpi ratio ${ratioPct.toFixed(1)}% < ${thresholds.minRatioPct.toFixed(1)}%`);
    }
    if (input.sampleCount < thresholds.targetSampleCount) {
        warnings.push(`sample below target ${input.sampleCount.toFixed(0)}/${thresholds.targetSampleCount}`);
    }
    if (typeof input.winRatePct === 'number' && input.winRatePct < thresholds.targetWinRatePct) {
        warnings.push(`win rate below target ${input.winRatePct.toFixed(1)}%/${thresholds.targetWinRatePct.toFixed(1)}%`);
    }
    if (typeof input.profitFactor === 'number' && input.profitFactor < thresholds.targetProfitFactor) {
        warnings.push(`PF below target ${input.profitFactor.toFixed(2)}/${thresholds.targetProfitFactor.toFixed(2)}`);
    }
    if (typeof input.netEdgeBps === 'number' && input.netEdgeBps < thresholds.targetNetEdgeBps) {
        warnings.push(`net edge below target ${input.netEdgeBps.toFixed(2)}bps/${thresholds.targetNetEdgeBps.toFixed(2)}bps`);
    }
    if (typeof input.confidencePct === 'number' && input.confidencePct < thresholds.targetConfidencePct) {
        warnings.push(`confidence below target ${input.confidencePct.toFixed(1)}%/${thresholds.targetConfidencePct.toFixed(1)}%`);
    }
    if (typeof input.drawdownPct === 'number' && input.drawdownPct > thresholds.maxDrawdownPct * 0.8) {
        warnings.push(`drawdown nearing the ceiling ${input.drawdownPct.toFixed(1)}%/${thresholds.maxDrawdownPct.toFixed(1)}%`);
    }
    const passed = blockers.length === 0 && ratioPct >= thresholds.minRatioPct;
    const grade = ratioPct >= 85 ? 'A' : ratioPct >= 75 ? 'B' : ratioPct >= 65 ? 'C' : ratioPct >= 55 ? 'D' : 'F';
    const statusText = passed ? 'pass' : 'hold';
    const blockerText = blockers.length > 0 ? `blocked by ${blockers.join('; ')}` : `clear above gate ${thresholds.minRatioPct.toFixed(1)}%`;
    const warningText = warnings.length > 0 ? `warnings: ${warnings.join('; ')}` : 'no material warnings';
    const summary = `${scopeLabel(input.scope)} KPI ratio ${ratioPct.toFixed(1)}% (${grade}) → ${statusText}; ${blockerText}; ${warningText}. ${metricLine(input)}`;
    return {
        scope: input.scope,
        passed,
        ratioPct,
        grade,
        blockers,
        warnings,
        summary,
        thresholds
    };
}
