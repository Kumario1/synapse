# Plan 020: Pin GitHub webhook repo ids to the signed payload

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and stop on any STOP condition. Update this plan's row
> in `plans/README.md` when done unless your reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- apps/server/src/github.ts apps/server/src/github.test.ts apps/server/src/index.ts scripts/verify-github-webhook.mjs scripts/verify-security.mjs`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `e3c46f2`, 2026-06-12

## Why this matters

GitHub signs the webhook body, not the URL query string. The server validates
the HMAC over the raw body, then passes `url.searchParams.get("repoId")` into
the payload converter. The converter currently prefers that override over the
payload's `repository.full_name`. A valid signed payload can therefore be
routed into a different Synapse repo by changing the webhook URL query.

## Current state

Relevant files:

- `apps/server/src/index.ts` - validates signature and calls converters.
- `apps/server/src/github.ts` - converts GitHub payloads into Synapse messages.
- `apps/server/src/github.test.ts` - converter unit tests.
- `scripts/verify-github-webhook.mjs` - end-to-end webhook verifier.

Current routing:

```ts
// apps/server/src/index.ts:485
const repoEvent = gitHubRepoEventToNotify(event, payload, url.searchParams.get("repoId"));

// apps/server/src/index.ts:503
const push = gitHubPushToNotify(payload, url.searchParams.get("repoId"));
```

Current converter preference:

```ts
// apps/server/src/github.ts:89
const repoId = repoIdOverride || stringAt(push.repository, "full_name") || "local";
```

Current tests intentionally assert override wins, for example
`apps/server/src/github.test.ts:21-24` expects `"local"` even though the
payload says `"Kumario1/synapse"`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Server tests | `npm test --workspace @synapse/server` after build | exit 0 |
| Webhook verify | `npm run verify:github-webhook` | exit 0 |
| Security verify | `npm run verify:security` | exit 0 |
| Full check | `npm run check` | exit 0 |

Use Node `20.19.x` or newer Node 20.

## Scope

**In scope**:

- `apps/server/src/github.ts`
- `apps/server/src/github.test.ts`
- `apps/server/src/index.ts` only if response handling needs a clearer error
- `scripts/verify-github-webhook.mjs`
- `scripts/verify-security.mjs`

**Out of scope**:

- Per-repo webhook secrets.
- Changing GitHub event support.
- Changing non-GitHub local `push.notify` behavior.

## Git workflow

- Branch: `advisor/020-pin-webhook-repo-id-to-signed-payload`
- Commit style: `fix(security): reject webhook repo id overrides that mismatch payload`.

## Steps

### Step 1: Centralize repo id resolution for GitHub payloads

In `apps/server/src/github.ts`, add a helper used by push, PR, review, and
issue-comment conversions:

- If `repository.full_name` exists and `repoIdOverride` is absent, use
  `repository.full_name`.
- If both exist and match exactly, use that value.
- If both exist and differ, throw an error that mentions repo mismatch.
- If `repository.full_name` is missing, keep the old fallback:
  `repoIdOverride || "local"`.

**Verify**: `npm run typecheck --workspace @synapse/server` -> exit 0.

### Step 2: Update unit tests

Change tests that currently expect override-wins behavior. Add explicit tests:

- push payload with matching override succeeds;
- push payload with mismatched override throws;
- `pull_request`, `pull_request_review`, and `issue_comment` mismatches throw;
- payload without repository can still use override for legacy/dev payloads.

**Verify**: `npm run build && npm test --workspace @synapse/server` -> exit 0.

### Step 3: Add or update end-to-end verification

Extend `scripts/verify-github-webhook.mjs` or `scripts/verify-security.mjs` to
send a signed payload with `repository.full_name = "owner/repo-a"` to a URL
containing `?repoId=owner/repo-b`. It should receive a 400 and should not
mutate `owner/repo-b`.

**Verify**: `npm run verify:github-webhook && npm run verify:security` -> exit 0.

## Test plan

- Unit tests prove converter semantics.
- End-to-end verifier proves the signed webhook path rejects mismatched query
  overrides.
- Full repo `npm run check` still passes.

## Done criteria

- [ ] `npm run check` exits 0.
- [ ] `npm run verify:github-webhook` exits 0.
- [ ] `npm run verify:security` exits 0.
- [ ] All GitHub converters reject mismatched payload/query repo ids.
- [ ] No files outside scope are modified.

## STOP conditions

Stop and report if:

- A documented production setup relies on using `repoId` to map GitHub
  `repository.full_name` to a different Synapse repo id.
- Fixing the verifier requires changing auth or signature validation.

## Maintenance notes

If Synapse later supports repo aliases, the alias mapping must be part of the
signed or authenticated configuration, not an unsigned webhook query override.
