---
name: firm-architecture
description: Full Hermes trading firm architecture, COO loop, service topology, env tunables, and operator runbook. Load when doing anything non-trivial in this repo.
---

# Hermes Trading Firm — Architecture Skill

When you load this skill, you should consult `HANDOFF.md` in the repo root for
the canonical long-form version. This skill file summarises what's there and
highlights what's changed recently so you don't regress those fixes.

## Read on load

1. `HANDOFF.md` — full architecture, COO loop diagram, runbook, known issues.
2. `AGENTS.md` — the one-page pre-read. This skill file does NOT replace it.

## Architecture in 60 seconds

- **Tilt-managed** fleet of ~50 resources (mostly under the `hermes-*` label).
- **Paper engine** in `@hermes/api` (port 4300) executes grid / maker / scalper
  strategies against live Coinbase crypto + paper Alpaca equities + paper OANDA
  forex. Grid engines run inside the api process; they also register as
  watch-only agents via `grid-synthetic-agents.ts` for dashboard visibility.
- **COO bridge** (`services/openclaw-hermes/`, port 4395) observes firm events
  and dispatches decisions to MiniMax-M2.7 via the openclaw gateway on 18789.
- **Two-tier decision loop**:
  - Fast path (30 s, no LLM): rule-based halt on drawdown / broker outage.
  - Slow path (10 min, LLM): strategic pause / amplify / directive / notes.
- **MiniMax concurrency cap of 1-2 agents** is enforced via
  `/tmp/minimax-busy.lock` — `scripts/pi-exclusive.sh` sets it, bridge yields
  while it's fresh.
- **Cost optimization layer**: market-data refresh is 15 s (not 5 s), Alpaca
  polling is session-gated, OANDA skipped on weekends. See
  `services/market-data/src/index.ts` refreshSnapshots logic.

## Recently-fixed regression hazards

Do not reintroduce these:

1. `services/openclaw-hermes/src/openclaw-client.ts`: the parser must read
   BOTH stdout and stderr (openclaw --local routes envelope to stderr).
2. `scripts/monitors/openclaw-agent-cleanup.sh`: pgrep pattern must be
   `"openclaw +agent( |$)"` with an explicit `cleanup` exclusion +
   `$$`/`$PPID` guards. A bare `"openclaw-agent"` pattern will self-murder
   the script.
3. `services/api/src/index.ts`: every `/api/coo/*` POST needs a per-route
   `cooJsonParser = express.json()` — global middleware is attached inside a
   setTimeout and routes registered earlier will throw
   "Cannot destructure req.body".
4. `services/api/src/strategy-director-prompts.ts`: must include the
   AUTHORITATIVE P&L BY STRATEGY/SYMBOL/LANE section and a COO OVERRIDES
   section. Without these the director will fabricate P&L and ignore
   pause/amplify gates.
5. `services/api/src/grid-engine.ts`: `processGridLevels` must consult the
   coo-gates (`isStrategyPaused`, `Math.min(builtin-cap, firm-cap,
   strategy-cap)` for maxPositions). `update` must consume `force-close`
   from gates and flatten positions.

## Tunables cheat-sheet

| Purpose | Var | Default |
|---|---|---|
| Slow LLM cadence | `OPENCLAW_HERMES_POLL_MS` | 600_000 |
| Fast-path cadence | `OPENCLAW_HERMES_FASTPATH_MS` | 30_000 |
| Drawdown halt | `OPENCLAW_HERMES_DD_USD` | 500 |
| Journal tail size | `OPENCLAW_HERMES_JOURNAL_TAIL` | 50 |
| Market-data refresh | `MARKET_DATA_REFRESH_MS` | 15_000 |
| ACP flag (broken, off) | `OPENCLAW_HERMES_USE_ACP` | unset |
| MiniMax stagger lock | `MINIMAX_BUSY_LOCK` | `/tmp/minimax-busy.lock` |

## Active followup: ACP

`services/openclaw-hermes/src/acp-client.ts` handshakes OK
(`initialize` → `session/new` returns valid sessionId) but `session/prompt`
never resolves. Spawn fallback in `openclaw-client.ts` still works. Prime
suspects: missing pre-prompt method (`session/set_model`?), stderr-routed
response we're filtering out, or wrong session key. Flip
`OPENCLAW_HERMES_USE_ACP=1` in Tiltfile once fixed.

## Operator muscle memory

```bash
# System alive?
curl -fsS http://localhost:4395/health
tilt get uiresource

# What has the COO done?
curl -fsS http://localhost:4300/api/coo/directives | jq .
tail -20 services/openclaw-hermes/.runtime/coo-actions.log

# Halt everything (bridge stops enacting, COO keeps observing)
touch services/openclaw-hermes/.runtime/HALT

# Pause one strategy
curl -X POST http://localhost:4300/api/coo/pause-strategy \
  -H 'content-type: application/json' \
  -d '{"strategy":"grid-xrp-usd","reason":"..."}'

# Typecheck before committing
npm run check --workspace @hermes/api

# Redis peek (bot-lock, market pub/sub)
redis-cli -p 16380 keys '*'
```

## Commit discipline

- `docs:` for HANDOFF/AGENTS/skill edits, `fix(<area>):` for bug fixes,
  `feat(<area>):` for new capability. Match the repo's existing cadence.
- Never force-push. Never push to master without explicit "push" from the
  user — `coo-journal-committer` pushes every 6 h automatically.
- No amending published commits. No `--no-verify`.
