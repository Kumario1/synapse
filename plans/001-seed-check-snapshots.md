# Plan 001: Seed snapshots during pre-edit checks

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a STOP condition occurs, stop and report instead of improvising. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 3a0b685..HEAD -- apps/cli/src/daemon.ts apps/cli/src/hooks.ts apps/cli/src/analysis.ts scripts/verify-hooks.mjs scripts/verify-daemon-ts-report.mjs scripts/verify-mcp-adapter.mjs`
> If any in-scope file changed since this plan was written, compare the current-state excerpts below against the live code before proceeding.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug, tests
- **Planned at**: commit `3a0b685`, 2026-06-11

## Why this matters

The advertised automatic flow is "check before editing, report after editing." Today the check path extracts symbols for conflict detection, but it does not seed the daemon's `contractSnapshots` map. The first report for a file therefore records a baseline and emits no delta, so the first real contract-changing edit in a session can be invisible to teammates unless a separate baseline report already happened.

## Current state

- `apps/cli/src/hooks.ts` owns Claude Code hook behavior.
- `apps/cli/src/daemon.ts` owns the local `/tools/synapse_check` and `/tools/synapse_report` endpoints.
- `apps/cli/src/analysis.ts` already extracts the current symbols for file-path checks.
- `scripts/verify-hooks.mjs` verifies the hook path but currently creates an explicit post-hook baseline before testing a delta.

Relevant excerpts:

```ts
// apps/cli/src/hooks.ts:123
if (stage === "post") {
  await postJson(`${baseUrl}/tools/synapse_report`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    filePath
  }).catch(() => undefined);
  return;
}

// apps/cli/src/hooks.ts:132
const result = (await postJson(`${baseUrl}/tools/synapse_check`, {
  repoId: defaults.repoId,
  sessionId: defaults.sessionId,
  files: [filePath]
}).catch(() => null)) as SynapseCheckResponse | null;
```

```ts
// apps/cli/src/daemon.ts:338
if (request.method === "POST" && url.pathname === "/tools/synapse_check") {
  const checkStartedAt = performance.now();
  const body = (await readJson(request)) as Partial<SynapseCheckRequest>;
  const targets = await resolveCheckTargets(config, body, analysisCache);
  // no write to contractSnapshots happens in this handler today
}

// apps/cli/src/daemon.ts:863
const current = await extractSymbolsForFile(config, filePath, cache);
const previous = contractSnapshots.get(filePath);
contractSnapshots.set(filePath, current);

if (!previous) {
  return [];
}
```

```js
// scripts/verify-hooks.mjs:106
await runHookStage("post", bobRoot, join(bobRoot, extra)); // baseline snapshot
await writeFile(join(bobRoot, extra), "export function extra(a: number): number { return a; }\n");
await runHookStage("post", bobRoot, join(bobRoot, extra)); // should report a delta
```

Repo conventions to match:

- Keep daemon logic deterministic and local; optional LLM work is not part of this path.
- Verification scripts are hermetic Node `.mjs` files using `node:assert/strict`, temp worktrees, and `fetch`.
- Commit messages in recent history use conventional prefixes such as `fix(daemon): ...` and `test(hooks): ...`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit 0, no TypeScript errors |
| Hook regression | `npm run verify:hooks` | exit 0, prints `Hook verification passed:` |
| Existing report path | `npm run verify:daemon-ts-report` | exit 0 |
| MCP smoke | `npm run verify:mcp-adapter` | exit 0 |

## Scope

**In scope**:

- `apps/cli/src/daemon.ts`
- `scripts/verify-hooks.mjs`
- `scripts/verify-daemon-ts-report.mjs` only if an existing assertion must be adjusted
- `scripts/verify-mcp-adapter.mjs` only if a same-endpoint MCP regression is cheap and localized

**Out of scope**:

- Analyzer contract extraction behavior.
- Server state mutation semantics.
- Any change to the public `SynapseCheckRequest` or `SynapseReportRequest` shape.

## Git workflow

- Branch: `advisor/001-seed-check-snapshots`
- Suggested commit: `fix(daemon): seed report snapshots during checks`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add the failing hook regression first

In `scripts/verify-hooks.mjs`, add a case that follows the real automatic flow:

1. Create a fresh analyzable file, for example `src/preseed.ts`.
2. Write version 1 with an exported function.
3. Invoke `runHookStage("pre", bobRoot, join(bobRoot, preseedFile))`.
4. Rewrite the file with a signature change.
5. Invoke `runHookStage("post", bobRoot, join(bobRoot, preseedFile))`.
6. Assert the server eventually contains a delta for `src/preseed.ts` from Bob.

Keep the existing baseline-post coverage if it still documents useful behavior, but the new test must fail on the current code before the fix.

**Verify**: `npm run verify:hooks` -> fails before the fix because the pre-check does not seed the baseline for the later post report.

### Step 2: Seed snapshots in the check endpoint

In `apps/cli/src/daemon.ts`, seed `contractSnapshots` for each analyzable file in a successful `/tools/synapse_check` request before returning the check response.

Implementation guidance:

- Use the same `analysisCache` as the rest of the check path.
- For each unique `body.files` entry:
  - Skip non-analyzable files.
  - Extract current symbols with `extractSymbolsForFile(config, filePath, analysisCache)`.
  - Set `contractSnapshots.set(filePath, symbols)`.
- It is acceptable, and usually correct, to replace an existing snapshot during pre-check: a pre-edit check should reset the "before" state for the next edit.
- Do not emit deltas from the check endpoint. It should still only return a `SynapseCheckResponse`.

If you can reuse symbols already loaded by `resolveCheckTargets` without complicating the code, do so. Do not introduce a broad cache redesign in this plan.

**Verify**: `npm run typecheck` -> exit 0.

### Step 3: Preserve current report behavior

Ensure `synapse_report` still behaves as before when no pre-check happened:

- First report on a file with no previous snapshot returns no deltas.
- Second report after a signature change emits a delta.
- Explicit `symbolId` reports still emit an explicit file/symbol delta without requiring a snapshot.

The existing `scripts/verify-daemon-ts-report.mjs` should continue to cover this. Add a narrow assertion only if the current script does not cover a behavior you touched.

**Verify**: `npm run verify:daemon-ts-report` -> exit 0.

### Step 4: Confirm MCP still benefits through the daemon endpoint

Because the MCP adapter forwards to the local daemon, the endpoint fix should apply to MCP clients too. Run the existing MCP verifier. If it lacks a check-then-report regression and adding one is under 20 lines, add it; otherwise leave the adapter untouched and rely on `verify:hooks` plus endpoint coverage.

**Verify**: `npm run verify:mcp-adapter` -> exit 0.

## Test plan

- New regression in `scripts/verify-hooks.mjs`: check-before-edit then report-after-edit emits the first signature delta.
- Existing `scripts/verify-daemon-ts-report.mjs`: baseline report semantics stay intact.
- Existing `scripts/verify:mcp-adapter`: adapter still forwards successfully to daemon tools.

## Done criteria

- [ ] `npm run typecheck` exits 0.
- [ ] `npm run verify:hooks` exits 0 and includes the new check-then-report regression.
- [ ] `npm run verify:daemon-ts-report` exits 0.
- [ ] `npm run verify:mcp-adapter` exits 0.
- [ ] `git diff --stat` shows only the in-scope files and `plans/README.md` status update.
- [ ] `plans/README.md` status row for Plan 001 is updated.

## STOP conditions

Stop and report if:

- The current hook or daemon snippets above no longer match the live code.
- Seeding snapshots requires changing protocol request/response types.
- The fix would emit deltas from `synapse_check`.
- A verification command fails twice after a focused fix attempt.

## Maintenance notes

Reviewers should scrutinize repeated extraction cost in the check endpoint. If a later performance plan changes graph or symbol caching, it must preserve this invariant: after a successful pre-edit check on an analyzable file, the next post-edit report can diff against the pre-edit signature.

