# Plan 061: Surface teammates' live edit regions at session start

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If anything in the "STOP conditions" section occurs, stop and report;
> do not improvise.
>
> **Drift check (run first)**: `git diff --stat 249a9b4..HEAD -- apps/cli/src/briefings.ts apps/cli/src/briefings.test.ts scripts/verify-session-start.mjs README.md docs/adr/0003-reservations-deny-core-warn-radius.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: feature
- **Planned at**: commit `249a9b4`, 2026-06-19
- **Issue**: https://github.com/Kumario1/synapse/issues/128

## Why this matters

Issue #128 asks for the first, warn-only slice of task-scoped Reservations:
when a session joins, it should see teammates' live edit regions before it starts
work. The data already exists in `SynapseWhatsupResponse.sessions` and
`SynapseWhatsupResponse.editLocks`; the missing behavior is filtering expired or
ended-session locks and rendering those live regions in the SessionStart
briefing. Do not persist Reservation state and do not add a blocking `deny` path
in this issue.

## Current state

- `apps/cli/src/briefings.ts` builds both `synapse_whatsup` JSON and the
  SessionStart context.
- `apps/cli/src/hooks.ts` calls `sessionStartBriefing()` and stays silent when it
  returns `null`.
- `packages/protocol/src/index.ts` already exposes `sessions` and `editLocks` on
  `SynapseWhatsupResponse`; no protocol change is needed.
- `packages/conflict-engine/src/index.ts` already exports `editLockIsActive()`;
  reuse it instead of duplicating TTL math.
- `scripts/verify-session-start.mjs` is the existing end-to-end SessionStart
  verifier.

Relevant excerpts:

```ts
// apps/cli/src/briefings.ts:13-16
/** Build the catch-up text from a whatsup briefing, excluding the reader's own work. */
export function sessionStartBriefing(briefing: SynapseWhatsupResponse, selfSessionId: string): string | null {
  const sections: string[] = [];
```

```ts
// apps/cli/src/briefings.ts:35-43
const othersDeltas = briefing.unpushedDeltas.filter((delta) => delta.sessionId !== selfSessionId);
if (othersDeltas.length > 0) {
  sections.push(
    `Teammates' unpushed contract changes:\n${othersDeltas
      .slice(0, 5)
      .map((delta) => `  • ${delta.memberLogin}: ${delta.symbolId.raw} (${delta.changeKind})`)
      .join("\n")}`
  );
}
```

```ts
// apps/cli/src/briefings.ts:73-78,128
const activeSessions = state.sessions
  .filter((session) => session.status !== "ended")
  .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
const unpushedDeltas = [...state.unpushedDeltas]
  .filter((delta) => delta.pushedAt === null)
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
...
editLocks: state.editLocks.slice(0, limit),
```

```ts
// packages/conflict-engine/src/index.ts:63-66
export function editLockIsActive(lock: EditLock, now = Date.now()): boolean {
  const acquiredAt = Date.parse(lock.acquiredAt);
  return Number.isNaN(acquiredAt) || now - acquiredAt <= lock.ttlSec * 1000;
}
```

## Commands you will need

| Purpose               | Command                             | Expected on success                     |
| --------------------- | ----------------------------------- | --------------------------------------- |
| Install               | `npm ci`                            | exit 0                                  |
| Build                 | `npm run build`                     | exit 0                                  |
| CLI tests             | `npm test --workspace @synapse/cli` | exit 0                                  |
| SessionStart verifier | `npm run verify:session-start`      | exit 0 and prints session-start context |
| Typecheck             | `npm run typecheck`                 | exit 0                                  |
| Lint                  | `npm run lint`                      | exit 0                                  |

## Scope

**In scope**:

- `apps/cli/src/briefings.ts`
- `apps/cli/src/briefings.test.ts`
- `scripts/verify-session-start.mjs`
- `README.md`
- `docs/adr/0003-reservations-deny-core-warn-radius.md`

**Out of scope**:

- Protocol schema changes.
- Persisted `Reservation` state.
- PreToolUse `deny` behavior.
- Owner dashboard Reservation UI.
- Server store migrations.

## Git workflow

- Branch: `feat/128-session-join-active-regions`
- Commit message: `feat(cli): surface live edit regions on session start`
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Filter whatsup edit locks to live active-session locks

In `apps/cli/src/briefings.ts`, import `editLockIsActive` from
`@synapse/conflict-engine`. In `buildWhatsupResponse()`, compute live-region
session ids from sessions whose `status` is exactly `"active"`, then compute
`activeEditLocks` by keeping only locks where:

- `editLockIsActive(lock)` is true.
- `lock.sessionId` is in the live-region session id set.

Use `activeEditLocks.length` in the summary line and return
`editLocks: activeEditLocks.slice(0, limit)`.

**Verify**: `npm run build` -> exit 0.

### Step 2: Render teammates' live regions in SessionStart context

In `sessionStartBriefing()`, group `briefing.editLocks` by teammate session after
excluding `selfSessionId`. Use `briefing.sessions` to label each group with
`memberLogin` when present, falling back to the session id. Add a section only
when at least one teammate lock remains. Suggested heading:

```text
Teammates' live edit regions:
  • alice: ts:src/auth/token.ts#validate in src/auth/token.ts
```

If a teammate has multiple locks, keep one bullet per lock. Keep the existing
silent behavior when there are no sections.

**Verify**: `npm run build` -> exit 0.

### Step 3: Add focused unit coverage

In `apps/cli/src/briefings.test.ts`, extend the existing imports to include
`buildWhatsupResponse` and `sessionStartBriefing`. Add tests that prove:

- Active teammate locks appear in `sessionStartBriefing()`.
- The reader's own locks do not appear.
- Expired locks and locks owned by ended sessions are omitted by
  `buildWhatsupResponse()`.
- No live teammate locks means no "live edit regions" section.

Use `createEmptyTeamState()` and small literal sessions/locks. Do not add a new
test framework.

**Verify**: `npm run build && npm test --workspace @synapse/cli` -> exit 0.

### Step 4: Extend the end-to-end SessionStart verifier

In `scripts/verify-session-start.mjs`, after both daemons are healthy and before
Bob's SessionStart hook runs, have Alice call `synapse_check` for
`src/auth/token.ts` / `ts:src/auth/token.ts#validate`. Wait until Bob's daemon
state contains Alice's edit lock. Assert Bob's SessionStart context includes:

- The "Teammates' live edit regions" heading.
- Alice's symbol id.
- Alice's file path.

Keep the existing unpushed-delta and push assertions.

**Verify**: `npm run verify:session-start` -> exit 0.

### Step 5: Update docs

Update `README.md` so the Team briefings feature mentions live edit regions.
Add `docs/adr/0003-reservations-deny-core-warn-radius.md` from the accepted ADR
text if it is still absent, and mark issue #128 as the first warn-only slice in
its remaining-work section.

**Verify**: `npm run lint` -> exit 0.

## Test plan

- Unit tests in `apps/cli/src/briefings.test.ts` cover filtering and rendering.
- `scripts/verify-session-start.mjs` covers the real hook path:
  teammate active lock -> session-start context includes the region.
- Existing `verify:whatsup` continues to cover JSON briefing basics.

## Done criteria

All must hold:

- [ ] `npm run build` exits 0.
- [ ] `npm test --workspace @synapse/cli` exits 0.
- [ ] `npm run verify:session-start` exits 0.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run lint` exits 0.
- [ ] SessionStart live-region output is warn-only context; no `deny`, prompt,
      or block path is added.
- [ ] No files outside the in-scope list are modified, except `plans/README.md`
      if the reviewer updates the plan index.

## STOP conditions

Stop and report if:

- `SynapseWhatsupResponse` no longer includes both `sessions` and `editLocks`.
- Adding live-region context appears to require protocol or server-store changes.
- `synapse_check` no longer creates an edit lock through the daemon path.
- The missing ADR file turns out to be intentionally excluded from the repo by a
  maintainer decision.

## Maintenance notes

This is the deterministic floor for Reservations: live `EditLock`s only. Future
work can add persisted radius Reservations and `deny` for live same-symbol
collisions, but this issue must stay advisory and session-start-only. Reviewers
should scrutinize expiry/session filtering because stale locks are the main way
this feature becomes noisy.
