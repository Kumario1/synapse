# Plan 042: Add ESLint + Prettier with type-aware async-hazard rules

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 6781b81..HEAD -- package.json tsconfig.base.json`
> If either changed materially, re-confirm the toolchain facts in "Current state".

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (first lint pass surfaces many findings — introduced as
  warnings, so it does not block; the only failing rules are a tiny curated set)
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `6781b81`, 2026-06-15

## Why this matters

This ~13K-LOC TypeScript monorepo — a realtime daemon + websocket server where
**unawaited promises and races are the recurring bug class** — has **no linter,
no formatter, no editorconfig**. `npm run typecheck` catches type errors but not
floating promises, unused code, or `no-misused-promises`. `typescript-eslint`'s
type-aware `no-floating-promises` / `no-misused-promises` rules catch exactly the
async hazards prior audits keep finding by hand. This plan adds ESLint (flat
config, type-aware) + Prettier with a **small set of error-level rules** (the
async-safety ones) and everything else as **warnings**, so it lands without a
giant cleanup and can be ratcheted later.

## Current state

- `package.json` — root scripts (no `lint`/`format`):
  - `"build": "turbo run build"`, `"typecheck": "turbo run typecheck"`,
    `"test": "turbo run test"`, plus the `ci:strict:*` runners.
  - devDeps: `@types/node`, `tsx`, `turbo`, `typescript` only.
  - workspaces: `apps/*`, `packages/*`; package manager `npm@11.4.1`; ESM
    (`"module": "NodeNext"` in `tsconfig.base.json`).
- `tsconfig.base.json` — `strict: true`, `target ES2022`, `module/moduleResolution NodeNext`.
- Source dirs: `apps/cli/src`, `apps/server/src`, `packages/*/src`. Tests are
  `*.test.ts` run via `node --test` over built `dist`. Verify scripts are
  `scripts/*.mjs` (plain Node ESM, not part of the TS project).
- `scripts/ci-strict-runner.mjs:23-27` — the `static` strict group runs build +
  typecheck + `ci-test-inventory.mjs`; it is where a `lint` step belongs.

### Repo conventions to match

- 2-space indent, double quotes, semicolons, trailing commas off (observed
  across `apps/server/src/index.ts`, `state.ts`). Configure Prettier to match so
  the first `format` run is near-noop, not a 13K-line reformat.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Install   | `npm install`                    | exit 0; lockfile updates |
| Lint      | `npm run lint`                   | exit 0 (warnings allowed, **0 errors**) |
| Format check | `npm run format:check`        | exit 0 |
| Typecheck | `npm run typecheck`               | exit 0 (unchanged) |
| Build     | `npm run build`                   | exit 0 (unchanged) |

## Scope

**In scope** (create/modify):
- `package.json` (root) — add devDeps + `lint` / `format` / `format:check` scripts.
- `eslint.config.js` (create, repo root) — flat config.
- `.prettierrc.json` (create) and `.prettierignore` (create).
- `.editorconfig` (create).
- `scripts/ci-strict-runner.mjs` — add `npm run lint` to the `static` group.
- Lockfile (`package-lock.json`) — updated by `npm install`.

**Out of scope**:
- **Do NOT auto-fix or reformat existing source in this plan.** No `eslint --fix`,
  no `prettier --write` over `src`. The goal is to *install the gate*, not churn
  the tree. A formatting sweep is a separate, reviewable plan.
- `scripts/*.mjs` — lint TS source only; exclude `scripts/`, `dist/`, `node_modules`,
  `.turbo/`, `Synapse/` (the untracked nested copy) via eslint `ignores`.
- Changing any TS source to satisfy a rule — if `no-floating-promises` finds real
  issues, they go in a follow-up; see STOP conditions.

## Git workflow

- Branch: `advisor/042-add-eslint-prettier-baseline`
- Commit style: `chore: add eslint + prettier baseline (type-aware async rules)`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add dev dependencies

Add to root `package.json` `devDependencies` (use current stable versions;
`typescript-eslint` v8+ supports flat config + `projectService`):

```
"eslint": "^9",
"typescript-eslint": "^8",
"prettier": "^3",
"eslint-config-prettier": "^9"
```

Run `npm install`.

**Verify**: `npm install` → exit 0; `npx eslint --version` prints a 9.x version.

### Step 2: Create `eslint.config.js` (flat, type-aware)

Create `eslint.config.js` at the repo root. Use `typescript-eslint`'s flat
helper, enable the type-aware service, set the **async-safety rules to `error`**
and keep the broader recommended set at `warn` so the tree lints clean today:

```js
// @ts-check
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".turbo/**",
      "Synapse/**",
      "scripts/**",
      "**/*.mjs",
      "**/*.cjs"
    ]
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["apps/**/src/**/*.ts", "packages/**/src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // The async-hazard class this codebase is most exposed to → hard errors:
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // Everything else from recommendedTypeChecked stays advisory for now so
      // the gate lands without a cleanup; ratchet to error in a follow-up.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn"
    }
  },
  {
    // Test files: relax the unsafe-* noise.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off"
    }
  },
  prettier
);
```

> `recommendedTypeChecked` emits many `warn`s on existing code — that is fine;
> `npm run lint` is configured (Step 4) to pass on warnings and fail only on
> errors. If the **error** rules (`no-floating-promises`/`no-misused-promises`)
> fire on existing code, that is a real finding — see STOP conditions.

**Verify**: `npx eslint apps/server/src/index.ts` runs without a config error
(it may print warnings).

### Step 3: Create Prettier + editorconfig files

`.prettierrc.json`:

```json
{
  "printWidth": 100,
  "tabWidth": 2,
  "semi": true,
  "singleQuote": false,
  "trailingComma": "none"
}
```

`.prettierignore`:

```
dist
node_modules
.turbo
Synapse
package-lock.json
```

`.editorconfig`:

```
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
insert_final_newline = true
trim_trailing_whitespace = true
```

**Verify**: `npx prettier --check "apps/server/src/index.ts"` runs (it may report
the file differs — that's fine; this plan does not reformat).

### Step 4: Add scripts

In root `package.json` `scripts`:

```json
"lint": "eslint .",
"format": "prettier --write \"{apps,packages}/**/src/**/*.ts\"",
"format:check": "prettier --check \"{apps,packages}/**/src/**/*.ts\""
```

ESLint exits non-zero only on **errors** by default (warnings don't fail it), so
`npm run lint` passing means zero `no-floating-promises`/`no-misused-promises`
violations.

**Verify**: `npm run lint` → exit 0 (warnings printed, **0 errors**). If it
exits non-zero, read the errors: they are floating/misused promises — go to STOP.

### Step 5: Wire lint into the static CI gate

In `scripts/ci-strict-runner.mjs`, add to the `static` group (after typecheck):

```js
    command("npm", "run", "lint")
```

**Verify**: `npm run ci:strict:static` → exit 0 (build + typecheck + inventory +
coverage-if-present + lint). If build is heavy in your env, instead verify
`npm run lint` alone exits 0.

## Test plan

- No `*.test.ts` added — linting is the gate. Validation is `npm run lint`
  exiting 0 (0 errors) and the static strict group passing.
- Sanity: deliberately introduce a floating promise in a scratch file under
  `apps/server/src/` (e.g. `Promise.resolve(1);` as a statement), run
  `npm run lint`, confirm it now **errors**, then remove the scratch line. (Don't
  commit the scratch line.)

## Done criteria

ALL must hold:

- [ ] `npm install` exits 0
- [ ] `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.editorconfig` exist
- [ ] `npm run lint` exits 0 with **0 errors** (warnings allowed)
- [ ] `npm run typecheck` still exits 0 (no regression)
- [ ] `npm run build` still exits 0
- [ ] A deliberately-added floating promise makes `npm run lint` error (Step 5 sanity), and was removed before finishing
- [ ] `scripts/ci-strict-runner.mjs` `static` group includes `npm run lint`
- [ ] No source files under `apps/*/src` or `packages/*/src` were reformatted or rule-fixed (`git diff` shows only config/package/lockfile changes)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `npm run lint` reports **errors** from `no-floating-promises` /
  `no-misused-promises` on existing code. This is the valuable outcome — those
  are real latent bugs. **Do not silence them by downgrading the rule or adding
  `// eslint-disable`.** Instead: list every error location (`file:line`) in your
  report and STOP. The maintainer decides whether to fix-then-error-gate or
  land warnings-only first. (If the maintainer pre-authorized "land it green,"
  the fallback is to set those two rules to `warn` *and clearly flag in the
  report that they are not yet enforced* — but prefer reporting the findings.)
- `projectService: true` fails to resolve tsconfigs for some files (type-aware
  parsing error). Report which files; a fallback is an explicit
  `parserOptions.project` array of the per-package tsconfigs.
- Prettier wants to reformat a huge fraction of the tree (`.prettierrc` doesn't
  match the real style). Re-derive the settings from an actual source file and
  report; do NOT run `format` over the tree.

## Maintenance notes

- Ratchet plan (separate, later): once the async-error rules are clean, promote
  the `warn`-level `no-unsafe-*` / `no-explicit-any` rules to `error` package by
  package, and add a one-time `prettier --write` formatting sweep as its own
  reviewable commit.
- The `Synapse/` ignore is important — it's an untracked nested build copy, not
  source.
- Reviewer should confirm the lint step doesn't materially slow the `static` CI
  job (type-aware linting builds the program once; with `projectService` it
  reuses tsconfigs). If it does, scope `eslint .` to changed files in CI later.
