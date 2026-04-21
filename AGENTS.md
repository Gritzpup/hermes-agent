# Hermes Trading Firm — Agent Context

This file is auto-loaded by opencode (and any agent honoring `AGENTS.md`) when
working in this repo. It is the pre-read so you don't have to rediscover the
firm each session. Keep it tight — every line is tokens on every turn.

**On every session in this repo, your first action is to read `HANDOFF.md`**
(full architecture, runbook, known issues, and active followups). This summary
file is a pointer, not a replacement. If you skip HANDOFF.md you will miss
regression hazards, env tunables, and the ACP followup context.

## One-paragraph mental model

Hermes is a **tilt-managed multi-service paper trading firm**. The paper engine
(`@hermes/api`, port 4300) runs grid / maker / scalper strategies against live
Coinbase crypto, paper Alpaca equities, paper OANDA forex. A tilt-resident
**COO bridge** (`services/openclaw-hermes/`, port 4395) observes events and
drives MiniMax-M2.7 via openclaw to make strategic decisions. The bridge is
**two-tier**: a rule-based fast path (30 s) handles halts and broker outage,
and a slow LLM path (10 min) handles strategy pause/amplify/directive/notes.
Everything runs under systemd + tilt so it survives reboots.

## Service ports (most-used)

| Port  | Service               |
|-------|-----------------------|
| 4300  | hermes-api (paper engine, COO endpoints, `/coo-dashboard`) |
| 4301  | hermes-risk-engine |
| 4302  | hermes-market-data (Coinbase WS + Alpaca/OANDA REST) |
| 4304  | hermes-review-loop |
| 4305  | hermes-strategy-lab |
| 4306  | hermes-daily-diary |
| 4308  | hermes-backtest |
| 4395  | openclaw-hermes (COO bridge) — `/health` shows cooCalls/Successes, minimaxLockFresh |
| 16380 | shared Redis (bot lock, `TOPICS.MARKET_TICK` pub/sub) |
| 18789 | openclaw gateway |

## COO bridge — the heart

- **Fast path** (`services/openclaw-hermes/src/fast-path.ts`, 30 s):
  - realized PnL < `-$FAST_PATH_DRAWDOWN_USD` over last `FAST_PATH_WINDOW_MS` → POST `/api/emergency-halt`
  - ≥ `FAST_PATH_MIN_UNHEALTHY_BROKERS` brokers offline/degraded in 10 min → halt
  - 15-min re-halt cooldown
- **Slow path** (LLM, 10 min default `POLL_INTERVAL_MS=600_000`):
  - Polls journal + events, yields tick if `/tmp/minimax-busy.lock` mtime < 5 min
  - Dispatches to MiniMax-M2.7 via openclaw gateway
  - Actions: halt / pause-strategy / amplify-strategy / directive / note / force-close / set-max-positions / noop
  - Enacts via POST `/api/coo/*` → persists to `coo-directives.jsonl` + `coo-gates`

## MiniMax concurrency (PLAN CEILING 1-2 AGENTS)

The openclaw account (used by pi, bridge, opencode via MiniMax) supports
**only 1-2 concurrent agents**. Coordinate with `/tmp/minimax-busy.lock`:

- `scripts/pi-exclusive.sh <pi args...>` — wraps pi; touches the lock on entry,
  refreshes every 60 s, removes on exit. Bridge yields its tick while held.
- Lock status on `curl http://localhost:4395/health` → `minimaxLockFresh`.
- Over-three-way races (pi + bridge + opencode) will produce HTTP 529 or
  "terminated" stream errors. When that happens, slow the bridge
  (`OPENCLAW_HERMES_POLL_MS=1200000`) or pause pi with the wrapper.

## Tunable env vars (OpenClaw bridge)

| Var | Default | Purpose |
|---|---|---|
| `OPENCLAW_HERMES_POLL_MS` | 600_000 | Slow LLM tick cadence |
| `OPENCLAW_HERMES_FASTPATH_MS` | 30_000 | Fast-path rule cadence |
| `OPENCLAW_HERMES_DD_USD` | 500 | Fast-path drawdown halt threshold |
| `OPENCLAW_HERMES_FP_WINDOW_MS` | 3_600_000 | Drawdown lookback window |
| `OPENCLAW_HERMES_FP_BROKERS` | 2 | Min unhealthy brokers to halt |
| `OPENCLAW_HERMES_JOURNAL_TAIL` | 50 | Journal entries in rolling context |
| `OPENCLAW_HERMES_USE_ACP` | (unset) | Set to 1 once ACP streaming fix lands |
| `MINIMAX_BUSY_LOCK` | `/tmp/minimax-busy.lock` | Stagger lock path |
| `MINIMAX_LOCK_STALE_MS` | 300_000 | Lock staleness cutoff |

| Var (market-data) | Default | |
|---|---|---|
| `MARKET_DATA_REFRESH_MS` | 15_000 | Alpaca/OANDA REST cadence |
| `ALPACA_CLOCK_CACHE_MS` | 30_000 | Alpaca clock cache TTL |

Alpaca polls are **session-gated** — skipped when the market is closed (last
snapshots reused). OANDA is **weekend-skipped** (Sat all day + Sun before 22 UTC).

## Where key state lives

- Events: `services/api/.runtime/paper-ledger/events.jsonl`
- Journal (trades): `services/api/.runtime/paper-ledger/journal.jsonl`
- Bridge state: `services/openclaw-hermes/.runtime/`
  - `seen-events.jsonl`, `coo-directives.jsonl`, `coo-actions.log`, `HALT`, `coo-outcomes.jsonl`
- COO journal (6 h snapshots, committed to git): `docs/coo-journal/`
- Secrets: `.env` (gitignored, auto-backed-up every 6 h to `.env-backups/`)

## Common operator commands

```bash
# Is everything alive?
curl -fsS http://localhost:4395/health
curl -fsS http://localhost:4300/api/coo/heartbeat
tilt get uiresource | head

# Pause the whole firm (bridge stops enacting, COO keeps observing)
touch services/openclaw-hermes/.runtime/HALT

# Pause a single strategy
curl -X POST http://localhost:4300/api/coo/pause-strategy \
  -H 'content-type: application/json' \
  -d '{"strategy":"grid-xrp-usd","reason":"manual pause"}'

# See recent COO actions
curl -fsS http://localhost:4300/api/coo/directives | jq .
tail -20 services/openclaw-hermes/.runtime/coo-actions.log
```

## Active followups / known gotchas

- **ACP is ENABLED** (2026-04-20): `OPENCLAW_HERMES_USE_ACP=1` in Tiltfile.
  Fixed by (a) propagating `OPENCLAW_GATEWAY_TOKEN` from openclaw.json to the
  spawned `openclaw acp`, (b) using `agent:main:explicit:hermes-bridge` as the
  session key + `--reset-session`. Spawn fallback auto-triggers if ACP returns
  null — zero-regression path.
- **Pre-existing dirty files** (`services/api/src/news-intel.ts`, etc.) block
  `hermes-auto-pull` — commit or stash to unblock.
- **Never write `/api/coo/*` routes without a per-route `cooJsonParser`
  (`express.json()`)** — the global middleware attaches inside a `setTimeout`
  and routes registered earlier throw "Cannot destructure req.body".
- **`openclaw-agent-cleanup` cleanup script** must NEVER pgrep `openclaw-agent`
  (too broad — matches itself). Use `"openclaw +agent"` + explicit `cleanup`
  exclusion + own-PID guard. Already fixed; don't regress.
- **Grid engines register as watch-only agents** via
  `paper-engine/grid-synthetic-agents.ts` so they appear in paper-desk +
  venue-matrix without accidentally double-trading.

## When coding

- TS hot-reloads via `tsx watch`. Typecheck:
  `npm run check --workspace @hermes/api`
- Don't push to `origin/master` directly — `coo-journal-committer` pushes
  every 6 h automatically. Direct pushes are blocked by the user's explicit
  "never git push unless asked" rule.
- New commits default to co-author `Claude Opus 4.7 (1M context)` style — match
  the repo's recent commit log for tone.
- Don't add features the user didn't ask for. Surgical edits win.
