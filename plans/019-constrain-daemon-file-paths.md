# Plan 019: Constrain daemon file reads to the worktree

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Stop
> on any STOP condition. When done, update this plan's row in `plans/README.md`
> unless your reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- apps/cli/src/analysis.ts apps/cli/src/daemon.ts apps/cli/src/hooks.ts apps/cli/src/watcher.ts scripts/verify-security.mjs`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 018 recommended
- **Category**: security
- **Planned at**: commit `e3c46f2`, 2026-06-12

## Why this matters

The local daemon accepts file paths from local tool JSON and watcher/report
paths. Several code paths call `resolve(config.worktreeRoot, filePath)` and
then read that path without checking that the resolved target remains inside
the worktree. If a caller reaches the daemon API, `..` traversal can read
outside the repo; with the optional resolver enabled, that content can also be
sent to the configured LLM provider.

## Current state

Relevant files:

- `apps/cli/src/analysis.ts` - `extractSymbolsForFile()` reads file content.
- `apps/cli/src/daemon.ts` - `readFileContext()` reads resolver context.
- `apps/cli/src/hooks.ts` and `apps/cli/src/watcher.ts` - existing relative
  path normalization patterns to preserve.
- `scripts/verify-security.mjs` - security regression verifier.

Current reads:

```ts
// apps/cli/src/analysis.ts:364
const fullPath = resolve(config.worktreeRoot, filePath);
const fingerprint = await fileFingerprint(fullPath);
...
const source = await readFile(fullPath, "utf8");
```

```ts
// apps/cli/src/daemon.ts:878
async function readFileContext(config: RuntimeConfig, filePath: string): Promise<string | undefined> {
  try {
    return await readFile(resolve(config.worktreeRoot, filePath), "utf8");
  } catch {
    return undefined;
  }
}
```

Repo conventions:

- Keep helper functions small and local unless they are shared by more than one
  module.
- Tests use `node:test` and `node:assert/strict`.
- Daemon security regressions are commonly covered by `scripts/verify-security.mjs`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | exit 0 |
| Security verify | `npm run verify:security` | exit 0 |

Use Node `20.19.x` or newer Node 20.

## Scope

**In scope**:

- `apps/cli/src/analysis.ts`
- `apps/cli/src/daemon.ts`
- Optional new CLI helper/test files under `apps/cli/src/`
- `scripts/verify-security.mjs`

**Out of scope**:

- Rewriting hook path normalization.
- Changing analyzer behavior for valid in-repo relative paths.
- Changing LLM resolver privacy defaults; this plan only constrains paths.

## Git workflow

- Branch: `advisor/019-constrain-daemon-file-paths`
- Commit style: `fix(security): reject daemon file paths outside the worktree`.

## Steps

### Step 1: Add a shared worktree path resolver

Create a small helper, either in `apps/cli/src/analysis.ts` if only used there
or in a new `apps/cli/src/path-safety.ts` if imported by both modules.

Required behavior:

- reject absolute paths;
- reject `..` escapes after `resolve()`;
- reject paths whose realpath escapes through a symlink when the file exists;
- return the resolved absolute path for valid repo-relative files;
- use path comparisons that are safe for sibling prefixes such as
  `/repo` vs `/repo-other`.

**Verify**: add unit tests for the helper if it is in its own module, then run
`npm run build` -> exit 0.

### Step 2: Use the helper before every daemon file read

In `extractSymbolsForFile()`, resolve `filePath` through the helper before
fingerprinting or reading.

In `readFileContext()`, resolve through the same helper. Continue returning
`undefined` for invalid/missing context rather than throwing out of conflict
resolution.

**Verify**: `npm run typecheck` -> exit 0.

### Step 3: Add daemon/security regression coverage

Extend `scripts/verify-security.mjs` or add focused CLI unit tests proving:

- `../outside.ts` is rejected or produces the same safe degraded response
  without reading outside the worktree;
- absolute paths are rejected;
- normal in-repo paths still work.

**Verify**: `npm run verify:security` -> exit 0.

## Test plan

- New helper tests for relative, absolute, `..`, sibling-prefix, and symlink
  escape cases if feasible.
- Security verifier covers at least one daemon tool endpoint with an escaped
  `filePath`.
- Full repo tests still pass.

## Done criteria

- [ ] `npm run typecheck` exits 0.
- [ ] `npm test` exits 0.
- [ ] `npm run verify:security` exits 0.
- [ ] `extractSymbolsForFile()` and `readFileContext()` no longer read
  `resolve(worktreeRoot, filePath)` directly.
- [ ] No files outside the scope list are modified.

## STOP conditions

Stop and report if:

- A required valid caller currently sends absolute paths into daemon tools.
- Symlink handling requires changing watcher/hook contracts.
- The fix would require modifying protocol request shapes.

## Maintenance notes

Any future daemon endpoint that reads a path from JSON must use the same helper.
Reviewers should check for direct `readFile(resolve(config.worktreeRoot, ...))`
patterns before approving.
