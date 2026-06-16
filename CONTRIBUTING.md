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
