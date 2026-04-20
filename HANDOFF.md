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

---

## The COO loop (this is the heart of the system)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. Firm services emit events (journal.jsonl, /api/*)                    │
│ 2. openclaw-hermes bridge polls every 30 s, content-hash dedup          │
│ 3. COO (MiniMax-M2.7 via openclaw gateway) receives events + rolling    │
│    context (50 recent journal entries, per-strategy stats, prior        │
│    decisions snapshot, COO-override gate state)                         │
│ 4. COO returns JSON actions: halt / clear-halt / pause-strategy /       │
│    amplify-strategy / directive / note / write-event / force-close /    │
│    set-max-positions / noop                                             │
│ 5. Bridge enacts:                                                       │
│    - halt          → POST /api/emergency-halt (+ gh issue + cooldown)   │
│    - pause/amplify → POST /api/coo/{pause,amplify}-strategy              │
│    - directive/note→ POST /api/coo/{directive,note}                     │
│    - force-close   → POST /api/coo/force-close-symbol                   │
│    - set-max       → POST /api/coo/set-max-positions                    │
│ 6. hermes-api persists to events.jsonl + coo-directives.jsonl +         │
│    updates in-memory coo-gates (paused/amplified/max-positions/force-close) │
│ 7. Engines on next tick consult coo-gates:                              │
│    - grid-engine.processGridLevels: skips opening new positions on      │
│      paused strategies; respects Math.min(builtin-cap, COO-firm-cap,    │
│      COO-strategy-cap) for maxPositions                                 │
│    - grid-engine.update: consumes force-close flag, flattens positions  │
│ 8. strategy-director on next 30-min cycle fetches /api/coo/directives   │
│    + /api/coo/gates, respects pause/amplify as hard constraints in     │
│    its prompt                                                            │
│ 9. Every 6 h, coo-journal-committer pushes docs/coo-journal/* to GH     │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key property**: every decision is journal-durable + git-historied. Even if
the bridge dies, its most recent 30 directives are queryable via
`/api/coo/directives`, and the 6-hour snapshots land in git forever.

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

- **ACP (Agent Client Protocol) migration disabled** in Tiltfile — see
  `services/openclaw-hermes/src/acp-client.ts`. Handshake works; streaming
  `session/prompt` response hangs 5 min. Needs investigation of whether
  `session/set_model` or another prep call is required before prompt.
  Flip on via `OPENCLAW_HERMES_USE_ACP=1` env var after fixing.
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

*Last updated: 2026-04-20 during active session; updated periodically by
coo-journal-committer auto-commits.*
