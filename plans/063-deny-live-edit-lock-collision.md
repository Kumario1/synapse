# Plan 063: Deny PreToolUse on live same-symbol edit-lock collisions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 1c17d41..HEAD -- apps/cli/src/hooks.ts apps/cli/src/connect.ts scripts/verify-hooks.mjs README.md synapse-technical-spec.md docs/adr/0003-reservations-deny-core-warn-radius.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: plans/062-persist-session-reservations.md
- **Category**: bug
- **Planned at**: commit `1c17d41`, 2026-06-19
- **Issue**: https://github.com/Kumario1/synapse/issues/130

## Why this matters

Issue #130 is the deny-core half of ADR 0003. Synapse already detects the exact
case where one live session is editing a symbol that another session is about to
edit (`same_symbol_active`), but the Claude `PreToolUse` hook still returns
`ask` for every surfaced conflict. For this one live mutual-exclusion case,
cooperating agents should be blocked with `permissionDecision: "deny"` so they
do not start work inside another active editor's lock. All dependency-radius and
unpushed-contract cases must remain advisory.

## Current state

- `apps/cli/src/hooks.ts` builds the Claude `PreToolUse` hook response. It
  always returns `permissionDecision: "ask"` after the `SYNAPSE_HOOK_NONBLOCKING`
  allow/context escape hatch.
- `packages/conflict-engine/src/index.ts` already emits `same_symbol_active`
  for active peer `EditLock`s. No detection change is needed.
- `scripts/verify-hooks.mjs` drives the real hook command end to end, but it
  only asserts that a `contract_divergent` warning returns `ask`.
- `apps/cli/src/connect.ts`, `README.md`, and `synapse-technical-spec.md`
  still contain "never auto-block" language that becomes false after this
  narrow deny path lands.
- `docs/adr/0003-reservations-deny-core-warn-radius.md` already records the
  accepted decision and lists the hook flip as remaining work.

Relevant excerpts at `1c17d41`:

`apps/cli/src/hooks.ts:267-312`

```ts
/**
 * Build the Claude Code `PreToolUse` response that surfaces a conflict. Default
 * is `ask` so the developer decides (proceed/adjust/ping) - the "agents query,
 * humans decide" principle - never an auto-block. Set `SYNAPSE_HOOK_NONBLOCKING=1`
 * to instead inject the heads-up as context and proceed without a prompt.
 */
function preToolUseDecision(filePath: string, result: SynapseCheckResponse): unknown {
  ...
  if (process.env.SYNAPSE_HOOK_NONBLOCKING === "1") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        additionalContext: message
      }
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: message
    }
  };
}
```

`packages/conflict-engine/src/index.ts:77-90`

```ts
for (const lock of context.state.editLocks.filter((candidate) => editLockIsActive(candidate))) {
  if (lock.sessionId === context.selfSessionId) {
    continue;
  }

  if (sameSymbol(lock.symbolId, targetSymbol)) {
    addConflict(conflicts, {
      severity: "warn",
      rule: "same_symbol_active",
      targetSymbol,
      counterpart: counterpartFor(context.state.sessions, lock.sessionId),
      detail: `${labelFor(lock.sessionId, context.state.sessions)} is actively editing ${targetSymbol.raw}.`,
      suggestion: "Coordinate on the intended contract before continuing."
    });
  }
}
```

`scripts/verify-hooks.mjs:98-109`

```js
const preOut = await runHookStage("pre", bobRoot, join(bobRoot, filePath));
assert.ok(preOut, "hook pre emitted a decision for a conflicting edit");
const out = preOut.hookSpecificOutput;
assert.equal(out.hookEventName, "PreToolUse");
assert.equal(out.permissionDecision, "ask", "warn surfaces as ask - the developer decides");
assert.ok(out.permissionDecisionReason.includes("Synapse"), "reason is a Synapse heads-up");
assert.ok(
  out.permissionDecisionReason.includes("contract_divergent"),
  "reason names the contract_divergent rule"
);
assert.ok(out.permissionDecisionReason.includes("alice"), "reason names the counterpart");
```

`apps/cli/src/connect.ts:20`

```ts
2. BEFORE EDITING - before you create, edit, or refactor a file, call `synapse_check` with that file (and the symbol(s) you intend to change). If it returns conflicts (verdict "warn" or higher), surface them to the user and decide together before proceeding. Synapse never auto-blocks - agents query, humans decide. (Equivalent to the PreToolUse hook on Edit/Write/MultiEdit.)
```

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `npm ci` | exit 0 |
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0, no TS errors |
| CLI tests | `npm run build --workspace @synapse/cli && npm test --workspace @synapse/cli` | exit 0 |
| Hook verifier | `npm run verify:hooks` | exit 0, includes the deny and nonblocking hook cases |
| Strict agent loop | `npm run ci:strict:agent-loop` | exit 0, 16/16 green |
| Root tests | `SYNAPSE_PYTHON_BASE=/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12 npm test` | exit 0 |
| Lint | `npm run lint` | exit 0; warning-level findings may remain |
| Format check | `npm run format:check` | exit 0 |

## Scope

**In scope**:

- `apps/cli/src/hooks.ts`
- `apps/cli/src/connect.ts`
- `scripts/verify-hooks.mjs`
- `README.md`
- `synapse-technical-spec.md`
- `docs/adr/0003-reservations-deny-core-warn-radius.md`
- `plans/063-deny-live-edit-lock-collision.md`
- `plans/README.md`

**Out of scope**:

- `packages/conflict-engine/src/index.ts`: `same_symbol_active` detection already exists.
- Reservation-radius enforcement, task-to-reservation matching, or dependency-derived `deny`.
- Owner dashboard reservation UI; that is issue #131.
- Any protocol version bump. This changes hook handling of an existing conflict rule only.

## Git workflow

- Branch: `fix/130-deny-live-lock-collision`
- Commit message: `fix(cli): deny live edit-lock hook collisions`
- Keep one focused PR for issue #130.
- Do not push or merge until local gates pass.

## Steps

### Step 1: Make `same_symbol_active` the only blocking hook conflict

In `apps/cli/src/hooks.ts`, update `preToolUseDecision` so it computes:

```ts
const blocksEdit = result.conflicts.some((conflict) => conflict.rule === "same_symbol_active");
```

Keep the existing message construction unchanged so the reason still names the
holder and symbol through the existing conflict detail line. Keep
`SYNAPSE_HOOK_NONBLOCKING=1` as the first return after message construction:
nonblocking mode must still return `permissionDecision: "allow"` with
`additionalContext`.

For normal mode, return `permissionDecision: blocksEdit ? "deny" : "ask"`.
Keep the field name `permissionDecisionReason` for both `deny` and `ask`.

Also update the function comment. It should say the default is advisory `ask`
except for `same_symbol_active`, which denies because another live session holds
the symbol's edit lock.

**Verify**: `npm run build --workspace @synapse/cli` -> exit 0.

### Step 2: Extend the hook verifier for deny, nonblocking, and ended-holder cases

In `scripts/verify-hooks.mjs`, add a new phase before the existing divergent
contract phase:

1. Have Alice acquire the live lock by posting `synapse_check` to her daemon for
   `filePath` and `symbol`.
2. Wait for server state to show Alice's active edit lock for `symbol`.
3. Run Bob's `hook pre` for the same file and assert:
   - a decision is emitted,
   - `hookEventName === "PreToolUse"`,
   - `permissionDecision === "deny"`,
   - `permissionDecisionReason` includes `same_symbol_active`,
   - the reason includes `alice`,
   - the reason includes the symbol string.
4. Run Bob's `hook pre` again with `SYNAPSE_HOOK_NONBLOCKING=1` in the hook
   process environment and assert:
   - `permissionDecision === "allow"`,
   - `additionalContext` includes `same_symbol_active`,
   - no `permissionDecisionReason` is required.
5. End Alice's session through `synapse_session` or the existing helper path,
   wait until Alice's edit lock is gone, and run Bob's `hook pre` again for the
   same file. Assert this no longer returns `deny` for `same_symbol_active`.

To support step 4 without duplicating process code, extend `runHookStage` to
accept an optional env object and merge it into the child process env.

Keep the existing `contract_divergent` assertion and update its message to say
`contract_divergent` remains `ask`. That covers an unrelated surfaced-conflict
case staying advisory.

Do not change the conflict engine to satisfy these tests; the server already
clears locks on `session.end`, and the engine already ignores expired locks.

**Verify**: `npm run verify:hooks` -> exit 0 and prints the hook verification
summary.

### Step 3: Update agent-facing guidance and docs

Update docs and generated guidance so they no longer claim Synapse never blocks:

- `apps/cli/src/connect.ts`: revise the BEFORE EDITING rule to say the only
  blocking case is a live same-symbol edit-lock collision; all other conflicts
  remain advisory and should be surfaced to the user.
- `README.md`: update the "Works with any agent" / hook description and any
  nearby "agents query, humans decide" wording to mention `same_symbol_active`
  denial. Do not rewrite unrelated product copy.
- `synapse-technical-spec.md`: update the Claude hook section and the conflict
  pseudocode from `WARN (same_symbol_active)` / no auto-block to deny-core
  language.
- `docs/adr/0003-reservations-deny-core-warn-radius.md`: mark the hook flip as
  shipped in issue #130 while leaving issue #131 dashboard work outstanding.

If a changelog exists, update it. If no changelog exists, do not create one.

**Verify**: `rg -n "never auto-block|no auto-block|agents query, humans decide" README.md synapse-technical-spec.md apps/cli/src/connect.ts docs/adr/0003-reservations-deny-core-warn-radius.md` -> either no matches or only historically accurate ADR context that explicitly notes the old behavior.

### Step 4: Run full local gates and update the plan index

Run the listed local gates. If `npm run lint` exits 0 with existing warnings,
record that in the PR body; do not chase unrelated warning cleanup.

Update `plans/README.md` row 063 to `DONE` only after all local gates pass.
Mention that #130 intentionally excludes dependency-radius deny and dashboard UI.

**Verify**:

- `npm run build` -> exit 0.
- `npm run typecheck` -> exit 0.
- `npm run lint` -> exit 0.
- `npm run ci:strict:agent-loop` -> 16/16 green.
- `SYNAPSE_PYTHON_BASE=/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12 npm test` -> exit 0.
- `git diff --check` -> exit 0.

## Test plan

- Extend `scripts/verify-hooks.mjs` because it already runs the exact
  `synapse hook pre` executable path Claude Code uses.
- Required new assertions:
  - live lock held by Alice on Bob's target symbol -> `permissionDecision:
    "deny"`;
  - `SYNAPSE_HOOK_NONBLOCKING=1` for that same conflict -> `permissionDecision:
    "allow"` with context;
  - after Alice's session ends and her lock is released -> Bob no longer gets a
    `same_symbol_active` deny;
  - existing `contract_divergent` surfaced conflict -> still `ask`.
- Existing conflict-engine tests already cover expired edit locks; keep them
  unchanged unless they fail due to a real regression.

## Done criteria

- [ ] `same_symbol_active` is the only conflict rule that yields hook
  `permissionDecision: "deny"` in normal mode.
- [ ] `SYNAPSE_HOOK_NONBLOCKING=1` still yields `permissionDecision: "allow"`
  and context for the deny-core case.
- [ ] `contract_divergent`, `same_symbol_unpushed`, `dependency_changed`, and
  transitive/dependency-radius conflicts remain advisory (`ask`, `warn`, or
  `info` as before).
- [ ] The hook does not throw or emit a decision for quiet/out-of-tree/error
  paths; existing quiet hook assertion remains.
- [ ] Documentation describes deny-core accurately and does not imply broad
  auto-blocking.
- [ ] `plans/README.md` contains plan 063 with `DONE` after verification.
- [ ] All commands in Step 4 pass.

## STOP conditions

Stop and report back if:

- `same_symbol_active` is not present in the hook response for an active peer
  edit lock after Alice runs `synapse_check`; that means the issue is no longer
  a hook-only change.
- Making `deny` work requires changing conflict detection or protocol schema.
- Nonblocking mode cannot be preserved without changing Claude hook output
  shape.
- A doc update would need to redefine ADR 0002 or broaden `deny` beyond
  `same_symbol_active`.

## Maintenance notes

- Issue #131 should build on this by showing live Reservations to Owners, not by
  broadening `deny`.
- Future task-to-reservation matching must remain warn-only unless a new ADR
  explicitly extends enforcement beyond the live edit-lock core.
- Reviewers should scrutinize the hook verifier: it must exercise the real
  child-process hook path, not just a helper function.
