# Plan 041: Pull the race-prone verifiers into the required CI gate and guard against drift

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 6781b81..HEAD -- scripts/ci-strict-runner.mjs`
> If it changed since this plan was written, re-run the gap computation in
> "Current state" before proceeding; the exact missing-script list may differ.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `6781b81`, 2026-06-15

## Why this matters

The required CI gate (`.github/workflows/ci.yml` → the `required` job, which
aggregates the seven `ci:strict:*` groups) only runs the verifiers **hand-listed**
in `scripts/ci-strict-runner.mjs`. 20 of the 56 `verify-*.mjs` / `eval-*.mjs`
scripts are in **no** strict group, so they never gate a merge — they run only
in `scripts/ci-verify-all.mjs`, which is **not** a required check. Critically,
the verifiers for the newest and most race-prone features are in that gap:
`verify-atomic-intent` (plan 036 — the TOCTOU edit-intent fix),
`verify-delta-broadcast` (plan 028 — protocol v2 deltas), `verify-protocol-compat`
(handshake negotiation), and `verify-pr-brief` (plan 031). These can regress
without failing CI. This plan promotes those four into the gate and adds a
coverage guard so a new verify script can never again silently fall out of the
required matrix.

## Current state

- `scripts/ci-strict-runner.mjs:22-80` — the `groups` object hand-lists scripts
  into 7 named groups (`static`, `unit`, `detection`, `agent-loop`, `polyglot`,
  `services`, `package`). The `agent-loop` group (lines 40-52) is single-process
  realtime-loop verifiers (no Postgres/Redis), e.g.:

```js
  "agent-loop": [
    command("node", "scripts/verify-strict-agent-loop.mjs"),
    command("node", "scripts/verify-daemon-ts-report.mjs"),
    command("node", "scripts/verify-dependency-ts-check.mjs"),
    command("node", "scripts/verify-file-only-ts-check.mjs"),
    command("node", "scripts/verify-hooks.mjs"),
    command("node", "scripts/verify-mcp-adapter.mjs"),
    command("node", "scripts/verify-session-start.mjs"),
    command("node", "scripts/verify-session-summary.mjs"),
    command("node", "scripts/verify-whatsup.mjs"),
    command("node", "scripts/verify-why.mjs"),
    command("node", "scripts/verify-onboard.mjs")
  ],
```

- `scripts/ci-strict-runner.mjs:11` — `const groupNames = [...]` lists the 7
  groups; `scripts/ci-strict-runner.mjs:88-90` rejects `SYNAPSE_VERIFY_SKIP`.
- `scripts/ci-strict-runner.mjs:23-27` — the `static` group already runs
  `node scripts/ci-test-inventory.mjs`, so `static` is the right home for an
  additional meta-check.
- `.github/workflows/ci.yml:172-198` — the `required` job asserts every group
  `result == 'success'`; it is the single aggregate gate (branch protection must
  require the `required` check — confirm in repo settings; out of scope here).

**The gap (recompute to confirm):**

```bash
ls scripts/verify-*.mjs scripts/eval-*.mjs | sed 's#scripts/##;s#\.mjs##' | sort > /tmp/all.txt
grep -oE 'scripts/(verify|eval)-[a-z0-9-]+\.mjs' scripts/ci-strict-runner.mjs | sed 's#scripts/##;s#\.mjs##' | sort -u > /tmp/gated.txt
comm -23 /tmp/all.txt /tmp/gated.txt
```

At commit `6781b81` this prints 20 names. This plan classifies all 20 (below).

## Classification (all 20 ungated scripts)

**PROMOTE — add to the `agent-loop` group (single-process, deterministic, no services):**

| Script | Feature it guards |
|--------|-------------------|
| `verify-atomic-intent` | plan 036 server-authoritative TOCTOU check |
| `verify-delta-broadcast` | plan 028 protocol v2 `state.delta` |
| `verify-protocol-compat` | handshake version negotiation |
| `verify-pr-brief` | plan 031 local PR handoff briefing |

**ALLOWLIST — keep out of the required gate, with a recorded reason:**

| Script | Reason it stays ungated |
|--------|-------------------------|
| `verify-hot-path-latency` | timing-sensitive p95/max latency budget; flaky on shared CI runners — run locally |
| `verify-large-repo-latency` | same: latency budget |
| `verify-repo-latency` | same: latency budget |
| `verify-up-tunnel` | opens an external public tunnel (network) — not hermetic |
| `verify-why-rag` | needs pgvector; SKIPs offline — belongs with the `services` matrix, promote in a follow-up if it runs green there |
| `verify-connect` | promotion candidate — runs in `ci-verify-all` today |
| `verify-doctor` | promotion candidate |
| `verify-insights` | promotion candidate |
| `verify-feedback` | promotion candidate |
| `verify-llm-actions` | promotion candidate |
| `verify-rename-tracking` | promotion candidate |
| `verify-push-state-reset` | promotion candidate |
| `verify-git-repo-id` | promotion candidate |
| `verify-join-config` | promotion candidate |
| `verify-up` | promotion candidate (spawns full up flow) |
| `verify-milestone-0` | promotion candidate (skeleton loop) |

> The allowlist is deliberately honest: latency/tunnel/services scripts have a
> permanent reason; the "promotion candidate" ones are simply not yet promoted.
> The guard's job is to force a *deliberate* decision (gate or allowlist) for
> every script — including future ones — instead of silent omission.

## Commands you will need

| Purpose   | Command                                   | Expected on success |
|-----------|-------------------------------------------|---------------------|
| Build     | `npm run build`                           | exit 0              |
| Coverage guard | `node scripts/ci-strict-coverage.mjs` | exit 0, ends `PASS` |
| One promoted verifier | `npm run verify:atomic-intent`  | exit 0, ends `PASS` |
| Each promoted verifier | `npm run verify:delta-broadcast` / `verify:protocol-compat` / `verify:pr-brief` | exit 0, `PASS` |

## Scope

**In scope**:
- `scripts/ci-strict-runner.mjs` — add the 4 promoted scripts to `agent-loop`.
- `scripts/ci-strict-coverage.mjs` (create) — the drift guard.
- Wire `ci-strict-coverage.mjs` into the `static` strict group (in
  `ci-strict-runner.mjs`).

**Out of scope**:
- `.github/workflows/ci.yml` — no change needed; the `static` job already runs
  the strict `static` group, which will pick up the new meta-check. Do NOT edit
  the workflow or branch-protection settings.
- Promoting the 16 allowlisted scripts — explicitly deferred (the guard makes
  promoting them later a one-line move from allowlist → group).
- Fixing any verifier that fails — if a promoted verifier fails, see STOP
  conditions.

## Git workflow

- Branch: `advisor/041-close-ci-strict-gate-coverage`
- Commit style: `ci: gate atomic-intent/delta/protocol/pr-brief verifiers + drift guard`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Promote the 4 verifiers into `agent-loop`

In `scripts/ci-strict-runner.mjs`, append to the `"agent-loop"` array:

```js
    command("node", "scripts/verify-atomic-intent.mjs"),
    command("node", "scripts/verify-delta-broadcast.mjs"),
    command("node", "scripts/verify-protocol-compat.mjs"),
    command("node", "scripts/verify-pr-brief.mjs")
```

**Verify**: `node -c scripts/ci-strict-runner.mjs` → exit 0 (syntax OK).

### Step 2: Confirm the 4 promoted verifiers pass

Run each individually (cheaper than the whole group):

```bash
npm run verify:atomic-intent
npm run verify:delta-broadcast
npm run verify:protocol-compat
npm run verify:pr-brief
```

**Verify**: each exits 0 and ends with `PASS`. If any fails, STOP (see conditions).

### Step 3: Create the coverage guard `scripts/ci-strict-coverage.mjs`

Create `scripts/ci-strict-coverage.mjs` that:

1. Lists every `scripts/verify-*.mjs` and `scripts/eval-*.mjs` file (use
   `node:fs` `readdirSync`).
2. Parses the set of scripts referenced in `scripts/ci-strict-runner.mjs`
   (read the file as text; regex `/scripts\/((?:verify|eval)-[a-z0-9-]+)\.mjs/g`),
   OR — cleaner — import the `groups` object if `ci-strict-runner.mjs` exports
   it. **Prefer making `ci-strict-runner.mjs` export `groups`** and importing it,
   so the guard reads the real data structure, not a regex. If you export it,
   ensure running the runner standalone still works (it has top-level
   `process.argv` handling — guard that with an `import.meta.main`-style check
   or move the CLI dispatch below an `if (process.argv[1] === fileURLToPath(import.meta.url))`).
3. Defines an `UNGATED` allowlist array of the 16 script base-names from the
   "ALLOWLIST" table above, each with a `reason` string.
4. Computes `missing = allScripts − gatedScripts − ungatedNames`. If `missing`
   is non-empty, print each missing script and exit 1 with a message telling the
   maintainer to either add it to a `ci-strict-runner.mjs` group or to the
   `UNGATED` allowlist with a reason. Otherwise print `PASS` and exit 0.
5. Also flag (warn, non-fatal) any `UNGATED` entry whose file no longer exists
   (stale allowlist).

Match the repo's script style: `#!/usr/bin/env node`, ESM imports, `console.error`
for failures, a final `console.log("PASS")`, `process.exit(1)` on failure. Look
at `scripts/ci-test-inventory.mjs` as the structural exemplar.

**Verify**: `node scripts/ci-strict-coverage.mjs` → exit 0, prints `PASS`.

### Step 4: Wire the guard into the `static` strict group

In `scripts/ci-strict-runner.mjs`, add to the `static` group (after the existing
`command("node", "scripts/ci-test-inventory.mjs")`):

```js
    command("node", "scripts/ci-strict-coverage.mjs")
```

**Verify**: `npm run ci:strict:static` → exit 0 (runs build + typecheck +
inventory + coverage). If build/typecheck are slow in your environment, instead
verify just the coverage step ran: `node scripts/ci-strict-coverage.mjs` → `PASS`.

### Step 5: Negative test the guard

Temporarily add a throwaway file `scripts/verify-guard-selftest.mjs` (one line:
`console.log("noop");`), run `node scripts/ci-strict-coverage.mjs`, and confirm
it now **exits 1** naming `verify-guard-selftest`. Then delete the throwaway
file and confirm the guard returns to `PASS`.

**Verify**: guard exits 1 with the throwaway present, exits 0 (`PASS`) after
removing it. Ensure the throwaway file is deleted before finishing
(`git status` clean of it).

## Test plan

- The guard itself is the test infrastructure: Step 5 is its self-test (fails on
  an unclassified script, passes when all are classified).
- The 4 promoted verifiers are proven green in Step 2.
- No new `*.test.ts` needed — this is CI orchestration, validated by running the
  scripts.

## Done criteria

ALL must hold:

- [ ] `node scripts/ci-strict-coverage.mjs` exits 0 and prints `PASS`
- [ ] `grep -c "verify-atomic-intent\|verify-delta-broadcast\|verify-protocol-compat\|verify-pr-brief" scripts/ci-strict-runner.mjs` returns 4
- [ ] `verify:atomic-intent`, `verify:delta-broadcast`, `verify:protocol-compat`, `verify:pr-brief` each exit 0
- [ ] The guard exits 1 when an unclassified `verify-*.mjs` exists (Step 5 self-test)
- [ ] No throwaway/self-test files left behind (`git status` clean except in-scope files)
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Any of the 4 promoted verifiers fails locally (Step 2). Do NOT "fix" the
  verifier or the feature — a real failure here is exactly the regression the
  gate is meant to catch; report which one failed and its output.
- A promoted verifier needs Postgres/Redis/Docker/Go/Python to run (it should
  not — these 4 are single-process). If one does, move it from `agent-loop` to
  the matching services/polyglot/package group instead and note it.
- `ci-strict-runner.mjs` cannot be made to export `groups` without breaking its
  CLI dispatch — fall back to the regex-parse approach in Step 3 and note it.

## Maintenance notes

- The guard makes the gate self-policing: every new `verify-*.mjs` must be added
  to a group or the `UNGATED` allowlist with a reason, or CI's `static` job
  fails. This is the durable win.
- Follow-up (separate plan, not now): promote the 12 "promotion candidate"
  allowlisted scripts into appropriate groups one batch at a time, watching CI
  job timeouts (the `agent-loop` job has a 15-min budget). `verify-why-rag`
  belongs in `services` (it needs pgvector, available there).
- Reviewer should confirm branch protection actually requires the `required`
  check — the whole gate is advisory if it doesn't.
