# Synapse Future Plan v2 — Milestone-by-Milestone Execution Plan

> v2 · 2026-06-09 · Supersedes the v1 track-based plan (which is now partially stale).
> Ground truth: verified against `main` @ `e353296` ("Ship server via Docker with per-project
> key auth and tenancy (#31)") by reading the code, not the docs.
> Companions: `synapse-build-plan.md` (engineering outline), `synapse-technical-spec.md` (spec),
> `synapse-context.md` (vision), `plan.md` (resolver plan — shipped, historical).

---

## 1. Status ledger (what is actually done on `main`)

Verified by inspection this session:

| Area | Status | Evidence |
|------|--------|----------|
| Core loop M0–M3 (protocol, daemon, conflict engine, analyzers TS+Py, MCP, hooks, briefings, why, feedback capture) | ✅ | 30 `verify:*` scripts + `eval:conflicts`, all hermetic |
| LLM resolver (converged contract, first-writer-wins) | ✅ | `plan.md` executed; `verify:resolution` |
| SQLite `StateStore` (snapshot per repo) | ✅ | `apps/server/src/store.ts` |
| **Docker Compose self-host (was B2)** | ✅ | `apps/server/Dockerfile`, `docker-compose.yml`, `verify:docker` |
| **`synapse doctor` (was B4)** | ✅ | `verify:doctor` |
| **`synapse up` + quick tunnel + `keygen`** (not in v1 plan) | ✅ | `verify:up`, `verify:up-tunnel` |
| **Per-project key auth + real tenancy** | ✅ | `deriveProjectKey(masterSecret, repoId)`, per-message repo check (`apps/server/src/index.ts:142`), `verify:tenancy` |
| CI pipeline (G1) | ❌ | no `.github/workflows/` |
| Publishable npm CLI (B1) | ❌ | `apps/cli/package.json` still `"private": true`, workspace deps at `0.0.0` |
| Resilient channel (G2) | ❌ | fixed `setTimeout(connect, 1000)` (`apps/cli/src/index.ts:261`); `sendToServer` drops messages when socket closed (`:208`); no transport ping |
| Observability (G3) | ❌ | `console.log` only; no `/metrics` |
| Per-entity store + Postgres (A1) | ❌ | store is still full-snapshot last-writer-wins |
| Redis fan-out (A2), multi-instance (A5) | ❌ | in-process `roomClients` only |
| GitHub OAuth + JWT (A3) | ❌ | project-key mode is the shipped interim (a deliberate design change vs. v1 — see Decision D1) |
| RAG memory (C), Go analyzer (D2), VS Code (E1), dashboard (E2), adaptive severity (F1), file watcher (F3), security pass (G4), protocol negotiation (G5), fuzzing (G6) | ❌ | — |

Auth note: the v1 plan assumed OAuth/JWT for tenancy; what shipped instead is
**HMAC-derived per-project keys** (`SYNAPSE_MASTER_SECRET` → `deriveProjectKey(secret, repoId)`).
This already delivers per-repo isolation with zero DB and zero third-party dependency. OAuth is
therefore *re-scoped* as a SaaS-phase identity feature, not a tenancy prerequisite (Decision D1).

---

## 2. Codebase findings — where the big improvements are

From reading the source this session (8.6k LOC product):

1. **`apps/cli/src/index.ts` is a 2,880-line monolith** — daemon HTTP surface, WS client, hot-path
   check, hooks installer, `up`/`doctor`/`keygen`/tunnel, why/whatsup rendering, all in one file.
   Every breadth feature (watcher, VS Code, languages) makes it worse. → Milestone M7 (refactor
   split) before Phase-3 breadth work.
2. **Message loss is real today**: `sendToServer` silently no-ops when the socket isn't OPEN, and
   reconnect is a fixed 1s loop. An agent's `contract.delta` emitted during a server blip is gone
   forever (the team never learns about the change). Highest-value robustness fix. → M2.
3. **The CLI depends on `@synapse/server`** (`synapse up` resolves and spawns the built server
   entrypoint, `apps/cli/src/index.ts:797`). Any npm-publish story must inline or co-publish the
   server, or `up` breaks from a tarball install. The v1 plan missed this. → M5.
4. **No server-side input validation**: `handleMessage` casts `JSON.parse(raw) as ClientMessage`
   and `applyMessage` trusts the shape. Any authorized (or, in open mode, any) client can poison
   persisted state with malformed payloads. Cheap to fix with zod at ingress; pulled forward from
   the v1 "G4 security pass". → M4.
5. **Write + broadcast amplification**: every mutation rewrites the repo's entire JSON snapshot to
   SQLite (`persist()`) and re-broadcasts the entire `state.snapshot` to every room client. Fine at
   demo scale; it is the scaling ceiling. Per-entity store ops (M8) fix the write side; incremental
   `state.delta` fan-out (Decision D3) would fix the broadcast side.
6. **Token in the query string** (`?token=`): leaks into proxy/access logs; header path already
   exists. Default the daemon to header-only and keep `?token=` as a deprecated fallback. Folded
   into M4.
7. **`conflictFeedback` is collected and never used** — the "tunable + learns" promise of the spec
   (§9 fatigue controls) is one deterministic aggregation away. Cheapest "product gets smarter"
   win. → M6.
8. **No file watcher**: the daemon only learns about edits when an agent reports them; manual edits
   between agent turns are invisible (spec §1 promises a git watcher). → M10.
9. **`Synapse/` (Vite landing page) sits untracked at the repo root** with its own
   `node_modules` — it's invisible to CI and not part of the workspace. → Decision D4, then M13.
10. **Protocol version field exists but is never negotiated** (`WireEnvelope.v`); a future wire
    change would fail opaquely. → M15.

---

## 3. Decision points — owner sign-off required before implementing

Per owner direction, design/product changes are flagged here *before* being made. Milestones
marked “(D-gated)” do not start until the decision is confirmed. Everything else follows the
already-documented design.

- **D1 — Auth roadmap: keep project keys as the primary story; re-scope OAuth.**
  Proposal: treat per-project keys as the supported self-host + small-team SaaS auth
  indefinitely; build GitHub OAuth/JWT (M14) only when a hosted multi-tenant offering with
  per-user identity is actually being launched. Implication: A3 moves from Phase 2 to the SaaS
  launch phase; tenancy is already done. *Default if unconfirmed: plan assumes D1 accepted
  (matches what was already shipped in #31).*
- **D2 — Store evolution shape.** v1 chose "per-entity row ops wired through `applyMessage`".
  Confirmed as still the right call (it's the only way two instances don't clobber snapshots), but
  with a concrete amendment: keep `SqliteStateStore` on the *new* interface via per-entity tables,
  and add `PostgresStateStore` behind `SYNAPSE_DATABASE_URL`. No alternative proposed — listed
  because it rewrites the persistence seam. *Default: proceed as v1 documented (M8).*
- **D3 — Incremental `state.delta` broadcast (new proposal).** Replace full-snapshot fan-out with
  per-mutation deltas + periodic snapshot resync (the protocol doc already reserves `state.delta`).
  Cuts broadcast cost from O(state×clients×mutations) to O(mutation). It is a wire-protocol
  addition (backward-compatible: servers can keep sending snapshots to old clients once M15
  negotiation exists). *Not started until approved; sequenced after M15.*
- **D4 — Web home for the landing page (new proposal).** Fold `Synapse/` into the monorepo as
  `apps/web` (workspace + CI + shared types for the future read-only dashboard), deploy via
  Vercel. Alternative: keep it a separate repo. *Not started until approved.*
- **D5 — First new language is Go** (v1 default). Swap to Rust/Java here if user demand differs.
  *Default: Go (M12).*

---

## 4. Milestones

Conventions (unchanged from v1, they're good): every milestone ships a hermetic
`scripts/verify-<name>.mjs` + root `package.json` entry in the established style; all new infra is
env-gated and off by default; mutations stay in `apps/server/src/state.ts`, transport/store in
`apps/server/src/index.ts`; hot-path budget p95 ≤ 50ms warm stays enforced.

### Phase A — Foundation hardening (this session's execution target: M1–M4, then M5/M6 as time allows)

**M1 — CI gate** *(was G1; unblocks everything)*
- `scripts/ci-verify-all.mjs`: one entrypoint that runs build → typecheck → unit tests → every
  hermetic `verify:*` + `eval:conflicts` in sequence, aggregating failures into one report;
  skips environment-dependent scripts (`verify:docker` needs Docker; `verify:up-tunnel` needs
  cloudflared/ngrok) with an explicit SKIP line unless the binary is present.
- `.github/workflows/ci.yml`: PR + push-to-main. Job 1 (fast): `npm ci`, build, typecheck, test.
  Job 2 (verify): `setup:analyzer-py` then `node scripts/ci-verify-all.mjs`. Node 20, npm cache +
  `packages/analyzer-py/.venv` cache keyed on `requirements.txt`. Latency gates are the existing
  scripts' own exit codes — no new budget mechanism.
- Exit: workflow green on a no-op PR; `node scripts/ci-verify-all.mjs` green locally.

**M2 — Resilient daemon↔server channel** *(was G2; fixes finding #2)*
- `apps/cli/src/index.ts`: exponential backoff + full jitter (base 500ms, cap 30s, reset on open)
  replacing the fixed 1s retry; module-level outbox — `sendToServer` enqueues instead of dropping
  when not OPEN (cap ~500, drop-oldest), flushed in order on open after `session.start`.
- `apps/server/src/index.ts`: transport `ws` ping every 20s; a socket that misses a pong is
  terminated so half-open connections leave the room (daemon's backoff reconnects it).
- Exit: `verify:reconnect` — report lands, kill server, report while down, restart, both deltas in
  `GET /state`; no silent loss.

**M3 — Observability** *(was G3)*
- Tiny in-process metrics registry (no heavy dep): counters (messages by type, conflicts by
  rule/severity, reconnects, ws connections, llm calls by outcome) + histograms (check latency,
  message apply time). `GET /metrics` in Prometheus text format next to `/health` (kept unauthenticated
  read-only or gated — match `/health`).
- Structured JSON logs (single tiny logger util, level via `SYNAPSE_LOG_LEVEL`, default `info`)
  for connect/close/auth-reject/message/webhook/llm events on the server; reconnect/outbox events
  on the daemon.
- Exit: `verify:metrics` — drive a check + a conflict, scrape `/metrics`, assert counters moved.

**M4 — Server ingress validation + auth hygiene** *(pulled forward from G4; findings #4, #6)*
- zod schemas for every `ClientMessage` variant living in `@synapse/protocol` (single source,
  shared by cli + server), applied in `handleMessage` before `applyMessage`; invalid → `ack`
  error, never a cast. Cap WS message + webhook body size (e.g. 1 MB) with a clear error.
- Daemon sends the credential via `Authorization: Bearer` header only; server keeps accepting
  `?token=` for back-compat but it's no longer emitted.
- Exit: unit tests for rejected malformed payloads; all existing verifies stay green.

**M5 — Publishable `@synapse/cli`** *(was B1; amended for finding #3)*
- esbuild bundle (`apps/cli/scripts/bundle.mjs`) producing self-contained `dist/` that inlines
  `@synapse/{protocol,conflict-engine,analyzer-ts,analyzer-py,server}` (server inlined as a
  spawnable compiled entry so `synapse up` works from a tarball). External deps stay real:
  `ws`, `zod`, `@modelcontextprotocol/sdk`, `better-sqlite3`, `typescript`/`ts-morph`.
- Ship `packages/analyzer-py/{python,requirements.txt,scripts}` as package assets; resolve them
  relative to the bundle.
- `package.json`: un-private, real version (`0.1.0`), `files`, `publishConfig.access=public`.
- Exit: `verify:npm-pack` — `npm pack` → install tarball in temp dir → `synapse --help`, `join` in
  a scratch git repo writes `.synapse/config.json` + `.claude/settings.json`, daemon answers a
  file-only `synapse_check`.

**M6 — Adaptive severity from feedback** *(was F1; finding #7)*
- Deterministic policy in the daemon's verdict step: per `(repoId, rule)`, compute
  dismissed/acted counts from `teamState.conflictFeedback`; when dismissals ≥ N (default 5) and
  dismiss-rate ≥ 80%, demote that rule's `warn` → `info` for subsequent conflicts (never demote
  `block` recommendations from resolutions; never promote). Config knob
  `SYNAPSE_ADAPTIVE_SEVERITY=0` to disable.
- Exit: `verify:adaptive-severity` — feed N dismissals for a rule via `synapse_feedback`, assert
  the next check reports `info` and that a differently-ruled conflict still warns.

**M6.5 — Branch-aware conflict severity** *(new; first slice of F2/F4/F5
branch awareness, pulled forward ahead of M7)*
- Add optional `branch` field to `Session`, `RecentPush`, and
  `Conflict.counterpart` (additive, `looseObject`-compatible). CLI captures
  the local branch via `git rev-parse --abbrev-ref HEAD`; the GitHub webhook
  derives it from the push payload's `ref`.
- New `applyBranchAwareness` pass (mirrors M6's `applyAdaptiveSeverity`):
  when a conflict's counterpart is on a different branch than the current
  session, demote `dependency_changed`/`stale_base` from `warn` to `info`
  (less immediately pressing across branches). `same_symbol_active`,
  `same_symbol_unpushed`, and `contract_divergent` are never demoted — they
  represent incompatibilities that will surface at merge time regardless of
  branch. Unknown branch on either side → no change (old clients, detached
  HEAD). Config knob `SYNAPSE_BRANCH_AWARE_SEVERITY=0` to disable; runs before
  M6's adaptive pass so feedback-based demotion still has the final say.
- Exit: `verify:branch-aware-severity` — two sessions on different branches
  with a stale `dependency_changed`/`stale_base` conflict report `info`;
  same-branch sessions and `contract_divergent`/`same_symbol_active` still
  report `warn`.

### Phase B — Structure + scale-out backbone

**M7 — CLI decomposition** *(new; finding #1 — do before breadth)*
- Split `apps/cli/src/index.ts` into modules with unchanged behavior: `daemon.ts` (HTTP surface +
  WS client + outbox), `commands/{join,up,doctor,keygen,session,check,report,push,feedback}.ts`,
  `briefings.ts` (whatsup/why/render), `tunnel.ts`, `hooks.ts`. `index.ts` becomes the dispatcher.
- Exit: zero new behavior; full verify matrix green is the test.

**M8 — Per-entity `StateStore` + Postgres** *(was A1; Decision D2 default)*
- Interface: keep `load(repoId)` for boot hydration; replace `save` with per-entity ops mirroring
  `TeamState` arrays (`upsertSession/endSession`, `upsertEditLock/deleteEditLock`,
  `upsertDelta/clearDeltasForPush`, `appendPush`, `appendRepoEvent`, `appendSummary`,
  `upsertResolution/deleteResolution`, `appendFeedback`, `pruneExpired`).
- `applyMessage` takes the store and emits the matching store op alongside each in-memory
  mutation (in-memory stays the source of truth; persistence becomes incremental).
- `SqliteStateStore` re-implemented on per-entity tables; `PostgresStateStore` (node-postgres)
  selected by `SYNAPSE_DATABASE_URL`; SQLite remains default.
- Exit: `store.test.ts`/`state.test.ts` parameterized over both backends; `verify:persistence`
  still green; `verify:persistence-pg` runs when `SYNAPSE_DATABASE_URL` is present (CI service),
  SKIPs offline.

**M9 — Redis fan-out + multi-instance** *(was A2+A5)*
- `SYNAPSE_REDIS_URL` set → on mutation, `PUBLISH repo:<id>`; every instance subscribes, re-reads
  the repo from the shared store, re-broadcasts to its local room. Locks/session liveness get
  Redis TTLs mirroring the 90s in-memory TTL. Unset → today's single-instance path.
- Exit: `verify:multi-instance` — two servers + shared Postgres/Redis, daemons split across them,
  a report on A is visible in `GET /state` on B and pushed to B's daemon. CI-gated by services;
  SKIPs offline.

### Phase C — Capability breadth (parallelizable after M7)

**M10 — File watcher** *(was F3)* — chokidar in the daemon over `worktreeRoot` (gitignore-aware,
  debounced); a changed tracked file flows through the existing `synapse_report` path so manual
  edits emit deltas. Exit: `verify:file-watcher` — touch a file, delta appears with no explicit
  report call.

**M11 — JS/JSX/TSX audit** *(was D1)* — fixtures for `.jsx/.tsx/.js/.mjs/.cjs` through
  `extractTypeScriptContracts` + the dependency graph; close gaps (JSX components as contracts,
  default exports). Exit: `verify:tsx-check`.

**M12 — Go analyzer** *(was D2; D5-gated)* — `packages/analyzer-go` warm sidecar (tree-sitter +
  `go/packages`) speaking the same JSON-RPC analyzer protocol, `go:`-prefixed `SymbolId`s,
  bootstrap mirroring `setup-venv.mjs`. Exit: `verify:go-check` mirroring `verify-python-check.mjs`.

**M13 — Web app + dashboard** *(was B3/E2; D4-gated)* — fold `Synapse/` → `apps/web`; then a
  read-only team view (sessions, deltas, pushes, resolutions, feedback) over `GET /state` with a
  project key. Opt-in, read-only (principle #6).

**M14 — GitHub OAuth + JWT identity** *(was A3; D1-gated, SaaS launch phase)* — OAuth callback
  mints short-lived JWTs carrying `{githubLogin, allowedRepoIds}`; project-key mode remains for
  self-host. Exit: `verify:oauth-jwt` with a stubbed identity provider.

**M15 — Protocol version negotiation** *(was G5)* — versions exchanged at WS open; graceful
  downgrade/refusal. Prerequisite for D3 (incremental deltas). Exit: `verify:protocol-compat`.

### Phase D — Depth (after the above)

- **RAG memory (C1/C2)** on M8's Postgres + pgvector: embed summaries/resolutions/events behind
  the optional-provider seam; hybrid recall on top of the deterministic `why` floor with the
  citation contract preserved; `degraded:true` without embeddings. Exit: `verify:why-rag`.
- **Remaining G4**: rate limiting, webhook secret required in production, resolver privacy opt-out
  note.
- **G6 fuzzing/property tests**: malformed-source fuzz for both analyzers; `resolutionInputsHash`
  symmetry properties.
- **D3 incremental `state.delta`** (after M15, if approved), **C3/C4 external ingestion +
  onboarding mode**, **F4/F5 richer auto-resolution, rename tracking** (branch-awareness M6.5
  done), **D3–D5 more languages/SCIP**, **E1 VS Code extension**, **E4 editor rules**.

---

## 5. Sequencing & dependency summary

```
M1 CI ──┬─→ M2 channel ─→ M3 observability ─→ M4 validation ─→ M5 packaging ─→ M6 severity
        │                                                        (Phase A, this session order)
        └─→ M7 cli split ─→ {M10 watcher, M11 tsx, M12 go(D5), M13 web(D4)}   (breadth)
M8 store ─→ M9 redis/multi-instance ─→ RAG / M14 oauth(D1)                    (backbone)
M15 negotiation ─→ D3 delta broadcast (if approved)
```

## 6. Execution log

- 2026-06-09 — v2 plan written; ground-truthed against `main` @ `e353296`. Phase A execution begun
  (M1 first). Decisions D1–D5 await owner confirmation; defaults noted above are being followed,
  and no D-gated milestone is implemented before sign-off.
- 2026-06-10 — M6.5 (branch-aware conflict severity) added to Phase A, slotted before M7 per owner
  direction. Pulls forward the first slice of the deferred F2/F4/F5 branch-awareness backlog item;
  remaining richer auto-resolution/rename-tracking stays deferred to Phase D.
- 2026-06-10 — **M6.5** ✅ (branch `feat/branch-aware-severity`): optional `branch` on
  `Session`/`RecentPush`/`Conflict.counterpart`/`push.notify` (additive, looseObject-compatible);
  daemon captures the branch by reading `.git/HEAD` directly (the `git rev-parse --abbrev-ref HEAD`
  answer without a subprocess on the hot path; handles linked-worktree `gitdir:` pointers, detached
  HEAD → unknown); webhook derives it from the push `ref` (`refs/heads/X` only).
  `applyBranchAwareness` in conflict-engine demotes cross-branch `dependency_changed`/`stale_base`
  `warn`→`info`, never touches `same_symbol_active`/`same_symbol_unpushed`/`contract_divergent`,
  no-ops on unknown branch, runs before the adaptive pass; `SYNAPSE_BRANCH_AWARE_SEVERITY=0`
  opt-out; `synapse_branch_severity_demotions_total` metric. 5 unit tests +
  `verify:branch-aware-severity` (4 daemons on 2 branches: cross-branch stale_base → info, opt-out
  + same-branch still warn, cross-branch same_symbol_unpushed still warns and surfaces
  `counterpart.branch`). Also restored the `verify:{reconnect,metrics,adaptive-severity,npm-pack}`
  + `verify:all` npm aliases that PR #34's package.json rewrite dropped (CI was unaffected —
  `ci-verify-all.mjs` discovers `scripts/verify-*.mjs` directly).
- 2026-06-10 — **M7** ✅ (branch `refactor/cli-decomposition`): `apps/cli/src/index.ts` (3,100
  lines) split into a 119-line dispatcher + focused modules with zero behavior change:
  `daemon.ts` (HTTP surface + WS client + outbox + state/report/resolution helpers), `config.ts`
  (RuntimeConfig, flags, git identity, local/team config, `cliEntrypoint`), `analysis.ts`
  (analyzer adapters, source scanning, dependency graph, check targets), `briefings.ts`
  (whatsup/why/session-start render), `hooks.ts` (Claude Code hook install + runtime),
  `tunnel.ts`, `http.ts`, and `commands/{check,report,push,feedback,session,whatsup,why,join,
  connect,up,keygen,doctor,analyze}.ts`. Two deliberate location-sensitive adjustments, behavior
  identical: `cliEntrypoint()` now resolves `dist/index.js` as a sibling of the compiled module
  (it is embedded in hook commands and must keep pointing at the dispatcher), and
  `resolveServerEntry()`'s monorepo fallback gained one `../` hop (`dist/commands/`). Line-level
  audit: every non-empty line of the old file accounted for verbatim in the new modules except
  those two functions and added `export` keywords. Exit per plan: no new behavior; full verify
  matrix green.
- 2026-06-10 — **M8** ✅ (branch `feat/per-entity-store`): `StateStore` rewritten to per-entity row
  ops (`upsertSession`, `upsertEditLock`/`deleteEditLock(+ForSession)`, `upsertDelta`/`deleteDelta`,
  `appendPush`/`appendRepoEvent`/`appendSummary`/`appendFeedback` with the in-memory caps,
  `upsertResolution`/`deleteResolution`; async `load`/`listRepoIds`/`flush`/`close`).
  `applyMessage(state, repoId, message, store = noop)` emits the matching op alongside every
  in-memory mutation (memory stays the source of truth); `pruneExpiredLocks` deletes expired lock
  rows too. `SqliteStateStore` re-implemented on per-entity tables (rowid ordering; one-time
  automatic migration from the legacy `team_state` snapshot table, then drops it).
  `PostgresStateStore` (`store-pg.ts`, `pg` imported lazily so the bundled CLI never needs it)
  selected by `SYNAPSE_DATABASE_URL`, ops serialized on an internal queue (`flush()` awaits).
  `store.test.ts` parameterized over both backends (Postgres variants run when
  `SYNAPSE_VERIFY_PG_URL`/`SYNAPSE_DATABASE_URL` is set); `verify:persistence` still green;
  new `verify:persistence-pg` (SIGKILL durability; SKIPs offline) + a `postgres:16` service on the
  CI verify job exposed as `SYNAPSE_VERIFY_PG_URL` so the rest of the matrix stays on SQLite.
- 2026-06-10 — **M9** ✅ (branch `feat/redis-multi-instance`): `apps/server/src/fanout.ts` —
  `SYNAPSE_REDIS_URL` set → after every mutation the instance `PUBLISH`es `synapse:repo:<id>`
  (after `store.flush()`, so a subscriber's re-read can never miss the rows the mutation wrote);
  every instance `PSUBSCRIBE`s, ignores its own `instanceId`, re-reads the repo from the shared
  M8 store, swaps its cache, and re-broadcasts the snapshot to its local room. The `redis` driver
  is imported lazily (like `pg`); unset → single-instance path untouched. *Amendment to the plan's
  "Redis TTLs mirroring the 90s in-memory TTL" line:* Redis carries no state, so no Redis TTLs —
  lock/session expiry stays timestamp-based (`acquiredAt + ttlSec`, `lastSeen`) evaluated at read
  time against the shared rows by every instance, which is the same guarantee without a second
  source of truth. Exit: `verify:multi-instance` — two servers on shared Postgres + Redis, alice's
  daemon on A, bob's on B; both servers see both sessions; alice's contract delta is readable in
  `GET /state` on B and lands in bob's daemon's cached state via B's room broadcast. Runs on the
  CI `postgres:16` + `redis:7` services (`SYNAPSE_VERIFY_{PG,REDIS}_URL`), SKIPs offline.
  Two races found by stress-looping the verify against local Postgres+Redis (reproduced ~1-in-4,
  then 20/20 green after the fixes): (1) concurrent `CREATE TABLE IF NOT EXISTS` from two booting
  instances crashes one (Postgres catalog race) → DDL now serialized under `pg_advisory_lock`;
  (2) a cache reload that started before a local mutation could complete after it and roll the
  in-memory state back (lost update — a session vanished until the next heartbeat) → every
  cache-touching path (message apply, webhook apply, snapshot reads, remote refresh) now runs
  under a per-repo async mutex (`withRepo`), with dirty-marking + single-flight loads inside it.
- 2026-06-11 — **M10** ✅ (branch `feat/file-watcher`): `apps/cli/src/watcher.ts` — chokidar over
  `worktreeRoot`, scope mirroring the analyzer scan's ignored-directory set (the product-wide
  .gitignore approximation), per-file debounce (`SYNAPSE_WATCH_DEBOUNCE_MS`, default 400ms), only
  analyzable sources forwarded. A watched change flows through the existing `reportContractChanges`
  path (first event = baseline snapshot, next = deltas via `contract.delta`), so manual edits
  between agent turns reach the team with no `synapse_report` call. On by default in the daemon
  (the spec-§1 promise), `SYNAPSE_FILE_WATCHER=0` opts out; `synapse_watch_reports_total` metric.
  Exit: `verify:file-watcher` — new file → baseline, signature edit → delta in server `/state`
  with zero report calls; README.md edit ignored; opt-out daemon stays inert.
- 2026-06-11 — **M11** ✅ (branch `feat/tsx-audit`): audited `.tsx/.jsx/.js/.mjs/.cjs` through the
  TS analyzer and closed the found gaps: (1) default-exported arrow/function expressions were
  invisible — now extracted as function contracts named by their export (`#default`);
  (2) default imports never resolved graph edges (the export key was ignored) — a per-file
  exported-name → symbol map now resolves both default imports and `export { X as Y }` aliases to
  the real symbol; (3) `.mjs` was not analyzable in the CLI and not a module-resolution candidate —
  added (plus `/index.{js,jsx,mjs}` candidates). `.cjs` stays deliberately on the file-level
  fallback: `module.exports` is invisible to the extractor, so "analyzable" would silence its
  changes entirely (decision documented in `isTypeScriptLike`). JSX function/arrow components
  already worked (covered by new tests). 5 new analyzer tests (9 total) + `verify:tsx-check` —
  default-export `.tsx` props change → symbol delta + `dependency_changed` for the importing
  component via the default-import edge; `.mjs` helper joins the same graph.
- 2026-06-11 — **M12** ✅ (branch `feat/go-analyzer`, D5 default: Go): `packages/analyzer-go` —
  a warm Go sidecar (stdlib `go/parser` + `go/ast`, zero module deps, static binary) speaking the
  same newline-delimited JSON-RPC protocol as analyzer-py (`health`/`extractFile`/`indexGraph`).
  `go:`-prefixed SymbolIds; exported = uppercase (Go's own rule): functions, methods (`T.Name`),
  structs (class + exported fields), interfaces, type aliases, consts. Graph edges: same-package
  bare identifiers + cross-package `pkg.Sym` selectors via import-path↔directory suffix matching.
  `scripts/setup-go.mjs` builds the binary (source-hash stamp; no toolchain → warn + exit 0),
  mirroring `setup-venv.mjs`; wired into join, `ci-verify-all` stages, packaging (sources, never
  the platform-specific `bin/`), and CI (`actions/setup-go`). Daemon routes `.go` through
  extract/diff/graph alongside ts/py (`lang: "go"` added to the protocol union). Exit:
  `verify:go-check` mirroring `verify-python-check` — two worktrees rewrite `Validate` to
  incompatible return types → `contract_divergent` + deterministic block resolution; SKIPs without
  the built binary. 4 wrapper unit tests (skip without toolchain).
- 2026-06-11 — **M15** ✅ (branch `feat/protocol-negotiation`): versions exchanged at the WS
  handshake. `negotiateProtocolVersion` + `MIN_SUPPORTED_PROTOCOL_VERSION` in `@synapse/protocol`
  (agreed = `min(client, server)` on overlap; refusal with reason otherwise; no announcement = v1
  for pre-negotiation clients). Daemon announces `&v=` on connect, verifies the server's advertised
  dialect from the upgrade headers, and renders a 426 refusal as a clear "upgrade the older side"
  warning. Server refuses out-of-range clients at the handshake (HTTP 426 +
  `x-synapse-protocol{,-min}` headers, `synapse_protocol_refusals_total` metric), advertises its
  range on every upgrade, records the agreed dialect per socket (the D3 downgrade seam), and
  reports `minProtocolVersion` on `/health`; `synapse doctor` now FAILs on non-overlapping ranges
  and warns on compatible-but-different. 6 unit tests + `verify:protocol-compat` (current client,
  legacy client, newer-client downgrade, out-of-range 426 refusal). D3 (incremental `state.delta`)
  is now unblocked pending owner approval.
- 2026-06-11 — **G4 remainder** ✅ (branch `feat/security-hardening`): (1) ingress rate limiting —
  sliding one-minute budgets per WS connection (`SYNAPSE_RATE_LIMIT_PER_MIN`, default 600) and for
  the webhook endpoint (`SYNAPSE_WEBHOOK_RATE_LIMIT_PER_MIN`, default 120; 0 disables either);
  over-limit WS messages are acked `rate_limited` and dropped before any mutation, webhooks answer
  429; `synapse_rate_limited_total{surface}` metric. (2) webhook secret required in production:
  with auth enabled (shared-token/project-key), `/webhooks/github` answers 403
  `webhook_secret_required` until `SYNAPSE_GITHUB_WEBHOOK_SECRET` is configured; open mode
  unchanged. (3) resolver privacy: README Privacy section documenting the one place raw code can
  leave the machine and the `SYNAPSE_LLM_RESOLVE=0` / `OPENROUTER_BASE_URL` opt-outs (knob already
  existed). Exit: `verify:security` — WS flood → bounded state + rate_limited acks; webhook 429;
  auth-mode 403 without secret; signed-only acceptance with one.
- 2026-06-09 — **Phase A complete** (branch `foundation-hardening-m1-m4`):
  - **M1** ✅ `.github/workflows/ci.yml` (check + verify jobs, npm/venv caching) +
    `scripts/ci-verify-all.mjs` (one-build aggregate runner; `--only`, `SYNAPSE_VERIFY_SKIP`,
    per-script timeout w/ process-group reaping) + root `verify:all`.
  - **M2** ✅ exponential backoff + full jitter reconnect (`SYNAPSE_RECONNECT_{BASE,MAX}_MS`),
    capped drop-oldest offline outbox flushed on open (heartbeats excluded), server ws ping with
    dead-socket termination (`SYNAPSE_WS_PING_INTERVAL_MS`). `verify:reconnect` proves no message
    loss across a server outage (pre-outage delta survives via SQLite; during-outage delta flushes
    from the outbox).
  - **M3** ✅ `MetricsRegistry` + `createLogger` in `@synapse/protocol`; `GET /metrics` on server
    (connections, messages by type, apply histogram, auth rejections, webhooks) **and** daemon
    (check-latency histogram, verdicts, conflicts by rule/severity, outbox, reconnects, demotions);
    JSON logs on stderr gated by `SYNAPSE_LOG_LEVEL`. `verify:metrics`.
  - **M4** ✅ zod wire schemas (`packages/protocol/src/wire-schema.ts`, loose objects for forward
    compat) validated at server ingress before any mutation; 1MB payload caps (ws `maxPayload` +
    webhook 413); daemon/doctor credentials moved to `Authorization: Bearer` (query-string accepted
    for back-compat only). Unit-tested in protocol.
  - **M6** ✅ `applyAdaptiveSeverity` in conflict-engine (≥5 dismissals & ≥80% dismiss rate per
    rule → warn demotes to info; never promotes; `SYNAPSE_ADAPTIVE_SEVERITY=0` opt-out), wired into
    the daemon check path. 7 unit tests + `verify:adaptive-severity` (warn → 5 dismissals → info,
    opt-out daemon still warns).
  - **M5** ✅ publishable `@synapse/cli@0.1.0`: bundleDependencies for the five workspace packages
    materialized by `apps/cli/scripts/pack.mjs` (npm pack skips symlinked bundle deps, so the script
    stages real copies — server dist + analyzer-py python/requirements/scripts, never `.venv`);
    `better-sqlite3`/`ts-morph` promoted to direct deps (npm does not install deps-of-bundled-deps).
    `verify:npm-pack`: pack → tarball completeness asserts → install in fresh project → help → join
    (config + hooks) → bundled server + installed daemon answer a live check (SKIPs offline).
  - README sections + `.env.example` knobs added for all of the above.
  - M7 (CLI decomposition) is the next milestone; M8–M9 (store + Redis) follow per §5.
