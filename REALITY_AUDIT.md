# Reality Audit

This repo has a mix of live, simulated, staged, and demo-only surfaces. The goal is to keep them honest so the dashboard never looks more real than it is.

## What is intentionally simulated

- **Quarter Outlook**: simulation-backed report and bootstrap projections.
- **Copy Sleeve**: delayed public-manager replication from SEC 13F filings.
- **Macro Preservation**: CPI-gated cash/real-asset sleeve with backtest output.
- **`packages/contracts/src/mock.ts`**: demo/test snapshot data only.

## What was cleaned up so it reads more truthfully

- **Tape provenance** now shows source and freshness (`source`, `updatedAt`) instead of only price/action.
- **Pilot Progress** panels now show active broker-backed lanes, watch-only lanes, live tape counts, and Pi council load.
- **Default symbol selection** no longer biases the dashboard to BTC-USD when other active lanes exist.
- **Live Terminals** now include Pi council / Claude / Codex / Gemini panes, not just service health boxes.

## Remaining gaps to keep an eye on

- **AI council panes** show votes, confidence, and notes, but they are still a summary of model outputs, not a raw chat transcript.
- **Watch-only lanes** are visible but not tradable; they should never be presented as live execution.
- **Mock/demo data** still exists for tests and examples, but it should stay isolated from production-facing routes.
- **Some venue parity** for forex/bonds is still staged, not live.

## Rules

- If a value is simulated, label it.
- If a value is stale, timestamp it.
- If a lane is staged, do not present it as live.
- If a service is unavailable, say so plainly.

## Next cleanup steps

- Persist learning history so the self-learning scorecard can show 7d / 30d before-after trends.
- Add source-trust weighting for market/news inputs so stale feeds cannot mask fresh ones.
- Keep expanding terminal visibility so council activity is easy to audit.

## Newly added transparency surfaces

- **Learning History**: the main dashboard, paper desk, and reviews page now surface persisted `learning-log.jsonl` and `lane-learning-log.jsonl` history with 7d/30d windows.
- **Terminal progress**: the review-loop terminal now includes the latest self-learning and lane-learning decisions so live adaptation is visible, not implied.
- **Learning logs now SSR/poll:** the main dashboard, paper-desk page, and reviews page now pull persisted learning-loop and lane-learning logs directly, so the progress panels have real history on first render instead of waiting on a client-only fetch.

## Learning center

- **/learning page**: exposes persisted self-learning history, lane-allocation decisions, and the raw Pi council transcript feed.
- **Main dashboard / paper desk / reviews**: now load the same persisted learning data server-side so the trend panels render truthfully on first paint.
- **Pi Council panes**: the live terminal feed now surfaces prompt and raw output snippets from the latest Pi calls, so model activity is visible instead of implied.
- **AI vote transparency**: provider votes now carry a `source` label (`pi` / `api` / `cli` / `rules`), so the dashboard can show whether a response came from an actual Pi call or a fallback path.
- **AI council fallback visibility**: council cards now show a source summary badge (`Pi only` vs `Fallback: API / CLI / rules`) and a banner appears when non-Pi votes are present.
- **Transcript search**: the Pi transcript viewer now has client-side search so raw prompts/outputs can be filtered without pretending the full log changed.
- **Learning header source mix**: the Learning Center header now shows a compact Pi/API/CLI/rules source breakdown from the latest council decisions, making fallback-heavy periods visible without opening the transcript table.
- **Transcript role filters**: the Pi transcript viewer now has role filter chips for Claude/Codex/Gemini plus search, so the operator can narrow the raw log without changing the underlying trace feed.
- **Council source mix on dashboards**: the main control room and paper-desk AI council panels now show a compact Pi/API/CLI/rules source breakdown, matching the Learning Center’s transparency surface.
- **Queued council decisions are no longer misclassified as fallback**: source mix counts now ignore queued/evaluating decisions, and the dashboard labels them as queued/evaluating/error instead of pretending they are model votes.
- **Terminal revamp pass**: tightened global panel density, reduced whitespace, and moved the live terminals panel higher so the dashboard reads more like a trading terminal than a scattered product page.
- **Learning page live plumbing**: the learning header now polls `/api/paper-desk`, so council source counts and fallback warnings are no longer static SSR snapshots.
- **Transcript wording cleanup**: the Pi transcript filter banner now says “Pi transcripts only” instead of implying a transport distinction that does not exist.
- **Terminal vote lines**: the Pi Council terminal pane now prints each vote on its own line instead of one concatenated string.
- **Command strip + deck labels**: added a live status strip (feed, NAV, daily PnL, open risk, council fallback, tape count, active agents) and grouped the main page into terminal-style deck labels so the operator sees live state first.
- **Live terminals prioritized**: the main dashboard now surfaces Live Terminals before reference panels, so actual agent activity is visible earlier in the control room.
- **Section labeling**: added concise deck labels (`Execution and telemetry`, `Reference and outlook`, `Learning and governance`, `Market execution`, `Execution analytics`, `Trader scoreboard`, `Decision engine`, `Portfolio and sleeves`) so the operator can tell what is live versus reference at a glance.
- **Two-column command center**: the main dashboard is now a proper two-column operator layout. The left column shows live execution (terminals, council decisions, tape chart, tuning, risk, trader tables) while the right rail holds reference panels (quarter outlook, pilot progress, learning history, Pi transcripts, capital allocation, copy sleeve, macro preservation). The rail is sticky so it stays visible while scrolling the execution stream.
- **Color pass**: metric card values, readout card values, table cells (PF, win rate, PnL, status), symbol change %, deck labels, hero meta, and status strip chips are now colored by meaning (green/amber/red) instead of being all white.
- **Session timer**: the dashboard hero and status strip now show how long the current browser session has been open.
- **Frontend data logger**: every 20th SSE message dumps key values (nav, equity, dayPnl, realized, winRate, agents, trades, tapes, fills, council) to the browser console so the operator can verify the data pipeline is not hallucinating.
- **Multi-broker equity**: the dashboard now shows per-broker equity chips for every connected platform (Alpaca, Coinbase, OANDA) with equity, cash, realized PnL, allocation %, mode, and connection status. Firm NAV now sums all broker equity instead of only the Alpaca paper account.
- **BrokerHeat expanded**: the contract now includes equity, cash, status, mode, and updatedAt so the UI can show actual dollar amounts per platform instead of just allocation percentages.
