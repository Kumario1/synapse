# Plan 035: Add strict GitHub PR quality gates

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise by weakening assertions, making checks optional, or
> hiding failures behind skips. When done, update the status row for this plan
> in `plans/README.md` unless a reviewer tells you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- package.json turbo.json .github/workflows/ci.yml scripts evals apps packages`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding. On a
> mismatch that changes the intended CI/test shape, treat it as a STOP
> condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `e3c46f2`, 2026-06-14

## Why this matters

Synapse is a coordination product: if conflict detection, agent hooks, MCP
adapter behavior, persistence, auth, or packaging regress, users trust the tool
less exactly when multiple coding agents are editing the same repo. The current
CI has useful coverage, but it is shaped as one fast check plus one broad
verify bucket, and parts of the verify runner are deliberately permissive for
local use. This plan adds strict PR-only gates: small named jobs, fresh
product-level verifiers, no silent zero-test passes, and hard detection
ratchets that fail when scenarios disappear or baselines are missing.

## Current state

Relevant files and roles:

- `package.json` - root npm workspace scripts and all current verify entrypoints.
- `.github/workflows/ci.yml` - the only GitHub Actions workflow.
- `scripts/ci-verify-all.mjs` - local/full verify runner currently used by the
  workflow's `verify` job.
- `scripts/eval-detection.mjs` and `evals/detection-baseline.json` - current
  precision/recall ratchet.
- `scripts/lib/verify-harness.mjs` - shared verifier helpers for temp ports,
  process tracking, HTTP helpers, and state polling.
- `scripts/verify-package.mjs` - good example of a product-level verifier that
  tests the installed npm artifact like a real user.

Current root commands:

```json
// package.json:10-14
"scripts": {
  "build": "turbo run build",
  "typecheck": "turbo run typecheck",
  "test": "turbo run test",
  "check": "npm run typecheck && npm test",
```

There are many verify scripts already wired at `package.json:15-72`, including
`verify:hooks`, `verify:mcp-adapter`, `verify:security`, `verify:package`,
`eval:conflicts`, and `eval:detection`. Do not delete those scripts. This plan
adds stricter CI entrypoints and new product-level checks on top.

Current workflow shape:

```yaml
# .github/workflows/ci.yml:19-32
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm run typecheck
      - run: npm test
```

```yaml
# .github/workflows/ci.yml:34-91
verify:
  runs-on: ubuntu-latest
  timeout-minutes: 60
  services:
    postgres:
      image: pgvector/pgvector:pg16
    redis:
      image: redis:7
  steps:
    - run: npm ci
    - name: Build, test, and run the full verify matrix
      run: node scripts/ci-verify-all.mjs
```

Current full verifier has local-development escape hatches:

```js
// scripts/ci-verify-all.mjs:12-20
// Environment-dependent scripts stay green everywhere: verify-docker self-skips
// without docker, verify-up-tunnel stubs the tunnel binary. To skip scripts
// explicitly (e.g. latency gates on a noisy machine):
//
//   SYNAPSE_VERIFY_SKIP=hot-path-latency,large-repo-latency node scripts/ci-verify-all.mjs
//
// Or run just a few while iterating locally:
//
//   node scripts/ci-verify-all.mjs --only why,doctor
```

```js
// scripts/ci-verify-all.mjs:75-89
const entries = (await readdir(join(rootDir, "scripts")))
  .filter((name) => /^verify-.+\.mjs$/.test(name))
  .sort();
entries.push("eval-conflicts.mjs");
entries.push("eval-detection.mjs");
...
if (skip.has(short)) {
  console.log(`\n=== ${entry} === SKIP (SYNAPSE_VERIFY_SKIP)`);
  results.push({ entry, status: "skip" });
  continue;
}
```

That is acceptable for local runs, but too loose as the only required PR gate.
Keep `scripts/ci-verify-all.mjs` for local/full runs; create strict PR scripts
that do not accept `SYNAPSE_VERIFY_SKIP` and do not discover checks by "whatever
file happens to exist."

Current detection ratchet can pass without a baseline:

```js
// scripts/eval-detection.mjs:61-65
const baselineText = await readFile(baselinePath, "utf8").catch(() => null);
if (baselineText === null) {
  console.log(`\nNo baseline at ${baselinePath} yet; run with --write-baseline to create one.`);
  process.exit(0);
}
```

It also gates only precision/recall against the baseline:

```js
// scripts/eval-detection.mjs:84-99
const base = baseline.rules[rule];
const current = metrics[rule];

if (current.precision < base.precision) {
  ...
}

if (current.recall < base.recall) {
  ...
}
```

Current baseline:

```json
// evals/detection-baseline.json
{
  "generatedAt": "2026-06-12T18:18:20.378Z",
  "corpusSize": 25,
  "rules": {
    "dependency_changed": {
      "tp": 5,
      "fp": 1,
      "fn": 0,
      "precision": 0.8333333333333334,
      "recall": 1
    }
  }
}
```

Current source test files discovered during recon:

```text
apps/cli/src/briefings.test.ts
apps/cli/src/explain-openrouter.test.ts
apps/server/src/github.test.ts
apps/server/src/pg-advisory-lock.test.ts
apps/server/src/state.test.ts
apps/server/src/store.test.ts
packages/analyzer-go/src/index.test.ts
packages/analyzer-py/src/index.test.ts
packages/analyzer-ts/src/index.test.ts
packages/conflict-engine/src/adaptive.test.ts
packages/conflict-engine/src/branch-aware.test.ts
packages/conflict-engine/src/compare.test.ts
packages/conflict-engine/src/index.test.ts
packages/conflict-engine/src/resolution-property.test.ts
packages/conflict-engine/src/resolution.test.ts
packages/protocol/src/negotiation.test.ts
packages/protocol/src/wire-schema.test.ts
```

Verifier style to match:

```js
// scripts/verify-package.mjs:1-6
// Proves the publishable npm artifact works exactly as a user would consume it:
// pack the release tarball, `npm install` it into a clean temp project, then run
// the installed CLI (not the monorepo build) through the real two-machine flow
```

Use top-level verifier scripts with `node:assert/strict`, temp directories,
real spawned server/daemon processes, and explicit assertions. Reuse helpers
from `scripts/lib/verify-harness.mjs` where possible.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `npm ci` | exit 0 |
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0, no TypeScript errors |
| Existing unit tests | `npm test` | exit 0 |
| Python analyzer setup | `npm run setup:analyzer-py` | exit 0 |
| Go analyzer setup | `npm run setup:analyzer-go` | exit 0 |
| Existing full local gate | `npm run verify:all` | exit 0, summary all pass |
| New static gate | `npm run ci:strict:static` | exit 0 |
| New unit gate | `npm run ci:strict:unit` | exit 0 |
| New detection gate | `npm run ci:strict:detection` | exit 0 |
| New agent loop gate | `npm run ci:strict:agent-loop` | exit 0 |
| New polyglot gate | `npm run ci:strict:polyglot` | exit 0 |
| New services gate | `npm run ci:strict:services` | exit 0 |
| New packaging gate | `npm run ci:strict:package` | exit 0 |

## Scope

**In scope**:

- `.github/workflows/ci.yml`
- `package.json`
- `scripts/ci-strict-runner.mjs` (create)
- `scripts/ci-test-inventory.mjs` (create)
- `scripts/verify-strict-agent-loop.mjs` (create)
- `scripts/eval-detection.mjs`
- `evals/detection-corpus/*.json`
- `evals/detection-baseline.json`
- Narrow source fixes only if a new strict verifier exposes a real product bug
  and the fix is local to the named behavior under test.

**Out of scope**:

- Do not remove `scripts/ci-verify-all.mjs`; it remains the local/full runner.
- Do not weaken or delete existing verify scripts to make the new workflow fit.
- Do not add paid services, external SaaS, secrets, or network-dependent LLM
  calls.
- Do not change branch protection settings in GitHub UI. Mention the required
  job names in the PR description, but the owner must enforce them in repo
  settings.
- Do not edit generated `dist/`, `.turbo/`, `.venv/`, `Synapse/`, or
  `dist-release/` artifacts unless an existing build/package command updates
  ignored outputs while verifying locally.

## Git workflow

- Branch: `advisor/035-strict-pr-quality-gates`
- Commit style: follow existing conventional commits, for example
  `test: extract shared verify harness helpers` and
  `docs(plan): refresh implemented feature status across roadmap docs`.
- Suggested commits:
  - `test: add strict pr quality scripts`
  - `ci: split strict pull request gates`
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add strict CI runner and test inventory guard

Create `scripts/ci-test-inventory.mjs`.

Required behavior:

- Read root `package.json` and resolve workspace packages from `apps/*` and
  `packages/*`.
- For each workspace, read its `package.json`, discover `src/**/*.test.ts`,
  and after build assert each source test has a matching `dist/**/*.test.js`.
- Fail if any workspace with a `test` script reports zero test files.
- Enforce these current minimum source test-file counts:
  - `@synapse/protocol`: 2
  - `@synapse/conflict-engine`: 6
  - `@synapse/analyzer-ts`: 1
  - `@synapse/analyzer-py`: 1
  - `@synapse/analyzer-go`: 1
  - `@synapse/server`: 4
  - `@synapse/cli`: 2
- Fail if any source test file contains focused-test markers:
  `.only(`, `test.only`, `describe.only`, or `it.only`.
- Print a JSON summary with package name, source test count, matched dist test
  count, and status.

Create `scripts/ci-strict-runner.mjs`.

Required behavior:

- Accept exactly one argument: `static`, `unit`, `detection`, `agent-loop`,
  `polyglot`, `services`, `package`, or `--list`.
- Hard-code the command list for each group. Do not discover scripts by
  directory scan.
- Refuse to run if `process.env.SYNAPSE_VERIFY_SKIP` is set.
- Force deterministic env for child processes:
  `OPENROUTER_API_KEY=""`, `SYNAPSE_LLM_EXPLAIN="0"`,
  `SYNAPSE_LLM_RESOLVE="0"`.
- Use process-group cleanup and per-command timeout handling like
  `scripts/ci-verify-all.mjs:115-156`.
- If a command fails, continue within that group only when continuing gives
  useful aggregate output; the process must exit nonzero if any command failed.
- Print a final per-command summary.

Add root scripts to `package.json`:

```json
"ci:strict:static": "node scripts/ci-strict-runner.mjs static",
"ci:strict:unit": "node scripts/ci-strict-runner.mjs unit",
"ci:strict:detection": "node scripts/ci-strict-runner.mjs detection",
"ci:strict:agent-loop": "node scripts/ci-strict-runner.mjs agent-loop",
"ci:strict:polyglot": "node scripts/ci-strict-runner.mjs polyglot",
"ci:strict:services": "node scripts/ci-strict-runner.mjs services",
"ci:strict:package": "node scripts/ci-strict-runner.mjs package"
```

Group contents:

- `static`: `npm run build`, `npm run typecheck`,
  `node scripts/ci-test-inventory.mjs`
- `unit`: `npm test`, then one explicit `npm test --workspace <name>` for each
  workspace package listed above
- `detection`: `node scripts/eval-conflicts.mjs`,
  `node scripts/eval-detection.mjs --strict`,
  `node scripts/verify-contract-compat.mjs`,
  `node scripts/verify-resolution.mjs`,
  `node scripts/verify-adaptive-severity.mjs`,
  `node scripts/verify-branch-aware-severity.mjs`
- `agent-loop`: `node scripts/verify-strict-agent-loop.mjs`,
  `node scripts/verify-daemon-ts-report.mjs`,
  `node scripts/verify-dependency-ts-check.mjs`,
  `node scripts/verify-file-only-ts-check.mjs`,
  `node scripts/verify-hooks.mjs`,
  `node scripts/verify-mcp-adapter.mjs`,
  `node scripts/verify-session-start.mjs`,
  `node scripts/verify-session-summary.mjs`,
  `node scripts/verify-whatsup.mjs`,
  `node scripts/verify-why.mjs`,
  `node scripts/verify-onboard.mjs`
- `polyglot`: `npm run setup:analyzer-py`, `npm run setup:analyzer-go`,
  `node scripts/verify-python-check.mjs`,
  `node scripts/verify-go-check.mjs`,
  `node scripts/verify-tsx-check.mjs`,
  `node scripts/verify-fuzz.mjs`
- `services`: `node scripts/verify-security.mjs`,
  `node scripts/verify-auth.mjs`, `node scripts/verify-tenancy.mjs`,
  `node scripts/verify-persistence.mjs`,
  `node scripts/verify-persistence-pg.mjs`,
  `node scripts/verify-multi-instance.mjs`,
  `node scripts/verify-github-webhook.mjs`,
  `node scripts/verify-github-briefing.mjs`,
  `node scripts/verify-reconnect.mjs`,
  `node scripts/verify-metrics.mjs`,
  `node scripts/verify-file-watcher.mjs`
- `package`: `node scripts/verify-npm-pack.mjs`,
  `node scripts/verify-package.mjs`, `node scripts/verify-demo.mjs`,
  `node scripts/verify-docker.mjs`

**Verify**:

```bash
npm ci
npm run build
node scripts/ci-strict-runner.mjs --list
npm run ci:strict:static
```

Expected result: all commands exit 0. `--list` prints the seven group names.
The static gate prints the test inventory summary and reports no missing dist
test files or focused tests.

### Step 2: Make the detection ratchet fail closed

Update `scripts/eval-detection.mjs`.

Required behavior in normal or `--strict` mode:

- Missing baseline is a failure, not success.
- Add `--baseline <path>` so the missing-baseline path can be verified without
  moving real files.
- `--write-baseline` remains the only way to update
  `evals/detection-baseline.json`.
- Fail if `skipped > 0`.
- Fail if `scenarios.length !== baseline.corpusSize`.
- Fail if scenario names are not unique across the full corpus.
- Fail if a rule exists in current metrics but not the baseline, or in the
  baseline but not current metrics.
- For every rule, fail on any of these raw-count regressions:
  - `current.tp < baseline.tp`
  - `current.fp > baseline.fp`
  - `current.fn > baseline.fn`
- Keep the existing precision/recall floor checks as additional output.

Expand the detection corpus with at least 12 new hard scenarios. Do not copy
existing scenarios with renamed symbols only. Cover these product cases:

- Same-session deltas never warn the same agent.
- Deltas from a different `repoId` never affect the current room.
- A pushed delta no longer warns after `synapse_push` semantics clear it.
- Same-file no-overlap remains only an informational file-level warning and
  never suppresses a same-symbol warning.
- A compatible dependency change has an explicit non-warning scenario. If this
  exposes the known `dependency_changed` false positive in the baseline, either
  fix the evaluator narrowly or keep the expected current behavior and document
  why in the scenario name. Do not delete the scenario.
- Direct dependency breaking change warns.
- Transitive dependency breaking change warns with the transitive rule.
- Stale base warning fires when Bob edits after Alice's recent push on the same
  symbol.
- Active edit lock warning fires for a different active session.
- Inactive or expired session data does not warn.
- TypeScript source scenario for an exported interface field removal.
- TypeScript source scenario for adding an optional parameter or optional
  property that should be compatible.

After the new scenarios pass, update `evals/detection-baseline.json` with:

```bash
node scripts/eval-detection.mjs --write-baseline
```

The new baseline `corpusSize` must be at least `37` because the current
baseline is `25` and this step adds at least 12 scenarios.

**Verify**:

```bash
node scripts/eval-detection.mjs --baseline /tmp/synapse-missing-baseline.json
```

Expected result: exits nonzero and prints a missing-baseline error.

```bash
node scripts/eval-detection.mjs --strict
node scripts/eval-conflicts.mjs
npm run ci:strict:detection
```

Expected result: all three commands exit 0. The detection output says the
baseline holds, reports zero skipped scenarios, and reports a corpus size of at
least 37.

### Step 3: Add a fresh strict end-to-end agent-loop verifier

Create `scripts/verify-strict-agent-loop.mjs`.

This must be a new product test, not a thin wrapper around the existing
`verify-hooks.mjs` or `verify-mcp-adapter.mjs`.

Use `scripts/lib/verify-harness.mjs` helpers. Build a temp repo with two
worktrees, one server, and two daemons:

- Alice and Bob join the same `repoId`.
- File under test: `src/auth/token.ts`.
- Initial contract:

```ts
export interface Token { value: string; }
export function validate(input: string): boolean {
  return input.length > 0;
}
```

Assertions to implement:

1. Before any report, Bob's `synapse_check` for `validate` returns
   `verdict === "none"` and `conflicts.length === 0`.
2. Alice reports a real signature change from `boolean` to `Token | null`.
   Assert server state contains exactly one unpushed delta for Alice, with
   `before` containing `boolean` and `after` containing `Token | null`.
3. Bob checks the same symbol twice. Both calls return `verdict === "warn"`,
   exactly one `same_symbol_unpushed` conflict, counterpart Alice, and the same
   conflict id on both calls.
4. Bob reports an incompatible local change to `Promise<Token>`. A subsequent
   check surfaces `contract_divergent`, includes both self and counterpart
   contract text, and does not downgrade severity below `warn`.
5. Bob records `synapse_feedback` with outcome `acted`. Assert server state
   has exactly one feedback record tied to the conflict id.
6. Alice runs `synapse_push` for the file and symbol. Assert unpushed deltas for
   that symbol clear. Bob's next check must not include
   `same_symbol_unpushed` or `contract_divergent`; the expected product
   behavior is a `stale_base` warning for the recent push, matching
   `scripts/verify-push-state-reset.mjs`.
7. `synapse_whatsup` from Bob still shows both active sessions, and
   `synapse_why` cites an unpushed delta while the delta exists.

Keep it deterministic:

- Set `OPENROUTER_API_KEY=""`, `SYNAPSE_LLM_EXPLAIN="0"`,
  `SYNAPSE_LLM_RESOLVE="0"`.
- Use free ports, temp directories, and cleanup all child processes in
  `finally`.
- Do not depend on git remotes; set `SYNAPSE_REPO_ID` or pass `--repo-id`.

Add `verify:strict-agent-loop` to `package.json`:

```json
"verify:strict-agent-loop": "npm run build && node scripts/verify-strict-agent-loop.mjs"
```

Include this script in the `agent-loop` strict group.

**Verify**:

```bash
npm run build
node scripts/verify-strict-agent-loop.mjs
npm run ci:strict:agent-loop
```

Expected result: all commands exit 0. The verifier prints a JSON summary that
includes `initialCheck: "none"`, `sameSymbolStableId: true`,
`divergentConflict: true`, `feedbackRecorded: true`, `pushCleared: true`, and
`postPushStaleBase: true`.

### Step 4: Split GitHub Actions into short strict PR checks

Replace the two-job workflow in `.github/workflows/ci.yml` with multiple named
jobs. Keep triggers on `push` to `main` and `pull_request`.

Workflow-wide requirements:

- Add:

```yaml
permissions:
  contents: read
```

- Do not set `SYNAPSE_VERIFY_SKIP` anywhere.
- Do not call `node scripts/ci-verify-all.mjs` from the strict PR workflow.
  That runner stays available locally through `npm run verify:all`.
- Every job must set:

```yaml
env:
  OPENROUTER_API_KEY: ""
  SYNAPSE_LLM_EXPLAIN: "0"
  SYNAPSE_LLM_RESOLVE: "0"
```

Use these jobs:

1. `static`
   - timeout: 10 minutes
   - setup Node 20 with npm cache
   - `npm ci`
   - `npm run ci:strict:static`

2. `unit`
   - timeout: 12 minutes
   - setup Node 20 with npm cache
   - `npm ci`
   - `npm run build`
   - `npm run ci:strict:unit`

3. `detection-ratchet`
   - timeout: 12 minutes
   - setup Node 20 with npm cache
   - `npm ci`
   - `npm run build`
   - `npm run ci:strict:detection`

4. `agent-loop`
   - timeout: 15 minutes
   - setup Node 20 with npm cache
   - `npm ci`
   - `npm run build`
   - `npm run ci:strict:agent-loop`

5. `polyglot`
   - timeout: 18 minutes
   - setup Node 20, Python 3.12, Go 1.22
   - cache `packages/analyzer-py/.venv`
   - `npm ci`
   - `npm run build`
   - `npm run ci:strict:polyglot`

6. `services-security`
   - timeout: 18 minutes
   - setup Node 20
   - services: `pgvector/pgvector:pg16` and `redis:7`, same health checks as
     current workflow lines 41-64
   - env:
     `SYNAPSE_VERIFY_PG_URL=postgres://postgres@localhost:5432/postgres`
     and `SYNAPSE_VERIFY_REDIS_URL=redis://localhost:6379`
   - `npm ci`
   - `npm run build`
   - `npm run ci:strict:services`

7. `package-release`
   - timeout: 20 minutes
   - setup Node 20
   - Docker must be available on `ubuntu-latest`; if `verify-docker` still
     self-skips, update it so this strict group fails when Docker is missing on
     GitHub Actions but may keep a local self-skip outside CI.
   - `npm ci`
   - `npm run build`
   - `npm run ci:strict:package`

8. `required`
   - timeout: 3 minutes
   - `needs`: all seven jobs above
   - Always runs.
   - Fails if any needed job result is not `success`.
   - Prints the job result map.

The `required` job gives the owner one stable branch-protection check name
while still exposing small failing jobs on PRs.

**Verify**:

```bash
grep -R "SYNAPSE_VERIFY_SKIP" .github/workflows || true
grep -R "ci-verify-all" .github/workflows || true
npm run ci:strict:static
npm run ci:strict:detection
```

Expected result: both `grep` commands print no workflow references to
`SYNAPSE_VERIFY_SKIP` or `ci-verify-all`; both npm commands exit 0.

### Step 5: Run the whole strict suite locally before handoff

Run the strict commands independently, not only through `verify:all`:

```bash
npm run ci:strict:static
npm run ci:strict:unit
npm run ci:strict:detection
npm run ci:strict:agent-loop
npm run ci:strict:polyglot
npm run ci:strict:services
npm run ci:strict:package
```

Expected result: every command exits 0. If one is too slow, optimize the
specific verifier or split the group further. Do not remove assertions to make
the job fast.

Also run:

```bash
npm run verify:all
```

Expected result: exits 0. This confirms the old local aggregate still works
after the strict PR gates are added.

## Test plan

Add or update tests/checks in these places:

- `scripts/ci-test-inventory.mjs`: static inventory guard for test count,
  compiled test presence, and focused-test markers.
- `scripts/eval-detection.mjs`: fail-closed behavior for missing baselines,
  skipped scenarios, corpus-size drift, duplicate names, new/missing rules, and
  raw TP/FP/FN regressions.
- `evals/detection-corpus/*.json`: at least 12 new hard scenarios listed in
  Step 2.
- `scripts/verify-strict-agent-loop.mjs`: fresh end-to-end product verifier
  covering same-symbol warnings, divergent conflicts, feedback, push clearing,
  briefings, and memory citations.
- `.github/workflows/ci.yml`: seven short strict jobs plus one stable
  `required` aggregation job.

Use existing patterns:

- For workspace unit tests, match `node:test` plus `node:assert/strict` as in
  `packages/conflict-engine/src/index.test.ts`.
- For end-to-end verifier scripts, match top-level async script style and
  assert-heavy checks from `scripts/verify-package.mjs`.
- For temp server/daemon checks, reuse `scripts/lib/verify-harness.mjs`.

Verification:

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run ci:strict:static
npm run ci:strict:unit
npm run ci:strict:detection
npm run ci:strict:agent-loop
npm run ci:strict:polyglot
npm run ci:strict:services
npm run ci:strict:package
npm run verify:all
```

All commands must exit 0.

## Done criteria

All must hold:

- [ ] `.github/workflows/ci.yml` has separate `static`, `unit`,
      `detection-ratchet`, `agent-loop`, `polyglot`, `services-security`,
      `package-release`, and `required` jobs.
- [ ] No workflow file references `SYNAPSE_VERIFY_SKIP`.
- [ ] No strict PR workflow job calls `scripts/ci-verify-all.mjs`.
- [ ] `package.json` exposes all seven `ci:strict:*` scripts and
      `verify:strict-agent-loop`.
- [ ] `scripts/ci-test-inventory.mjs` fails on zero-test packages, missing
      compiled test files, and focused-test markers.
- [ ] `scripts/ci-strict-runner.mjs` refuses `SYNAPSE_VERIFY_SKIP` and runs
      only hard-coded command groups.
- [ ] `scripts/eval-detection.mjs --baseline /tmp/synapse-missing-baseline.json`
      exits nonzero.
- [ ] `node scripts/eval-detection.mjs --strict` exits 0 with zero skipped
      scenarios and corpus size at least 37.
- [ ] `node scripts/verify-strict-agent-loop.mjs` exits 0 and asserts all seven
      behaviors from Step 3.
- [ ] Every command in the final verification block exits 0.
- [ ] `git status --short` shows only intentional changes to in-scope files and
      generated ignored artifacts, if any.
- [ ] `plans/README.md` status row for Plan 035 is updated if the executor owns
      plan-index updates.

## STOP conditions

Stop and report back if:

- The workflow or scripts in "Current state" no longer match the excerpts in a
  way that makes this plan's file paths or job model stale.
- Adding the new detection scenarios reveals a product bug that requires a
  broad redesign rather than a narrow fix.
- The strict suite cannot finish on GitHub-hosted `ubuntu-latest` within the
  proposed per-job timeouts after one reasonable optimization pass.
- Any strict check can pass by skipping work, ignoring a failed child process,
  accepting zero tests, or missing a baseline.
- Making the package-release gate strict would require external credentials,
  paid services, or network LLM calls.
- You need to edit files outside the Scope section.

## Maintenance notes

- Keep `scripts/ci-verify-all.mjs` as the developer convenience command. The
  strict PR workflow should use the hard-coded `ci:strict:*` groups so PRs fail
  closed.
- When a new verifier script is added in the future, reviewers should ask
  whether it belongs in one strict group. Do not rely on directory discovery to
  make it required.
- When detection behavior intentionally changes, update corpus scenarios first,
  then run `node scripts/eval-detection.mjs --write-baseline`, and review the
  raw TP/FP/FN changes in the PR.
- The owner must configure GitHub branch protection to require the `required`
  job after this workflow lands. That setting is outside the repo and cannot be
  done by this plan.
