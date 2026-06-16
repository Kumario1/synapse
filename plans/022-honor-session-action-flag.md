# Plan 022: Honor `synapse session --action` regardless of argument order

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and stop on any STOP condition. Update this plan's row
> in `plans/README.md` when done unless your reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- apps/cli/src/commands/session.ts packages/protocol/src/command-catalog.ts scripts/verify-join-config.mjs scripts/verify-mcp-adapter.mjs apps/cli/src/config.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `e3c46f2`, 2026-06-12

## Why this matters

The command catalog documents `synapse session --action <action>`, but the CLI
ignores `flags.action` and chooses the first raw non-flag token. A valid call
like `synapse session --task "wrap up" --action end` can send action
`"wrap up"` and the daemon treats it as a heartbeat. That skips the session
summary and session-end cleanup.

## Current state

Relevant files:

- `apps/cli/src/commands/session.ts` - session CLI command.
- `apps/cli/src/config.ts` - `parseFlags()` implementation.
- `packages/protocol/src/command-catalog.ts` - documented usage.
- `scripts/verify-join-config.mjs` and `scripts/verify-mcp-adapter.mjs` -
  existing CLI/MCP verification style.

Current parser:

```ts
// apps/cli/src/commands/session.ts:5
const flags = parseFlags(rawArgs);
const defaults = commandDefaults(flags);
const action = (rawArgs.find((arg) => !arg.startsWith("--")) ?? "heartbeat") as
  | "start"
  | "end"
  | "heartbeat";
```

Current documented usage:

```ts
// packages/protocol/src/command-catalog.ts:67
usage: "synapse session --action <action>"
```

Daemon behavior:

```ts
// apps/cli/src/daemon.ts:573
if (action === "end") { ... } else if (action === "start") { ... } else { heartbeat }
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck --workspace @synapse/cli` | exit 0 |
| CLI tests | `npm run build && npm test --workspace @synapse/cli` | exit 0 |
| Join verifier | `npm run verify:join-config` | exit 0 |
| MCP verifier | `npm run verify:mcp-adapter` | exit 0 |

Use Node `20.19.x` or newer Node 20.

## Scope

**In scope**:

- `apps/cli/src/commands/session.ts`
- Optional CLI test/verifier changes under `apps/cli/src/*.test.ts` or
  `scripts/verify-*.mjs`

**Out of scope**:

- Changing protocol request schemas.
- Changing daemon session semantics.
- Rewriting `parseFlags()` globally.

## Git workflow

- Branch: `advisor/022-honor-session-action-flag`
- Commit style: `fix(cli): honor session action flag`.

## Steps

### Step 1: Prefer `flags.action`

Update `runSession()` so action resolution is:

1. `flags.action` when present;
2. otherwise a positional action token among `start`, `heartbeat`, `end`;
3. otherwise `"heartbeat"`.

Do not allow flag values like the `--task` value to become the action.
Validate unknown actions locally and print/throw a clear error instead of
silently heartbeat.

**Verify**: `npm run typecheck --workspace @synapse/cli` -> exit 0.

### Step 2: Add regression coverage

Add or extend a verifier so it exercises these cases:

- `synapse session --action start`
- `synapse session --task "done" --action end`
- `synapse session end --task "done"` remains accepted if positional action
  was previously supported.
- invalid `--action nope` fails clearly and does not call heartbeat.

Prefer a small CLI unit test if command tests already exist after build;
otherwise extend `scripts/verify-join-config.mjs` because it already calls
`session`.

**Verify**: `npm run build && npm test --workspace @synapse/cli` -> exit 0.

### Step 3: Run integration gates

Run the existing join and MCP verifiers to ensure both CLI and MCP session
paths still work.

**Verify**: `npm run verify:join-config && npm run verify:mcp-adapter` -> exit 0.

## Test plan

- Regression for `--task ... --action end` selecting `end`, not the task text.
- Regression for invalid action.
- Existing MCP adapter session call remains unchanged.

## Done criteria

- [ ] `npm run verify:join-config` exits 0.
- [ ] `npm run verify:mcp-adapter` exits 0.
- [ ] `npm run check` exits 0.
- [ ] `runSession()` uses `flags.action`.
- [ ] No files outside scope are modified.

## STOP conditions

Stop and report if:

- `parseFlags()` cannot represent `--action` without a broader parser change.
- Existing docs intentionally support arbitrary session actions.

## Maintenance notes

When adding future CLI flags, avoid selecting action-like positional values
from raw args without first excluding flag values.
