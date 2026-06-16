# Plan 047: Add AGENTS.md + contributor/community-health docs for professional GitHub standards

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ba1bd003..HEAD -- AGENTS.md CONTRIBUTING.md SECURITY.md CODEOWNERS .github/`
> Expected: the only pre-existing tracked file under `.github/` is
> `.github/workflows/ci.yml`. If `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`,
> `CODEOWNERS`, or `.github/PULL_REQUEST_TEMPLATE.md` already exist as tracked
> files, STOP and report — this plan assumes they are net-new.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (adds new docs only; touches no source, no CI, no config)
- **Depends on**: none. Recommended **before** plan 048 (the governance runbook
  turns on a `CODEOWNERS`-based required review that needs the `CODEOWNERS`
  file this plan creates).
- **Category**: docs
- **Planned at**: commit `259e3f7`, 2026-06-15; **reconciled** to `main` @ `ba1bd003`, 2026-06-16 (plan 042 landed in between, adding `lint`/`format` scripts — see "Current state").
- **Issue**: —

## Why this matters

This is a **public** repo (`github.com/Kumario1/synapse`) worked by multiple AI
agents and tools (branches under `advisor/`, `codex/`, `cursor/`) plus the
maintainer, but it has **no `AGENTS.md`, no `CONTRIBUTING.md`, no PR template,
no `CODEOWNERS`, and no `SECURITY.md`**. Conventions (conventional-commit
messages, `type/slug` branch names, one-PR-per-change, a single required CI
gate) live only in people's heads and in `plans/`. The result: every new agent
re-derives the rules, and there is nothing on the repo telling a drive-by
contributor or a security researcher what to do. This plan writes the standards
down in the files GitHub and AI coding tools actually read, so the conventions
are discoverable and enforceable. It pairs with plan 048, which turns the
written rules into enforced branch protection.

## Current state

The facts the executor needs, inlined:

- **No governance docs exist.** `git ls-files | grep -iE 'AGENTS|CONTRIBUTING|CODEOWNERS|SECURITY|PULL_REQUEST_TEMPLATE|ISSUE_TEMPLATE'`
  returns nothing. The only tracked file under `.github/` is
  `.github/workflows/ci.yml`.
- **Commit convention = Conventional Commits** with a scope. Real examples from
  `git log` on this repo (use these as the template in `AGENTS.md`):
  - `feat(web): add live dashboard app`
  - `feat(daemon): await authoritative locks before evaluating check`
  - `refactor(036): simplify check per review — inline lock union`
  - `test: add two-daemon atomic-intent integration verifier`
- **Branch convention = `type/short-slug`.** Observed prefixes: `advisor/`,
  `feat/`, `fix/`, `docs/`, `refactor/`, `chore/`, `codex/`, `cursor/`. The
  advisory workflow uses `advisor/NNN-slug` (e.g. `advisor/037-web-dashboard`).
- **Merge style = squash.** Merged feature-branch tips are not ancestors of
  `main` (e.g. PR #87 `advisor/037-web-dashboard` is merged but `git branch
  --merged origin/main` does not list it), which is the signature of squash
  merges. State this in `AGENTS.md` so contributors keep PRs small.
- **CI gate.** `.github/workflows/ci.yml` defines jobs `static`, `unit`,
  `detection-ratchet`, `agent-loop`, `polyglot`, `services-security`,
  `package-release`, and an aggregate `required` job (`ci.yml:172`) that fails
  unless all seven pass. The `required` check is the one that must be green to
  merge (plan 048 makes it a required status check).
- **Toolchain.** Root `package.json` is an npm workspace monorepo
  (`apps/*`, `packages/*`), package manager `npm@11.4.1`, Node 20 (see `.nvmrc`
  and `setup-node` in `ci.yml`). Real root scripts: `build` (`turbo run build`),
  `typecheck` (`turbo run typecheck`), `test` (`turbo run test`), `lint`
  (`eslint "{apps,packages}/**/src/**/*.ts"`), `format` (`prettier --write …`),
  `format:check` (`prettier --check …`), plus the `ci:strict:*` runners.
  **`lint`/`format` now exist** (plan 042 landed on `main` as commit `234906d
  chore: add eslint + prettier baseline`; `eslint.config.js`, `.prettierrc.json`,
  `.prettierignore` are tracked). The CI `static` job runs
  `npm run ci:strict:static`, which executes `npm run typecheck` **and**
  `npm run lint` (`scripts/ci-strict-runner.mjs:25-28`), so **lint is part of the
  `required` gate**. Reference `build`, `typecheck`, `test`, `lint`,
  `format:check`, and the `ci:strict` runners as real commands.
- **Secrets hygiene is already correct.** `.gitignore` ignores `.env`, `.env.*`
  (keeping `.env.example`), and `.DS_Store`. `.env` is **not** tracked and never
  was (`git log --all -- .env` is empty). `AGENTS.md` should codify "never
  commit `.env` / secrets; rotate if leaked" but must **not** imply there is a
  current leak, and must **never** contain a real secret value.
- **License**: MIT (`LICENSE` present). Maintainer / GitHub owner: `@Kumario1`.

### Repo conventions to match in the prose

- Markdown style across the repo: ATX `#` headings, sentence-case headings,
  fenced code blocks with language tags. Match `plans/README.md` and `README.md`
  for tone (direct, scannable, no marketing fluff).

## Commands you will need

| Purpose            | Command                                              | Expected on success |
|--------------------|------------------------------------------------------|---------------------|
| Confirm net-new    | `git ls-files \| grep -iE 'AGENTS\|CONTRIBUTING\|CODEOWNERS\|SECURITY.md\|PULL_REQUEST_TEMPLATE\|ISSUE_TEMPLATE'` | prints nothing (exit 1 is fine) |
| List created files | `git status --porcelain`                             | shows only the new files from this plan |
| Markdown sanity    | `git grep -n "TODO-FILL" -- AGENTS.md CONTRIBUTING.md SECURITY.md` | prints nothing (no unfilled placeholders) |
| CODEOWNERS lint    | `gh api repos/Kumario1/synapse/codeowners/errors -q '.errors'` (after the file is pushed; optional, see Step 4) | `[]` |

> Note: this plan creates files only. There is **no build/test to run** and you
> must **not** run `npm`, `turbo`, or any mutating git command (no commit, no
> push). Creating the files and updating `plans/README.md` is the whole job.

## Scope

**In scope** (create these files; create parent dirs as needed):
- `AGENTS.md` (repo root) — primary, tool-agnostic agent guide
- `CONTRIBUTING.md` (repo root) — human contributor guide (short; points to AGENTS.md)
- `SECURITY.md` (repo root) — vulnerability disclosure policy
- `CODEOWNERS` (repo root) — default reviewer mapping
- `.github/PULL_REQUEST_TEMPLATE.md` — PR checklist
- `.github/ISSUE_TEMPLATE/bug_report.yml` — bug issue form (Step 6, optional)
- `.github/ISSUE_TEMPLATE/feature_request.yml` — feature issue form (Step 6, optional)
- `.github/ISSUE_TEMPLATE/config.yml` — issue chooser config (Step 6, optional)
- `plans/README.md` — status row update only

**Out of scope** (do NOT touch):
- `.github/workflows/ci.yml` and anything under `scripts/` — CI behavior is not
  part of this plan (plan 048 wires the existing `required` job into branch
  protection; plan 041 owns CI gate changes).
- `README.md` — leave it; `AGENTS.md` links to it, it does not link back here.
- Any source under `apps/`, `packages/`, `evals/`.
- `package.json` — do not add scripts; this plan introduces no tooling.
- The loose root `*.md` files (`synapse-context.md`, `plan-future.md`, etc.) and
  the untracked `Synapse/` dir — relocating/cleaning those is plan 048's optional
  hygiene step, not this one.

## Git workflow

- Branch: `advisor/047-github-standards-docs` (match the repo's `type/slug`
  convention; the advisory workflow uses `advisor/NNN-slug`).
- One commit is fine for this plan; message (Conventional Commits, as observed
  in `git log`): `docs: add AGENTS.md and GitHub community-health files`.
- Do **NOT** push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create `AGENTS.md` (the primary deliverable)

Create `AGENTS.md` at the repo root. This is the file AI coding tools (Codex,
Cursor, and others) read by convention, and the single source of truth for "how
we work on this repo." Use the content below **verbatim in structure**, filling
the facts from "Current state" (they are already filled here — do not invent new
ones). Keep it concise and scannable.

````markdown
# AGENTS.md — How to work on Synapse

This file is the contract for any agent or contributor making changes to this
repository. Human contributors: see also [CONTRIBUTING.md](CONTRIBUTING.md)
(it points back here for the shared rules). If you use an AI coding tool, point
it at this file.

## TL;DR

- One focused change per branch and per PR. Small PRs merge; big ones rot.
- Branch from `main`, named `type/short-slug` (see below).
- Commit with [Conventional Commits](https://www.conventionalcommits.org/).
- Open a PR into `main`. PRs are **squash-merged**. The CI `required` check
  must be green. Never push directly to `main`.
- Never commit secrets or `.env`. Match existing code style. Don't expand scope.

## Project shape

- npm **workspace monorepo**: `apps/*` (e.g. `apps/server`, `apps/cli`,
  `apps/web`) and `packages/*`. Package manager: npm (`npm@11.4.1`). Runtime:
  **Node 20** (see `.nvmrc`).
- Build/check commands (run from the repo root):
  - `npm ci` — install from the lockfile.
  - `npm run build` — `turbo run build`.
  - `npm run typecheck` — `turbo run typecheck`.
  - `npm test` — `turbo run test`.
  - `npm run lint` — `eslint` over `{apps,packages}/**/src/**/*.ts`. **Part of the
    CI `required` gate** (the `static` job runs typecheck + lint).
  - `npm run format` — `prettier --write …`; `npm run format:check` to verify.
  - `npm run ci:strict:package` and the other `ci:strict:*` runners — the strict
    gates CI enforces.

## Branching

- Always branch off the latest `main`. Do not commit to `main` directly.
- Name: `type/short-slug`, lowercase, hyphenated. `type` is one of
  `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `spike`.
  - Examples: `feat/web-dashboard`, `fix/daemon-lock-race`, `docs/readme-rewrite`.
  - Advisor-driven work uses `advisor/NNN-slug` (matches `plans/NNN-*.md`).
- Delete your branch after it merges (the repo auto-deletes merged branches).

## Commits

Conventional Commits: `type(scope): summary`. Real examples from this repo:

```
feat(web): add live dashboard app
feat(daemon): await authoritative locks before evaluating check
refactor(036): simplify check per review — inline lock union
test: add two-daemon atomic-intent integration verifier
```

- Imperative mood, lower-case summary, no trailing period.
- `scope` is optional but encouraged (`server`, `daemon`, `cli`, `web`,
  `protocol`, or a plan number).
- Keep commits coherent; you don't need one-commit-per-file, but each commit
  should build.

## Pull requests

1. Push your branch and open a PR into `main`.
2. Fill out the PR template (checklist auto-loads).
3. Keep PRs small and single-purpose — they are **squash-merged**, so the PR
   title becomes the commit on `main`; write it as a Conventional Commit.
4. The **`required`** status check (the aggregate CI gate) must pass. It rolls up
   `static`, `unit`, `detection-ratchet`, `agent-loop`, `polyglot`,
   `services-security`, and `package-release`.
5. `main` is protected: no direct pushes, no force-pushes. Land work through PRs.
6. Address review before merge. The maintainer (see `CODEOWNERS`) reviews changes.

## Scope discipline

- Change only what the task needs. If you find unrelated problems, note them in
  the PR description or open an issue — don't fix them in the same PR.
- Match the surrounding code's style, naming, and patterns. This repo prefers
  small, boring, well-tested changes over clever rewrites.
- Add or update tests for behavior you change. CI gates (`detection-ratchet`,
  `agent-loop`) will fail closed if you regress detection quality.

## Security & secrets

- **Never commit secrets.** `.env` and `.env.*` are gitignored (keep
  `.env.example` as the template). If a secret is ever committed, treat it as
  compromised: rotate it and tell the maintainer. Do not paste secret values
  into issues, PRs, or commit messages.
- Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## Where things live

- Architecture & usage: [README.md](README.md).
- Active and historical work plans: [`plans/`](plans/) (`plans/README.md` is the
  index with status).
- CI definition: `.github/workflows/ci.yml`.
````

**Verify**: `test -f AGENTS.md && git grep -c "Conventional Commits" AGENTS.md`
→ prints a non-zero count and the file exists. Also run
`git grep -n "npm run lint" AGENTS.md` → **prints a match** (lint now exists and
is part of the CI gate; AGENTS.md must reference it).

### Step 2: Create `CONTRIBUTING.md`

Keep it short — it exists so GitHub shows the "Contributing guidelines" link and
so humans have an entry point. It defers to `AGENTS.md` for the shared rules.

````markdown
# Contributing to Synapse

Thanks for contributing! The working conventions for this repo —
branching, commit format, PR process, and the CI gate — live in
**[AGENTS.md](AGENTS.md)**. They apply to humans and AI agents alike; please
read that first.

## Quick start

```bash
npm ci            # install from the lockfile (Node 20)
npm run build     # build all workspaces
npm run typecheck # type-check all workspaces
npm run lint      # eslint (part of the CI required gate)
npm test          # run the test suite
```

## Before you open a PR

- Branch off `main` as `type/short-slug` (e.g. `fix/daemon-lock-race`).
- Use Conventional Commit messages (`feat(scope): …`).
- Keep the PR focused and small; PRs are squash-merged into `main`.
- Make sure the CI `required` check passes.
- Never commit secrets or `.env` files. See [SECURITY.md](SECURITY.md) to report
  a vulnerability.

## Code of conduct

Be respectful and constructive. Harassment or abuse is not tolerated; the
maintainer may remove contributions or block accounts that violate this.
````

**Verify**: `test -f CONTRIBUTING.md && git grep -q "AGENTS.md" CONTRIBUTING.md && echo OK`
→ `OK`.

### Step 3: Create `SECURITY.md`

This repo is public and handles auth tokens, GitHub webhooks, and a server, so a
disclosure policy is appropriate. Do not invent an email the maintainer hasn't
agreed to — route reporting through GitHub's private advisory feature (always
available) and mention email as optional.

````markdown
# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/Kumario1/synapse/security/advisories/new)**
(Security tab → "Report a vulnerability"). This opens a private advisory visible
only to the maintainer.

Include: a description, affected version/commit, reproduction steps, and impact.
Please give us a reasonable window to fix and release before any public
disclosure.

## Scope

In scope: the Synapse server (`apps/server`), CLI/daemon (`apps/cli`), analyzers
and protocol packages (`packages/*`), and the webhook ingestion path.
Out of scope: issues requiring a compromised developer machine, and findings in
third-party dependencies (report those upstream; we'll bump once a fix ships).

## Secrets

Never include secret values (tokens, keys, `.env` contents) in a report,
issue, or PR. Reference the location and credential type instead. If you believe
a secret was committed, treat it as compromised and tell the maintainer so it
can be rotated.
````

**Verify**: `test -f SECURITY.md && git grep -q "security/advisories/new" SECURITY.md && echo OK`
→ `OK`.

### Step 4: Create `CODEOWNERS`

Place it at the repo root (GitHub also accepts `.github/CODEOWNERS`; root is
fine and most visible). Single maintainer today, so a catch-all owner is correct.

```
# Default owner for everything in this repo.
# Required reviews from code owners are enforced via branch protection (see plan 048).
*       @Kumario1
```

**Verify**: `test -f CODEOWNERS && git grep -q "@Kumario1" CODEOWNERS && echo OK`
→ `OK`. (Optional, only after the file reaches the remote: the GitHub API
endpoint `repos/Kumario1/synapse/codeowners/errors` should report `[]`. Do not
push just to check this — it's a post-merge verification for plan 048.)

### Step 5: Create `.github/PULL_REQUEST_TEMPLATE.md`

This auto-populates every new PR's description.

````markdown
## What & why

<!-- One or two sentences: what this PR changes and why. -->

## How

<!-- Key implementation notes a reviewer should know. Link the plan if one
     exists (e.g. plans/0NN-*.md). -->

## Checklist

- [ ] Branch named `type/short-slug`; PR title is a Conventional Commit
      (it becomes the squash-merge commit on `main`).
- [ ] Scope is focused — one logical change. Unrelated findings are noted, not fixed here.
- [ ] `npm run build`, `npm run typecheck`, `npm run lint`, and `npm test` pass locally.
- [ ] Tests added/updated for changed behavior.
- [ ] No secrets, tokens, or `.env` contents committed.
- [ ] The CI `required` check is green.
````

**Verify**: `test -f .github/PULL_REQUEST_TEMPLATE.md && git grep -q "Conventional Commit" .github/PULL_REQUEST_TEMPLATE.md && echo OK`
→ `OK`.

### Step 6 (optional): Issue templates

Lower priority (the repo currently has no open issues and one maintainer). Create
these only if you have time; they make "professional GitHub" complete. If you
skip them, say so in your status update.

`.github/ISSUE_TEMPLATE/config.yml`:

```yaml
blank_issues_enabled: false
contact_links:
  - name: Security vulnerability
    url: https://github.com/Kumario1/synapse/security/advisories/new
    about: Report security issues privately — do not open a public issue.
```

`.github/ISSUE_TEMPLATE/bug_report.yml`:

```yaml
name: Bug report
description: Something isn't working as expected.
labels: [bug]
body:
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: What you expected vs. what actually happened.
    validations:
      required: true
  - type: textarea
    id: repro
    attributes:
      label: Steps to reproduce
    validations:
      required: true
  - type: input
    id: version
    attributes:
      label: Version / commit
    validations:
      required: false
```

`.github/ISSUE_TEMPLATE/feature_request.yml`:

```yaml
name: Feature request
description: Suggest an improvement or new capability.
labels: [enhancement]
body:
  - type: textarea
    id: problem
    attributes:
      label: Problem
      description: What problem would this solve? Who is it for?
    validations:
      required: true
  - type: textarea
    id: proposal
    attributes:
      label: Proposed solution
    validations:
      required: false
```

**Verify** (if created): `for f in config bug_report feature_request; do test -f .github/ISSUE_TEMPLATE/$f.yml || echo "MISSING $f"; done`
→ prints nothing.

### Step 7: Update `plans/README.md`

Add the status row for plan 047 (and 048 if it exists in the index) and set 047
to `DONE`. Do not restructure the table.

**Verify**: `git grep -n "047" plans/README.md` → shows the new row.

## Test plan

There is no executable test surface for docs. Verification is structural:

- Every "Verify" command above passes.
- `git grep -n "TODO-FILL\|<placeholder>\|FIXME" -- AGENTS.md CONTRIBUTING.md SECURITY.md CODEOWNERS .github/`
  → prints nothing (no unfilled placeholders left in shipped docs).
- `git grep -n "npm run lint" -- AGENTS.md CONTRIBUTING.md` → prints a match
  (lint exists on `main` and is part of the CI gate; the docs must reference it).
- Manual read-through: `AGENTS.md` describes only conventions that match this
  repo's actual `git log` and `package.json` scripts.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `test -f AGENTS.md && test -f CONTRIBUTING.md && test -f SECURITY.md && test -f CODEOWNERS && test -f .github/PULL_REQUEST_TEMPLATE.md && echo ALL-PRESENT` → `ALL-PRESENT`
- [ ] `git grep -n "npm run lint" -- AGENTS.md CONTRIBUTING.md` returns a match
- [ ] `git grep -n "Conventional Commits\|Conventional Commit" AGENTS.md` returns a match
- [ ] `git status --porcelain` shows only the files this plan creates plus `plans/README.md` (no source files touched)
- [ ] `git diff --name-only ba1bd003..HEAD -- apps packages evals scripts .github/workflows package.json` is empty (no out-of-scope edits)
- [ ] `plans/README.md` status row for 047 = DONE

## STOP conditions

Stop and report back (do not improvise) if:

- Any of `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODEOWNERS`, or
  `.github/PULL_REQUEST_TEMPLATE.md` already exists as a tracked file — the repo
  drifted and these may need merging, not overwriting.
- You discover a root `CLAUDE.md` (or other agent-instructions file) with
  conventions that **contradict** what's written here — reconcile with the
  maintainer rather than shipping two conflicting sources of truth.
- Recon facts no longer match: e.g. the `lint`/`format` scripts described above
  are **gone** from `package.json`, the default branch is no longer `main`, or
  commit messages have stopped following Conventional Commits. Report the
  mismatch instead of writing stale guidance. (As of the `ba1bd003` reconcile,
  `lint`/`format` are expected to be present — their *absence* is the surprise.)
- You feel the urge to also "clean up" branches, change CI, or move the loose
  root `.md` files — that is plan 048, explicitly out of scope here.

## Maintenance notes

For the human/agent who owns this after it lands:

- `AGENTS.md` is the single source of truth for conventions. The `lint`/`format`
  scripts (plan 042) are already reflected here; if the merge strategy changes or
  scripts are added/removed, update `AGENTS.md`'s "Project shape" and "Pull
  requests" sections to match — reviewers should treat drift between `AGENTS.md`
  and reality as a bug.
- `CONTRIBUTING.md` deliberately defers to `AGENTS.md`; keep it thin so there's
  only one place to update.
- `CODEOWNERS` is consumed by plan 048's branch protection ("require review from
  code owners"). If collaborators are added, expand the ownership map before
  tightening protection.
- If a root `CLAUDE.md` is ever wanted for Claude Code specifically, make it a
  one-line pointer to `AGENTS.md` rather than a second copy of the rules.
- Reviewer should scrutinize: that no command in the docs is fictional (run each
  referenced `npm run …` mentally against `package.json`), and that `SECURITY.md`
  routes reporting through the private advisory URL (never a public issue).
