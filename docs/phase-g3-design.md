# Phase G3: Exit-Reason Class Relabeling Pipeline

## Context
Phase J1/J2 revealed that triple-barrier labels are unusable: 99.4% censored (label=0). R-multiple labels fail for a maker-heavy corpus (79% maker-round-trips by design).

**Reframe**: Predict exit-reason class at entry time. Instead of "did this trade win?", ask "how will this trade end?"

---

## STEP 1: Label Distribution from journal.jsonl (4,649 trades)

| exitReason (raw) | Count | % | Mapped Class |
|---|---|---|---|
| maker-round-trip | 3,688 | 79.3% | `maker-normal` |
| undefined | 682 | 14.7% | `other` |
| reversion | 106 | 2.3% | `bad-exit` |
| inventory-release-under-pressure | 99 | 2.1% | `maker-normal` |
| stop-loss | 28 | 0.6% | `bad-exit` |
| broker reconciliation | 24 | 0.5% | **EXCLUDED** |
| external broker flatten | 8 | 0.2% | **EXCLUDED** |
| correlation-break | 8 | 0.2% | `bad-exit` |
| timeout | 3 | 0.06% | `forced-exit` |
| Alpaca paper order filled | 2 | 0.04% | **EXCLUDED** |
| coo-manual-flatten | 1 | 0.02% | **EXCLUDED** |

**Excluded (quarantined):** 35 trades (0.75%) — broker operations, not trade decisions.

**Trainable classes after mapping:**

| Class | Count | % of trainable |
|---|---|---|
| `maker-normal` | 3,787 | 82.1% |
| `other` | 682 | 14.8% |
| `bad-exit` | 142 | 3.1% |
| `forced-exit` | 3 | 0.06% |

⚠️ **Sample size concern**: `forced-exit` has only 3 samples (vs. minimum 30). This class should be merged into `other` or dropped for G3a.

---

## STEP 2: Entry-Time Schema Analysis

**Available entry-time fields:**

| Field | Type | Source | Leakage Risk |
|---|---|---|---|
| `symbol` | string | entryAt | None |
| `strategyId` | string | entryAt | None |
| `lane` | string | entryAt | None |
| `assetClass` | enum | symbol inference | None |
| `confidencePct` | number | entryAt | None |
| `regime` | string | entryAt | None |
| `newsBias` | string | entryAt | None |
| `orderFlowBias` | string | entryAt | None |
| `macroVeto` | boolean | entryAt | None |
| `embargoed` | boolean | entryAt | None |
| `spreadBps` | number | entryAt | None |
| `source` | enum | entryAt | None |
| `tags[]` | string[] | entryAt | None |
| `entryScore` | number | broker | None |
| `entryConfidencePct` | number | broker | None |
| `entryTrainedProbability` | number | NB model | None (pre-entry) |
| `entryApprove` | boolean | broker | None |
| `expectedNetEdgeBps` | number | broker | None |

**Derived features:**

- `entryHour`: hour-of-day from `entryAt` (categorical: 0-23 or binned)
- `spreadBucket`: micro/tight/normal/wide/extreme
- `confidenceBucket`: low/medium/high

**EXIT-time fields (DO NOT USE as features):** `exitAt`, `exitReason`, `realizedPnl`, `realizedPnlPct`, `holdTicks`, `verdict`

---

## STEP 3: Label Mapping Table

```
| exitReason pattern          | → Mapped Class    |
|-----------------------------|-------------------|
| /maker-round-trip/i         | maker-normal      |
| /inventory-release-under.*/i| maker-normal      |
| /stop-loss/i                | bad-exit          |
| /correlation-break/i        | bad-exit          |
| /reversion/i                | bad-exit          |
| /timeout/i                  | other (merge)     |
| /undefined/i                | other             |
| /broker reconciliation/i    | EXCLUDED          |
| /external broker flatten/i  | EXCLUDED          |
| /Alpaca paper order/i       | EXCLUDED          |
| /coo-manual-flatten/i      | EXCLUDED          |
| (other)                     | other             |
```

---

## STEP 4: Training Target

**Recommended: BINARY first** (`bad-exit` vs. rest)

- `1` = bad-exit (stop-loss, correlation-break, reversion)
- `0` = anything else (maker-normal, other)

| Class | Binary Label | Count |
|---|---|---|
| bad-exit | 1 | 142 |
| maker-normal | 0 | 3,787 |
| other | 0 | 682 |

**Rationale:** Simple, actionable. If P(bad-exit) > threshold → reject/skip trade.

**Multi-class** (for G3b if needed): Full 3-class or 4-class classification. Harder but more informative.

---

## STEP 5: Feature List (Entry-Time Only, No Leakage)

```
FEATURES = [
  # Identity
  symbol (one-hot or hash),
  strategyId (one-hot or hash),
  lane (categorical),
  assetClass (categorical),
  
  # Market context
  regime (categorical: normal/compression/trending/chop),
  spreadBps (numeric, binned),
  newsBias (categorical: bullish/bearish/neutral),
  orderFlowBias (categorical: bullish/bearish/neutral),
  
  # Entry quality signals
  confidencePct (numeric, binned),
  entryScore (numeric, binned),
  entryTrainedProbability (numeric, binned),
  entryApprove (boolean),
  expectedNetEdgeBps (numeric, binned),
  
  # Risk gates
  macroVeto (boolean),
  embargoed (boolean),
  
  # Context
  source (broker/simulated),
  entryHour (hour-of-day),
  
  # Tags (binary flags for key tags)
  'session-america', 'session-asia', 'session-london',
  'dir-long', 'dir-short',
  'intel-weak', 'intel-strong'
]
```

**Total: ~25-30 features after one-hot encoding.**

---

## STEP 6: Training Split (Walk-Forward)

**Strategy: Expanding window, 60/20/20**

```
All trades sorted by entryAt:
├── Train (oldest 60%) ──────────────┼─── Validate (next 20%) ──── Test (newest 20%)
2026-04-14                          │                          2026-04-17
                                   ▲
                              retrain point
```

- **Train**: 60% oldest trades (≥2,791 trades)
- **Validate**: next 20% (929 trades)
- **Test**: newest 20% (929 trades)
- **Retrain frequency**: monthly or when test accuracy degrades >5%

**Minimum samples for binary training:** 142 bad-exit + ~400 random non-bad-exit = 542 trades ✓

---

## Implementation Plan (G3a File List)

| # | File | Action | Purpose |
|---|---|---|---|
| 1 | `services/backtest/src/meta-label/relabel-from-journal.ts` | **NEW** | Maps journal.jsonl → exit-reason classes, outputs `exit-reason-labels.jsonl` |
| 2 | `services/backtest/src/meta-label/exit-reason-classifier.ts` | **NEW** | Trains binary classifier (bad-exit predictor), outputs model to JSON |
| 3 | `scripts/train-exit-reason-classifier.ts` | **NEW** | One-shot trainer script (reads journal → trains → saves model) |
| 4 | `services/api/src/services/meta-label-model.ts` | **KEEP** (swap internals) | Keep existing interface, replace with exit-reason model |

**Dependency order:** 1 → 2 → 3 → 4

---

## GO/NO-GO for G3a Implementation

| Criterion | Status | Notes |
|---|---|---|
| bad-exit samples ≥ 30 | ✅ PASS | 142 samples |
| Total trainable samples ≥ 300 | ✅ PASS | 4,611 (excl. quarantined) |
| Entry-time features available | ✅ PASS | 25+ features identified |
| Binary target viable | ✅ PASS | 3.1% positive rate (imbalanced but workable) |
| Forced-exit class ≥ 30 | ❌ FAIL | Only 3 samples → merge into `other` |
| maker-normal class ≥ 30 | ✅ PASS | 3,787 samples |

**GO/NO-GO: ✅ GO (with fix: merge forced-exit into other)**

---

## Deliverables for G3a

1. **Output file**: `services/api/.runtime/paper-ledger/exit-reason-labels.jsonl`
   - One JSON per trade: `{ entryAt, symbol, strategyId, features: {...}, exitReasonClass: "maker-normal"|"bad-exit"|"other" }`

2. **Model file**: `services/api/.runtime/paper-ledger/exit-reason-model.json`
   - Weights, feature names, class priors, validation metrics

3. **Metrics to track**:
   - Test accuracy (binary: bad-exit vs rest)
   - Precision@0.5 threshold for bad-exit
   - Recall@0.5 threshold for bad-exit
   - AUC-ROC
