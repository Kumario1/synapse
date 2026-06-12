# Plan 006: Publish branch changes during active sessions

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a STOP condition occurs, stop and report instead of improvising. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 3a0b685..HEAD -- packages/protocol/src/index.ts packages/protocol/src/wire-schema.ts packages/protocol/src/wire-schema.test.ts apps/cli/src/daemon.ts apps/server/src/state.ts apps/server/src/state.test.ts scripts/verify-branch-aware-severity.mjs packages/conflict-engine/src/branch-aware.test.ts`
> If any in-scope file changed since this plan was written, compare the current-state excerpts below against the live code before proceeding.
>
> Known drift (verified by review on 2026-06-11): PRs #51 and #52 merged
> after this plan was stamped — the drift check WILL report
> `apps/cli/src/daemon.ts` and `packages/protocol/src/wire-schema.ts`; that
> alone is NOT a STOP. Re-verified anchors on the post-merge tree: the
> periodic heartbeat send is now at `daemon.ts:279` (was cited 265), the
> manual/session heartbeat at `daemon.ts:538` (was ~518), `makeSession`'s
> `branch:` at `daemon.ts:628` (was 601), and `currentGitBranch` is defined
> in `apps/cli/src/config.ts:203` (imported by the daemon). `state.ts:48`
> and `touchSession` (now `state.ts:180`) are unchanged. Locate by symbol
> (`grep -n 'session.heartbeat' apps/cli/src/daemon.ts` → 2 send sites),
> not by the cited line numbers.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: direction, correctness
- **Planned at**: commit `3a0b685`, 2026-06-11

## Why this matters

Branch-aware severity demotes cross-branch `dependency_changed` and `stale_base` conflicts to `info`. Session branches are currently captured at session start and may lag after a checkout, so a mid-session branch switch can produce wrong severity until reconnect. Publishing branch updates with heartbeats keeps branch-aware decisions tied to the actual current branch.

## Current state

- `packages/protocol/src/index.ts` documents that session branch can lag.
- `apps/cli/src/daemon.ts` sets branch in `makeSession`, sends heartbeats without branch, and sends push notifications with current branch.
- `apps/server/src/state.ts` touches sessions on heartbeat without branch updates.
- `scripts/verify-branch-aware-severity.mjs` validates branch-aware behavior using branches fixed at daemon startup.

Relevant excerpts:

```ts
// packages/protocol/src/index.ts:266
/**
 * The git branch this session is working on, when known. Optional and
 * additive: old clients never send it, detached HEAD omits it. Captured at
 * session start, so it can lag a mid-session checkout until the next
 * (re)connect.
 */
branch?: string;
```

```ts
// packages/protocol/src/index.ts:600
| WireEnvelope<"session.heartbeat", { repoId: string; sessionId: string }>
```

```ts
// apps/cli/src/daemon.ts:265
sendToServer("session.heartbeat", {
  repoId: config.repoId,
  sessionId: config.sessionId
});

// apps/cli/src/daemon.ts:601
branch: currentGitBranch(config.worktreeRoot)
```

```ts
// apps/server/src/state.ts:48
case "session.heartbeat":
  touchSession(state, repoId, store, message.payload.sessionId, now);
  break;
```

Repo conventions to match:

- Protocol changes are additive and backward compatible.
- Runtime schemas are loose for forward compatibility.
- Branch-aware logic itself lives in `packages/conflict-engine`; this plan should not change demotion rules.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit 0 |
| Protocol tests | `npm test --workspace @synapse/protocol` | exit 0 |
| Server tests | `npm test --workspace @synapse/server` | exit 0 |
| Branch-aware verify | `npm run verify:branch-aware-severity` | exit 0 |
| Protocol compatibility | `npm run verify:protocol-compat` | exit 0 |

## Scope

**In scope**:

- `packages/protocol/src/index.ts`
- `packages/protocol/src/wire-schema.ts`
- `packages/protocol/src/wire-schema.test.ts`
- `apps/cli/src/daemon.ts`
- `apps/server/src/state.ts`
- `apps/server/src/state.test.ts` if present or a new focused state test.
- `scripts/verify-branch-aware-severity.mjs`

**Out of scope**:

- Changing branch-aware severity rules.
- Adding branch names to old stored records retroactively.
- GitHub webhook branch handling; it already derives branch from refs.
- Reworking protocol version negotiation.

## Git workflow

- Branch: `advisor/006-live-branch-updates`
- Suggested commit: `feat(protocol): refresh session branch on heartbeat`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Make heartbeat branch additive in protocol types

In `packages/protocol/src/index.ts`, update the `session.heartbeat` payload type to include optional `branch?: string`.

Also update the `Session.branch` comment to remove the stale "can lag until reconnect" statement. Replace it with a note that new clients refresh branch on heartbeat and old clients may omit it.

**Verify**: `npm run typecheck` -> exit 0 immediately (the field is optional and additive; nothing consumes it yet, so no consumer updates are needed for this step to pass).

### Step 2: Update runtime schema and tests

In `packages/protocol/src/wire-schema.ts`, allow optional `branch` in the `session.heartbeat` payload schema.

In `packages/protocol/src/wire-schema.test.ts`, add a heartbeat case with branch:

```ts
{ ...base, type: "session.heartbeat", payload: { repoId: "local", sessionId: "alice", branch: "feature-x" } }
```

Keep the existing heartbeat-without-branch case to prove backward compatibility.

**Verify**: `npm test --workspace @synapse/protocol` -> exit 0.

### Step 3: Send current branch on all daemon heartbeats

In `apps/cli/src/daemon.ts`, include `branch: currentGitBranch(config.worktreeRoot)` in
both `session.heartbeat` send sites (find them with
`grep -n 'session.heartbeat' apps/cli/src/daemon.ts` — ~line 279 periodic,
~line 538 in the `/tools/synapse_session` action path):

Do not include branch when `currentGitBranch` returns `undefined`; preserve optional-field semantics if the helper currently omits detached HEAD.

**Verify**: `npm run typecheck` -> exit 0.

### Step 4: Persist branch updates on heartbeat

In `apps/server/src/state.ts`, change heartbeat handling so it passes optional branch into `touchSession`. Update `touchSession` to:

- Always update `lastSeen`.
- Keep current status behavior.
- If `branch` is present and non-empty, set `session.branch = branch`.
- If `branch` is omitted, leave the existing branch unchanged for older clients.

Add or update state tests for:

- Heartbeat updates branch from `main` to `feature-x`.
- Heartbeat without branch does not clear a known branch.

**Verify**: `npm test --workspace @synapse/server` -> exit 0.

### Step 5: Extend branch-aware integration verification

In `scripts/verify-branch-aware-severity.mjs`, add a mid-session branch switch scenario:

1. Start Alice on `feature-x` and Bob on `main` as the script already does.
2. After initial startup, switch Alice's temp repo to a new branch, for example `feature-y`, using a git command in Alice's temp worktree.
3. Call Alice's local `/tools/synapse_session` with `{ action: "heartbeat" }` or wait for a fast heartbeat if the script already has a test knob.
4. Assert the server state shows Alice's session branch as `feature-y`.
5. Assert a conflict counterpart branch surfaces as `feature-y`.

Keep the existing branch-aware assertions.

**Verify**: `npm run verify:branch-aware-severity` -> exit 0.

### Step 6: Confirm protocol compatibility

Because this is an additive v1 payload field and schemas are loose, protocol compatibility should still pass.

**Verify**: `npm run verify:protocol-compat` -> exit 0.

## Test plan

- Protocol schema test for heartbeat with and without branch.
- Server state test for branch update and branch preservation.
- Integration verifier for mid-session checkout and updated conflict counterpart branch.

## Done criteria

- [ ] Heartbeats can carry optional `branch`.
- [ ] New clients send current branch on periodic and manual heartbeat.
- [ ] Server updates session branch when heartbeat includes it.
- [ ] Heartbeat without branch remains backward compatible.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm test --workspace @synapse/protocol` exits 0.
- [ ] `npm test --workspace @synapse/server` exits 0.
- [ ] `npm run verify:branch-aware-severity` exits 0.
- [ ] `npm run verify:protocol-compat` exits 0.
- [ ] `plans/README.md` status row for Plan 006 is updated.

## STOP conditions

Stop and report if:

- Protocol negotiation requires a version bump for this additive field.
- Updating branch on heartbeat would clear branch for older clients.
- The branch-aware verifier cannot switch branches in its temp git repos without adding real remotes or commits.
- A verification command fails twice after a focused fix attempt.

## Maintenance notes

Future session metadata that can change during a daemon lifetime should follow this same pattern: optional on heartbeat, preserve old values when omitted, and verify compatibility with old clients.

