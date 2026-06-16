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
