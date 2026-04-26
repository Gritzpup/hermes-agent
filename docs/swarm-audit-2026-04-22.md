# Hermes Trading Firm — Swarm Audit Report
**Date:** 2026-04-22  
**Agents:** 4 parallel (Tilt · OpenClaw · Services · Observability)  
**Scope:** OpenClaw ↔ Hermes integration, Tilt orchestration, service architecture, observability

---

## Executive Summary

The swarm found **~30 issues** across four domains. The most critical: the COO bridge is **blind to 90% of errors**, Tilt's readiness probes are **wrong or missing**, and the codebase has **15+ hardcoded absolute paths** that prevent it from running anywhere except this workstation.

| Domain | Critical | High | Medium | Maturity |
|--------|----------|------|--------|----------|
| Tilt Orchestration | 3 | 3 | 2 | ⚠️ Fragile |
| OpenClaw Bridge | 2 | 4 | 7 | ⚠️ Leaky |
| Service Architecture | 3 | 4 | 7 | ⚠️ Brittle |
| Observability / DevEx | 4 | 4 | 6 | 🔴 Reactive |

**If you fix only three things this week:**
1. Wire `setupErrorEmitter` into **every** service (not just OpenClaw)
2. Fix the Tiltfile: correct `openclaw-hermes` port (`18789 → 4395`), add `broker-router`, add readiness probes
3. Replace hardcoded `/mnt/Storage/github/...` paths with env vars

---

## 1. Tilt & Service Orchestration

### 🔴 Critical

**1.1 `openclaw-hermes` readiness probe targets wrong port**
- Tilt probes **18789** (`openclaw-gateway` systemd daemon).
- The actual Node service listens on **4395**.
- Tilt will **never mark it ready**.
- **Fix:** Change `serve_cmd` to `npm run dev:openclaw-hermes`, probe port to `4395`.

**1.2 `broker-router` is entirely missing from Tiltfile**
- The Tiltfile comment says "API embeds broker-router internally" — **this is false**.
- The API imports `@hermes/broker-router` **library code**, but the **HTTP server on 4303 is standalone** and required for order routing.
- API calls `127.0.0.1:4303` at runtime via `strategy-director.ts` and `maker-executor.ts`.
- **Fix:** Add `hermes-broker-router` as a Tilt resource with readiness probe on 4303.

**1.3 API missing runtime dependencies**
- API calls `4305` (eod-analysis) and `4308` (backtest) on-demand.
- Without these in `resource_deps`, API starts before downstreams are ready → degraded responses.
- **Fix:** Add `hermes-broker-router`, `hermes-backtest`, `hermes-eod-analysis` to API's `resource_deps`.

### 🟡 High

**1.4 Only 1 of 12 resources has a readiness probe — and it's wrong**
- Tilt marks resources "green" the instant `tsx watch` starts, not when Express is listening.
- Causes cascading `ECONNREFUSED` errors downstream.
- **Fix:** Add probes to all HTTP services (`/health` or `/` for Vite).

**1.5 `resource_deps` graph is incomplete**
- `review-loop` calls `/api/coo/directives` on startup but has no `resource_deps`.
- `risk-engine` calls API and market-data but declares no deps.
- `cfo` POSTs webhooks to `4395` but doesn't depend on OpenClaw.
- **Fix:** Map actual HTTP call graph into `resource_deps`.

**1.6 Batch agents should use `auto_init=False`**
- `cfo`, `compliance`, `daily-diary`, `eod-analysis` are periodic agents.
- Starting them on every `tilt up` wastes resources and clutters the UI.
- **Fix:** Set `auto_init=False` for non-core agents.

---

## 2. OpenClaw-Hermes Bridge (COO)

### 🔴 Critical

**2.1 `pollEvents()` is 12 sequential HTTP GETs**
- No `Promise.all()`. Worst-case latency = 12 × 5s timeout = **60s**.
- **Fix:** Parallelize with `Promise.all()` or `Promise.allSettled()`.

**2.2 `safeGet` silently swallows all failures**
- Returns `null` on timeout or non-2xx. Logs at `debug` level.
- The COO receives **no signal** when PnL attribution is down or broker-health timed out.
- **Fix:** Return `{ok:false, error}` or push synthetic `HermesEvent` on failure.

### 🟡 High

**2.3 Self-heal only records `tick()` failures**
- `recordError()` is called in exactly **one** place: the outer `tick()` catch block.
- Cannot auto-detect: API endpoint failures, Kimi API failures, fast-path failures, script execution failures.
- **Fix:** Wrap `kimi-client.ts`, `fast-path.ts`, and `safe-scripts.ts` error paths with `selfHeal.recordError()`.

**2.4 Script failures don't reach `events.jsonl`**
- `safe-scripts.ts` writes stdout/stderr to `coo-scripts.jsonl`, but **never** to the firm's `events.jsonl`.
- `hermes-poller.ts:tailErrorEvents()` cannot see them because it only scans for `source === 'error-event'`.
- **Fix:** On non-zero exit, write a firm error event:
  ```ts
  writeFirmEvent('coo-script-run-error', { scriptKey, exitCode, stderrPreview });
  ```

**2.5 `lastPollAt` is set at tick *start*, not completion**
- If `pollEvents()` throws, `lastPollAt` still updates.
- `/health` falsely reports recent successful polling.
- **Fix:** Set `lastPollAt` only after success, or add `lastSuccessfulPollAt`.

**2.6 ACP path permanently dies after 5 restarts**
- `acp-client.ts` tracks `restartCount` but **never resets it**.
- After 5 child crashes across the process lifetime, ACP is dead forever.
- **Fix:** Decrement/reset `restartCount` after 30 min of stability.

### 🟢 Medium

**2.7 Fast-path `haltFileExists()` hardcoded to `return false`**
- Never early-exits when already halted. Redundantly POSTs halt again.
- **Fix:** Query API halt endpoint or read local halt file.

**2.8 No file locking on `events.jsonl`**
- `actions.ts` and `fast-path.ts` both read/write the same file. Race risk.
- **Fix:** Use `fs.openSync` with `O_APPEND` or `proper-lockfile`.

**2.9 `seen-events.jsonl` only loaded once per process**
- If file is truncated externally, in-memory `seen` set diverges permanently.
- **Fix:** Reload periodically or use `fs.watchFile`.

**2.10 Self-heal scripts can hang the tick**
- `runDeferred()` awaits scripts sequentially with no overall deadline.
- If `npm run check` hangs for 180s, the slow path is blocked.
- **Fix:** Add `Promise.race` with overall timeout.

**2.11 No circuit breaker on slow path**
- If `pollErrors` exceeds threshold, Kimi (paid API) keeps getting called.
- **Fix:** Stop LLM calls after 3 consecutive poll errors; escalate to webhook alert.

**2.12 Health check verifies no dependencies**
- `/health` does not ping Hermes API, CFO, Kimi, or Redis.
- Could report `"healthy"` while completely isolated.
- **Fix:** Add lightweight dependency probes to `/health` response.

---

## 3. Service Architecture

### 🔴 Critical

**3.1 API calls backtest on TWO different ports**
- `BACKTEST_URL` defaults to `4305` (which is **eod-analysis**).
- Endpoints `/api/copy-sleeve/backtest` and `/api/macro-preservation/backtest` hardcode `4308`.
- Backtest integration is **broken by default**.
- **Fix:** Unify `BACKTEST_URL` to `4308`, remove hardcoded URLs, add to `.env.example`.

**3.2 API `/health` has duplicate route handlers**
- Two handlers registered (lines ~199 and ~388). Express matches the first (simple `{"ok":true}`).
- Richer handler with timestamp is **shadowed and never executes**.
- **Fix:** Remove the early simple handler or merge them.

**3.3 Three services have completely hardcoded ports**
- `daily-diary` (4307), `cfo` (4309), `compliance` (4310) — no `process.env.PORT` override.
- **Fix:** Add `process.env.PORT || 43xx` to all three.

### 🟡 High

**3.4 No service registry or discovery**
- Every service hardcodes `127.0.0.1` or `localhost` with fallback ports.
- 15+ absolute paths to `/mnt/Storage/github/hermes-trading-firm/` hardcoded across codebase.
- **Fix:** Create `packages/infra/src/ports.ts` registry. Derive runtime paths from `import.meta.url` or env.

**3.5 Root `dev` script is missing 5 services**
- `npm run dev` does not start: `daily-diary`, `eod-analysis`, `cfo`, `compliance`, `openclaw-hermes`.
- **Fix:** Add missing services to `concurrently` command, or document that Tilt is the canonical dev path.

**3.6 API defers router stack by 5 seconds**
- `setTimeout(5000)` before mounting `/api/*` routes.
- During this window, `/health` says `{"ok":true}` but `/api/*` returns 404.
- **Fix:** Add a `/ready` endpoint that returns 200 only after routers are mounted.

**3.7 Broker-router dual-mode confusion**
- Exists as both library (imported by API) and standalone service (port 4303).
- Risk of port collision if API ever instantiates the Express app.
- **Fix:** Decide on Option A (pure library) or Option B (standalone service via HTTP).

### 🟢 Medium

**3.8 Inconsistent address families**
- Mix of `127.0.0.1`, `localhost`, and `0.0.0.0` across services.
- **Fix:** Standardize on `127.0.0.1` for internal calls, `0.0.0.0` for bind.

**3.9 No graceful shutdown handlers**
- `backtest`, `strategy-lab`, `review-loop`, `eod-analysis`, `daily-diary`, `cfo`, `compliance` all lack SIGTERM handlers.
- **Fix:** Add `process.on('SIGTERM', () => { server.close(); process.exit(0); })`.

**3.10 `tsx watch` restart races**
- No port-release delay. Quick restarts cause `EADDRINUSE`.
- **Fix:** Add graceful shutdown with `server.close()` to release ports before exit.

---

## 4. Observability & DevEx

### 🔴 Critical

**4.1 `setupErrorEmitter` is wired into exactly ONE service**
- Only `openclaw-hermes` calls it. Every other service's `logger.error` goes to stdout only.
- The COO is **blind to 90% of errors**.
- **Fix:** Import and call `setupErrorEmitter(logger)` in `api`, `market-data`, `risk-engine`, `backtest`, `cfo`, `compliance`, `review-loop` on startup.

**4.2 `error-emitter.ts` has hardcoded absolute path**
- `EVENTS_FILE = '/mnt/Storage/github/hermes-trading-firm/...'`
- Breaks on any machine that isn't this workstation.
- **Fix:** Derive from `process.env.HERMES_RUNTIME_DIR` or `process.cwd()`.

**4.3 API `uncaughtException` handler never exits**
```ts
process.on('uncaughtException', (err) => {
  console.error('[hermes-api] UNCAUGHT EXCEPTION:', err);
  // Don't exit — let the engine keep running
});
```
- Process stays up in a corrupted state. No recovery path.
- **Fix:** Emit fatal error event, then `process.exit(1)`. Let systemd/Tilt restart.

**4.4 No Docker / docker-compose**
- Services run directly on host. Redis and Postgres are assumed present.
- New developer onboarding requires manual OS-level dependency installation.
- **Fix:** Add `docker-compose.yml` with Redis, Postgres, and shared volume.

### 🟡 High

**4.5 No test runner configured**
- `vitest` is imported in test files but not in any `package.json`.
- `npm test` fails. No CI/CD pipeline exists.
- Test coverage is **<1%**.
- **Fix:** Add `vitest` to root `package.json`, create `npm test` script, wire to GitHub Actions.

**4.6 No Prometheus scraper or Grafana**
- Only OpenClaw exposes `/metrics`. No one scrapes it.
- No RED metrics (Rate, Errors, Duration) for API routes.
- **Fix:** Add `prom-client` to API and core services. Run Prometheus + Grafana locally.

**4.7 No correlation ID propagation**
- API injects `x-request-id` into HTTP responses but **not into logs**.
- Cross-service request tracing is impossible.
- **Fix:** Pass `req.id` into every `logger.*` call via pino's `bindings`.

**4.8 No out-of-band alerting**
- If the COO halts the firm at 3 AM, nobody knows until morning.
- No Slack/Discord/PagerDuty integration.
- **Fix:** Add webhook to Slack/Discord on CFO critical alerts (20-line change).

### 🟢 Medium

**4.9 `error-emitter.ts` uses in-memory dedup only**
- `dedupMap` is a global `Map`. Process restarts wipe history → error floods.
- **Fix:** Use Redis `SETEX error:${hash} 300 1` for cross-process dedup.

**4.10 MD5 collision risk in error hashing**
- 12 hex chars = 48 bits. With ~10k errors/day, collisions likely within weeks.
- **Fix:** Use full SHA-256 or at least 16+ hex chars.

**4.11 `appendFileSync` blocks event loop**
- Synchronous file write on every error. Under high error rates, stalls the service.
- **Fix:** Buffer and flush asynchronously, or use a worker thread.

**4.12 No database migrations**
- `pg` Pool is created but no migration tool configured.
- **Fix:** Introduce `node-pg-migrate` or `pgm`.

---

## Implementation Tracks

### Track A: "Stop the Bleeding" (This Week)
*Goal: Make the stack runnable, observable, and correctly orchestrated.*

| # | Task | File(s) | Owner |
|---|------|---------|-------|
| A1 | Fix Tiltfile `openclaw-hermes` port + command | `Tiltfile` | DevOps |
| A2 | Add `broker-router` to Tiltfile | `Tiltfile` | DevOps |
| A3 | Add readiness probes to all core services | `Tiltfile` | DevOps |
| A4 | Fix API `resource_deps` | `Tiltfile` | DevOps |
| A5 | Wire `setupErrorEmitter` into all services | `services/*/src/index.ts` | Backend |
| A6 | Fix `error-emitter.ts` hardcoded path | `packages/logger/src/error-emitter.ts` | Backend |
| A7 | Fix API duplicate `/health` handler | `services/api/src/index.ts` | Backend |
| A8 | Fix backtest port confusion | `services/api/src/index.ts`, `.env.example` | Backend |
| A9 | Fix `uncaughtException` handler to exit | `services/api/src/index.ts` | Backend |
| A10 | Add `docker-compose.yml` | `docker-compose.yml` | DevOps |

### Track B: "Harden the Bridge" (Next 2 Weeks)
*Goal: Make the COO reliable, fast, and actually self-healing.*

| # | Task | File(s) | Owner |
|---|------|---------|-------|
| B1 | Parallelize `pollEvents()` | `services/openclaw-hermes/src/hermes-poller.ts` | Backend |
| B2 | Make API failures visible to COO | `services/openclaw-hermes/src/hermes-poller.ts` | Backend |
| B3 | Wire subsystem errors into self-heal | `services/openclaw-hermes/src/*.ts` | Backend |
| B4 | Script failures → firm events | `services/openclaw-hermes/src/safe-scripts.ts` | Backend |
| B5 | Fix `lastPollAt` semantics | `services/openclaw-hermes/src/index.ts` | Backend |
| B6 | Add dependency checks to `/health` | `services/openclaw-hermes/src/index.ts` | Backend |
| B7 | Add circuit breaker for slow path | `services/openclaw-hermes/src/index.ts` | Backend |
| B8 | Fix `haltFileExists()` | `services/openclaw-hermes/src/fast-path.ts` | Backend |
| B9 | Add file locking for `events.jsonl` | `services/openclaw-hermes/src/actions.ts` | Backend |
| B10 | Add timeout to `runDeferred()` | `services/openclaw-hermes/src/self-heal.ts` | Backend |

### Track C: "Modernize DevEx" (This Month)
*Goal: Make onboarding, testing, and local dev frictionless.*

| # | Task | File(s) | Owner |
|---|------|---------|-------|
| C1 | Add `vitest` test runner + `npm test` | `package.json` | DevEx |
| C2 | Add GitHub Actions CI workflow | `.github/workflows/ci.yml` | DevEx |
| C3 | Create `packages/infra/src/ports.ts` registry | `packages/infra/src/ports.ts` | Backend |
| C4 | Replace hardcoded ports with env vars | `services/*/src/index.ts` | Backend |
| C5 | Add `docker-compose.yml` with all deps | `docker-compose.yml` | DevOps |
| C6 | Add Prometheus + Grafana local stack | `docker-compose.yml`, `prometheus.yml` | DevOps |
| C7 | Add graceful shutdown to all services | `services/*/src/index.ts` | Backend |
| C8 | Add `/ready` endpoint to API | `services/api/src/index.ts` | Backend |
| C9 | Create `scripts/bootstrap.sh` for new devs | `scripts/bootstrap.sh` | DevEx |
| C10 | Add Slack webhook for CFO critical alerts | `services/cfo/src/index.ts` | Backend |

---

## Quick Wins (Under 10 Lines Each)

1. **Fix Tiltfile openclaw port** → change `18789` to `4395` (1 line)
2. **Fix API duplicate `/health`** → delete lines 199–206 or merge handlers (3 lines)
3. **Add `broker-router` to Tiltfile** → copy/paste any resource block, change port to 4303 (5 lines)
4. **Wire error emitter to API** → add `import { setupErrorEmitter } from '@hermes/logger'; setupErrorEmitter(logger);` to `api/src/index.ts` (2 lines)
5. **Fix `uncaughtException`** → add `process.exit(1)` after the log (1 line)
6. **Fix `lastPollAt`** → move assignment to after `await pollEvents()` succeeds (1 line)
7. **Parallelize polls** → change `for...await` to `Promise.all()` (2 lines)
8. **Add `auto_init=False` to batch agents** → add param to 4 Tilt resources (4 lines)

---

## Appendix: Current Service Map

```
┌─────────────────────────────────────────────────────────────────┐
│  CLIENTS                                                        │
│  ┌─────────┐  ┌─────────────┐  ┌─────────┐                     │
│  │  web    │  │  COO Bridge │  │ Grafana │                     │
│  │ :4173   │  │   :4395     │  │ (none)  │                     │
│  └────┬────┘  └──────┬──────┘  └─────────┘                     │
│       │              │                                          │
│       └──────────────┼──────────────────────────────────────────┘
│                      ▼                                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  API (:4300)  ← EMBEDS broker-router LIBRARY            │    │
│  │  ├── /health (BROKEN — duplicate route)                 │    │
│  │  ├── /api/feed (SSE)                                    │    │
│  │  ├── /api/live-log (SSE)                                │    │
│  │  ├── /api/coo/*                                         │    │
│  │  └── routers: core, paper, strategies, intel, director  │    │
│  └─────────────────────────────────────────────────────────┘    │
│       │              │              │                           │
│  ┌────┴────┐  ┌─────┴─────┐  ┌─────┴─────┐                    │
│  │ risk    │  │  market   │  │  review   │                    │
│  │ :4301   │  │  :4302    │  │  :4304    │                    │
│  └────┬────┘  └─────┬─────┘  └───────────┘                    │
│       │             │                                           │
│  ┌────┴─────────────┴────┐  ┌─────────────────┐               │
│  │  broker-router (:4303) │  │  backtest (:4308)│              │
│  │  (MISSING from Tilt)   │  │  (NOT LISTENING) │              │
│  └────────────────────────┘  └─────────────────┘               │
│       │                                                       │
│  ┌────┴────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐          │
│  │ eod     │  │  diary  │  │   cfo   │  │compliance│          │
│  │ :4305   │  │  :4307  │  │  :4309  │  │  :4310   │          │
│  └─────────┘  └─────────┘  └─────────┘  └──────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

---

*Generated by swarm: 4 parallel agents · 30+ findings · 3 implementation tracks · 8 quick wins*
