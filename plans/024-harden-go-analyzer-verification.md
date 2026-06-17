# Plan 024: Make Go analyzer failures visible in CI and package checks

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and stop on any STOP condition. Update this plan's row
> in `plans/README.md` when done unless your reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- packages/analyzer-go/scripts/setup-go.mjs packages/analyzer-go/src/index.test.ts scripts/verify-go-check.mjs scripts/verify-fuzz.mjs scripts/verify-package.mjs scripts/verify-npm-pack.mjs apps/cli/package.json package-lock.json README.md`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 026 recommended
- **Category**: tests
- **Planned at**: commit `e3c46f2`, 2026-06-12

## Why this matters

The Go analyzer is part of the shipped CLI bundle, but several verification
paths skip or pass when it is missing or fails to build. Local no-Go-toolchain
degradation is useful, but CI has Go 1.22 and should fail if Go exists and the
sidecar cannot build. Package verifiers should also assert that Go analyzer
assets ship with the public package.

## Current state

Relevant files:

- `packages/analyzer-go/scripts/setup-go.mjs` - builds the sidecar.
- `packages/analyzer-go/src/index.test.ts` - skips behavior tests when binary
  unavailable.
- `scripts/verify-go-check.mjs` and `scripts/verify-fuzz.mjs` - skip when the
  Go binary is absent.
- `scripts/verify-package.mjs` and `scripts/verify-npm-pack.mjs` - package
  verifiers.
- `apps/cli/package.json` and `package-lock.json` - bundle metadata.

Current setup behavior:

```js
// packages/analyzer-go/scripts/setup-go.mjs:65
if (build.status !== 0) {
  log("go build failed; .go files will use file-level detection until it succeeds.");
  process.exit(0);
}
```

Current tests skip the whole behavior suite:

```ts
// packages/analyzer-go/src/index.test.ts:14
const available = await goAnalyzerAvailable();
```

Current package verifier omits analyzer-go from import probes:

```js
// scripts/verify-package.mjs:56
const imported = ["@synapse/protocol", "@synapse/conflict-engine", "@synapse/analyzer-ts", "@synapse/analyzer-py"];
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Go setup | `npm run setup:analyzer-go` | exit 0 and binary built when Go exists |
| Go tests | `npm run build && npm test --workspace @synapse/analyzer-go` | exit 0 |
| Go verifier | `npm run verify:go-check` | exit 0 |
| Fuzz verifier | `npm run verify:fuzz` | exit 0 |
| Package verifier | `npm run verify:package` | exit 0 |
| npm pack verifier | `npm run verify:npm-pack` | exit 0 |

Use Node `20.19.x` or newer Node 20. CI has Go 1.22.

## Scope

**In scope**:

- `packages/analyzer-go/scripts/setup-go.mjs`
- `packages/analyzer-go/src/index.test.ts`
- `scripts/verify-go-check.mjs`
- `scripts/verify-fuzz.mjs`
- `scripts/verify-package.mjs`
- `scripts/verify-npm-pack.mjs`
- `apps/cli/package.json`
- `package-lock.json` only if refreshed bundle metadata changes
- `README.md` only for verifier table wording if needed

**Out of scope**:

- Rewriting Go analyzer parsing.
- Consolidating all package build flows; plan 027 owns that.
- Making Go mandatory for local development without an escape hatch.

## Git workflow

- Branch: `advisor/024-harden-go-analyzer-verification`
- Commit style: `test(analyzer-go): fail CI when sidecar build regresses`.

## Steps

### Step 1: Separate missing toolchain from failed build

In `setup-go.mjs`, keep exit 0 when `go version` is unavailable. When Go is
available but `go build` fails, exit non-zero. If local developers need a
force-skip escape hatch, add a clearly named env such as
`SYNAPSE_ANALYZER_GO_OPTIONAL=1`; do not enable that in CI.

**Verify**: `npm run setup:analyzer-go` -> exit 0 with Go installed.

### Step 2: Make CI/verifiers fail when Go exists but the binary is absent

Update `scripts/verify-go-check.mjs` and `scripts/verify-fuzz.mjs` so they:

- still skip when no Go toolchain exists and no binary exists;
- fail when Go exists but setup/build did not produce the binary;
- continue to run the existing behavior checks when the binary exists.

**Verify**: `npm run verify:go-check && npm run verify:fuzz` -> exit 0.

### Step 3: Assert analyzer-go package assets

Update `scripts/verify-package.mjs` and `scripts/verify-npm-pack.mjs` to assert
that `@synapse/analyzer-go` resolves and that the tarball/package ships:

- `dist/index.js`;
- `go/` sources needed for setup;
- `scripts/setup-go.mjs`.

If lockfile bundle metadata is stale after manifest changes, refresh it with
the repo-supported npm version in the worker worktree.

**Verify**: `npm run verify:package && npm run verify:npm-pack` -> exit 0.

### Step 4: Keep local degradation documented

If user-facing messages change, update README verifier/package notes to say Go
is optional locally but required for CI's Go analyzer checks.

**Verify**: `rg -n "verify:go-check|analyzer-go|Go" README.md packages/analyzer-go/scripts/setup-go.mjs scripts/verify-go-check.mjs` -> shows consistent wording.

## Test plan

- Existing Go analyzer tests pass when Go exists.
- Verification fails for a build error when Go exists.
- Verification can still skip on machines without Go.
- Package verifiers assert Go assets.

## Done criteria

- [ ] `npm run setup:analyzer-go` exits 0 and builds the binary on a machine
  with Go.
- [ ] `npm run verify:go-check` exits 0.
- [ ] `npm run verify:fuzz` exits 0.
- [ ] `npm run verify:package` exits 0.
- [ ] `npm run verify:npm-pack` exits 0.
- [ ] Package verifiers explicitly mention `@synapse/analyzer-go`.
- [ ] No files outside scope are modified.

## STOP conditions

Stop and report if:

- CI does not actually provide Go after checking `.github/workflows/ci.yml`.
- npm lockfile refresh tries to rewrite unrelated dependency versions.
- Fixing package verification requires the broader package-flow refactor from
  plan 027.

## Maintenance notes

Plan 027 will later consolidate package build paths. When reviewing that plan,
make sure it preserves the Go asset assertions introduced here.
