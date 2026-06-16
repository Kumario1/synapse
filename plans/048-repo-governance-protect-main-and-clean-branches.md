# Plan 048: Protect `main`, enable auto-delete-on-merge, and clean up stale branches & worktrees

> **This is an OWNER-RUN runbook, not an executor coding task.** Every step
> mutates the GitHub remote or your local git state (branch protection, branch
> deletion, worktree removal). The improve-skill executor edits code in a
> throwaway worktree and must **not** run these commands. Whoever runs this needs
> push/admin access to `Kumario1/synapse` and an authenticated `gh`
> (`gh auth status` shows logged in). Run the **dry-run** in each phase and read
> its output before running the destructive command in that phase.
>
> **Pre-flight (run first)**:
> ```bash
> gh auth status                         # must show: Logged in to github.com
> gh repo view Kumario1/synapse --json defaultBranchRef,deleteBranchOnMerge,visibility
> #   expect: defaultBranchRef.name = "main"; if it's not "main", STOP — this
> #   runbook assumes the default branch is main (see plan decision below).
> git status --porcelain                 # commit or stash local work before Phase 4
> git fetch --prune                      # sync remote refs before any cleanup
> ```

## Status

- **Priority**: P1
- **Effort**: M (mostly review time; the commands are short)
- **Risk**: HIGH — Phases 3 and 4 **permanently delete** remote and local
  branches. They are gated behind dry-runs and an explicit keep-list. Phase 2
  (protection) is reversible.
- **Depends on**: plan 047 recommended first (Phase 2's optional
  "require code-owner review" needs the `CODEOWNERS` file plan 047 creates).
- **Category**: dx / tech-debt
- **Planned at**: commit `259e3f7`, 2026-06-15; **facts re-verified against `main` @ `ba1bd003`, 2026-06-16** (see refreshed "Current state" — the Phase 3b keep-list is now **empty**).
- **Issue**: —

## Decision baked into this plan

The default branch **stays `main`** (the owner confirmed this on 2026-06-15;
`main` is GitHub's modern default and avoids breaking existing clones, forks,
open-PR bases, and the `on: push:` refs in `.github/workflows/ci.yml`). This
runbook **protects `main`**; it does **not** rename it to `master`. If you later
decide you truly want `master`, that is a separate, outward-facing change
(`gh api --method POST repos/Kumario1/synapse/branches/main/rename -f new_name=master`
plus updating CI `branches:` filters and notifying anyone with a fork/clone) and
is explicitly **out of scope** here.

## Why this matters

The repo is **public** with **no branch protection** (`gh api
repos/Kumario1/synapse/branches/main/protection` returns `404 Branch not
protected`), so anyone with push access — including an agent on a bad day — can
push or force-push straight to `main` and bypass CI. Meanwhile
`deleteBranchOnMerge` is `false`, so merged branches never get cleaned up: there
are **~55 remote branches but 0 open PRs**, and **26 git worktrees** (most are
leftover executor worktrees under `/private/tmp`). This is the difference
between a repo that looks maintained and one that looks abandoned. This runbook
turns on the protection the written standards (plan 047) assume, stops the
branch pile-up at the source, and clears the existing backlog.

> **Reconcile note (2026-06-16, `main` @ `ba1bd003`)**: re-ran the read-only
> pre-flight and Phase 3a/3b dry-runs. Deltas from the original survey: **47**
> remote branches (was ~55); the Phase 3a "merged-PR + still on remote" delete
> set is now **46 branches**; the **Phase 3b keep-list is now EMPTY** — the seven
> branches it listed (`codex/github-push-webhook`, `codex/openrouter-demo-readme`,
> `cursor/streamline-agent-mcp-onboarding-a9af`, `feat/publishable-cli`,
> `feat/seamless-multi-machine-setup`, `foundation-hardening-m1-m4`,
> `ship-server-docker-project-key-auth`) have **all since gained merged PRs** and
> now fall into Phase 3a. The safety check still holds: `main` is **not** in the
> delete set. Worktrees: **27** total, **21** leftover under `/private/tmp`.
> Protection still 404, `deleteBranchOnMerge` still false, 0 open PRs, default
> branch still `main`. Phase 3b below is effectively a no-op now, but keep its
> per-branch `git log origin/main..origin/<b>` spot-check habit before deleting.

## Current state (originally verified at commit `259e3f7`, 2026-06-15; see reconcile note above for `ba1bd003` deltas)

- **Protection**: none. `repos/Kumario1/synapse/branches/main/protection` → 404.
- **Repo settings**: `defaultBranchRef = main`, `deleteBranchOnMerge = false`,
  `visibility = PUBLIC`.
- **CI gate already exists**: `.github/workflows/ci.yml` defines an aggregate
  `required` job (`ci.yml:172`, `if: always()`, `needs:` the other seven jobs)
  that fails unless `static`, `unit`, `detection-ratchet`, `agent-loop`,
  `polyglot`, `services-security`, and `package-release` all succeed. The status
  check context to require is **`required`**.
- **Branches vs PRs**: `gh pr list --state open` → **0 open**.
  `gh pr list --state merged --limit 200` shows merged PRs whose head branches
  still exist on the remote (e.g. `advisor/001..046`, `advisor/035`,
  `advisor/037`, `docs/post-plan-017-031-refresh`, `docs/roadmap-complete`).
  These are safe to delete (work is on `main` via **squash** merge — which is
  why `git branch --merged` does **not** list them; do not rely on `--merged`).
- **Remote branches with NO merged PR** (need human judgment — may hold
  unmerged work; do **not** bulk-delete):
  - `codex/github-push-webhook`
  - `codex/openrouter-demo-readme`
  - `cursor/streamline-agent-mcp-onboarding-a9af`
  - `feat/publishable-cli`
  - `feat/seamless-multi-machine-setup`
  - `foundation-hardening-m1-m4`
  - `ship-server-docker-project-key-auth`
- **Worktrees**: `git worktree list` shows 26, including the main checkout
  (`/Users/princekumar/Documents/synapseWork`) and many disposable ones under
  `/private/tmp/synapse*` and `/private/tmp/synapseWork*`, plus a detached
  `…verify-package-base…`, a `.cursor/worktrees/…`, and three
  `.claude/worktrees/agent-…`. The `/private/tmp/*` ones are leftover executor
  worktrees and the prime cleanup target.
- **Secrets hygiene is fine** (no action): `.env`/`.env.*`/`.DS_Store` are
  gitignored, untracked, and absent from history. Do not "clean" them.

## Commands you will need

| Purpose                  | Command                                                                 | Expected |
|--------------------------|-------------------------------------------------------------------------|----------|
| Auth check               | `gh auth status`                                                        | logged in |
| Read protection          | `gh api repos/Kumario1/synapse/branches/main/protection`               | JSON (after Phase 2) |
| Enable auto-delete       | `gh repo edit Kumario1/synapse --delete-branch-on-merge`               | no error |
| List merged-PR heads     | `gh pr list --state merged --limit 200 --json headRefName -q '.[].headRefName'` | branch names |
| List remote branches     | `git ls-remote --heads origin \| sed 's#.*refs/heads/##'`              | branch names |
| Delete one remote branch | `git push origin --delete <branch>`                                    | `- [deleted]` |
| Worktrees                | `git worktree list` / `git worktree remove <path>` / `git worktree prune -v` | — |

## Scope

**In scope**: GitHub repo settings (`deleteBranchOnMerge`), branch protection on
`main`, deletion of merged/stale remote branches, removal of leftover worktrees,
deletion of stale local branches, and updating `plans/README.md`. Optionally
(Phase 5) flagging loose root files.

**Out of scope** (do NOT do):
- Renaming `main` → `master` (decision above).
- Editing `.github/workflows/ci.yml` or any source — protection consumes the
  **existing** `required` job; it does not change CI. (Closing CI gate coverage
  is plan 041.)
- Deleting any branch in the "NO merged PR" keep-list without per-branch review
  (Phase 3b).
- Deleting `main`, the branch you currently have checked out, or the main
  worktree at `/Users/princekumar/Documents/synapseWork`.
- Touching `.env`, `.DS_Store`, or git history.

## Phases

### Phase 1 — Stop the bleeding: auto-delete merged branches

So future merged branches are removed automatically and this backlog never
rebuilds.

```bash
gh repo edit Kumario1/synapse --delete-branch-on-merge
```

**Verify**:
```bash
gh repo view Kumario1/synapse --json deleteBranchOnMerge
# expect: {"deleteBranchOnMerge":true}
```

### Phase 2 — Protect `main`

Apply classic branch protection: require a PR, require the `required` CI check,
forbid force-pushes and deletion, and require linear history (you squash-merge,
so history stays linear). `required_approving_review_count` is **0** because you
are currently the sole maintainer and GitHub won't let you approve your own PR —
this still forces every change through a PR and a green CI check, just without a
second approver. Raise it to 1 and set `require_code_owner_reviews: true` when
collaborators join (the `CODEOWNERS` from plan 047 is already in place for that).

`enforce_admins` is **false** so you keep an emergency escape hatch as the owner;
set it to `true` for the strictest posture (then even you must go through PRs).

```bash
gh api --method PUT repos/Kumario1/synapse/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["required"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
```

Notes:
- `"strict": false` = does **not** force every PR to be rebased onto the latest
  `main` before merge. Left off because this repo's CI matrix has been flaky and
  `strict: true` re-runs CI on every merge. Flip to `true` once CI is reliable
  (plan 041) if you want the stricter "branch must be up to date" rule.
- `"contexts": ["required"]` is the aggregate CI job. If GitHub later reports the
  check under a different display name, fix the context string (see verify step).

**Verify**:
```bash
gh api repos/Kumario1/synapse/branches/main/protection \
  -q '{checks: .required_status_checks.contexts, force: .allow_force_pushes.enabled, del: .allow_deletions.enabled, pr: .required_pull_request_reviews.required_approving_review_count}'
# expect: checks contains "required"; force = false; del = false; pr = 0
```
Then open a throwaway test PR (or check the next real one) and confirm the
**"required"** check is listed under the PR's checks and that "Merge" is blocked
until it's green. If the check name shown in the PR UI is not exactly `required`,
re-run the PUT with the corrected context string.

### Phase 3a — Delete remote branches whose PR is already merged

Work through a dry-run first. This computes the intersection of "branches with a
merged PR" and "branches that still exist on the remote," minus `main`.

**Dry run (prints what would be deleted — deletes nothing):**
```bash
git fetch --prune
gh pr list --state merged --limit 300 --json headRefName -q '.[].headRefName' | sort -u > /tmp/merged-heads.txt
git ls-remote --heads origin | sed 's#.*refs/heads/##' | sort -u > /tmp/remote-branches.txt
echo "=== will delete (merged PR + still on remote) ==="
comm -12 /tmp/merged-heads.txt /tmp/remote-branches.txt | grep -vx 'main'
```

Read that list. It should be the `advisor/*`, `docs/post-plan-017-031-refresh`,
`docs/roadmap-complete` style branches. It must **not** contain `main` or any
branch from the Phase 3b keep-list. If it does, STOP and investigate.

**Delete (after you've read the dry-run output):**
```bash
comm -12 /tmp/merged-heads.txt /tmp/remote-branches.txt | grep -vx 'main' \
  | while read -r b; do echo "deleting origin/$b"; git push origin --delete "$b"; done
```

**Verify**:
```bash
git ls-remote --heads origin | sed 's#.*refs/heads/##' | grep -E '^advisor/' | wc -l
# expect: 0 (or only advisor branches that genuinely have no merged PR — there should be none)
```

### Phase 3b — Review the "no merged PR" branches by hand

These may contain unmerged work. For **each** branch below, inspect, then decide
keep or delete. Do **not** loop-delete them.

Branches: `codex/github-push-webhook`, `codex/openrouter-demo-readme`,
`cursor/streamline-agent-mcp-onboarding-a9af`, `feat/publishable-cli`,
`feat/seamless-multi-machine-setup`, `foundation-hardening-m1-m4`,
`ship-server-docker-project-key-auth`.

```bash
b=codex/github-push-webhook   # repeat per branch
echo "=== $b: ever had a PR? ==="
gh pr list --state all --head "$b" --json number,state,title
echo "=== $b: commits not on main ==="
git log --oneline origin/main..origin/"$b" | head -20
```
- If `git log origin/main..origin/$b` is **empty** → fully merged/contained;
  safe to delete: `git push origin --delete "$b"`.
- If it shows commits and there's no intent to revive the work → delete after
  confirming with yourself that nothing there is wanted.
- If it holds work you might still want → **keep it**, and consider opening a
  tracking issue or a draft PR so it's not orphaned.

Record your keep/delete decision for each in your status note.

### Phase 4 — Clean local worktrees and branches

Do this from the main checkout (`/Users/princekumar/Documents/synapseWork`).
First make sure you are not standing on a branch you're about to delete:

```bash
git -C /Users/princekumar/Documents/synapseWork switch main 2>/dev/null || git -C /Users/princekumar/Documents/synapseWork checkout main
git fetch --prune
```

**4a — Remove leftover worktrees.** Review, then remove the disposable ones.
Never remove the main worktree.
```bash
git worktree list                 # review the full list first
git worktree prune -v             # drop worktrees whose directory is already gone
# Remove each leftover /private/tmp executor worktree (add --force if it reports dirty/locked):
git worktree list | awk '$1 ~ "^/private/tmp/"{print $1}' \
  | while read -r w; do echo "removing $w"; git worktree remove "$w" || git worktree remove --force "$w"; done
```
Then handle the `.claude/worktrees/agent-*` and `.cursor/worktrees/*` entries the
same way **if** you no longer need those sessions (check `git worktree list`
output; remove only the ones you recognize as finished).

**Verify**:
```bash
git worktree list | wc -l    # expect: just the worktrees you intend to keep (1 if you removed them all)
```

**4b — Delete local branches whose upstream is gone.** After Phase 3 +
`fetch --prune`, local branches that tracked a now-deleted remote show
`: gone]`. Review the list before deleting.
```bash
echo "=== local branches with a deleted upstream (will delete) ==="
git branch -vv | awk '/: gone]/{print $1}'
# delete them (force -D is correct: their work is on main via squash):
git branch -vv | awk '/: gone]/{print $1}' | xargs -r -n1 git branch -D
```
Branches with **no upstream** (local-only experiments like `cursor/44246656`,
`worktree-agent-*`, `fix/up-teammate-command`) won't appear above. Review those
separately and delete only the ones you recognize as dead:
```bash
git for-each-ref --format='%(refname:short) %(upstream)' refs/heads \
  | awk '$2==""{print $1}'    # local-only branches — review, delete by hand
```

**Verify**:
```bash
git branch | wc -l    # expect: a small number (main + any active work)
```

### Phase 5 (optional) — Flag loose root files

Not destructive and judgment-dependent — surface, don't auto-move. The repo root
has several large loose `.md` files (`synapse-context.md`, `synapse-build-plan.md`,
`synapse-technical-spec.md`, `plan-future.md`, `openrouter-demo.md`) and an
**untracked** `Synapse/` directory (already noted as build output in
`plans/README.md`'s rejected findings). Moving the tracked `.md` files into
`docs/` would tidy the root but can break inbound links, so leave that to the
owner's discretion — just note in your status update that these exist. Do not
move or delete them as part of this runbook.

## Done criteria

- [ ] `gh repo view Kumario1/synapse --json deleteBranchOnMerge` → `true`
- [ ] `gh api repos/Kumario1/synapse/branches/main/protection -q '.required_status_checks.contexts'` includes `"required"`
- [ ] `gh api repos/Kumario1/synapse/branches/main/protection -q '.allow_force_pushes.enabled'` → `false` and `.allow_deletions.enabled` → `false`
- [ ] `git ls-remote --heads origin | grep -c 'refs/heads/advisor/'` → `0` (all merged advisor branches deleted)
- [ ] Each Phase 3b keep-list branch has a recorded keep/delete decision
- [ ] `git worktree list` shows only worktrees you intend to keep; no leftover `/private/tmp/synapse*` entries
- [ ] `plans/README.md` status row for 048 updated (DONE, or "DONE except 3b/5 deferred" with the specifics)

## STOP conditions

Stop and report (do not improvise) if:
- `gh repo view … defaultBranchRef.name` is not `main` — the rename decision was
  reversed without updating this runbook.
- The Phase 3a **dry-run** list contains `main`, any Phase-3b keep-list branch,
  or a branch you don't recognize as having a merged PR.
- The PUT to `…/branches/main/protection` returns a non-2xx error (e.g. 403 — you
  lack admin rights, or the repo is on a plan without protected branches for
  private repos; this repo is public so protection is available — re-check
  `gh auth status` and token scopes).
- The `required` status check never appears on a test PR, or appears under a
  different name — fix the context string rather than leaving `main` effectively
  unprotected.
- `git worktree remove` reports a worktree as having uncommitted changes you
  didn't expect — inspect that worktree before forcing removal; it may hold work.

## Maintenance notes

- **Future branches auto-delete on merge** after Phase 1; this backlog should not
  recur. If it does, re-check that `deleteBranchOnMerge` is still on.
- **Tightening later**: when collaborators join, raise
  `required_approving_review_count` to `1` and set
  `require_code_owner_reviews: true` (CODEOWNERS from plan 047 is ready). Flip
  `required_status_checks.strict` to `true` once CI is reliable (plan 041), and
  consider `enforce_admins: true` for the strictest posture.
- **Modern alternative**: GitHub *rulesets* (`repos/{o}/{r}/rulesets`) supersede
  classic branch protection and support explicit bypass actors. Classic
  protection is used here for simplicity; migrate to a ruleset if you want the
  owner as a named bypass instead of relying on `enforce_admins: false`.
- **If the required check name changes** (CI job renamed/refactored), update the
  protection `contexts` array or merges will be blocked indefinitely on a check
  that never reports.
- A reviewer auditing this work should confirm, on the next real PR, that direct
  pushes to `main` are rejected and that merge is gated on `required`.
