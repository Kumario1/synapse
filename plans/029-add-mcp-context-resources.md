# Plan 029: Add MCP-native context resources

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and stop on any STOP condition. Update this plan's row
> in `plans/README.md` when done unless your reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- apps/cli/src/mcp.ts apps/cli/src/connect.ts packages/protocol/src/command-catalog.ts scripts/verify-mcp-adapter.mjs README.md`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW/MED
- **Depends on**: 017 recommended
- **Category**: direction
- **Planned at**: commit `e3c46f2`, 2026-06-12

## Why this matters

Synapse already exposes MCP tools and an `instructions` string. MCP clients
vary in how reliably they follow instructions, but many can list and read
resources natively. Exposing read-only resources such as team briefing,
current state, and recent decisions makes context retrieval discoverable
without depending only on rules-file compliance.

## Current state

Relevant files:

- `apps/cli/src/mcp.ts` - registers MCP tools only.
- `apps/cli/src/connect.ts` - agent guidance string/rules files.
- `packages/protocol/src/command-catalog.ts` - command catalog from plan 016.
- `scripts/verify-mcp-adapter.mjs` - MCP verifier.
- `README.md` - "Works with any agent" docs.

Current MCP server:

```ts
// apps/cli/src/mcp.ts:49
const server = new McpServer(serverInfo, { instructions: SYNAPSE_AGENT_GUIDANCE });

// apps/cli/src/mcp.ts:51
server.registerTool("synapse_check", ...);
```

Existing read-only tools include:

```ts
// apps/cli/src/mcp.ts:249
server.registerTool("synapse_whatsup", ...);

// apps/cli/src/mcp.ts:276
server.registerTool("synapse_onboard", ...);

// apps/cli/src/mcp.ts:303
server.registerTool("synapse_why", ...);
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck --workspace @synapse/cli` | exit 0 |
| CLI tests | `npm run build && npm test --workspace @synapse/cli` | exit 0 |
| MCP verifier | `npm run verify:mcp-adapter` | exit 0 |
| Full check | `npm run check` | exit 0 |

Use Node `20.19.x` or newer Node 20.

## Scope

**In scope**:

- `apps/cli/src/mcp.ts`
- `apps/cli/src/connect.ts` only for guidance wording
- `packages/protocol/src/command-catalog.ts` only if catalog/guidance needs a
  resource note
- `scripts/verify-mcp-adapter.mjs`
- `README.md`

**Out of scope**:

- New daemon endpoints unless existing endpoints cannot serve the resource.
- Changing MCP tool names.
- Replacing rules files or hooks.

## Git workflow

- Branch: `advisor/029-add-mcp-context-resources`
- Commit style: `feat(mcp): expose Synapse context resources`.

## Steps

### Step 1: Inspect the MCP SDK resource API

Use the installed `@modelcontextprotocol/sdk` types/examples in `node_modules`
or package docs in the repo to confirm the correct resource registration API.
Do not guess method names. If the SDK version lacks resource support, stop and
report.

**Verify**: identify the actual resource registration API in code/types before
editing.

### Step 2: Add read-only resources backed by existing daemon calls

Register at least these resources:

- `synapse://briefing` - returns the same information as `synapse_onboard` or
  `synapse_whatsup` in markdown or JSON;
- `synapse://team-state` - summarized current state from `/state` or
  `synapse_whatsup`;
- `synapse://decisions` - recent cited decisions/memories, using `synapse_why`
  or onboard context when available.

Keep them read-only and idempotent. Use existing `daemonPost()` patterns and
default repo/session resolution.

**Verify**: `npm run typecheck --workspace @synapse/cli` -> exit 0.

### Step 3: Extend MCP verification

Update `scripts/verify-mcp-adapter.mjs` to:

- list resources;
- read each new resource;
- assert each result is non-empty and includes the expected Synapse context
  shape;
- keep all existing tool-call assertions.

**Verify**: `npm run verify:mcp-adapter` -> exit 0.

### Step 4: Update guidance and docs

Update guidance so agents prefer resources for passive context and tools for
actions/checks. If plan 017 has landed in the target branch, update the
catalog-derived guidance path. If plan 017 has not landed, keep the wording
minimal and do not duplicate the command-reference work.

Update README's MCP section to mention resources.

**Verify**: `rg -n "synapse://briefing|resources|synapse://team-state|synapse://decisions" README.md apps/cli/src` -> matches expected docs/code.

## Test plan

- MCP verifier lists and reads resources.
- Existing MCP tool calls still pass.
- Guidance/docs mention resources without replacing hooks/tools.

## Done criteria

- [ ] `npm run check` exits 0.
- [ ] `npm run verify:mcp-adapter` exits 0.
- [ ] MCP clients can list/read the new resources.
- [ ] Resources are read-only and backed by existing daemon context.
- [ ] No files outside scope are modified.

## STOP conditions

Stop and report if:

- The installed MCP SDK does not support resources.
- Resource registration requires a breaking server transport change.
- Guidance edits conflict with unmerged plan 017 changes.

## Maintenance notes

Resources should not replace `synapse_check`/`synapse_report`. They are for
context; tools remain the action surface.
