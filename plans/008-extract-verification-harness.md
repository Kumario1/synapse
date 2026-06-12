# Plan 008: Extract a shared verification-script harness

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a STOP condition occurs, stop and report instead of improvising. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 3a0b685..HEAD -- scripts/verify-hooks.mjs scripts/verify-daemon-ts-report.mjs scripts/verify-branch-aware-severity.mjs scripts`
> If any in-scope file changed since this plan was written, compare the current-state excerpts below against the live code before proceeding.
>
> Sequencing note (added by review 2026-06-11): pending plans 011, 012, 014,
> 015, and 016 in this folder each CREATE new verify/eval scripts that
> copy-paste the same helpers this plan extracts. Those new scripts are NOT
> in this plan's scope — do not migrate them. Prefer running this plan LAST
> among the pending set; if it lands first, the later plans' executors keep
> copy-pasting (acceptable) and a follow-up migrates opportunistically per
> the maintenance note.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: Plans 001, 003, 004 recommended first to avoid script churn conflicts
- **Category**: dx, tech-debt
- **Planned at**: commit `3a0b685`, 2026-06-11

## Why this matters

The verification suite is one of the repo's strengths, but many `.mjs` scripts duplicate helpers for child processes, ports, HTTP polling, JSON POSTs, and cleanup. That duplication makes every new verifier slower to write and every harness-level fix easy to miss in one script. A small shared harness reduces future test maintenance without changing product behavior.

## Current state

- `scripts/verify-hooks.mjs`, `scripts/verify-daemon-ts-report.mjs`, and `scripts/verify-branch-aware-severity.mjs` all define similar helpers.
- The scripts are plain ESM Node files and run directly with `node`.
- Package scripts invoke them by path after `npm run build`.

Representative excerpts:

```js
// scripts/verify-hooks.mjs:219
function startProcess(label, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  return child;
}
```

```js
// scripts/verify-hooks.mjs:236
async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${url} failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}
```

```js
// scripts/verify-branch-aware-severity.mjs has similar helpers:
// startProcess, postJson, waitForHttp, waitForState, waitFor, freePort, stopChildren
```

Repo conventions to match:

- Verification scripts should stay hermetic and easy to run individually.
- Helper output prefixes child process logs with a label.
- Cleanup should still kill children and remove temp directories in `finally`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Hook verifier | `npm run verify:hooks` | exit 0 |
| Report verifier | `npm run verify:daemon-ts-report` | exit 0 |
| Branch verifier | `npm run verify:branch-aware-severity` | exit 0 |
| Full typecheck | `npm run typecheck` | exit 0 |

## Scope

**In scope**:

- New file `scripts/lib/verify-harness.mjs`.
- `scripts/verify-hooks.mjs`.
- `scripts/verify-daemon-ts-report.mjs`.
- `scripts/verify-branch-aware-severity.mjs`.

**Out of scope**:

- Migrating every verifier in `scripts/`.
- Changing verifier semantics or expected assertions.
- Adding TypeScript build steps for scripts.
- Changing root `package.json` script names.

## Git workflow

- Branch: `advisor/008-verify-harness`
- Suggested commit: `test: extract shared verify harness helpers`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Create a minimal shared harness

Add `scripts/lib/verify-harness.mjs` exporting only the helpers needed by the first migrated scripts:

- `freePort()`
- `waitFor(predicate, timeoutMs)`
- `waitForHttp(url, timeoutMs = 5000)`
- `waitForState(port, predicate, timeoutMs = 5000, repoId = "local")`
- `postJson(url, body)`
- `createProcessTracker(rootDir)` returning `{ startProcess, stopChildren }`

Keep the helper code close to existing script behavior. Do not add dependencies.

**Verify**: `node -e "import('./scripts/lib/verify-harness.mjs').then(() => console.log('ok'))"` -> prints `ok`.

### Step 2: Migrate `verify-branch-aware-severity.mjs`

This script has representative process, HTTP, state, and port helpers. Replace local helper definitions with imports from `scripts/lib/verify-harness.mjs`.

Keep script-specific helpers such as `onlyRule`, `check`, `push`, `report`, and fixture writing in the script.

**Verify**: `npm run verify:branch-aware-severity` -> exit 0.

### Step 3: Migrate `verify-hooks.mjs`

Replace duplicated helpers with harness imports while preserving:

- Child label output.
- `children` cleanup in `finally`.
- Hook-specific `runHookStage`, `runCli`, fixture writing, and local config helpers.

If Plan 001 has already changed this script, preserve its regression tests.

**Verify**: `npm run verify:hooks` -> exit 0.

### Step 4: Migrate `verify-daemon-ts-report.mjs`

Apply the same migration to `scripts/verify-daemon-ts-report.mjs`.

Keep report-specific assertions and fixture setup local to the script.

**Verify**: `npm run verify:daemon-ts-report` -> exit 0.

### Step 5: Check duplication and avoid overreach

Run a search to confirm the migrated files no longer define the shared helper names locally:

```bash
rg -n "function (startProcess|postJson|waitForHttp|waitForState|waitFor\\(|freePort|stopChildren)" scripts/verify-hooks.mjs scripts/verify-daemon-ts-report.mjs scripts/verify-branch-aware-severity.mjs
```

Expected result: no matches for helpers now imported from the harness. Script-specific helpers may remain if their names differ.

Do not migrate additional scripts in this plan.

**Verify**: `npm run typecheck` -> exit 0.

## Test plan

- Import smoke for the new harness.
- Run each migrated verifier individually.
- Search migrated files for duplicated helper definitions.

## Done criteria

- [ ] `scripts/lib/verify-harness.mjs` exists and has no external dependencies.
- [ ] Three selected verifier scripts import shared helpers and keep their original assertions.
- [ ] `npm run verify:branch-aware-severity` exits 0.
- [ ] `npm run verify:hooks` exits 0.
- [ ] `npm run verify:daemon-ts-report` exits 0.
- [ ] Helper-definition search shows no migrated duplicate helpers in the three scripts.
- [ ] `npm run typecheck` exits 0.
- [ ] `plans/README.md` status row for Plan 008 is updated.

## STOP conditions

Stop and report if:

- Migrating the helpers changes verifier timing or causes flaky cleanup.
- A script has already been substantially rewritten by another plan and the helper extraction would create merge conflicts.
- You need to migrate more than the three in-scope scripts to make the harness viable.

## Maintenance notes

After this lands, future verifier scripts should import from `scripts/lib/verify-harness.mjs` instead of copy-pasting process and HTTP helpers. Migrate the rest of `scripts/` opportunistically when touching them for product work.

