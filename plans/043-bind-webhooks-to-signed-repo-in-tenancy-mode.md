# Plan 043: Strictly bind GitHub webhooks to the signed payload's repo in tenancy mode

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 6781b81..HEAD -- apps/server/src/index.ts apps/server/src/github.ts`
> If either changed, compare the "Current state" excerpts against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (tightening webhook repo resolution could reject a legitimately
  unusual delivery; mitigated by gating the new requirement to project-key mode
  only and leaving open/shared-token behavior unchanged)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `6781b81`, 2026-06-15

## Why this matters

The GitHub webhook handler is the **one** state-changing surface that never
calls `authorized()` — its only gate is the **server-wide**
`SYNAPSE_GITHUB_WEBHOOK_SECRET` HMAC. The target room comes from
`repoIdFromPayload`, which falls back to the attacker-controllable `?repoId=`
query param when the payload omits `repository.full_name`. In **project-key
mode** (the "real tenancy" mode), that means a holder of the single shared
webhook secret can inject `repo.event` / `push` prose (PR titles, distilled
comment bodies, file paths) into **any** tenant's room — polluting another
tenant's briefings and `synapse why` / RAG decision memory — by sending a signed
body with no `full_name` and `?repoId=victim/repo`. This plan closes the
`?repoId=` retargeting vector by requiring `repository.full_name` and binding
strictly to it in tenancy mode. (The deeper "webhook secret is not per-repo"
issue is scoped as a documented follow-up — see Maintenance notes — because it
requires a per-repo webhook-secret scheme and operator setup change, and the
hosted multi-tenant mode that makes it acute is not yet launched.)

## Current state

- `apps/server/src/github.ts:302-309` — repo resolution trusts the override when
  `full_name` is absent:

```ts
function repoIdFromPayload(repository: unknown, repoIdOverride?: string | null): string {
  const repoFullName = stringAt(repository, "full_name");
  if (repoFullName && repoIdOverride && repoFullName !== repoIdOverride) {
    throw new Error("GitHub webhook repository.full_name does not match repoId.");
  }
  return repoFullName || repoIdOverride || "local";   // ← override trusted when full_name absent
}
```

- `apps/server/src/index.ts:462-543` — `handleGitHubWebhook`: rate-limit → secret
  posture check → read body → `validGitHubSignature` (only `if (secret)`) → parse
  → dispatch to `gitHubRepoEventToNotify` / `gitHubPushToNotify` with
  `url.searchParams.get("repoId")`. It never calls `authorized()`.
- `apps/server/src/index.ts:506-512` — `payload` is parsed (as `unknown`) and
  available before dispatch:

```ts
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    writeJson(response, 400, { ok: false, error: "invalid_json" });
    return;
  }
```

- `apps/server/src/index.ts:560-563` — the dispatch `try/catch` returns
  `400 { error: <message> }` on any thrown error.
- `apps/server/src/index.ts:478-488` — the existing tenancy posture check shows
  the `authMode !== "open"` gate + `synapse_webhook_rejections_total` metric
  pattern to mirror.
- `apps/server/src/github.ts:339-345` — `stringAt(value, key)` and
  `isRecord` (`:380-381`) are module-private safe readers (good building blocks
  for a small exported helper).

## Commands you will need

| Purpose   | Command                              | Expected on success |
|-----------|--------------------------------------|---------------------|
| Build     | `npm run build`                      | exit 0              |
| Typecheck | `npm run typecheck`                   | exit 0, no errors   |
| Server unit tests | `npm test --workspace @synapse/server` | all pass     |
| Webhook verify | `npm run verify:github-webhook` | exit 0, ends `PASS` |
| Tenancy verify | `npm run verify:tenancy`        | exit 0, ends `PASS` |

## Scope

**In scope**:
- `apps/server/src/github.ts` — add an exported `webhookRepoFullName(payload)`
  helper.
- `apps/server/src/index.ts` — in project-key mode, require `full_name` before
  dispatch.
- `apps/server/src/github.test.ts` — unit-test the helper.
- `scripts/verify-github-webhook.mjs` — add a tenancy-mode rejection assertion.

**Out of scope**:
- **Open mode and shared-token mode** — behavior unchanged. Local/dev webhooks
  must keep working with no `full_name` (verify scripts rely on this). The new
  requirement applies ONLY when `authMode === "project-key"`.
- `repoIdFromPayload`'s existing mismatch throw — keep it (it's the consistency
  check); do not weaken it.
- The per-repo webhook-secret redesign — explicitly deferred (Maintenance notes).
- The HMAC verification / signature code — unchanged.

## Git workflow

- Branch: `advisor/043-bind-webhooks-to-signed-repo-in-tenancy-mode`
- Commit style: `fix(server): require signed repository.full_name for webhooks in tenancy mode`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Export a safe `webhookRepoFullName` helper from `github.ts`

In `apps/server/src/github.ts`, add (reusing the existing `stringAt`/`isRecord`):

```ts
/**
 * The signed payload's `repository.full_name`, or null when absent/blank. Used
 * to enforce that tenancy-mode webhooks bind to the repo the signature covers,
 * never to an attacker-supplied `?repoId=` override (plan 043).
 */
export function webhookRepoFullName(payload: unknown): string | null {
  return isRecord(payload) ? stringAt(payload.repository, "full_name") : null;
}
```

**Verify**: `npm run build` → exit 0.

### Step 2: Require `full_name` in project-key mode before dispatch

In `apps/server/src/index.ts`, import `webhookRepoFullName` from `./github.js`
(add to the existing import from that module), and insert a guard in
`handleGitHubWebhook` **after** the payload is parsed (`index.ts:512`) and
**before** the event dispatch (`index.ts:514`):

```ts
  // Tenancy binding (plan 043): in project-key mode the webhook secret is
  // server-wide, so the room MUST be pinned to the repo the signature covers —
  // never an attacker-supplied ?repoId=. Require repository.full_name; the
  // existing repoIdFromPayload mismatch check then makes ?repoId= a consistency
  // check only. Open/shared-token (local/dev) are unchanged.
  if (authMode === "project-key" && !webhookRepoFullName(payload)) {
    metrics.count("synapse_webhook_rejections_total", { reason: "repo_binding_required" });
    log.warn("webhook.repo_binding_required", { authMode });
    writeJson(response, 422, { ok: false, error: "repository_full_name_required" });
    return;
  }
```

Because `full_name` is now guaranteed present in this mode, `repoIdFromPayload`
returns it (the `?repoId=` override only applies when `full_name` is absent), so
the retargeting vector is closed without changing `repoIdFromPayload`.

**Verify**: `npm run build && npm run typecheck` → exit 0.

### Step 3: Unit-test the helper

In `apps/server/src/github.test.ts` (follow its existing `node:test` structure),
add tests for `webhookRepoFullName`:

- `{ repository: { full_name: "acme/widgets" } }` → `"acme/widgets"`.
- `{ repository: {} }` → `null`.
- `{}` → `null`.
- `null` / `"string"` / `42` → `null`.

**Verify**: `npm test --workspace @synapse/server` → all pass, including new tests.

### Step 4: Add a tenancy-mode rejection assertion to the webhook verifier

Read `scripts/verify-github-webhook.mjs` to see how it spawns the server and
posts signed webhook bodies. Add a case: boot the server with
`SYNAPSE_MASTER_SECRET` set (project-key mode) and `SYNAPSE_GITHUB_WEBHOOK_SECRET`
set, POST a correctly-**signed** body that has **no** `repository.full_name` with
`?repoId=someone/else`, and assert the response is **422**
`repository_full_name_required` and that no `repo.event`/`push` was written to
`someone/else` (a follow-up `GET /state?repoId=someone/else`, with the project
key for that repo, shows empty `recentRepoEvents`/`recentPushes`). Then assert a
signed body **with** `full_name` still succeeds (202). Match the script's
existing assertion/`PASS` style.

**Verify**: `npm run verify:github-webhook` → exit 0, ends `PASS`.

### Step 5: Confirm open-mode webhooks still work

**Verify**: `npm run verify:tenancy` → exit 0, ends `PASS` (shared-token /
project-key auth paths intact).

## Test plan

- Unit: `webhookRepoFullName` truth table in `github.test.ts`.
- Integration: `verify-github-webhook.mjs` gains a project-key-mode case proving
  (a) a signed body without `full_name` + `?repoId=victim` is rejected 422 and
  writes nothing, and (b) a signed body with `full_name` still succeeds.
- Regression: existing webhook cases (open mode, signed PR/push/comment) and
  `verify:tenancy` still pass.

## Done criteria

ALL must hold:

- [ ] `npm run build` exits 0
- [ ] `npm run typecheck` exits 0
- [ ] `npm test --workspace @synapse/server` exits 0; `webhookRepoFullName` tests exist and pass
- [ ] `npm run verify:github-webhook` exits 0 incl. the new 422 tenancy case
- [ ] `npm run verify:tenancy` exits 0
- [ ] In open mode, a webhook with no `full_name` still processes (asserted by existing cases)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- An existing verify script sends webhooks in a mode where it sets
  `SYNAPSE_MASTER_SECRET` *and* relies on a missing `full_name` — that would mean
  the 422 requirement breaks a legitimate flow; report it rather than loosening
  the guard.
- `authMode` is not in scope where you add the guard (it's a module-scope `const`
  in `index.ts`; confirm before referencing).
- The webhook signature is verified *before* the body is parsed and you find you
  must reorder parse-before-verify to read `full_name` — you should NOT need to:
  the guard runs after the existing parse at `index.ts:506-512`, which is already
  after signature verification. If the order looks different in the live code,
  STOP and report.

## Maintenance notes

- **Deferred (the real multi-tenant fix):** the webhook secret is still
  server-wide, so a holder of `SYNAPSE_GITHUB_WEBHOOK_SECRET` can still target an
  arbitrary repo by putting that repo's `full_name` in a crafted signed body.
  True tenant isolation needs a **per-repo webhook secret**, e.g. each tenant
  configures their GitHub webhook secret = `HMAC-SHA256(masterSecret, "webhook:" + repoId)`;
  the server derives the expected secret from the payload's `full_name` and
  verifies the signature against it, so a signature is cryptographically bound to
  one repo. That requires reordering verify-after-parse, a derivation helper, and
  a `synapse keygen --webhook` output for operators. Build it when hosted
  multi-tenant is actually on the roadmap (it is decision-gated today).
- Reviewer should confirm the 422 guard sits after parse and before dispatch, and
  that open/shared-token paths are untouched.
- Pairs with plan 040 (rate-limiting the read routes) — both harden the
  internet-reachable HTTP surface.
