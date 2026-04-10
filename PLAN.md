# Hermes Trading Firm — Master Modernization Plan

_Last updated: 2026-04-08_

## Mission

Drive Hermes toward the highest possible **real** win rate and expectancy by:

1. Trading less often, but with much higher precision
2. Favoring market-neutral, hedged, and maker-style strategies over naked directional guessing
3. Building a real self-learning loop with promotion, probation, rollback, and auditability
4. Adding news, macro, and order-book intelligence so the stack stops trading blind
5. Keeping research, paper, and eventual live execution aligned enough to trust improvements

## Reality Constraint

A literal 100% win rate is not realistic for live or paper directional trading.

The closest practical path is:
- fewer trades
- stronger veto systems
- market-neutral strategies
- maker-first execution where possible
- hard event/news embargoes
- aggressive rollback of degrading configs

That is the operating philosophy behind this plan.

## Capital Deployment Program

This is the part of the plan that turns Hermes from a research stack into a capital engine.

Important: no system can guarantee profit "no matter what". The real goal is to deploy actual money only when the after-cost edge is positive, the regime matches the sleeve, and the live execution path is proven.

### Rules
- Cash / T-bills are a valid allocation and the default when no sleeve has edge.
- A sleeve only gets live capital if it clears out-of-sample, after-cost, regime-stratified gates.
- Live size starts tiny and scales only on stable forward metrics.
- If a sleeve's edge disappears, it is de-risked back to cash.
- No forced trades.

### Sleeve roles
- Scalping / maker: intraday edge capture with fill-model and adverse-selection control.
- Pairs / grid: market-neutral or range-capture with carry / borrow / financing fully modeled.
- Copy sleeve: delayed public-manager replication only.
- Macro preservation: inflation defense using real assets when CPI and rates justify it.
- Cash / T-bills: capital preservation when nothing qualifies.

### Hard gates before live size
- positive net expectancy after fees, slippage, spread, carry, and borrow
- walk-forward stability across multiple regimes
- drawdown within budget
- execution parity within model tolerance
- no unresolved data gaps or lookahead contamination

---

## Current System Status

### Overall status
- **Architecture state:** substantially modernized, still incomplete
- **Paper stack:** running
- **Backtest / evolution stack:** running
- **News layer:** first working version live
- **Coinbase crypto tape:** public WebSocket + L2 is now primary
- **Learning loop:** hot-apply exists with challenger probation and rollback MVP
- **Risk posture:** intentionally conservative under hostile macro/news conditions

### What is already true now
- Coinbase **public** WebSocket market data works without a paid Pro subscription
- Hermes now uses Coinbase public `ticker` + `l2_data` as the primary crypto market-data path
- crypto order-flow signals are driven by live L2 depth and not just REST snapshots
- news and macro vetoes can block entries
- challenger configs can be promoted, run on probation, and roll back automatically
- a bandit-style allocation layer can reduce or increase position sizing by agent
- events are now logged for replay/audit instead of being purely ephemeral

---

## Execution Checklist

## Completed
- [x] Audit the existing Hermes architecture and identify the highest-value modernization gaps
- [x] Research state-of-the-art open-source references:
  - Hummingbot
  - Freqtrade
  - NautilusTrader
  - VectorBT
  - FinGPT
  - FinRL-X
  - OpenBB
- [x] Build cross-asset signal bus
- [x] Build market intelligence module:
  - order flow
  - fear/greed
  - Bollinger logic
  - VWAP logic
- [x] Build initial pairs engine
- [x] Upgrade pairs engine into dynamic hedge-ratio / correlation-aware spread logic
- [x] Build initial grid engines
- [x] Build backtest service
- [x] Build delayed public-manager copy-sleeve MVP using SEC 13F filing snapshots (Berkshire Hathaway initial manager), including API proxy endpoints and quarter backtest support
- [x] Build strategy-lab / evolutionary optimizer
- [x] Add learning-loop framework
- [x] Close the learning-loop stub so promotions hot-apply into paper-engine runtime config overlays
- [x] Add local untracked API-key config for external providers via repo `.env`
- [x] Build multi-source news intelligence module with:
  - source trust scoring
  - bias scoring
  - macro vs symbol-level classification
  - veto logic
- [x] Expose news intelligence via API
- [x] Feed news context into AI council review
- [x] Gate paper-engine entries on symbol-specific and macro news vetoes
- [x] Make Coinbase public WebSocket + L2 the **primary** crypto market-data path
- [x] Expose market-data microstructure endpoint
- [x] Feed microstructure back into market intelligence
- [x] Add deeper public microstructure primitives:
  - queue imbalance
  - trade imbalance
  - book slope
  - microprice
  - spread-duration / quote-stability timing
  - cancel-to-add style pressure proxy via rolling book deltas
- [x] Add challenger probation + rollback MVP
- [x] Add bandit-style capital allocation MVP
- [x] Add deterministic event log plus replay-event endpoint
- [x] Add replay reconstruction endpoint with state/config/allocation timeline recovery
- [x] Add basic review-loop clustering and replay summaries
- [x] Add richer review metadata plumbing into journals:
  - lane
  - regime
  - news bias
  - order-flow bias
  - embargo state
  - confidence / latency / hold context
- [x] Add sidecar strategy control plane for pairs/grid/maker:
  - risk-driven lane blocking
  - lane allocation multipliers
  - replayable strategy-state logging
  - visible `/api/strategy-controls`
- [x] Add lane-learning audit loop for non-scalping lanes:
  - posterior-win-rate scoring
  - profitability / expectancy scoring
  - allocation recommendations
  - quarantine / de-risk / promote decisions
  - visible `/api/lane-learning`
- [x] Add macro + earnings embargo windows MVP
- [x] Add first maker-first crypto execution support:
  - post-only routing support in broker-router
- [x] Add maker quote-engine MVP in API:
  - inventory tracking
  - quote-width adaptation
  - adverse-selection pausing
  - maker round-trip journaling
  - visible via `/api/maker` and `/api/strategies`
- [x] Add maker order-execution scaffolding:
  - shadow quote intent management
  - optional live routing env gate
  - quote refresh thresholds
  - broker cancel endpoint groundwork
  - maker order-state persistence + broker order/fill reconciliation scaffolding
  - external-fill handoff into maker inventory/PnL engine
  - canary rollout policy endpoint / symbol caps / quote-notional caps
  - maker readiness endpoint for live canary preflight
  - visible via `/api/maker/orders`
- [x] Unify one important config drift issue (`maxTradeNotional` now aligned at `$5,000`)
- [x] Surface pairs + grid as first-class lanes in `/api/strategies`
- [x] Add contextual meta-label trade acceptance filter MVP
  - heuristic + journal-conditioned posterior blend
  - replay-visible meta-label state
  - visible `/api/meta-labels`
- [x] Add first trained statistical meta-label model MVP
  - Bernoulli naive-Bayes classifier trained on scalping journal outcomes
  - walk-forward validation snapshot
  - token-edge inspection
  - visible `/api/meta-model`
- [x] Capture entry-time meta-label context on positions and feed it into journaling / training
  - position entry metadata now persists on open positions and broker fills
  - exit journals inherit entry probabilities, reason, regime, news bias, flow bias, macro veto, embargo state, and tags
  - meta-label tokens now learn from entry-time conditions instead of only exit-time outcomes
  - review-loop loss clustering now prefers entry-time regime/news/flow/embargo labels when available
- [x] Add precision-first symbol/asset-class performance gating to paper entries
  - broker-paper scalps now block low-performing symbols by recent realized win rate / PF / expectancy
  - asset-class-aware recent-performance blocks now keep the model from re-learning obvious losers
  - journal and review logs now record asset class for better cross-asset diagnostics
- [x] Add fee-aware routing and auto-switching for scalpers
  - scalper selection now ranks routes by estimated gross edge minus spread/fee/slippage/carry cost
  - only the best positive-net scalper per asset class stays armed
  - route snapshots are exposed via `/api/opportunities`
  - bond/forex candidates are visible in the route planner even when execution is still staged
- [x] Add delayed public-manager copy sleeve plumbing
  - Berkshire Hathaway 13F filings are parsed from SEC atom/XML feeds
  - copy sleeve portfolio snapshots and quarter backtests are exposed through the backtest service and API
  - the web dashboard now shows a real copy-sleeve panel and a dedicated `/copy-sleeve` view, with explicit unavailable states instead of fake values
  - the first completed-quarter simulation showed the sleeve losing about 2.2% on $100k while still beating SPY over the same window
- [x] Add a macro-preservation sleeve for inflation shocks
  - released CPI now gates a cash-first rotation into GLD / SLV / USO / DBC with BIL as fallback
  - macro snapshot and backtest endpoints are exposed through the backtest service and API
  - the web dashboard now shows a real macro-preservation panel and a dedicated `/macro-preservation` view
  - the long-horizon simulation uses released CPI data and ETF historical prices with a Yahoo fallback when Alpaca bars are unavailable
- [x] Build a unified capital allocation snapshot and dashboard
  - live sleeve scoring now considers scalping across crypto/equity/commodity-proxy/forex/bond, plus pairs, grid, maker, copy, macro, and cash
  - forex and bond are visible in the allocator but remain staged until venue parity / live gates are crossed
  - the allocator is now exposed via `/api/capital-allocation` and shown on the web dashboard plus `/capital-allocation`
  - KPI ratio gates now score agent readiness and sleeve allocation so low-quality sleeves stay in cash
- [x] Activate guarded local BTC-only live maker canary
  - live routing can be toggled from local gitignored `.env`, but is currently disabled until paper win rate clears the 90% gate
  - quote notional capped at `$25`
  - maker order rejections now enter cooldown / credential block instead of retry-spamming
  - broker-router now supports separate trading-scoped Coinbase credentials via env override
  - new trading-scoped Coinbase key verified: scope issue is resolved
  - current live blocker is account funding (`BTC-USD` maker bid needs USD balance; available USD is `0`)

## Partially Complete / MVP only
- [~] Pairs strategy exists and is visible as a strategy lane, but is not yet routed end-to-end through broker / review / learning the same way scalpers are
- [~] Grid strategies exist and are visible as strategy lanes, but are still sidecar engines instead of full broker-backed strategy lanes
- [~] Event replay exists as event logging + replay endpoint, but not yet exact deterministic decision re-simulation
- [~] Challenger deployment exists, but validation logic is still lightweight
- [~] Maker-first support exists at the order-routing layer, but not yet as a full market-making engine
- [~] Review clustering exists, but still lacks deep regime-aware diagnosis
- [~] Meta-labeling now blends heuristics, contextual posterior, and a first trained statistical classifier, but it is still not a full triple-barrier production model

## Remaining High-Value Work
- [~] Wire the unified capital allocator into a live rebalance/execution path (not just snapshot/reporting).
- [ ] Upgrade validation to purged walk-forward, triple-barrier, and regime-stratified gates before live capital scales.
- [~] Promote pairs/grid into first-class broker/risk/review/learning lanes end-to-end
  - now includes lane controls, risk-driven blocking, journal coverage, and replayable state logging
  - still not broker-backed execution lanes
- [~] Upgrade event replay into exact re-simulation of decisions, signals, and config state transitions
  - now reconstructs tick/agent/strategy/config/allocation state from the event log
  - still not a full deterministic re-execution of strategy logic from raw inputs alone
- [~] Expand review clustering with richer metadata:
  - regime
  - spread bucket
  - latency bucket
  - news state
  - order-flow state
  - embargo state
- [~] Expand market intelligence with deeper microstructure features beyond the current set:
  - adverse-selection metrics
  - spread-duration metrics
  - cancel-to-add style pressure metrics
  - deeper use of trade-sign imbalance in actual entry models
- [ ] Upgrade challenger logic with stricter acceptance / rollback metrics
- [~] Extend maker-first execution into a real quoting engine with:
  - inventory skew
  - quote width adaptation
  - adverse-selection filters
  - maker/taker switching
- [~] Build full market-making strategy lane on Coinbase crypto
  - a simulated maker lane now exists in API and replay/review paths
  - shadow/live order-management scaffolding now exists
  - broker order/fill reconciliation handoff now exists
  - guarded live BTC canary is enabled locally
  - current legacy Coinbase key from `project-sanctuary/hermes-trading-post` can read account/order state
  - separate trading-scoped key support is now live and working
  - live maker routing is now blocked by funding, not permissions (`BTC-USD` requires USD source balance)
  - broker-backed quote placement and fill reconciliation are still not fully proven in live routing because no live funded order has been allowed to rest/fill yet
- [~] Move heuristic meta-labeling toward proper triple-barrier labeling + trained acceptance model
  - first trained statistical classifier now exists
  - still missing triple-barrier labels, richer entry-feature capture, and stronger walk-forward challenger gating
- [~] Expand the copy sleeve beyond the Berkshire initial manager
  - need multi-manager support, better ticker resolution, and explicit delayed-public-copy sizing rules
- [ ] Add richer regime classifier:
  - trend
  - chop
  - panic/liquidation
  - event-driven volatility
  - mean-reverting compression
  - macro corroborators like real yields, breakevens, credit spreads, and recession stress
- [ ] Add better calendar coverage for macro events beyond current news-driven embargoes and FMP earnings windows
- [ ] Replace the fixed mid-month CPI availability approximation with the actual BLS release calendar in macro-preservation
- [~] Add full review and learning support for non-scalping lanes
  - review coverage, adaptive lane allocation, and lane-learning audit decisions now exist
  - strategy-lab/backtest-driven evolution for pairs/grid/maker is still missing
- [~] Replace hardcoded readiness `overallEligible: false` with a real promotion-policy computation and explicit live/candidate states
- [ ] Add firm-level data-health gating so stale market-data/news/calendar/broker feeds can reduce or zero capital deployment
- [ ] Make `/api/health` and market-data health source-sensitive so one live venue cannot hide a stale crypto tape
- [ ] Add explicit freshness / stale-age fields to market-data, market-intel, news-intel, and event-calendar snapshots so the allocator can see when the data is old
- [ ] Make snapshot timestamps reflect last successful refresh instead of call-time so stale data cannot look current
- [ ] Add explicit per-symbol freshness / source health into the market-data snapshot and allocator inputs so one good venue cannot mask stale symbols
- [x] Mark market-data snapshots delayed/stale when they fall back to REST or missing quotes instead of always reporting live
- [~] Expand service-health coverage to include backtest, strategy-lab, news-intel, event-calendar, and market-intel so data-health gating sees the full stack
  - backtest and strategy-lab are now included in `/api/health`
  - news-intel, event-calendar, and market-intel still need freshness-aware internal health surfaced explicitly
- [ ] Add jitter/backoff/circuit-breakers to fixed-interval background pollers so feed outages do not cause synchronized retry storms
- [x] Add explicit fetch timeouts/cancellation to market-data provider calls so one hung Alpaca/Coinbase/OANDA request cannot stall the refresh cycle
- [x] Add explicit fetch timeouts/cancellation to paper-engine and maker-executor broker-router calls so live control paths cannot hang on broker stalls
- [x] Add single-flight guards and explicit fetch timeouts to news-intel and event-calendar refresh loops so slow upstreams do not stall the whole cycle
- [x] Quarantine or disable news providers that keep returning 401/403 instead of retrying them forever
- [ ] Make news source trust adaptive from realized predictive lift instead of a static domain map
- [x] Parallelize or single-flight market-intel orderbook polling so a slow symbol cannot stall the whole 3s sweep
- [ ] Add heartbeat / stale-socket reconnect with exponential backoff and jitter to the Coinbase WebSocket feed so silent stalls recover cleanly
- [ ] Remove duplicate direct orderbook polling from market-intel and consume shared market-data microstructure as the single source of truth
- [x] Deduplicate unchanged market snapshots before feeding market-intel so identical polls do not overweight technical indicators
- [x] Make market-feed dedupe content-hash based instead of timestamp-based so unchanged states do not still retrigger indicator updates
- [x] Prune AI-council decision cache entries and avoid full-map sorts on every snapshot read
- [ ] Add portfolio correlation / crowding budgets so multiple sleeves cannot all scale into the same regime at once
- [~] Upgrade pairs/grid/maker promotion metrics from PnL proxies to lane-specific execution quality metrics
  - examples: spread capture, adverse selection, inventory drift, round-trip quality, queue position
- [ ] Materialize allocator snapshots and persist allocation events on a schedule for audit/replay
- [ ] Move synchronous journal/snapshot file writes off the hot path so event logging cannot block the control loop
- [ ] Bound maker-executor processed-fill tracking or rebuild it from persisted tail state so long runs do not accumulate an unbounded Set
- [ ] Index or cache review-loop / replay JSONL reads so large logs do not get scanned in full on every request
- [x] Make review-loop summary metrics use an actual trailing 30-day window instead of lifetime entries
- [ ] Reconcile broker execution reports into journal entries with realized PnL and dedupe by client order id before review clustering uses them
- [ ] Key review summaries by strategyId/configVersion instead of string-matched strategy names so renamed or versioned strategies do not merge silently
- [ ] Centralize `/api/feed` SSE fan-out so each browser tab does not trigger its own broker/account polling loop
- [ ] Reduce feed payload size by sending deltas / targeted channels instead of full paper-desk snapshots every second
- [ ] Move heavy allocator/backtest work off the HTTP request path into a job queue or scheduled snapshot builder
- [ ] Add explicit fetch timeouts/cancellation to backtest, copy-sleeve, macro-preservation, and strategy-lab evaluation calls so hung upstream data sources do not stall long-running jobs
- [ ] Make strategy-lab runs seedable/deterministic so evolution results can be replayed and compared cleanly
- [ ] Limit strategy-lab backtest concurrency and add a per-generation runtime budget so population sweeps do not run unboundedly slow
- [ ] Persist backtest results and raw-data provenance so capital snapshots are reproducible after restart
- [ ] Add bounded/LRU cache eviction for copy-sleeve, macro-preservation, and API state caches so long-running processes do not accumulate stale in-memory maps
- [ ] Unify the per-agent bandit sizing layer with the firm allocator so there is one source of truth for capital weights
- [ ] Add freshness / provenance fields to allocator snapshots so stale copy/macro/backtest inputs are visible instead of silently null
- [ ] Serve last-known-good allocator snapshots with a stale flag when dependency fetches fail instead of hard-failing the whole route
- [ ] Version the KPI / allocator formulas in snapshots so historical comparisons stay comparable after gate changes
- [ ] Make best-sleeve selection freshness-aware so newer evidence beats stale snapshots when scores tie or nearly tie
- [ ] Make allocator capital source use broker buying power / risk-engine state instead of paper-desk equity alone
- [ ] Calibrate allocator scores onto a common scale so scalping, copy, macro, and lane snapshots compare cleanly
- [ ] Split semantic allocation score from true expectedNetEdgeBps so copy/macro/lane ranking does not overload one field with different meanings
- [ ] Add confidence-adjusted KPI ratios with recency decay / lower-bound stats so tiny samples do not look as trustworthy as durable samples
- [ ] Add automatic allocator refresh / cached staleness indicators in the dashboard so operators can see when the snapshot is old
- [ ] Add corporate-action and survivorship-bias handling to the copy sleeve so delayed public-manager replication is not distorted by splits, delistings, or ticker changes

---

## Implemented Architecture Snapshot

## Core services
- `services/api`
- `services/market-data`
- `services/risk-engine`
- `services/broker-router`
- `services/review-loop`
- `services/backtest`
- `services/strategy-lab`
- `apps/web`

## Current strategy layers

### 1. Directional scalping layer
- broker-backed paper lanes for core crypto/equity pilots
- AI council advisory layer
- meta-label acceptance filter
- market-intel gate
- news/macro/event veto gate
- adaptive tuning
- challenger probation / rollback

### 2. Pairs layer
- BTC/ETH dynamic hedge-ratio spread logic
- correlation-aware entry gating
- z-score reversion logic on spread
- sidecar lane control with risk-driven blocking + allocation multiplier
- replayable strategy-state logging
- visible via `/api/pairs`, `/api/strategies`, and `/api/strategy-controls`

### 3. Grid layer
- BTC / ETH / SOL / XRP grids
- sidecar lane control with risk-driven blocking + allocation multiplier
- replayable strategy-state logging
- visible via `/api/grid`, `/api/strategies`, and `/api/strategy-controls`
- currently still sidecar rather than fully broker-integrated

### 4. Maker layer
- BTC / ETH simulated maker quote engine
- inventory-aware quoting
- adverse-selection pausing
- replayable maker state + journal output
- visible via `/api/maker` and `/api/strategies`
- still not broker-backed quote placement

## Intelligence layers

### Market intelligence
Currently built:
- live L2 order-book imbalance
- microprice
- spread / spread bps
- fear & greed
- Bollinger logic
- VWAP logic
- composite directional score

### News intelligence
Currently built:
- multi-source article ingestion
- symbol extraction
- topic classification
- source trust/bias scoring
- symbol-level veto logic
- macro-level veto logic
- contradiction detection

### Event intelligence
Currently built:
- macro embargo derived from active macro/news risk
- earnings embargo via FMP stable earnings calendar

## Control / learning layers
Currently built:
- adaptive tuning after outcomes
- learning-loop-driven config promotion
- challenger probation
- rollback conditions
- bandit-style capital allocation
- event logging

---

## API / Data Source Status

> Secrets live in local `.env` and should **not** be copied into this file.

## Working providers right now

### News / sentiment
- **Finnhub** — working for article flow
- **NewsAPI** — working for article flow
- **CoinDesk RSS** — working as a crypto-native source
- **Alternative.me Fear & Greed** — already integrated

### Calendar / macro / reference
- **FMP stable earnings calendar** — working for earnings embargo lookup
- **FRED** — key available, not yet deeply wired into strategy decisions

### Market data
- **Coinbase public WebSocket** — working for `ticker` and `l2_data`
- **Coinbase public REST** — working as fallback
- **Alpaca paper market data** — working where credentials permit
- **OANDA** — existing support remains in place

## Connected but not yielding useful current results yet
- **Marketaux** — connected, query/result shaping still needs improvement
- **Alpha Vantage NEWS_SENTIMENT** — connected, not yet yielding useful article flow in the current request shape

## Needs follow-up
- **FMP legacy stock news endpoint** — obsolete / legacy-only, returns `403`; use stable endpoints instead where possible
- **TheNewsAPI** — current token returns `401 invalid_api_token`
- **GDELT** — researched and recommended, but not wired yet
- **CryptoPanic** — not wired because paid plan / scraper path not yet implemented
- **CoinMarketCap** — key available, not yet used
- **SEC EDGAR** — not wired yet
- **CoinDesk API key** — available, but RSS already provides useful free signal flow

## Bias-aware source strategy
Ground News does not appear to expose a clean public trading API worth building around.

Current practical path is:
- maintain source-domain trust/bias mapping locally
- use article source trust in score weighting
- treat contradictory coverage as uncertainty, not alpha
- potentially add AllSides-style source mapping later

## Coinbase AgentKit assessment
Coinbase AgentKit was reviewed.

Current conclusion:
- AgentKit is primarily an **onchain wallet + action framework** for AI agents
- its action-provider ecosystem is focused on onchain actions and protocols
- it is **not** the right primitive for Hermes' current centralized-exchange scalping stack
- Hermes' current Coinbase integration is correctly built around:
  - public Advanced Trade WebSocket for ticker + L2
  - Coinbase Advanced Trade REST/order routing for exchange execution

AgentKit becomes relevant later if Hermes adds:
- Base/onchain execution
- agent-managed wallets
- DEX routing / swaps
- autonomous treasury/payment flows

For the current CEX/L2 scalping path, direct Advanced Trade REST + WS is the correct implementation choice.

---

## Verified Endpoints / Runtime Surfaces

## API service
- `GET /api/paper-desk`
- `GET /api/agent-configs`
- `GET /api/learning`
- `GET /api/pairs`
- `GET /api/grid`
- `GET /api/signals`
- `GET /api/intel`
- `GET /api/news-intel`
- `GET /api/news-intel/:symbol`
- `GET /api/calendar`
- `GET /api/replay/events`
- `GET /api/review-clusters`
- `GET /api/strategies`

## Market-data service
- `GET /snapshots`
- `GET /microstructure`
- `GET /health`

## Review-loop service
- `GET /reviews`
- `GET /journal`
- `GET /clusters`

---

## Current Remaining Gaps

## 1. Pairs / grid still need full first-class integration
At the control plane, they now appear as real strategies.

But they still do **not** have full parity with the scalping lanes across:
- broker routing
- learning-loop promotion
- review journaling
- readiness analysis
- risk-engine-specific strategy controls

That is the biggest remaining architectural gap.

## 2. Replay is still audit-first, not simulation-first
The event log is useful now, but Hermes still lacks:
- exact deterministic reconstruction of decision state
- replay-based side-by-side comparison of champion vs challenger
- exact state re-simulation from log + config snapshot

## 3. Review-loop still lacks rich causal diagnosis
The cluster endpoint is useful, but still shallow.

It needs richer annotations for every trade / exit:
- market regime
- order-flow state
- embargo state
- news state
- entry quality score bucket
- latency bucket
- spread bucket

## 4. Maker system is still routing support, not a real engine
Right now Hermes can express post-only limit intent.

It still lacks the actual maker engine logic:
- quote generation
- quote cancellation / refresh rules
- inventory skew
- edge-aware width adaptation
- adverse-selection avoidance

## 5. Meta-labeling is still heuristic
The current acceptance filter is useful but still hand-built.

The next step is:
- triple-barrier labeling
- training data generation
- purged walk-forward validation
- learned acceptance model

---

## Current Strategic Priority Order

## Priority 1 — Finish research-to-execution parity
1. Promote pairs/grid into full broker/risk/review/learning lanes
2. add richer journaling for all strategies
3. add exact replay/re-simulation path

## Priority 2 — Finish market-making path
4. build maker quoting engine on Coinbase
5. add inventory skew and adverse-selection protection
6. add maker/taker switching logic

## Priority 3 — Improve statistical trustworthiness
7. add triple-barrier labels
8. add trained meta-label model
9. add purged walk-forward validation

## Priority 4 — Improve causal diagnosis
10. enrich review clusters with regime + news + microstructure state
11. add challenger-vs-champion replay comparison
12. add rollback quality dashboards

---

## Strategy Families With Best Near-Term Odds

## Highest-value families
1. **Market-neutral pairs**
   - BTC/ETH
   - ETH/SOL
   - SPY/QQQ
   - NVDA/AMD or NVDA/SMH when added

2. **Inventory-controlled market making**
   - maker-first crypto quoting
   - order-flow skew
   - spread capture with inventory discipline

3. **Selective directional scalps**
   - only with tape alignment
   - only with strong precision estimate
   - blocked during macro/news hostility

4. **Event-driven no-trade / re-entry strategies**
   - avoid headline chaos
   - trade only after post-event normalization

5. **Risk-off rotation / flight-to-safety logic**
   - crypto weakness + gold/PAXG strength

---

## Symbol Expansion Policy

Expand only after feature quality is good enough.

## Current best focus set
### Crypto
- BTC-USD
- ETH-USD
- SOL-USD
- XRP-USD
- PAXG-USD

### Equities / ETFs
- SPY
- QQQ
- NVDA

### Forex
- EUR_USD
- GBP_USD
- USD_JPY

## Next candidates
### Crypto
- LINK-USD
- ADA-USD

### Equities / ETFs
- AMD
- SMH
- GLD
- TLT
- XLE

### Forex
- AUD_USD
- EUR_GBP

---

## Success Metrics

Do **not** optimize only for raw win rate.

Track:
- win rate by strategy and regime
- expectancy after fees and slippage
- profit factor
- drawdown
- adverse excursion
- slippage drift
- fraction of bad trades avoided by veto systems
- challenger promotion quality
- rollback frequency and quality

If win rate rises while expectancy collapses, the system is getting worse.

---

## Non-Negotiable Operating Principles

- Prefer **precision over activity**
- Prefer **market-neutral over naked directional exposure**
- Prefer **maker edge over taker churn** where feasible
- Prefer **replayable systems over clever but unauditable heuristics**
- Prefer **automatic rollback over blind auto-promotion**
- Prefer **free / durable data sources first** before paying for more APIs
- Prefer **no-trade** over low-quality trade

---

## Definition of Done

The plan is considered **executed successfully** only when all of the following are true:

### Paper-trading quality gates
- at least **3 consecutive weeks** of positive paper expectancy
- overall paper **profit factor >= 1.35**
- overall paper **win rate >= 60%**
- no single strategy lane responsible for more than **45%** of total paper PnL
- max paper drawdown stays below **5%**

### Strategy-lane parity gates
- scalping, pairs, and grid all route through broker/risk/review with consistent lifecycle handling
- all active strategy lanes have journal + replay + review support
- challenger promotions and rollbacks are logged and explainable

### Execution-quality gates
- Coinbase crypto lanes use public WS + L2 as primary tape
- maker-first crypto execution supports quoting/inventory controls, not just post-only flags
- latency / spread / adverse-selection diagnostics are available in review data

### Intelligence gates
- news layer has stable multi-source coverage with useful article flow
- embargo windows are working for macro + earnings + major symbol-specific event risk
- order-book microstructure includes more than raw imbalance alone

### Research-trust gates
- deterministic replay / re-simulation exists for post-mortem analysis
- challenger configs are validated against replay/backtest/walk-forward evidence before acceptance
- meta-label acceptance logic is measurable and not just opaque heuristics

## Immediate Next Execution Queue

These are the next implementation targets in the correct order:

1. **Pairs/grid full lifecycle integration**
   - route through broker/risk/review/learning the same way scalping lanes do
2. **Deterministic re-simulation**
   - rebuild decisions from event log + config snapshot + tape state
3. **ADE / action-policy layer**
   - let an Adaptive Decision Engine choose enter/hold/trim/hedge/rotate/cash actions under cost, crowding, and regime constraints
   - simulate candidate policies against historical state before any implementation
   - required gates: purged walk-forward, cost/slippage injection, news-latency stress, crowding stress, and shadow-paper comparison vs baseline
4. **Review metadata deepening**
   - persist regime/news/order-flow/embargo context on every trade
5. **Full maker engine**
   - inventory skew, quote width adaptation, adverse-selection protection
5. **Deeper microstructure features**
   - queue imbalance, slope, trade-sign imbalance, spread duration
6. **Stronger challenger validation**
   - replay-aware promotion, stricter rollback scoring, challenger vs champion comparisons

## Explicitly Out of Scope For The Current Branch

These are useful later, but not the right next move right now:
- rebuilding Hermes around Coinbase AgentKit for CEX scalping
- adding many more symbols before feature quality improves
- paying for more APIs before current free / already-keyed sources are fully exploited
- live deployment before paper replay, review, and rollback controls are stronger

## Bottom Line

Hermes is no longer just a simple paper scalper. It now has:
- live Coinbase public L2 as the primary crypto tape
- multi-source news intelligence
- macro and earnings embargo logic
- challenger probation / rollback
- bandit-style allocation
- dynamic hedge-ratio pairs logic
- event logging and basic replay/review infrastructure

The plan is now complete as a document.

The project itself is **not** complete.

The remaining work is concentrated in three areas:
1. full first-class integration of non-scalping strategy lanes
2. real deterministic replay / re-simulation
3. real maker engine + deeper microstructure features
