# Phase G4 — Walk-Forward Validation Design

_Source: Phase R3 investigation, 2026-04-18._

## Goal

Block challenger promotion in `learning-loop.ts` until the proposed config clears a **purged expanding-window walk-forward** AND a **regime-stratified gate**. PLAN.md Priority 3 Items 7-9; live-canary prerequisite.

## Walk-Forward Harness

**Split pattern: expanding window with purge.**

- Train on `[0, T]`, validate on `[T, T + ΔT]`
- ΔT = 2 weeks of trading (≈ 2,000–3,000 trades)
- Run 4–5 folds per challenger before acceptance
- **Purge**: drop trades in the last 60 minutes of each training window whose exit overlaps the next validation window (prevents information leakage from overlapping holds)

## Regime-Stratified Gate

After walk-forward, report per-regime metrics in: `panic` / `trend` / `normal` / `compression` / `chop`.

Gate conditions:
- ≥ 30 trades per regime (or flag `insufficient data`)
- Positive expectancy in ≥ 3 of 5 regimes
- No single regime with expectancy < −2R

## Integration — pre-promotion gate in `learning-loop.ts`

```
evolveAgent() finds candidate
        ↓
runWalkForwardGate(candidate, symbol)        # NEW
        ↓ PASS
runRegimeGate(candidate, symbol)             # NEW
        ↓ PASS
comparePF(candidate, champion, ≥ 1.15)       # existing
        ↓ PASS
applyConfig(candidate)                       # existing
```

Any rejection produces a structured reason:

```typescript
interface WalkForwardRejection {
  stage: 'walk_forward' | 'regime_gate' | 'pf_comparison';
  reason: string;
  details: {
    foldsPassed?: number;
    minTradesPerRegime?: number;
    failingRegimes?: string[];
    candidatePF?: number;
    championPF?: number;
  };
}
```

## Implementation file list (order by dependency)

| # | File | Purpose |
|---|------|---------|
| 1 | `services/backtest/src/validation/purge.ts` | Purge logic: drop trades within buffer of val window |
| 2 | `services/backtest/src/validation/walk-forward.ts` | Expanding-window WF engine + fold aggregator |
| 3 | `services/backtest/src/validation/regime-stratification.ts` | Regime label assignment + gate thresholds |
| 4 | `scripts/run-walk-forward.ts` | CLI runner for manual validation |
| 5 | `services/api/src/learning-loop.ts` | Add gate calls before `applyConfig()` |
| 6 | `services/api/src/routes/validation.ts` | `GET /api/validation/challenger/:id` endpoint |

## Risk assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Historical data gaps (> 1 week in a regime) | Medium | Multi-source fallback; coarser TF; flag `insufficient data` |
| Regime classifier not backtest-ready | Medium | Rolling-vol + trend-strength heuristic for replay; live classifier for paper |
| Learning-loop bottleneck (WF + regime adds 30-60 s per eval) | Medium | Async background job; cache by `configHash`; re-run only on config change |
| Insufficient historical trades per regime | High | Bootstrap resample OR reduce threshold to 20 trades for 6-month history |
| Backtest/paper slippage mismatch (0.5× vs 0.25× spread) | Low | Use same slippage model; see `scripts/fill-parity.ts` |

## Build feasibility

1-week build, with caveat. Critical path is files 1-2 (purge + WF). Regime stratification (file 3) can build in parallel. Integration (files 5-6) depends on 1-3.
