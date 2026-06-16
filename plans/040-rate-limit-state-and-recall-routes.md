# Plan 040: Rate-limit the `/state` and `/recall` HTTP routes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 6781b81..HEAD -- apps/server/src/index.ts scripts/verify-security.mjs`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `6781b81`, 2026-06-15

## Why this matters

The ingress rate limiter (plan G4) is wired to WS messages and the GitHub
webhook, but **not** to the two read HTTP routes: `GET /state` and
`POST /recall`. In open mode (the default for local/dev, and what a
tunnel-exposed dev server runs) both are unauthenticated, and `/recall` issues
an embedding-provider call plus a pgvector query **per request** with no
per-caller cap. An unauthenticated caller can therefore drive unbounded
embedding-API spend and DB load, and hammer `/state` with arbitrary `repoId`s
to force repeated store loads. The "1MB body cap + rate limiting" hardening is
simply incomplete on these two routes. The fix reuses the existing
`overRateLimit` window helper already used by the webhook.

## Current state

- `apps/server/src/index.ts:275-286` — the limiter helper (already exists):

```ts
function overRateLimit(window: RateWindow, limitPerMinute: number, now: number): boolean {
  if (limitPerMinute <= 0) {
    return false;
  }
  if (now - window.windowStartedAt >= 60_000) {
    window.windowStartedAt = now;
    window.count = 0;
  }
  window.count += 1;
  return window.count > limitPerMinute;
}
```

- `apps/server/src/index.ts:264-273` — existing windows/tunables:

```ts
const WS_RATE_LIMIT_PER_MIN = Number(process.env.SYNAPSE_RATE_LIMIT_PER_MIN ?? 600);
const WEBHOOK_RATE_LIMIT_PER_MIN = Number(process.env.SYNAPSE_WEBHOOK_RATE_LIMIT_PER_MIN ?? 120);
// ...
const socketRates = new WeakMap<WebSocket, RateWindow>();
const webhookRate: RateWindow = { windowStartedAt: 0, count: 0 };
```

- `apps/server/src/index.ts:467-471` — the webhook applies the limiter (the
  pattern to mirror):

```ts
  if (overRateLimit(webhookRate, WEBHOOK_RATE_LIMIT_PER_MIN, Date.now())) {
    metrics.count("synapse_rate_limited_total", { surface: "webhook" });
    log.warn("rate.limited", { surface: "webhook", limit: WEBHOOK_RATE_LIMIT_PER_MIN });
    writeJson(response, 429, { ok: false, error: "rate_limited" });
    return;
  }
```

- `apps/server/src/index.ts:154-199` — `/state` and `/recall` handlers: neither
  calls `overRateLimit`. `/state` runs `withRepo(repoId, () => getState(repoId))`;
  `/recall` calls `memory.recall(...)` (embedding + pgvector) after an auth and a
  query check.

- `scripts/verify-security.mjs` — the existing security verifier already drives a
  WS flood → `rate_limited` and the webhook 429; it is the place to add an HTTP
  rate-limit assertion.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Build     | `npm run build`                  | exit 0              |
| Typecheck | `npm run typecheck`               | exit 0, no errors   |
| Security verify | `npm run verify:security`  | exit 0, ends `PASS` |
| Auth verify | `npm run verify:auth`          | exit 0, ends `PASS` |

## Scope

**In scope**:
- `apps/server/src/index.ts` — add a shared HTTP read-route window and apply it
  in the `/state` and `/recall` handlers.
- `scripts/verify-security.mjs` — add an assertion that the HTTP routes return
  429 past budget.

**Out of scope**:
- The WS and webhook limiters — already correct, leave them.
- `/health`, `/metrics`, `/webhooks/github` — `/health` and `/metrics` must stay
  cheap and open for probes/scrapers; do NOT add the read-route limiter to them.
- Auth logic — this is orthogonal to auth; over-limit is checked *before* auth so
  an unauthenticated flood is rejected cheaply.

## Git workflow

- Branch: `advisor/040-rate-limit-state-and-recall-routes`
- Commit style: `fix(server): rate-limit /state and /recall read routes`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add a shared read-route window and tunable

In `apps/server/src/index.ts`, next to the existing windows (after
`webhookRate` at `index.ts:273`), add:

```ts
// Read-route ingress limiting (plan 040): /state and /recall were left off the
// limiter. /recall drives an embedding call + pgvector query per request, so in
// open mode an unauthenticated caller could run up provider cost and DB load. A
// single global window (these are GET/POST reads, not per-connection) mirrors
// the webhook limiter. Set 0 to disable.
const HTTP_READ_RATE_LIMIT_PER_MIN = Number(process.env.SYNAPSE_HTTP_RATE_LIMIT_PER_MIN ?? 120);
const httpReadRate: RateWindow = { windowStartedAt: 0, count: 0 };
```

**Verify**: `npm run build` → exit 0.

### Step 2: Apply the limiter in `/state`

At the top of the `GET /state` handler (`index.ts:154`, before the auth check),
add the over-limit guard (mirror the webhook pattern):

```ts
  if (request.method === "GET" && url.pathname === "/state") {
    if (overRateLimit(httpReadRate, HTTP_READ_RATE_LIMIT_PER_MIN, Date.now())) {
      metrics.count("synapse_rate_limited_total", { surface: "state" });
      writeJson(response, 429, { ok: false, error: "rate_limited" });
      return;
    }
    const repoId = url.searchParams.get("repoId") ?? "local";
    // ... existing auth + body ...
```

**Verify**: `npm run build && npm run typecheck` → exit 0.

### Step 3: Apply the limiter in `/recall`

At the top of the `POST /recall` handler (`index.ts:166`, before parsing the
body — reject the flood as cheaply as possible), add:

```ts
  if (request.method === "POST" && url.pathname === "/recall") {
    if (overRateLimit(httpReadRate, HTTP_READ_RATE_LIMIT_PER_MIN, Date.now())) {
      metrics.count("synapse_rate_limited_total", { surface: "recall" });
      writeJson(response, 429, { ok: false, error: "rate_limited" });
      return;
    }
    let body: { repoId?: string; query?: string; limit?: number };
    // ... existing parse + auth ...
```

Both routes share `httpReadRate` deliberately (one combined read budget).

**Verify**: `npm run build && npm run typecheck` → exit 0.

### Step 4: Extend `verify-security.mjs` with an HTTP rate-limit assertion

Read `scripts/verify-security.mjs` to learn how it boots the server and drives
requests (it already starts a server, floods WS, and checks the webhook 429).
Add a focused check: with `SYNAPSE_HTTP_RATE_LIMIT_PER_MIN` set to a small value
(e.g. `2`) in the spawned server's env, issue more than that many `GET /state`
requests within the window and assert at least one returns HTTP 429 with
`{ error: "rate_limited" }`. Follow the script's existing assertion/`PASS`
style.

**Verify**: `npm run verify:security` → exit 0, ends with `PASS`.

### Step 5: Confirm auth path unaffected

**Verify**: `npm run verify:auth` → exit 0, ends with `PASS`.

## Test plan

- Integration assertion added to `scripts/verify-security.mjs`: `/state` returns
  429 once the small per-minute budget is exceeded. (This script is the repo's
  established home for rate-limit verification — it already asserts WS and
  webhook limits.)
- Regression: `verify:auth` confirms authorized `/state` access still works
  under the default (high) budget.

## Done criteria

ALL must hold:

- [ ] `npm run build` exits 0
- [ ] `npm run typecheck` exits 0
- [ ] `npm run verify:security` exits 0 and the new HTTP-429 assertion passes
- [ ] `npm run verify:auth` exits 0
- [ ] `grep -n "httpReadRate" apps/server/src/index.ts` shows it used in both `/state` and `/recall`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- The `/state` or `/recall` handlers no longer match the "Current state"
  excerpts.
- `verify-security.mjs` has no clear pattern for spawning a server with custom
  env (you cannot set `SYNAPSE_HTTP_RATE_LIMIT_PER_MIN` for the spawned server) —
  STOP and report; do not hack a global env mutation that leaks into other checks.
- Adding the limiter to `/state` breaks `verify:multi-instance` (it reads
  `/state` across instances) — if a legitimate test trips the default budget,
  the default is too low; STOP and report rather than raising it blindly.

## Maintenance notes

- The default budget (120/min) is generous for real daemons and dashboards but
  blocks an abusive loop. If a future read-heavy dashboard polls `/state`
  frequently, raise `SYNAPSE_HTTP_RATE_LIMIT_PER_MIN` rather than removing the
  limiter.
- This is a global window, not per-IP — sufficient against accidental/abusive
  loops. If per-tenant fairness ever matters (hosted multi-tenant), upgrade to a
  per-credential window; note it, don't build it now.
- Pairs with plan 043 (webhook tenant-scoping): both harden the
  internet-reachable HTTP surface for tunnel/hosted deployments.
