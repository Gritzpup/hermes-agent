# Hermes Trading Firm — Handoff

This doc explains how the firm runs end-to-end. Give it to another human or AI
and they should be able to operate / extend the system without spelunking.

---

## Mental model in one paragraph

Hermes is a **tilt-managed multi-service paper trading firm**. The paper-trading
engine (`@hermes/api`, port 4300) runs strategies against live crypto (Coinbase)
and paper equities (Alpaca) / forex (Oanda). An **openclaw-driven "COO" agent**
observes the firm via a bridge service, makes decisions (halt / pause / amplify
strategies, issue directives), and those decisions feed back into the firm's
own services (strategy-director, review-loop) via a shared event stream.
Everything runs under systemd so it survives reboots and agent-session deaths.

---

## The full stack (49 tilt resources)

### Core trading services (port → role)

| Port  | Service               | Role |
|-------|------------------------|------|
| 4300  | `hermes-api`           | Paper engine — grids, maker, scalpers, all strategy execution |
| 4301  | `hermes-risk-engine`   | Pre-trade risk checks |
| 4302  | `hermes-market-data`   | Live price feeds (Coinbase WS, Alpaca REST, Oanda REST) |
| 4303  | *(embedded)*           | broker-router embedded inside hermes-api |
| 4304  | `hermes-review-loop`   | Post-trade journal analysis; consumes `/api/coo/directives` |
| 4305  | `hermes-strategy-lab`  | ML / meta-label experiments |
| 4306  | `hermes-daily-diary`   | Pre-market reflection agent |
| 4308  | `hermes-backtest`      | Historical simulation + quarter-outlook |
| 4395  | `openclaw-hermes`      | COO bridge — polls firm, dispatches to openclaw, enacts decisions |
| 18789 | openclaw-gateway       | OpenClaw WebSocket gateway (user-systemd managed) |

### Crypto grids (registered as watch-only agents in paper-engine)

`grid-btc-usd`, `grid-eth-usd`, `grid-sol-usd`, `grid-xrp-usd` — actual trade
execution happens in `GridEngine` instances in `services/api/src/grid-engine.ts`.
The grids are ALSO registered as agents in `paperEngine.agents` Map (via
`paper-engine/grid-synthetic-agents.ts`) with `executionMode: 'watch-only'` so
they appear in `/api/paper-desk`, VenueMatrixSection, and strategy-director
without accidentally double-trading.

### Auto-running tilt resources (non-trading, support)

- `hermes-auto-pull` — every 15 min, `git fetch + pull --ff-only origin master` (skips on dirty tree)
- `coo-journal-committer` — every 6 h, snapshots COO activity into `docs/coo-journal/`, commits + pushes
- `coo-retrospective` — every 24 h, COO reviews its own recent actions → `docs/coo-journal/retros/<date>.md`
- `coo-premarket-briefing` — 4 am ET daily, COO produces market-open briefing → `docs/coo-journal/briefings/<date>.md`
- `coo-symbol-proposer` — every 12 h, picks a crypto candidate + backtests + emits proposal event if Sharpe > 1.0
- `env-backup` — every 6 h, snapshots `.env` to `.env-backups/` with cmp-skip dedup
- `coo-sanity-monitor` — every 2 min, checks bridge+heartbeat
- `openclaw-gateway-monitor` — every 60 s, confirms port 18789 listening + process alive
- `firm-port-check` — every 5 min, verifies all 14 expected ports listening
- `tree-dirty-reporter` — every 15 min, surfaces uncommitted files blocking auto-pull
- `maker-economics-monitor` — every 15 min, reads Coinbase maker fee tier
- `openclaw-agent-cleanup` — every 10 min, prunes stale openclaw sessions, kills orphaned `openclaw agent` subprocesses (NOT the bridge's agent), restarts bridge if `tickInFlight` >5 min. Pattern-matches `openclaw +agent` (with space) to avoid self-killing — naive `openclaw-agent` pgrep used to match the cleanup script itself.

### External API savings (2026-04-20)

| Cadence | Before | After | Why |
|---|---|---|---|
| `market-data` refresh | 5 s | **15 s** | minute-scale trading doesn't need 5s freshness |
| Alpaca polling | always-on | **session-gated** — skipped when `fetchAlpacaClockState().session !== 'regular'`, reuses last snapshots | equities can't change when market is closed |
| OANDA polling | always-on | **skipped on weekends** (Sat + Sun before 22 UTC) | forex has no liquidity |
| `telemetry-sse` tick | 5 s | **10 s** | halves local CPU on terminal snapshot builds |
| Bridge LLM cadence | 30 s | **600 s** (10 min) + 30s fast-path | strategic decisions don't need sub-minute latency |

Env vars to tune: `MARKET_DATA_REFRESH_MS`, `OPENCLAW_HERMES_POLL_MS`, `OPENCLAW_HERMES_FASTPATH_MS`, `OPENCLAW_HERMES_DD_USD`, `OPENCLAW_HERMES_FP_WINDOW_MS`, `OPENCLAW_HERMES_FP_BROKERS`, `MINIMAX_BUSY_LOCK`, `MINIMAX_LOCK_STALE_MS`.

---

## The COO loop (this is the heart of the system)

The bridge is now **two-tier**: a rule-based fast path for time-critical halts,
and a slow LLM path for strategic judgment. This cut MiniMax invocations by ~95%
with no loss in coverage.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ FAST PATH (services/openclaw-hermes/src/fast-path.ts) — every 30 s      │
│ No LLM. Tails journal.jsonl (last 2MB) + events.jsonl (last 512KB).     │
│  • If realized PnL over last 60 min < -$500  → POST /api/emergency-halt │
│  • If ≥2 brokers unhealthy in last 10 min    → POST /api/emergency-halt │
│  • 15-min re-halt cooldown prevents flapping                            │
│                                                                         │
│ SLOW PATH (LLM) — every 10 min (POLL_INTERVAL_MS=600_000)               │
│ 1. Bridge polls firm events + journal tail, content-hash dedup          │
│ 2. MiniMax-busy lock check: if /tmp/minimax-busy.lock is fresh          │
│    (mtime <5 min), bridge yields the tick → skippedBecausePiBusy++      │
│    This prevents the bridge from racing against manual pi calls on      │
│    the same MiniMax account (plan allows only 1-2 concurrent agents)    │
│ 3. COO (MiniMax-M2.7 via openclaw gateway) receives events + rolling    │
│    context (50 recent journal entries, per-strategy stats, prior        │
│    decisions snapshot, COO-override gate state)                         │
│ 4. COO returns JSON: halt / clear-halt / pause-strategy /               │
│    amplify-strategy / directive / note / write-event / force-close /    │
│    set-max-positions / noop                                             │
│ 5. Bridge enacts:                                                       │
│    - halt          → POST /api/emergency-halt                           │
│    - pause/amplify → POST /api/coo/{pause,amplify}-strategy             │
│    - directive/note→ POST /api/coo/{directive,note}                     │
│    - force-close   → POST /api/coo/force-close-symbol                   │
│    - set-max       → POST /api/coo/set-max-positions                    │
│ 6. hermes-api persists + updates in-memory coo-gates                    │
│ 7. Engines on next tick consult coo-gates                               │
│ 8. strategy-director on next 30-min cycle fetches COO state             │
│ 9. Every 6 h, coo-journal-committer pushes docs/coo-journal/* to GH     │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key property**: every decision is journal-durable + git-historied. Even if
the bridge dies, its most recent 30 directives are queryable via
`/api/coo/directives`, and the 6-hour snapshots land in git forever.

### Running a manual pi/MiniMax session without fighting the bridge

```bash
scripts/pi-exclusive.sh --provider minimax --model MiniMax-M2.7 -p "your prompt"
```

The wrapper touches `/tmp/minimax-busy.lock` on start, refreshes every 60s while
running, removes it on exit. The bridge yields its LLM tick for as long as the
lock is fresh, so the two never race on the MiniMax account.

Lock status is exposed on `GET /health` as `minimaxLockFresh` + counter
`skippedBecausePiBusy`.

---

## How to operate — common questions

### "Is the system alive?"

```bash
curl -fsS http://localhost:4395/health         # bridge
curl -fsS http://localhost:4300/health         # api
curl -fsS http://localhost:4300/api/coo/heartbeat   # bridge heartbeat freshness
curl -fsS http://localhost:4300/api/coo/gates       # pause/amplify/force-close state
tilt get uiresource | head                          # fleet overview
```

### "What has the COO been doing?"

```bash
curl -fsS http://localhost:4300/api/coo/directives | jq .      # recent 30 directives
open http://localhost:4300/coo-dashboard                       # dark HTML dashboard
tail -20 services/openclaw-hermes/.runtime/coo-actions.log     # enacted actions
ls docs/coo-journal/retros/                                    # daily retros
```

### "How do I pause the whole firm?"

```bash
touch services/openclaw-hermes/.runtime/HALT
# remove the file when ready to resume
```

This stops the bridge from enacting ANY action. The COO keeps observing + writing
directives for future retrospection; trading just doesn't execute.

### "How do I pause a specific grid?"

```bash
curl -X POST http://localhost:4300/api/coo/pause-strategy \
  -H 'content-type: application/json' \
  -d '{"strategy":"grid-xrp-usd","reason":"manual pause"}'
```

Resume:

```bash
curl -X DELETE http://localhost:4300/api/coo/gates/pause \
  -H 'content-type: application/json' \
  -d '{"strategy":"grid-xrp-usd"}'
```

### "The bridge looks stuck — what do I do?"

1. Check `/health` response — if `tickInFlight: true` for > 5 min, the openclaw call is hung
2. `tilt trigger openclaw-hermes` to force restart
3. If openclaw gateway is the problem: `openclaw daemon restart` or `systemctl --user restart openclaw-gateway.service`

### "sfw-bot says 'Another bot instance already running'"

```bash
redis-cli -p 16380 del bot:instance_lock
tilt trigger sfw-bot
```

(The start_redis_bot.sh now clears the lock on every boot, so this should self-heal. If it still happens, redis may have reset between startup and lock acquisition.)

### "Where do my secrets live?"

`/mnt/Storage/github/hermes-trading-firm/.env` (gitignored). Backed up every 6 h
to `.env-backups/.env.<timestamp>` (also gitignored via `.env*` pattern — VERIFY
before pasting secrets). To restore: `cp .env-backups/.env.<timestamp> .env`.

Known keys: `SEC_API_KEY` (sec-api.io copy-sleeve), `TRADING_ECONOMICS_API_KEY`
(event-calendar), Alpaca + Coinbase + Oanda credentials. All gitignored.

---

## Known issues / followups (not blockers)

- **ACP (Agent Client Protocol) migration ENABLED** (2026-04-20). Two root
  causes were fixed: (1) openclaw acp needs the gateway token —
  `OPENCLAW_GATEWAY_TOKEN` is now auto-loaded from `~/.openclaw/openclaw.json`
  and propagated via env; (2) the `--session` key must be an existing
  gateway-store session with a model bound. We use
  `agent:main:explicit:hermes-bridge` + `--reset-session` so we inherit
  MiniMax-M2.7 + thinking=medium but start each tick clean. `askCoo` still
  falls back to spawn if ACP returns null, so regressions auto-recover.
- **Pre-existing dirty tree files** (`services/api/src/news-intel.ts`, etc.
  from older sessions) block `hermes-auto-pull`. Commit or stash to unblock.
- **strategy-director prompt recently fixed** (commit `3a95e71`) to use
  journal-authoritative P&L + respect COO overrides. If you ever see the COO
  flag "corrupted run" again, check `strategy-director-prompts.ts` to verify
  the AUTHORITATIVE P&L section is still present.

---

## How to resume work as another agent

If you are an AI or operator reading this for the first time:

1. **Read `CLAUDE.md`** in the repo root for session conventions.
2. **Read this file** (you're doing that).
3. **Read `~/.openclaw/workspace/HERMES_FIRM.md`** for the COO's standing briefing.
4. Poke `/api/coo/dashboard` in a browser to see current COO state at a glance.
5. Check `docs/coo-journal/retros/` for the latest daily retrospective.

For code changes: typecheck with `npm run check --workspace @hermes/api`
before committing; hermes-api hot-reloads via tsx watch on save.

For COO-side changes (prompts, action types, etc.): edit
`services/openclaw-hermes/src/`. The bridge tsx-reloads on save.

For deployment: commit to `master`; the journal-committer pushes every 6 h,
and auto-pull on other machines fetches within 15 min of a clean tree.

---

## Visibility: Agent Deck (mission-control TUI)

**`agent-deck` is the single pane of glass** for the firm. Open `deck` (or
`agent-deck`) and the `trading-firm` group shows 18 tiled sessions at once:

- **Interactive CLIs** (the ones you talk to): `claude-firm`, `hermes-firm`
  (MiniMax), `codex-firm`, `gemini-firm`. All four are pre-trusted for the
  firm repo. Default is Claude; hermes is the rate-limit fallback.
- **Service log-followers** (`tilt logs -f <svc>` wrapped so the pane stays
  alive after service restarts): `coo-bridge`, `cfo`, `openclaw-gateway`,
  `hermes-api`, `market-data`, `risk-engine`, `review-loop`, `strategy-lab`,
  `backtest`, `eod-analysis`, `daily-diary`, `web`, `improvement-watcher`.
- **Fleet dashboard**: `firm-fleet` (rolling `tilt get uiresource`).

**Auto-registration**: any `hermes`/`claude`/`codex`/`gemini` launched from a
bare terminal auto-registers via bashrc wrappers. When the terminal closes,
the EXIT trap removes the session. Backstop: `agent-deck-pruner` tilt
resource (every 2 min) prunes any Agent Deck session whose tmux session has
been gone ≥5 min, skipping the permanent fixture set above.

**Claude subagent dispatches** via `scripts/hermes-watch.sh` land as
`claude-sub-<timestamp>` entries in the same group so you can watch them
work in real time.

Aliases in `~/.bashrc`: `cc` / `hh` / `xx` / `gg` = quick-launch shortcuts;
`deck` / `watch-agents` = open the TUI.

---

*Last updated: 2026-04-21 — added Agent Deck visibility layer (18 tiled
sessions), auto-registration shell wrappers, and agent-deck-pruner monitor.
Earlier: two-tier bridge, CFO wiring + rolling-context, error-event emitter +
recentErrors, run-script self-heal, coo-improvement-watcher, ACP token fix +
respawn-per-prompt. Updated periodically by coo-journal-committer.*
