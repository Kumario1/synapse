# Plan 026: Align the documented and packaged Node runtime floor

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and stop on any STOP condition. Update this plan's row
> in `plans/README.md` when done unless your reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- README.md package.json package-lock.json scripts/build-package.mjs .github/workflows/ci.yml .nvmrc`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx / migration
- **Planned at**: commit `e3c46f2`, 2026-06-12

## Why this matters

The README says Node.js 20+, and the release builder publishes
`engines.node` as `>=20.6`. The lockfile currently includes runtime watcher
dependencies that require Node `>=20.19.0`. Users on Node 20.6-20.18 are told
they are supported but can hit install/runtime engine failures. CI also asks
for generic Node 20 while root `packageManager` pins npm 11.4.1.

## Current state

Relevant files:

- `README.md` - prerequisites.
- `scripts/build-package.mjs` - generated public package manifest.
- `package.json` and `package-lock.json` - package manager and dependencies.
- `.github/workflows/ci.yml` - CI runtime.
- Optional `.nvmrc` - add if this repo wants a local runtime hint.

Current docs/package metadata:

```md
<!-- README.md:83 -->
**Prerequisites:** Node.js 20+ and npm.
```

```js
// scripts/build-package.mjs:122
engines: { node: ">=20.6" },
```

Current locked dependency floor:

```json
// package-lock.json:1008
"node_modules/chokidar": {
  "version": "5.0.0",
  "engines": { "node": ">= 20.19.0" }
}
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Current node | `node --version` | `v20.19.x` or newer compatible Node |
| Current npm | `npm --version` | compatible with `packageManager` |
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | exit 0 |
| Package verify | `npm run verify:package` | exit 0 |

Use Node `20.19.x` or newer Node 20.

## Scope

**In scope**:

- `README.md`
- `scripts/build-package.mjs`
- `package.json`
- `package-lock.json` only if npm metadata needs refresh
- `.github/workflows/ci.yml`
- `.nvmrc` if adding a repo-local hint

**Out of scope**:

- Upgrading to a new major Node line.
- Changing app runtime behavior.
- Replacing dependencies just to lower the Node floor.

## Git workflow

- Branch: `advisor/026-align-node-runtime-floor`
- Commit style: `chore: align Node runtime floor with locked dependencies`.

## Steps

### Step 1: Pick and apply one runtime floor

Set the repo-supported floor to Node `>=20.19.0`, matching `chokidar` and
`readdirp`.

Update:

- README prerequisites;
- generated package `engines.node` in `scripts/build-package.mjs`;
- root `package.json` `engines` if it exists or should be added;
- `.nvmrc` with a concrete Node 20.19.x version if the repo uses version
  files;
- CI `actions/setup-node` to request a concrete compatible Node, not generic
  `20`, if the repo wants CI to prove the floor.

**Verify**: `rg -n "20\\.19|>=20\\.19|node-version" README.md package.json scripts/build-package.mjs .github/workflows/ci.yml .nvmrc` -> all runtime surfaces align.

### Step 2: Align npm/Corepack expectations

The root `package.json` pins `packageManager` to npm 11.4.1. Make CI use the
intended npm version if it currently uses the runner default. Prefer the
least-intrusive approach, such as Corepack only if npm supports it cleanly in
this repo.

Do not rewrite the lockfile except to update metadata that npm changes because
of the manifest edits.

**Verify**: `npm --version` and CI workflow text are consistent.

### Step 3: Verify package metadata

Run the release-package verifier so the staged public manifest gets checked.

**Verify**: `npm run verify:package` -> exit 0.

## Test plan

- Full build/typecheck/test under supported Node.
- Package verification confirms generated `engines.node`.
- No broad lockfile churn.

## Done criteria

- [ ] `npm run check` exits 0.
- [ ] `npm run verify:package` exits 0.
- [ ] README, root metadata, CI, and generated package manifest all state the
  same Node floor.
- [ ] Lockfile changes are limited to expected metadata, or there is no
  lockfile change.
- [ ] No files outside scope are modified.

## STOP conditions

Stop and report if:

- CI cannot install/use npm 11.4.1 under Node 20.19.x.
- Updating the lockfile rewrites dependency versions unrelated to this plan.
- A supported deployment target cannot run Node 20.19.x.

## Maintenance notes

Future dependency upgrades should check package engine floors before docs or
release metadata are changed. This plan also prevents repeating the Node 25
test-discovery issue from plan 017 by documenting the supported Node line.
