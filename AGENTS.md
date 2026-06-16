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
   `static` (typecheck + lint), `unit`, `detection-ratchet`, `agent-loop`,
   `polyglot`, `services-security`, and `package-release`.
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
