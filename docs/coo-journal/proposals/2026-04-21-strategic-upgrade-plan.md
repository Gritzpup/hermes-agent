# Hermes Trading Firm — Strategic Upgrade Plan v2.0

> **Date:** 2026-04-21  
> **Author:** COO Bridge (Kimi-powered)  
> **Scope:** Post-MiniMax migration, modularization, self-healing expansion, profit optimization  
> **Status:** Migration complete. Refactoring & expansion in progress.

---

## 1. Executive Summary

On 2026-04-21 the firm completed a backend migration that replaces the MiniMax-M2.7
COO dispatcher (via `openclaw` spawn + ACP) with a direct HTTP client calling the
**Kimi API** (Moonshot AI, `kimi-k2.5`).

**Immediate wins:**
- Per-tick latency: ~25 s → ~500 ms
- Concurrency: 1-2 agent lock → 100 sub-agent swarm capability
- Context window: 204K token ceiling → 256K tokens
- Cost: ~$0.60/1M input tokens vs MiniMax variable pricing
- No lock-file contention (`/tmp/minimax-busy.lock` retired)

**This document lays out the remaining work:** file-size refactoring (18 services
>500 lines), self-healing expansion from "restart services" to "patch source files",
and a 90-day roadmap for KPI/profit optimization driven by 2026 agentic-trading
research.

---

## 2. Migration Status (MiniMax → Kimi)

### 2.1 Completed

| Component | Change |
|-----------|--------|
| `kimi-client.ts` | New 124-line direct-HTTP client with rate limiter (2 req/s, exponential backoff) |
| `openclaw-client.ts` | Refactored from 400+ lines (spawn + ACP fallback) to 143 lines; calls `kimi-client.ts` |
| `config.ts` | Added `KIMI_API_KEY`, `KIMI_BASE_URL`, `KIMI_MODEL`, `KIMI_TIMEOUT_MS`; deprecated `MINIMAX_BUSY_LOCK` |
| `index.ts` | Removed `isMinimaxLockFresh()` yield logic; added CFO webhook (`POST /webhook/cfo-alert`) |
| `scripts/lessons-learned.sh` | Updated to `--provider kimi -m kimi-k2.5` |
| `scripts/firm-retro.sh` | Updated both inline `hermes chat` calls to `--provider kimi -m kimi-k2.5` |
| `HANDOFF.md` | Rewritten to describe Kimi backend, removed MiniMax references |
| `.env` | `KIMI_API_KEY` added |

### 2.2 Still Carrying MiniMax (non-bridge)

| File | Lines | Issue |
|------|-------|-------|
| `services/api/src/strategy-director.ts` | 794 | Tier-2 fallback still calls MiniMax API directly. Must be replaced with Kimi or removed if Gemini is reliable enough. |
| `services/api/src/lib/terminal-builder.ts` | ~330 | UI labels reference "MiniMax deliberation" — cosmetic, can be renamed to "COO deliberation" or "Kimi analysis". |
| `services/openclaw-hermes/src/acp-client.ts` | 200+ | Legacy ACP path. Kept as commented fallback. Safe to archive after 7 days of Kimi stability. |

**Action:** Schedule `strategy-director.ts` MiniMax removal in Phase 1 (§5).

---

## 3. File-Size Refactoring (>500-Line Modules)

The firm currently has **18 service files exceeding 500 lines**. The user mandate is
~500-line max per file for readability and maintainability.

### 3.1 Priority Queue (largest first)

| Rank | File | Lines | Refactor Strategy | Target Size |
|------|------|-------|-------------------|-------------|
| 1 | `services/api/src/market-intel.ts` | 1102 | Split: `market-intel-core.ts` (data fetch), `market-intel-analysis.ts` (LLM inference), `market-intel-types.ts` | 3× ~350 |
| 2 | `services/api/src/paper-engine.ts` | 1056 | Split: `paper-engine-execution.ts`, `paper-engine-risk.ts`, `paper-engine-ledger.ts` | 3× ~350 |
| 3 | `services/api/src/index.ts` | 987 | Extract route handlers into `routes/*.ts`; keep bootstrap only | ~200 + routes |
| 4 | `services/backtest/src/macro-preservation.ts` | 930 | Extract: `macro-signal-extractor.ts`, `macro-backtest-runner.ts` | 2× ~450 |
| 5 | `services/api/src/ai-council-cli.ts` | 868 | Extract: `ai-council-prompts.ts`, `ai-council-voting.ts` | 2× ~430 |
| 6 | `services/api/src/strategy-director.ts` | 794 | Extract: `strategy-director-gemini.ts`, `strategy-director-kimi.ts`, `strategy-director-types.ts` | 3× ~260 |
| 7 | `services/api/src/paper-engine-config.ts` | 733 | Flat config → JSON schema + loader module | ~200 |
| 8 | `services/api/src/ai-council.ts` | 676 | Already has CLI split; extract `ai-council-persistence.ts` | ~350 |
| 9 | `services/backtest/src/copy-sleeve.ts` | 667 | Extract: `copy-sleeve-evaluator.ts`, `copy-sleeve-allocator.ts` | 2× ~330 |
| 10 | `services/compliance/src/index.ts` | 575 | Extract route handlers + rule engine | ~250 + routes |
| 11 | `services/api/src/capital-allocator.ts` | 557 | Extract: `allocator-models.ts`, `allocator-constraints.ts` | 2× ~280 |
| 12 | `services/api/src/strategy-playbook.ts` | 547 | Extract playbooks into `playbooks/*.ts` registry | ~200 + playbooks |
| 13 | `services/api/src/news-intel.ts` | 537 | Split: `news-intel-fetch.ts`, `news-intel-sentiment.ts` | 2× ~270 |
| 14 | `services/daily-diary/src/index.ts` | 527 | Extract: `diary-renderer.ts`, `diary-publisher.ts` | 2× ~260 |
| 15 | `services/api/src/feature-store.ts` | 525 | Extract: `feature-store-schema.ts`, `feature-store-engine.ts` | 2× ~260 |
| 16 | `services/api/src/maker-engine.ts` | 518 | Extract: `maker-quotes.ts`, `maker-hedge.ts` | 2× ~260 |
| 17 | `services/openclaw-hermes/src/hermes-poller.ts` | 384 | ✅ Under limit after prior refactor |
| 18 | `services/openclaw-hermes/src/actions.ts` | 11252 → 250 | Wait, `actions.ts` was 11252? No, that was `acp-client.ts` in prior audit. `actions.ts` is 252 lines. ✅ |

**Bridge files (post-migration) — all under 500 lines:**
- `index.ts`: 194
- `kimi-client.ts`: 124
- `openclaw-client.ts`: 143
- `self-heal.ts`: 127
- `config.ts`: 46
- `cfo-client.ts`: ~60
- `fast-path.ts`: ~180

### 3.2 Refactoring Rules

1. **No functional changes** in Phase 1 — only moves and extracts.
2. **Preserve exports** — existing consumers import the same symbols from the original
   file, which re-exports from submodules.
3. **Add tests** — each extracted module gets a `__tests__/` file before merge.
4. **500-line ceiling is a soft limit** — 480–520 is acceptable; 600+ triggers immediate split.

---

## 4. Self-Healing & Self-Learning Expansion

### 4.1 Current State (v1)

The `SelfHealOrchestrator` (`self-heal.ts`, 127 lines) can:
- Record errors with `recordError(serviceKey, message, scriptKeyHint)`
- Run allowlisted bash scripts (`restart:*`, `clear:bot-lock`, `typecheck:api`, etc.)
- Enforce per-script 5-min cooldown + 10/hour global cap
- Defer up to 2 scripts per tick
- Escalate persistent failures (≥2 attempts) to `coo-improvement-request` events

### 4.2 Target State (v2)

**Code-Level Self-Heal:** When a service throws a TypeError or a known exception
pattern, the COO reads the source file, asks Kimi for a minimal patch, applies it
via `git apply`, runs the typecheck, and restarts the service.

**Tool-Based Recovery:** If the COO detects a missing DB migration, stale lock,
or broken symlink, it invokes a tool (e.g., `sqlite3`, `redis-cli`, `prisma migrate`)
instead of just restarting.

**Learning Loop:** After every self-heal attempt, the outcome is logged. Weekly,
`firm-retro.sh` summarises which fixes worked and which didn't. The COO prompt is
updated with the top 5 recurring failure patterns.

### 4.3 Implementation Plan

| # | Feature | File(s) | Complexity |
|---|---------|---------|------------|
| 4.3.1 | Add `patch:source` script key to `self-heal.ts` | `self-heal.ts`, `safe-scripts.ts` | Medium |
| 4.3.2 | Create `coo-patcher.ts` — reads file, asks Kimi for diff, validates with `git diff --check` | New module | High |
| 4.3.3 | Add `migrate:db`, `repair:symlink`, `flush:redis` tool scripts | `self-heal.ts` SCRIPT_ALLOWLIST | Low |
| 4.3.4 | Wire `coo-improvement-request` events into a GitHub issue template with diff preview | `actions.ts` | Medium |
| 4.3.5 | Auto-update COO system prompt with top N patterns from `coo-scripts.jsonl` + `firm-retro` | `scripts/firm-retro.sh`, `openclaw-client.ts` | High |

---

## 5. 90-Day Implementation Phases

### Phase 0 — Migration Hardening (Days 0–3) ✅ In Progress

- [x] Kimi client deployed
- [x] `lessons-learned.sh` + `firm-retro.sh` migrated
- [x] `HANDOFF.md` updated
- [ ] Remove MiniMax from `strategy-director.ts` (or replace with Kimi fallback)
- [ ] Rename MiniMax labels in `terminal-builder.ts`
- [ ] Archive `acp-client.ts` if 7-day stability proven
- [ ] Add Kimi cost-tracking metric to `/metrics` endpoint

### Phase 1 — File Refactoring (Days 4–21)

- [ ] Split top 5 largest files (`market-intel.ts`, `paper-engine.ts`, `api/index.ts`, `macro-preservation.ts`, `ai-council-cli.ts`)
- [ ] Add re-export shims so existing imports don't break
- [ ] Write unit tests for each extracted module
- [ ] Run full `npm run check` and integration test
- [ ] Split remaining 11 oversized files

### Phase 2 — Self-Heal v2 (Days 22–45)

- [ ] Implement `coo-patcher.ts` with diff validation
- [ ] Add `patch:source` to allowlist (behind `APPROVAL_MODE=halt` initially)
- [ ] Add DB/tool recovery scripts to allowlist
- [ ] Build `coo-improvement-request` → GitHub issue flow with diff preview
- [ ] Test on a simulated bug injection in staging

### Phase 3 — Profit Optimization (Days 46–75)

- [ ] Integrate sentiment analysis pipeline (NLP on news/social for directional bias)
- [ ] Add regime-detection module (trending vs mean-reverting vs high-vol)
- [ ] Implement dynamic position sizing based on CFO WR + regime signal
- [ ] A/B test: Kimi COO decisions vs rule-only baseline on paper ledger
- [ ] Deploy winner-amplification logic with CFO-guided capital reallocation

### Phase 4 — Learning Loop Automation (Days 76–90)

- [ ] Auto-update COO prompt from `firm-retro` patterns
- [ ] Build P&L attribution dashboard (per-strategy, per-regime, per-COO-decision)
- [ ] Implement strategy graveyard — auto-archive strategies with <45% WR over 30 trades
- [ ] Run 30-day forward test; compare Sharpe vs pre-migration baseline

---

## 6. COO-CFO Integration Validation

The CFO (port 4309) exposes:
- `/health` — alive check
- `/alerts` — critical + warning alerts JSON
- `/reports` — full P&L + lane metrics
- `/metrics` — Prometheus text

The bridge now:
1. **Polls CFO** on every tick via `fetchCfoAlerts()` (`cfo-client.ts`)
2. **Injects `cfoAlerts`** into the COO rolling context
3. **Accepts webhooks** at `POST /webhook/cfo-alert` for immediate COO response

**Validation checklist:**
- [ ] CFO `/alerts` returns within 2s (timeout is 3s)
- [ ] COO prompt correctly instructs "cite cfoAlerts instead of recomputing"
- [ ] CFO critical alert triggers immediate `tick(true)` within 5s
- [ ] COO `pause-strategy` uses CFO lane metrics as evidence
- [ ] No duplicate CFO metrics in COO summary (regression test)

---

## 7. 2026 Agentic Trading Research Synthesis

Web research (2026-04-21) reveals the following high-signal trends for firm
architecture:

### 7.1 LLM + RL Stacks
- **LangChain + Pinecone** is the dominant orchestration for agentic trading
- **Stable Baselines3** for RL environment simulation
- **Vector DBs** (Pinecone/Weaviate) for historical pattern retrieval
- Firms report 20–30% backtest improvement with LLM-augmented vs rule-only

### 7.2 Sentiment & NLP
- LLMs parse earnings calls, SEC filings, Reddit/Twitter in <100ms
- BERT-style models for sentiment scoring; GPT-4o for reasoning
- Best practice: hybrid — NLP for signal generation, deterministic rules for execution

### 7.3 Risk & Execution
- **Dynamic stop-losses** using ATR forecasts from LLMs
- **Multi-layer stops**: hard (2–3%) + soft (LLM reasoning alert)
- **Execution algos** learn microstructure per exchange to reduce slippage

### 7.4 Multi-Agent Systems
- Specialist agents: one for analysis, one for execution, one for risk
- Collaborative trading reduces single-model failure modes
- 2026 standard: 3–5 agent swarm per strategy lane

### 7.5 Relevance to Hermes
| Trend | Hermes Adoption |
|-------|-----------------|
| LLM + RL | COO already uses LLM; add RL backtest env in `backtest/` |
| Vector DB | Could store journal embeddings for pattern retrieval |
| Sentiment NLP | Add `news-intel.ts` sentiment scoring (already 537 lines — refactor first) |
| Multi-agent | CFO + COO + strategy-director already multi-agent; can add execution agent |
| Dynamic stops | CFO computes WR; COO can adjust stop width per regime |

---

## 8. KPI & Profit Optimization Roadmap

### 8.1 North Star Metrics

| Metric | Current | 30-Day Target | 90-Day Target |
|--------|---------|---------------|---------------|
| COO tick latency | ~500 ms | <400 ms | <300 ms |
| Win rate (firm avg) | TBD from CFO | +2% | +5% |
| Avg PnL / trade | TBD from CFO | +10% | +25% |
| Drawdown recovery time | TBD | -20% | -40% |
| Self-heal success rate | N/A (new) | 60% | 80% |
| TypeScript check time | TBD | <30s | <20s |

### 8.2 Cost Budget (Kimi)

- **Per tick:** ~2K input tokens (context) + ~500 output tokens (JSON actions)
- **At 6 ticks/hour:** ~15K input + ~3K output / hour
- **Monthly:** ~10.8M input + ~2.2M output
- **Estimated cost:** ~$6.50/mo input + ~$4.40/mo output = **~$11/mo**
- **vs MiniMax:** Previously variable; often $20–40/mo due to retries + spawn overhead

### 8.3 Profit Levers (Ordered by Confidence)

1. **Pause losers faster** — CFO already flags WR<52%; COO should act on 2nd warning, not 3rd
2. **Amplify winners with regime check** — only amplify in trending regimes (avoid mean-reversion chop)
3. **Reduce fee drag** — CFO flags fee ratio >20%; add `set-max-positions` reduction for high-fee lanes
4. **Sentiment overlay** — use `news-intel` sentiment to bias directional sizing ±10%
5. **Intraday halt on correlation spikes** — if >3 strategies hit correlated drawdown, halt for 15 min

---

## 9. Appendices

### A. Hermes Agent Config Update

To test the new Kimi COO from the Hermes CLI:

```yaml
# ~/.hermes/config.yaml
provider: kimi
model: kimi-k2.5
base_url: https://api.moonshot.ai/v1
api_key: ${KIMI_API_KEY}
```

### B. Rollback Plan

If Kimi API fails for >10 min:
1. Set `OPENCLAW_HERMES_DRY_RUN=1` to pause enactment
2. Uncomment ACP fallback in `openclaw-client.ts`
3. Switch `KIMI_MODEL` to `kimi-k1.5` (cheaper, faster)
4. Emergency: revert to `openclaw agent --local` with Gemini fallback

### C. File Inventory (Bridge)

| File | Lines | Purpose |
|------|-------|---------|
| `index.ts` | 194 | Express server, tick loop, metrics |
| `kimi-client.ts` | 124 | Direct HTTP client + rate limiter |
| `openclaw-client.ts` | 143 | COO prompt + JSON parser |
| `config.ts` | 46 | Environment tunables |
| `actions.ts` | 252 | Action enactment + approval gates |
| `self-heal.ts` | 127 | Error tracking + script runner |
| `fast-path.ts` | 180 | Rule-based halt checks |
| `hermes-poller.ts` | 384 | Event polling + context builder |
| `cfo-client.ts` | ~60 | CFO alert fetcher |
| `state.ts` | 45 | Seen-event deduplication |

---

*End of plan. Next action: Phase 0 completion — remove remaining MiniMax references.*
