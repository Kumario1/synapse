# Plan 030: Add local `synapse insights`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and stop on any STOP condition. Update this plan's row
> in `plans/README.md` when done unless your reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- apps/cli/src/index.ts apps/cli/src/daemon.ts apps/cli/src/mcp.ts packages/protocol/src/index.ts packages/protocol/src/command-catalog.ts scripts README.md`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: 022 recommended
- **Category**: direction
- **Planned at**: commit `e3c46f2`, 2026-06-12

## Why this matters

Synapse records checks, warnings, feedback, branch demotions, active deltas,
and session/team state. Early users need a local way to see whether Synapse is
preventing coordination waste or just adding friction. A local CLI/MCP
`insights` report can show acted/dismissed warnings, noisy rules, unresolved
work, and top conflict areas without building the deferred analytics dashboard.

## Current state

Relevant files:

- `packages/protocol/src/index.ts` - feedback and TeamState types.
- `apps/cli/src/daemon.ts` - records check metrics and feedback endpoint.
- `apps/cli/src/index.ts` - CLI command dispatch/help.
- `apps/cli/src/mcp.ts` - MCP tool registrations.
- `packages/protocol/src/command-catalog.ts` - agent-facing tool catalog.
- `scripts/verify-feedback.mjs` - drives check -> feedback flows.
- `README.md` - command/verifier docs.

Current feedback storage types:

```ts
// packages/protocol/src/index.ts:348
export interface ConflictFeedback { ... }

// packages/protocol/src/index.ts:367
feedback: ConflictFeedback[];
```

Current daemon feedback endpoint:

```ts
// apps/cli/src/daemon.ts:542
if (request.method === "POST" && url.pathname === "/tools/synapse_feedback") {
  ...
}
```

Current metrics are counted during checks around `apps/cli/src/daemon.ts:447`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | exit 0 |
| Feedback verifier | `npm run verify:feedback` | exit 0 |
| New insights verifier | `npm run verify:insights` | exit 0 |

Use Node `20.19.x` or newer Node 20.

## Scope

**In scope**:

- `packages/protocol/src/index.ts` if adding request/response types
- `packages/protocol/src/command-catalog.ts`
- `apps/cli/src/daemon.ts`
- `apps/cli/src/index.ts`
- new `apps/cli/src/commands/insights.ts`
- `apps/cli/src/mcp.ts`
- `scripts/verify-insights.mjs` (create)
- `package.json`
- `README.md`

**Out of scope**:

- Hosted analytics.
- Persistent new analytics schema.
- Sending telemetry off-machine.
- Web dashboard work.

## Git workflow

- Branch: `advisor/030-add-local-synapse-insights`
- Commit style: `feat(cli): add local Synapse insights report`.

## Steps

### Step 1: Define a small insights response

Add protocol types only if needed. Keep the response local and aggregate-only:

- total feedback count;
- acted vs dismissed;
- top rules by feedback;
- active sessions count;
- unpushed deltas count;
- active edit locks count;
- recent unresolved conflicts if already available locally;
- branch demotion metrics only if already accessible without new storage.

Do not add a database table.

**Verify**: `npm run typecheck --workspace @synapse/protocol` -> exit 0 if protocol changed.

### Step 2: Add daemon endpoint and CLI command

Add `POST /tools/synapse_insights` or a comparable local endpoint in the daemon
that computes the report from current `teamState` and in-memory metrics.

Add `synapse insights` in CLI dispatch/help, modeled after existing command
files such as `commands/why.ts` or `commands/feedback.ts`.

**Verify**: `npm run typecheck --workspace @synapse/cli` -> exit 0.

### Step 3: Add MCP tool and catalog entry

Register `synapse_insights` as a read-only MCP tool. Add it to
`SYNAPSE_COMMAND_CATALOG` with usage `synapse insights`.

If plan 017 has landed, ensure generated agent guidance picks it up from the
catalog. If not, do not duplicate plan 017; just add the catalog entry.

**Verify**: `npm run verify:mcp-adapter` -> exit 0.

### Step 4: Add verifier

Create `scripts/verify-insights.mjs`:

- start server and two daemon sessions;
- trigger at least one check/conflict;
- send acted/dismissed feedback;
- call CLI or daemon insights;
- assert counts and top-rule fields are present and correct.

Add `verify:insights` to `package.json` and README verifier table.

**Verify**: `npm run verify:insights` -> exit 0.

## Test plan

- New hermetic verifier for check -> feedback -> insights.
- Existing feedback verifier still passes.
- MCP adapter still passes.
- Full check passes.

## Done criteria

- [ ] `npm run check` exits 0.
- [ ] `npm run verify:feedback` exits 0.
- [ ] `npm run verify:insights` exits 0.
- [ ] `synapse insights` exists in CLI help.
- [ ] `synapse_insights` exists in MCP and command catalog.
- [ ] No telemetry leaves the machine.
- [ ] No files outside scope are modified.

## STOP conditions

Stop and report if:

- Meaningful insights require adding persistent analytics storage.
- Existing metrics are not accessible without a broad daemon metrics refactor.
- The report risks exposing raw code or secrets.

## Maintenance notes

Keep wording aggregate and coordination-focused. Avoid surveillance framing such
as ranking individual teammates.
