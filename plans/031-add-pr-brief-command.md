# Plan 031: Add PR handoff briefing

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and stop on any STOP condition. Update this plan's row
> in `plans/README.md` when done unless your reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- apps/cli/src/index.ts apps/cli/src/daemon.ts apps/cli/src/mcp.ts packages/protocol/src/index.ts packages/protocol/src/command-catalog.ts apps/server/src/github.ts scripts README.md`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: 020, 029 recommended
- **Category**: direction
- **Planned at**: commit `e3c46f2`, 2026-06-12

## Why this matters

Synapse owns live coordination state while GitHub owns canonical review
history. Before opening or reviewing a PR, users need a concise handoff:
unresolved deltas, recent repo decisions, branch-relevant conflicts, and
teammate activity. A local `synapse pr-brief` command provides that without
building a GitHub App comment workflow or hosted OAuth.

## Current state

Relevant files:

- `apps/server/src/github.ts` - ingests PR/review/comment webhook events.
- `apps/server/src/index.ts` - indexes repo events into memory.
- `apps/cli/src/daemon.ts` - local daemon endpoints and why/onboard context.
- `apps/cli/src/index.ts` - CLI dispatch/help.
- `apps/cli/src/mcp.ts` - MCP tool registrations.
- `packages/protocol/src/command-catalog.ts` - agent-facing command catalog.
- `README.md` - command and verifier docs.

Existing GitHub event support:

```ts
// apps/server/src/index.ts:568
function repoEventSupported(event: string): boolean {
  return event === "pull_request" || event === "pull_request_review" || event === "issue_comment";
}
```

Existing README verifier:

```md
<!-- README.md:333 -->
| `verify:github-webhook` / `verify:github-briefing` | GitHub push/PR/review/comment webhooks and catch-ups |
```

No command currently focuses on PR handoff; README command list includes
`why`, `onboard`, and `mcp`, but no `pr-brief`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | exit 0 |
| GitHub briefing verifier | `npm run verify:github-briefing` | exit 0 |
| New PR brief verifier | `npm run verify:pr-brief` | exit 0 |

Use Node `20.19.x` or newer Node 20.

## Scope

**In scope**:

- `packages/protocol/src/index.ts` if adding request/response types
- `packages/protocol/src/command-catalog.ts`
- `apps/cli/src/daemon.ts`
- `apps/cli/src/index.ts`
- new `apps/cli/src/commands/pr-brief.ts`
- `apps/cli/src/mcp.ts` if exposing MCP `synapse_pr_brief`
- `scripts/verify-pr-brief.mjs` (create)
- `package.json`
- `README.md`

**Out of scope**:

- Posting comments to GitHub.
- GitHub OAuth/App installation changes.
- Hosted SaaS flow.
- Raw code upload.

## Git workflow

- Branch: `advisor/031-add-pr-brief-command`
- Commit style: `feat(cli): add PR handoff briefing`.

## Steps

### Step 1: Define the briefing inputs and output

Start local and markdown-first:

```bash
synapse pr-brief --base main --head <branch>
```

If `--head` is omitted, use the current git branch. Include:

- active sessions relevant to the branch when known;
- unpushed deltas and edit locks;
- recent pushes/repo events;
- recent decisions/memories from existing why/onboard sources;
- conservative branch/file filtering only when reliable.

Do not require network access to GitHub.

**Verify**: `npm run typecheck` -> exit 0 after adding any types.

### Step 2: Add daemon and CLI support

Add a daemon endpoint such as `/tools/synapse_pr_brief` that composes the
briefing from local `teamState` plus existing memory/why helpers. Add
`synapse pr-brief` CLI command and help text.

Keep output deterministic enough for tests. Markdown is fine; JSON is also
acceptable if existing commands prefer JSON.

**Verify**: `npm run typecheck --workspace @synapse/cli` -> exit 0.

### Step 3: Add MCP/catalog support

If the command is useful to agents, expose `synapse_pr_brief` as a read-only
MCP tool and add it to `SYNAPSE_COMMAND_CATALOG`.

If plan 029 has landed, consider also exposing the latest PR brief as a
resource. Do not block this plan on resources.

**Verify**: `npm run verify:mcp-adapter` -> exit 0.

### Step 4: Add verifier

Create `scripts/verify-pr-brief.mjs`:

- start server and daemons;
- simulate a branch, push, PR/review/comment webhook event, and unpushed delta;
- call `synapse pr-brief --base main --head <branch>`;
- assert the output includes the relevant unresolved delta, recent PR event,
  and cited context/summary.

Add `verify:pr-brief` to `package.json` and README.

**Verify**: `npm run verify:github-briefing && npm run verify:pr-brief` -> exit 0.

## Test plan

- New verifier covers branch-aware PR handoff.
- Existing GitHub briefing verifier still passes.
- MCP adapter still passes if a new tool is added.
- Full check passes.

## Done criteria

- [ ] `npm run check` exits 0.
- [ ] `npm run verify:github-briefing` exits 0.
- [ ] `npm run verify:pr-brief` exits 0.
- [ ] `synapse pr-brief` appears in CLI help and README command list.
- [ ] No GitHub posting/OAuth behavior is added.
- [ ] No files outside scope are modified.

## STOP conditions

Stop and report if:

- Useful PR filtering requires calling GitHub APIs.
- The command cannot avoid raw code upload.
- The implementation depends on hosted OAuth or GitHub App write permissions.

## Maintenance notes

This is intentionally a local handoff command. A future GitHub comment/check
integration should be a separate plan after SaaS/OAuth decisions are made.
