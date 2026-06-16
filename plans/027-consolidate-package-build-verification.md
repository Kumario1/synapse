# Plan 027: Consolidate package build and verification paths

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and stop on any STOP condition. Update this plan's row
> in `plans/README.md` when done unless your reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- scripts/build-package.mjs scripts/verify-package.mjs scripts/verify-npm-pack.mjs apps/cli/scripts/pack.mjs apps/cli/package.json release.config.json README.md package-lock.json`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none hard; coordinates with 024 and 026
- **Category**: dx / release
- **Planned at**: commit `e3c46f2`, 2026-06-12

## Why this matters

The public release flow uses `scripts/build-package.mjs` and publishes
`@kumario/synapse`, but `verify:npm-pack` still runs through
`apps/cli/scripts/pack.mjs` and assumes an installed `@synapse/cli` layout.
Those paths stage different manifests and assertions. A green legacy pack
check can create false confidence about the public package users install.

During review of plan 026, `npm run verify:package` also failed the same way
on clean `HEAD` under Node `20.19.2`: `synapse up --serve` reached the daemon
startup path, then `synapse doctor` failed the Alice daemon health probe with
`fetch failed` and the verifier timed out waiting for daemon health. This plan
now owns making the canonical package smoke path reliable again before plans
024 or 026 are retried.

## Current state

Relevant files:

- `scripts/build-package.mjs` - public release builder.
- `scripts/verify-package.mjs` - public tarball install smoke test.
- `scripts/verify-npm-pack.mjs` - legacy npm pack verifier.
- `apps/cli/scripts/pack.mjs` - legacy CLI-local pack script.
- `apps/cli/package.json` - internal workspace manifest.
- `release.config.json` - public package name/version.
- `README.md` - release flow docs.

Current public builder bundles packages:

```js
// scripts/build-package.mjs:27
const BUNDLED = [
  { name: "@synapse/protocol", dir: "packages/protocol", copy: ["dist"] },
  ...
];
```

Current legacy verifier asserts an internal layout:

```js
// scripts/verify-npm-pack.mjs:113
const serverEntry = join(
  projectDir,
  "node_modules/@synapse/cli/node_modules/@synapse/server/dist/index.js"
);
```

README says the release flow is:

```bash
# README.md:280
node scripts/build-package.mjs
npm run verify:package
npm publish --access public dist-release/<tarball>
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Package verify | `npm run verify:package` | exit 0, including the daemon health smoke |
| npm pack verify | `npm run verify:npm-pack` | exit 0 |
| Full verify all | `npm run verify:all` | exit 0 if services/tooling available |
| Full check | `npm run check` | exit 0 |

Use Node `20.19.x` or newer Node 20.

## Scope

**In scope**:

- `scripts/build-package.mjs`
- `scripts/verify-package.mjs`
- `scripts/verify-npm-pack.mjs`
- `apps/cli/scripts/pack.mjs`
- `README.md`
- `apps/cli/package.json` and `package-lock.json` only if manifest metadata
  must be reconciled

**Out of scope**:

- Changing the public package name/version except where already configured.
- Publishing to npm.
- Reworking analyzer packaging beyond preserving plan 024 assertions.

## Git workflow

- Branch: `advisor/027-consolidate-package-build-verification`
- Commit style: `chore(release): consolidate package verification path`.

## Steps

### Step 1: Choose the canonical package builder

Make `scripts/build-package.mjs` the single canonical builder for the public
package. Either remove the behavior from `apps/cli/scripts/pack.mjs` or make
it a thin wrapper that delegates to the canonical builder and prints the same
tarball path.

Do not maintain two hard-coded bundle manifests.

**Verify**: `rg -n "const BUNDLED|bundleDependencies|@synapse/cli" scripts apps/cli/scripts apps/cli/package.json` -> there is one source of truth or a clearly delegated wrapper.

### Step 2: Make both verifiers exercise the same artifact

Update `scripts/verify-npm-pack.mjs` to use the public tarball layout produced
by `scripts/build-package.mjs`, or redirect `verify:npm-pack` to the public
package verifier if it is now redundant.

Preserve all important smoke checks:

- public `synapse` binary runs;
- bundled server can start;
- daemon can join/report/check;
- analyzer-py and analyzer-go assets from plan 024 are present.

**Verify**: `npm run verify:package && npm run verify:npm-pack` -> both exit 0.

### Step 3: Update docs and scripts

Update README and `package.json` scripts only as needed so contributors see one
release path. If keeping both verifier commands, document their difference
clearly; otherwise make one alias the other.

**Verify**: `rg -n "verify:npm-pack|verify:package|build-package|apps/cli/scripts/pack" README.md package.json scripts apps/cli/scripts` -> no stale internal-package guidance remains.

## Test plan

- Package verifier installs from the public tarball in a fresh project.
- Package verifier's `synapse up --serve`/daemon health smoke is green on a
  clean checkout under Node `20.19.x`.
- npm pack verifier uses the same artifact or is an alias.
- Existing `verify:docker`, `verify:mcp-adapter`, and package smoke behavior are
  not weakened.

## Done criteria

- [ ] `npm run check` exits 0.
- [ ] `npm run verify:package` exits 0.
- [ ] `npm run verify:npm-pack` exits 0.
- [ ] There is no second divergent hard-coded bundle manifest.
- [ ] Go analyzer asset assertions from plan 024 are preserved.
- [ ] No files outside scope are modified.

## STOP conditions

Stop and report if:

- The public tarball cannot support a smoke check that the old verifier covered.
- Consolidation requires changing the public package name.
- Native dependency packaging changes require a separate release-risk plan.

## Maintenance notes

Reviewers should compare the final tarball listing before and after. This plan
is successful only if the release artifact is more trustworthy, not merely if a
script is deleted.
