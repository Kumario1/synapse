# Plan 010: Make the published npm package the install front door

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c46a61..HEAD -- release.config.json scripts/build-package.mjs scripts/verify-package.mjs README.md`
> If any of these changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction (adoption/distribution)
- **Planned at**: commit `8c46a61`, 2026-06-11

## Why this matters

The CLI **is** published on npm as `@kumario/synapse` — version `0.1.1`,
published 2026-06-09 — but that build predates the entire roadmap completion
run (PRs #37–#48): no file watcher, no Go analyzer, no branch-aware severity,
no rate limiting, no protocol negotiation, no RAG memory. Meanwhile the
README never mentions the published name: it only references `@synapse/cli`
(which 404s on npm — it is the *internal workspace* name) and a
build-it-yourself tarball. So anyone who finds the package gets a stale
build, and anyone who reads the docs can't find the package. This plan
aligns the version, refreshes the staged release, and makes the README point
at the real package — the cheapest possible adoption win.

Note: this plan stages and verifies the release tarball but does **not**
publish. `npm publish` needs the owner's npm credentials and is an
irreversible public action — it is an explicit STOP/hand-off at the end.

## Current state

- `release.config.json` (repo root) — the single source of the public
  name/version. Currently:

  ```json
  {
    "name": "@kumario/synapse",
    "version": "0.1.0",
    "description": "Real-time coordination for coding agents: contract-level conflict detection before an agent edits, briefings, and team memory.",
    "homepage": "https://github.com/Kumario1/synapse",
    "license": "MIT"
  }
  ```

  The registry already has `0.1.0` and `0.1.1` (`npm view @kumario/synapse time`),
  so the version here is already stale relative to the registry — `0.1.1`
  was published from a manifest bump that never landed back in the repo.

- `scripts/build-package.mjs` — assembles the publishable package: builds
  all workspaces, stages `dist-release/package/` with the five `@synapse/*`
  workspace packages copied into `node_modules/` as `bundleDependencies`
  (header comment lines 2–17 explains the one-public-package strategy),
  writes the top-level manifest from `release.config.json` (lines 112–128),
  packs to `dist-release/<name>-<version>.tgz`, and prints
  `publish with: npm publish --access public dist-release/<tarball>` (line 139).
  It also copies the root `README.md` into the package (line 62) — so the
  README fix below is also the npm package page fix.

- `scripts/verify-package.mjs` — asserts exactly one tarball in
  `dist-release/` (lines 29–30) and exercises an install from it. Root alias:
  `npm run verify:package` (no rebuild; run it after `build-package`).

- `README.md` — two places reference the internal name as if it were the
  product:
  - line 71 (features table): "or install `@synapse/cli` as a self-contained tarball."
  - line 257: "**Install as a package** — `@synapse/cli` packs as a
    self-contained tarball …" followed by `node apps/cli/scripts/pack.mjs`.
    Note `apps/cli/scripts/pack.mjs` is the *older, separate* packing path
    used by `verify:npm-pack`; the release path is `scripts/build-package.mjs`.
    Keep both scripts — only the README narrative changes.

- `dist-release/` is gitignored (`.gitignore:3`) — staged artifacts never get
  committed.

- Repo conventions: README uses `<table>` feature rows and fenced bash blocks;
  match the surrounding style. Commit style is conventional commits
  (e.g. `fix(server): release advisory locks on init failure`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Registry state (read-only) | `npm view @kumario/synapse versions` | `[ '0.1.0', '0.1.1' ]` |
| Build + stage release | `node scripts/build-package.mjs` | ends with `tarball: dist-release/kumario-synapse-<version>.tgz` |
| Verify the tarball | `npm run verify:package` | exit 0 |
| Full hygiene (slow, optional) | `npm run verify:npm-pack` | exit 0 |

## Scope

**In scope** (the only files you modify):
- `release.config.json` (version bump only)
- `README.md` (install instructions + a short release-flow note)

**Out of scope** (do NOT touch, even though they look related):
- `apps/cli/package.json` and all workspace `package.json` names/versions —
  `@synapse/*` are internal workspace names; renaming them breaks every
  import and the bundling scripts.
- `scripts/build-package.mjs`, `apps/cli/scripts/pack.mjs` — both work; this
  plan changes no packing logic.
- Running `npm publish` — owner-only (STOP condition).
- CI workflows.

## Git workflow

- Branch: `advisor/010-npm-front-door`
- Conventional commits, e.g. `docs(readme): point installs at @kumario/synapse; bump release to 0.2.0`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Bump the release version to 0.2.0

In `release.config.json`, change `"version": "0.1.0"` → `"version": "0.2.0"`.
Rationale to preserve in the commit body: registry already has 0.1.1; the
new build adds twelve PRs' worth of features (watcher, Go analyzer,
negotiation, rate limits, RAG), so a minor bump, not a patch.

**Verify**: `node -e "console.log(JSON.parse(require('fs').readFileSync('release.config.json','utf8')).version)"` → `0.2.0`

### Step 2: Build and verify the staged release

```bash
node scripts/build-package.mjs
npm run verify:package
```

**Verify**: build-package prints `packing @kumario/synapse@0.2.0` and a
tarball path; `verify:package` exits 0. (`dist-release/` is gitignored —
nothing to commit from this step.)

### Step 3: Rewrite the README install story

1. Line 71 (features table, "Ship anywhere" row): replace
   "or install `@synapse/cli` as a self-contained tarball" with
   "or `npm install -g @kumario/synapse` for the self-contained CLI".
2. Replace the "Install as a package" block at line ~257 with a section that
   leads with the published package and keeps the from-source path second:

   ```markdown
   **Install as a package** — the CLI ships as a single self-contained npm
   package (all five workspace packages, the server, and the Python/Go
   sidecar assets bundled):

   ```bash
   npm install -g @kumario/synapse   # installs the `synapse` binary
   ```

   To build the same tarball from a checkout (release flow):

   ```bash
   node scripts/build-package.mjs    # stages + packs dist-release/<name>-<version>.tgz
   npm run verify:package            # installs from the tarball and smoke-tests it
   npm publish --access public dist-release/<tarball>   # maintainers only
   ```

   The public name/version live in `release.config.json`; bump the version
   there before building. Keep it ahead of `npm view @kumario/synapse version`.
   ```

   Match the README's existing tone — scannable, bold lead-ins (see the
   neighboring **CI** and **Privacy** blocks).
3. Search for any other `@synapse/cli` mentions presented as the install
   name: `grep -n '@synapse/cli' README.md`. Keep the ones describing the
   *dev workspace* (e.g. line 165's `npm run dev --workspace @synapse/cli`)
   — those are correct. Only user-facing install references change.

**Verify**: `grep -n 'kumario/synapse' README.md` → at least 2 matches;
`grep -n 'install.*@synapse/cli' README.md` → 0 matches.

### Step 4: Quick prose check

Re-read the changed README sections top to bottom once; confirm the code
fences render (balanced backticks — the nested fence in step 3's template
must be flattened to a single level when you write the real file).

**Verify**: `npx --yes markdownlint-cli2 README.md` is NOT required (repo has
no markdownlint config) — instead: `node -e "require('fs').readFileSync('README.md','utf8')"`
exits 0 and a manual scan shows balanced fences in the edited region.

## Test plan

No unit tests — packaging + docs. The machine gates are
`node scripts/build-package.mjs` and `npm run verify:package` (Step 2), which
install from the actual tarball and exercise the binary. Optionally also run
`npm run verify:npm-pack` (the older `apps/cli` packing path) to confirm it
still passes untouched.

## Done criteria

- [ ] `release.config.json` version is `0.2.0`
- [ ] `node scripts/build-package.mjs` succeeds and prints the 0.2.0 tarball
- [ ] `npm run verify:package` exits 0
- [ ] `grep -n 'install.*@synapse/cli' README.md` → no matches
- [ ] `git status --porcelain` shows only `release.config.json`, `README.md`, `plans/README.md`
- [ ] NOT published — the final report hands the owner the exact publish command printed by build-package
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `npm view @kumario/synapse versions` shows anything beyond `0.1.0, 0.1.1`
  (the owner published again; re-derive the right bump with them).
- `node scripts/build-package.mjs` fails — the staging script encodes
  bundling invariants (see its header comment); do not patch it, report.
- `npm run verify:package` fails twice after a clean rebuild.
- You are tempted to run `npm publish` — never; that is the owner's step.

## Maintenance notes

- The version now lives in two places people must keep ordered:
  `release.config.json` (source) and the registry. The README note from
  Step 3 documents this; if releases become frequent, a follow-up could
  check `npm view` inside `build-package.mjs` and refuse to pack a version
  the registry already has.
- `dist-release/package/package.json` in any stale local checkout may still
  say 0.1.0 — it's gitignored output; ignore it.
- Reviewer focus: the README diff (the only public-facing artifact) and that
  no workspace `package.json` was touched.
