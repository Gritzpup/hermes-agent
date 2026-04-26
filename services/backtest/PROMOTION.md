# Agent Promotion Gate — Phase 5 Backtest Harness

> **No phase ships to live capital until the backtest harness says so.**
> This document is the single source of truth for phase promotion criteria.

Reference: LiveTradeBench methodology (arxiv 2511.03628)

---

## The Rule

A phase may be promoted from **shadow** to **live** only when:

```
backtest P&L delta > 0          (at p < 0.05)
AND live-eval lane P&L > 0       (over 14 consecutive days)
AND no risk-engine regressions   (pre-trade rejections within ±5% of baseline)
```

If any criterion fails, the phase stays in shadow. Re-run after fixes.

---

## Phase Inventory & KPIs

| Phase | Components | KPI Claim | Verification |
|---|---|---|---|
| **Phase 0** | Tiered fees + concentration cap + Director context purge | Paper P&L within ±5% of baseline replay | `backtest:agents --variant=phase0` |
| **Phase 1** | TradingAgents 5-phase pipeline + 10-tool registry | Decision latency ≤ 2 min; allocation matches legacy ±1 weight | `backtest:agents --variant=phase1 --since=30` |
| **Phase 2** | FinGPT sentiment + Qdrant RAG + onchain | +3–5% win-rate uplift on sentiment-aligned entries | `backtest:agents --variant=phase2 --since=30` |
| **Phase 3** | FinRL-X shadow overlay | +8–15 bps slippage reduction on grid fills | `backtest:agents --variant=phase3 --since=30` |
| **Phase 4** | 4-tier router + 5 MCP servers | ~70–80% Opus token reduction | Manual audit of `model-router.ts` logs |
| **All** | Full stack | Net positive P&L at p<0.05 vs baseline | `backtest:agents --variant=all --since=90` |

---

## Promotion Checklist

For each phase, the operator must complete all steps before flipping from shadow to live:

### Pre-requisites (all phases)

- [ ] All unit tests pass: `pnpm check --workspace @hermes/backtest`
- [ ] All integration tests pass: `pnpm test` (vitest)
- [ ] No TypeScript errors: `npm run check --workspace @hermes/backtest`
- [ ] Dirty tree is clean: `git status` (no uncommitted changes)

### Backtest Gate

- [ ] Run smoke test: `HERMES_BACKTEST_SMOKE=1 pnpm backtest:agents --variant=<phase>`
  - Must complete in < 60 seconds
  - Must produce a report at `services/backtest/reports/`
- [ ] Run full replay: `pnpm backtest:agents --variant=<phase> --since=90`
  - P&L delta > $0 at p < 0.05 (bootstrap)
  - 95% CI lower bound > $0
  - R² ≥ 0.1 (phase contributions explain meaningful variance)
- [ ] Dominant phase is the one being promoted (not noise from other phases)
- [ ] Decision divergences are understood and intentional

### Live-Eval Lane Gate

- [ ] Start lane: `HERMES_LIVE_EVAL=on pnpm backtest:agents --variant=<phase> --live-eval`
- [ ] Confirm Redis keys being written: `redis-cli -p 16380 keys 'hermes:journal:live-eval:*'`
- [ ] After 14 days: compute live-eval P&L from `hermes:journal:live-eval:*` keys
  - Must be positive vs baseline
  - If negative: do not promote, investigate and re-run
- [ ] Live-eval lane stability: error count < 1% of decisions
- [ ] Redis TTL: confirm 30-day TTL is set on all `hermes:journal:live-eval:*` keys

### Operational Safety

- [ ] Rollback plan documented (feature flag `HERMES_AGENTS=monolith|pipeline`)
- [ ] Halt file pattern tested: `touch services/openclaw-hermes/.runtime/HALT`
- [ ] COO bridge health confirmed post-promotion: `curl http://localhost:4395/health`
- [ ] Paper-engine paper-desk shows expected positions

---

## Shadow vs Live Decision Tree

```
                    ┌─────────────────────┐
                    │  Phase X in shadow  │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Backtest P&L > 0   │
                    │  at p < 0.05?       │
                    └──┬──────────────┬───┘
                  NO  │              │ YES
                       │   ┌─────────▼─────────┐
                       │   │ Live-eval lane    │
                       │   │ running?          │
                       │   └────┬──────────────┘
                       │   NO   │ YES
                       │        │   ┌────────────▼──────────────┐
                       │        │   │ 14-day live-eval P&L > 0 │
                       │        │   └──────┬───────────────┬────┘
                       │        │     NO  │               │ YES
                       │        │          │               │
                       │        │   STAY IN SHADOW     PROMOTE
                       │        │                          │
                       │        │   ┌──────────────────────▼─┐
                       │        │   │ Flip HERMES_AGENTS=pipeline
                       │        │   │ Commit + push + notify
                       │        │   └──────────────────────┘
                       └──► FIX & RE-TEST
```

---

## Feature Flags

| Flag | Values | Effect |
|---|---|---|
| `HERMES_BACKTEST_SMOKE` | `0` \| `1` | Smoke vs full replay |
| `HERMES_LIVE_EVAL` | `on` \| `off` | Live-eval lane on/off |
| `HERMES_FEE_MODEL` | `v1` \| `v2` | Legacy vs tiered fee schedule |
| `HERMES_AGENTS` | `monolith` \| `pipeline` | Legacy COO vs TradingAgents pipeline |

---

## Report Locations

- Backtest reports: `services/backtest/reports/<timestamp>-<variant>.md`
- Attribution appended to each report
- Live-eval decisions: Redis `hermes:journal:live-eval:*` (TTL 30 days)
- Live-eval stats: Redis hash `hermes:journal:live-eval:stats`

---

## SHAP Attribution Interpretation

The backtest harness computes SHAP-style marginal attribution per phase:

- **Positive contribution**: phase is adding P&L vs baseline
- **Negative contribution**: phase is subtracting P&L vs baseline
- **Dominant phase**: phase with largest absolute contribution
- **R²**: fraction of P&L delta variance explained by phase attributions
  - R² < 0.1 suggests noise; interpret results with caution

If dominant phase is NOT the phase being promoted, investigate before proceeding.

---

## Emergency Rollback

If a promoted phase causes regressions:

```bash
# Immediate: halt all trading
touch services/openclaw-hermes/.runtime/HALT

# Revert feature flag
export HERMES_AGENTS=monolith

# Restart bridge
tilt trigger openclaw-hermes

# Investigate: read backtest report + live-eval journal
```

---

_Last reviewed: 2026-04-26 — Phase 5 backtest harness initial commit_
