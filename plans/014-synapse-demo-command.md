# Plan 014: Build `synapse demo` — a one-command sandboxed conflict demo

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c46a61..HEAD -- apps/cli/src/commands apps/cli/src/index.ts apps/cli/src/config.ts scripts/verify-dependency-ts-check.mjs`
> If any of these changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M (S if the orchestration ports cleanly)
- **Risk**: MED (spawns processes and writes temp dirs from the shipped CLI — sandboxing must be airtight)
- **Depends on**: none (pairs with plan 010 — the demo is most valuable once `npx @kumario/synapse demo` works from the registry)
- **Category**: direction (adoption/first-touch)
- **Planned at**: commit `8c46a61`, 2026-06-11

## Why this matters

The README's flagship "see a conflict" demo requires three terminals,
a hand-built throwaway repo, and ~10 manual steps. Everything it
demonstrates is already orchestrated programmatically in
`scripts/verify-dependency-ts-check.mjs` (252 lines: boots a server, two
daemons, manufactures a contract conflict, asserts on it) — but that script
lives outside the published package. `synapse demo` productizes it: one
command that runs the whole story in a temp sandbox and narrates each step.
Combined with plan 010, the entire first-touch experience becomes
`npx @kumario/synapse demo`. Nothing sells a coordination layer like
watching a conflict get caught in 30 seconds.

## Current state

- `scripts/verify-dependency-ts-check.mjs` — the orchestration to port. Key
  structure (read the whole file before starting):
  - `freePort()` via `node:net` `createServer` (lines ~1–20 imports + helper),
    `mkdtemp(join(tmpdir(), "synapse-dependency-ts-check-"))` for the
    sandbox worktree.
  - Fixture: `src/auth/token.ts` exporting `validate(input: string): boolean`
    and `src/auth/login.ts` importing it (lines ~25–41).
  - `startProcess("server", ["apps/server/dist/index.js"], { SYNAPSE_SERVER_PORT })`,
    then `startDaemon("alice"|"bob", port)` (spawn helper around line 149
    uses `process.execPath`), `waitForHttp(.../health)`, `waitForState`.
  - The story: bob's clean check → alice reports baseline → token.ts
    rewritten to `validate(input: string): Token | null` → alice re-reports
    (delta) → bob's check on `login.ts` now surfaces `dependency_changed`.
  - `SYNAPSE_REPO_ID ??= "local"` pins the room so git-remote derivation
    never touches a real repo — the demo MUST do the same with a unique id.
- `apps/cli/src/commands/whatsup.ts` — the minimal command exemplar
  (parseFlags → commandDefaults → postJson → print). The demo command is
  bigger but follows the same entry conventions (`runDemo(rawArgs)` export).
- `apps/cli/src/index.ts` — the ~119-line dispatcher; add `demo` the same
  way the other commands are wired (import + dispatch entry + help line).
- `apps/cli/src/commands/up.ts` — `resolveServerEntry()` resolves the
  spawnable server entry both in the monorepo (a `../`-hops fallback
  relative to `dist/commands/`) and from the packaged install (server
  bundled under `node_modules/@synapse/server`). REUSE IT — do not invent
  server resolution; this function is the reason `synapse up` works from a
  tarball, and the demo has the same need.
- `apps/cli/src/config.ts` — `cliEntrypoint()` resolves `dist/index.js`
  (the daemon spawn target). The daemons in the demo are
  `node <cliEntrypoint()> daemon --member alice --session alice --port ... --server ws://localhost:<port> --repo-id <demoRepoId>`
  — exactly the flags the README's manual demo uses.
- Conventions: hermetic verify scripts in `scripts/verify-*.mjs` discovered
  by `scripts/ci-verify-all.mjs`; root alias style
  `"verify:demo": "npm run build && node scripts/verify-demo.mjs"`.
  Conventional commits.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | all pass |
| Reference verify still green | `node scripts/ci-verify-all.mjs --only dependency-ts-check` | exit 0 |
| New verify | `npm run verify:demo` | exit 0 |
| Manual smoke | `node apps/cli/dist/index.js demo` | narrated run, exit 0, no leftover processes |

## Scope

**In scope**:
- `apps/cli/src/commands/demo.ts` (create)
- `apps/cli/src/index.ts` (dispatcher entry + help text)
- `apps/cli/src/commands/up.ts` — ONLY the one-line `export` keyword on
  `resolveServerEntry` (it is module-private today; no other change)
- `scripts/verify-demo.mjs` (create) + root `package.json` alias
- `README.md` — add the one-command path directly under the
  "Try it: see a conflict" heading, before the "Local dry-run" subsection
  (keep the manual walkthrough as the "what's actually happening" explainer)

**Out of scope** (do NOT touch):
- `scripts/verify-dependency-ts-check.mjs` — port the logic, don't refactor
  the verify to share code with the CLI; verifies must stay dependent only
  on built artifacts, not on demo internals.
- `apps/server/**`, analyzers, conflict engine.
- The two-machine/tunnel demo (`synapse up --serve --tunnel`) — unchanged.
- Anything in `commands/up.ts` beyond the in-scope `export` keyword.

## Git workflow

- Branch: `advisor/014-synapse-demo`
- Conventional commits, e.g. `feat(cli): synapse demo — one-command sandboxed conflict demo`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Port the orchestration into `commands/demo.ts`

`runDemo(rawArgs)` with flags `--keep` (don't delete the sandbox; print its
path) and `--json` (machine-readable event log instead of narration).

Hard sandbox rules (the point of the command):
1. Everything lives under `mkdtemp(join(tmpdir(), "synapse-demo-"))` —
   worktree and SQLite state. The server's SQLite location knob is
   `SYNAPSE_DB_PATH` (`apps/server/src/store.ts:355`; confirm with
   `grep -n 'SYNAPSE_DB_PATH' apps/server/src/store.ts`). With it unset and
   no `SYNAPSE_DATABASE_URL`, the server uses in-memory SQLite, so the
   default leak risk is low — pass `SYNAPSE_DB_PATH=<sandbox>/state.sqlite`
   explicitly anyway so the demo is deterministic and provably writes only
   inside the sandbox.
2. `repoId = "demo/" + <6 random hex chars>` passed explicitly via
   `--repo-id`/`SYNAPSE_REPO_ID` to every process — never derived from the
   cwd's git remote.
3. All ports from `freePort()`; never the default 4010.
4. Child processes tracked and killed in a `finally` + `SIGINT` handler;
   sandbox removed unless `--keep`.

The narrative (mirror the verify's story, printing before each act):
server up → alice & bob join → bob's clean check (verdict `none`) → alice
reports the baseline and then changes `validate`'s return type → bob checks
`login.ts` → conflict! Print the conflict rule, severity, and the
counterpart line, then a closing pointer to the README's manual walkthrough
and `synapse join` for the real thing. Use the existing HTTP surfaces
(`/tools/synapse_check`, `/tools/synapse_report`) exactly as the verify
script does.

**Verify**: `npm run build` → exit 0; `node apps/cli/dist/index.js demo` →
narrated run ends with a `dependency_changed` conflict, exit 0, and the
sandbox dir printed in the narration no longer exists
(`ls <printed path>` → "No such file or directory"). Lingering-process
checking is done mechanically in Step 3 via the ports in the JSON output.

### Step 2: `--json` and failure behavior

`--json` prints exactly one JSON object on stdout — this is the contract
Step 3 asserts, state it once and keep both sides in sync:

```json
{
  "ok": true,
  "sandbox": "/tmp/synapse-demo-XXXXXX",
  "ports": { "server": 0, "alice": 0, "bob": 0 },
  "steps": ["server-up", "join", "clean-check", "baseline", "delta", "conflict"],
  "conflict": { "rule": "dependency_changed", "severity": "warn" }
}
```

Any step failing → non-zero exit, children killed, sandbox removed (kept
under `--keep`), and a plain one-line error (no stack trace for expected
failures like a port race — retry `freePort` once).

**Verify**: `node apps/cli/dist/index.js demo --json | node -e "const d=JSON.parse(require('fs').readFileSync(0));process.exit(d.ok && d.conflict.rule==='dependency_changed'?0:1)"` → exit 0.

### Step 3: `scripts/verify-demo.mjs`

Thin: run the built CLI's `demo --json` as a child process, parse stdout
against the Step 2 contract, and assert: `ok === true`,
`conflict.rule === "dependency_changed"`, exit code 0, the `sandbox` dir no
longer exists, and each port in `ports` refuses connections after exit
(`fetch(http://localhost:<port>/health)` rejects — that is the mechanical
no-lingering-children check). Add the root `"verify:demo"` alias.

**Verify**: `npm run verify:demo` → exit 0; `node scripts/ci-verify-all.mjs --only demo,dependency-ts-check` → exit 0.

### Step 4: Dispatcher + README

Wire `demo` into `apps/cli/src/index.ts` (match the other commands; help
line: `demo            run a sandboxed two-agent conflict demo (no setup)`).
README: at the top of the "Try it: see a conflict" section, add the
one-command path (`synapse demo`, or `npx @kumario/synapse demo` once plan
010 is published) and keep the manual walkthrough as the explainer.

**Verify**: `node apps/cli/dist/index.js --help 2>&1 | grep demo` → 1 line;
`grep -n 'synapse demo' README.md` → ≥ 1 match.

## Test plan

The end-to-end test IS `scripts/verify-demo.mjs` (Step 3) — this command is
orchestration, so unit tests are limited to what's pure: if you extract
helpers (e.g. the narration formatter or the fixture file contents), test
those in `apps/cli/src/commands/demo.test.ts` only if a pure seam exists;
otherwise state in your report that coverage is the verify script, which
matches how `up`/`doctor` are covered (`verify-up.mjs`, `verify-doctor.mjs`).
Regression gate: `verify:dependency-ts-check` must stay green untouched.

## Done criteria

- [ ] `npm run build`, `npm run typecheck`, `npm test` exit 0
- [ ] `node apps/cli/dist/index.js demo` exits 0 with a narrated `dependency_changed` conflict
- [ ] `npm run verify:demo` exits 0 (json contract + sandbox cleanup asserted)
- [ ] `node scripts/ci-verify-all.mjs --only dependency-ts-check` still exits 0
- [ ] Demo never reads `.synapse/` from the cwd and never uses port 4010 (grep the new file for `4010` → 0 matches; repo-id always explicit)
- [ ] No files outside the in-scope list modified (`git status --porcelain`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `resolveServerEntry` cannot be reused without restructuring `up.ts`
  (it should be a function export away — if it's tangled in `up`'s flow,
  report the coupling).
- `SYNAPSE_DB_PATH` no longer exists in `apps/server/src/store.ts` (the
  knob was renamed/removed) — re-grep for the path construction and report
  what you find rather than writing state into a default location.
- The demo run inside `verify-demo.mjs` exceeds a 60s timeout — the
  daemons' check/report surfaces may be waiting on something (e.g. analyzer
  warmup); report the per-step timing breakdown (put step durations in the
  `--json` output if needed) instead of padding timeouts silently.

## Maintenance notes

- The demo encodes the fixture story twice (here and in
  `verify-dependency-ts-check.mjs`) by design — verifies must not depend on
  product code. If the conflict-engine's rule names ever change,
  both break loudly; that's the desired coupling direction.
- Once plan 010 publishes the package, update the README line to lead with
  `npx @kumario/synapse demo`; also consider mentioning the demo in the npm
  package description (release.config.json) — deferred to whoever publishes.
- Reviewer focus: child-process cleanup paths (SIGINT mid-demo must not
  orphan daemons) and that no demo path ever resolves the host repo's
  `.synapse/config.json`.
