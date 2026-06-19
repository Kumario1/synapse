# Plan 062: Persist per-session Reservations from reported edits

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If a STOP condition occurs, stop and report - do not improvise. When
> done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 7eb55ce..HEAD -- packages/protocol/src/index.ts packages/protocol/src/wire-schema.ts packages/protocol/src/wire-schema.test.ts packages/conflict-engine/src/compare.test.ts packages/conflict-engine/src/index.test.ts apps/server/src/state.ts apps/server/src/state.test.ts apps/server/src/store.ts apps/server/src/store-pg.ts apps/server/src/store.test.ts apps/server/src/index.ts apps/cli/src/analysis.ts apps/cli/src/analysis.test.ts apps/cli/src/daemon.ts apps/cli/src/briefings.ts apps/cli/src/briefings.test.ts apps/web/src/derive.test.ts apps/web/src/fixture.ts apps/web/src/projects.ts scripts/verify-session-start.mjs README.md docs/adr/0003-reservations-deny-core-warn-radius.md synapse-technical-spec.md plans/README.md`
>
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/061-session-join-active-region-awareness.md
- **Category**: direction
- **Planned at**: commit `7eb55ce`, 2026-06-19
- **Issue**: https://github.com/Kumario1/synapse/issues/129

## Why this matters

Issue #128 made SessionStart warn about raw live `EditLock`s. Issue #129
deepens that into the durable Reservation state described in ADR 0003: a
per-session, derived region made from edited symbols plus dependency-graph
neighbors. This gives the server and briefings a queryable region without
hand-declared scope, LLM scope guesses, or a new lifecycle. Pushes and edit-lock
TTL remain the release mechanics.

## Current state

- `packages/protocol/src/index.ts` has `EditLock`, `TeamState`, `SynapseWhatsupResponse`, `StateOp`, and `createEmptyTeamState`, but no `Reservation`.
- `apps/server/src/state.ts` mutates sessions, edit locks, deltas, pushes, resolutions, summaries, and feedback. `contract.delta` only calls `upsertDelta`; `push.notify` clears deltas and edit locks by file/symbol; `pruneExpiredLocks()` only deletes expired locks.
- `apps/server/src/store.ts` and `apps/server/src/store-pg.ts` persist each entity through `ENTITY_TABLES` plus `StateStoreOps`; adding one entity requires a table entry and matching store ops.
- `apps/server/src/index.ts` turns `StateStoreOps` into `state.delta` ops in `teeStateStoreOps()`.
- `apps/cli/src/daemon.ts` creates `ContractDelta`s in `reportContractChanges()`, driven by `synapse_report` / PostToolUse. This is the right place to derive the Reservation seed deterministically from local analysis.
- `apps/cli/src/analysis.ts` already builds a merged dependency graph. `DependencyGraph.dependenciesOf(symbol, 2)` is the same radius used by conflict detection, and `DaemonGraph.dependentsOf(symbolRaw)` already returns direct downstream call sites.
- `apps/cli/src/briefings.ts` currently builds the SessionStart live-region section from `SynapseWhatsupResponse.editLocks`; issue #129 requires it to read stored Reservations instead.

Relevant excerpts at `7eb55ce`:

```ts
// packages/protocol/src/index.ts
export interface TeamState {
  repoId: string;
  sessions: Session[];
  editLocks: EditLock[];
  unpushedDeltas: ContractDelta[];
  recentPushes: RecentPush[];
  recentRepoEvents: RecentRepoEvent[];
  resolutions: ContractResolution[];
  resolutionProposals?: ResolutionProposal[];
  sessionSummaries: SessionSummary[];
  conflictFeedback: ConflictFeedback[];
}
```

```ts
// apps/server/src/state.ts
case "contract.delta":
  upsertDelta(state, repoId, store, message.payload.delta);
  markSessionEditing(
    state,
    repoId,
    store,
    message.payload.delta.sessionId,
    message.payload.delta.filePath,
    now
  );
  break;
```

```ts
// apps/cli/src/daemon.ts
return changes.map((change) =>
  createContractDelta(config, {
    symbolId: change.symbolId,
    filePath,
    changeKind: change.changeKind,
    before: change.before?.signature ?? null,
    after: change.after?.signature ?? null,
    summary: body.summary ?? summarizeSymbolChange(change.changeKind, change.symbolId.raw),
    baseSha: body.baseSha,
    dependents: body.dependents
  })
);
```

Repo conventions to match:

- Protocol changes are additive and backward-compatible unless an explicit version bump is required. `wire-schema.ts` uses loose objects to tolerate extra fields.
- Server state mutation helpers stay pure and synchronous; persistence is emitted through `StateStoreOps`.
- Store backends share `ENTITY_TABLES`; SQLite and Postgres must expose the same logical ops.
- Tests use `node:test` with strict `assert`.
- Commit messages use Conventional Commits, for example `feat(cli): surface live edit regions on session start`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Build | `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm run build` | exit 0 |
| Protocol tests | `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm test --workspace @synapse/protocol` | exit 0 |
| Server tests | `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm test --workspace @synapse/server` | exit 0 |
| CLI tests | `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm test --workspace @synapse/cli` | exit 0 |
| SessionStart verifier | `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm run verify:session-start` | exit 0 |
| Typecheck | `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm run typecheck` | exit 0 |
| Lint | `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm run lint` | exit 0 |
| Full tests | `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && SYNAPSE_PYTHON_BASE=/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12 npm test` | exit 0 |

## Scope

**In scope**:

- `packages/protocol/src/index.ts`
- `packages/protocol/src/wire-schema.ts`
- `packages/protocol/src/wire-schema.test.ts`
- `packages/conflict-engine/src/compare.test.ts`
- `packages/conflict-engine/src/index.test.ts`
- `apps/server/src/state.ts`
- `apps/server/src/state.test.ts`
- `apps/server/src/store.ts`
- `apps/server/src/store-pg.ts`
- `apps/server/src/store.test.ts`
- `apps/server/src/index.ts`
- `apps/cli/src/analysis.ts`
- `apps/cli/src/analysis.test.ts`
- `apps/cli/src/daemon.ts`
- `apps/cli/src/briefings.ts`
- `apps/cli/src/briefings.test.ts`
- `apps/web/src/derive.test.ts`
- `apps/web/src/fixture.ts`
- `apps/web/src/projects.ts`
- `scripts/verify-session-start.mjs`
- `README.md`
- `docs/adr/0003-reservations-deny-core-warn-radius.md`
- `synapse-technical-spec.md`
- `plans/README.md`

**Out of scope**:

- No PreToolUse `deny` behavior. That is issue #130.
- No Owner dashboard rendering. That is issue #131.
- No hand-declared Reservation UI/API.
- No LLM/prose-derived Reservation scope.
- No protocol version bump unless typecheck proves an additive optional field cannot work.
- No unrelated plan cleanup or TODO execution.

## Git workflow

- Branch: `feat/129-persist-reservations`
- Commit message: `feat(protocol): persist session reservations`
- Do not batch issue #130 or #131.

## Steps

### Step 1: Add the protocol Reservation shape

In `packages/protocol/src/index.ts`, add:

- `ReservationSeed` for a `contract.delta` to carry the derived region from the daemon: `radius` and `symbols`.
- `ReservationRoot` for one edited root's contribution: `symbolId`, `filePath`, `acquiredAt`, `ttlSec`, and `symbols`.
- `Reservation` as queryable per-session state: `repoId`, `sessionId`, `radius`, `symbols`, `roots`, and `updatedAt`.

Add optional `reservation?: ReservationSeed` to `ContractDelta`.
Add `reservations: Reservation[]` to `TeamState` and `SynapseWhatsupResponse`.
Add state ops `{ op: "upsertReservation"; reservation: Reservation }` and
`{ op: "deleteReservation"; sessionId: string }`. Update `applyStateOp()` and
`createEmptyTeamState()`.

Mirror the new type in `packages/protocol/src/wire-schema.ts`, including
`contractDelta.reservation`, `teamState.reservations`, and the two state ops.
Update `wire-schema.test.ts` so snapshots and state deltas containing
Reservations parse and `applyStateOp()` converges.

Update existing `TeamState` fixture helpers in `packages/conflict-engine` and
`apps/web` to include the new required empty `reservations` array.

**Verify**: `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm test --workspace @synapse/protocol` -> exit 0.

### Step 2: Persist Reservations in both stores

In `apps/server/src/store.ts`:

- Add `upsertReservation(repoId, reservation)` and `deleteReservation(repoId, sessionId)` to `StateStoreOps`, `StateStore`, and `noopStateStore`.
- Add `reservations: { keys: ["session_id"], newestFirst: false, field: "reservations" }` to `ENTITY_TABLES`.
- Implement SQLite methods using `upsertRow("reservations", repoId, [reservation.sessionId], reservation)` and a delete from `reservations`.
- In legacy snapshot migration, migrate `snapshot.reservations ?? []`.

In `apps/server/src/store-pg.ts`, add matching methods using
`upsertRow("reservations", ...)` and `DELETE FROM synapse_reservations ...`.

Update `apps/server/src/store.test.ts` to prove Reservations round-trip through
`load()` and are deleted when cleared.

**Verify**: `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm test --workspace @synapse/server` -> exit 0.

### Step 3: Accrete and release Reservations in server state

In `apps/server/src/state.ts`:

- Introduce a shared edit-lock TTL constant, keeping the current 90 second behavior.
- On `contract.delta`, call a helper after `upsertDelta()` to accrete that session's Reservation.
- The helper must use `delta.reservation?.symbols` when present, otherwise `[delta.symbolId, ...delta.dependents]`; never inspect `delta.summary` or other prose.
- Replace the root contribution for the same `sessionId + symbolId`, recompute `reservation.symbols` as a stable union of all root symbols, and persist with `store.upsertReservation()`.
- Use the matching live edit lock's `acquiredAt` and `ttlSec` when present; otherwise use `now` and the default TTL so old/manual reports still dissolve.
- On `push.notify`, remove Reservation roots whose `filePath` or root `symbolId.raw` matches the pushed files/symbols. Delete the whole Reservation row when no roots remain.
- In `pruneExpiredLocks()`, also remove expired Reservation roots using the root lease fields.
- On `session.end`, stale-session ending, session prune, and edit-lock cap eviction, remove the relevant Reservation roots or whole Reservation rows.

In `apps/server/src/index.ts`, extend `teeStateStoreOps()` to emit the new `StateOp`s.

Update `apps/server/src/state.test.ts` with one acceptance-style test that covers:

1. a `contract.delta` with a seed for root `ts:src/auth/token.ts#validate` and neighbor `ts:src/auth/login.ts#login` creates a Reservation containing both symbols
2. a second delta from the same session accretes another root without losing the first
3. a push for the first file/symbol drops only that root's symbols
4. TTL expiry drops the remaining root and deletes the Reservation

Also update existing session-end/kick tests to assert Reservations clear with edit locks.

**Verify**: `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm test --workspace @synapse/server` -> exit 0.

### Step 4: Derive Reservation seeds in the daemon report path

In `apps/cli/src/analysis.ts`:

- Export `RESERVATION_RADIUS = 2`.
- Add `reservationSeedForSymbol(symbolId, graph, extraDependents = [])`, returning `{ radius: RESERVATION_RADIUS, symbols }`.
- Include the edited root symbol, `graph.graph.dependenciesOf(symbolId, RESERVATION_RADIUS)`, `graph.dependentsOf(symbolId.raw)`, and explicit `extraDependents`.
- Deduplicate by `raw` and preserve first-seen order.

Add `apps/cli/src/analysis.test.ts` coverage with a small TS project where one exported function calls another. Assert the seed includes the edited symbol and its downstream dependent.

In `apps/cli/src/daemon.ts`:

- For analyzable report paths, build/reuse the dependency graph once in `reportContractChanges()`.
- For explicit-symbol reports, still derive a seed from the graph when the file is analyzable.
- For analyzer-derived deltas, set `dependents` to `body.dependents` if provided, otherwise `graph.dependentsOf(change.symbolId.raw).map(site => site.symbolId)`, and set `reservation` from `reservationSeedForSymbol(...)`.
- For non-analyzable/file-level reports, fall back to a seed containing the file/symbol only.

Do not use summaries, task text, prompts, or LLM outputs to choose Reservation scope.

**Verify**: `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm test --workspace @synapse/cli` -> exit 0.

### Step 5: Read Reservations in whatsup and SessionStart

In `apps/cli/src/briefings.ts`:

- Filter `state.reservations` to active sessions only.
- Drop expired roots without mutating state, recomputing each response Reservation's union from surviving roots.
- Add `reservations` to `SynapseWhatsupResponse`.
- Add an active reservation count to the summary.
- Change `sessionStartBriefing()` to render `briefing.reservations` instead of `briefing.editLocks`, excluding `selfSessionId`.
- Keep `editLocks` in the response for compatibility and for issue #130.

Use a compact line format such as:

```text
Teammates' live reservations:
  - alice: 2 symbols, radius 2 - ts:src/auth/token.ts#validate; ts:src/auth/login.ts#login
```

Update `apps/cli/src/briefings.test.ts` so SessionStart tests create Reservations and prove:

- teammate Reservations appear
- self Reservations are excluded
- expired roots and idle/ended-session Reservations are omitted
- raw edit locks alone no longer produce the Reservation section

Update `scripts/verify-session-start.mjs` so Alice reports a real change and Bob's SessionStart context asserts the Reservation section, not the old raw edit-lock section.

**Verify**: `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm run verify:session-start` -> exit 0.

### Step 6: Update docs

Update:

- `README.md` usage/architecture text: `synapse whatsup` and SessionStart now surface live Reservations, derived from reported edits and dependency neighbors.
- `docs/adr/0003-reservations-deny-core-warn-radius.md`: mark persisted/queryable Reservation state as shipped by issue #129; leave deny/dashboard as remaining work.
- `synapse-technical-spec.md`: add Reservation to the state model, briefing description, and lifecycle rules.
- `plans/README.md`: add/update the plan 062 status row.

There is no `CHANGELOG.md` in this repo; do not create one just for this issue.

**Verify**: `rg -n "Reservation|reservation" README.md docs/adr/0003-reservations-deny-core-warn-radius.md synapse-technical-spec.md plans/README.md` -> output includes #129/persisted Reservation mentions.

## Test plan

- Protocol: schema accepts Reservation snapshots and state delta ops; `applyStateOp()` mutates `TeamState.reservations`.
- Server state: accrete, push-clear, TTL-expire, session-end clear.
- Store: SQLite and optional Postgres backend round-trip Reservation rows and delete cleared rows.
- CLI analysis: deterministic derived seed includes root + graph neighbor(s).
- CLI briefings: SessionStart reads Reservations, not raw edit locks.
- End-to-end verifier: `verify:session-start` proves reported edits surface a stored Reservation to a joining teammate.

## Done criteria

All must hold:

- [ ] `TeamState.reservations` exists and is persisted by SQLite/Postgres stores.
- [ ] `SynapseWhatsupResponse.reservations` exists and SessionStart renders from it.
- [ ] A reported symbol accretes that session's Reservation with root + deterministic dependency neighbors.
- [ ] Push clears matching Reservation roots.
- [ ] TTL expiry drops matching Reservation roots and deletes empty Reservations.
- [ ] No code uses prose, prompts, summaries, or LLM output to derive Reservation scope.
- [ ] No PreToolUse deny behavior is added.
- [ ] `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm run build` exits 0.
- [ ] `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm run typecheck` exits 0.
- [ ] `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm run lint` exits 0.
- [ ] `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm test --workspace @synapse/protocol` exits 0.
- [ ] `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm test --workspace @synapse/server` exits 0.
- [ ] `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm test --workspace @synapse/cli` exits 0.
- [ ] `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && npm run verify:session-start` exits 0.
- [ ] `source ~/.nvm/nvm.sh && nvm use 20.19.2 >/dev/null && SYNAPSE_PYTHON_BASE=/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12 npm test` exits 0.

## STOP conditions

Stop and report if:

- The protocol/store/state excerpts above no longer match the live code after drift check.
- Persisting Reservations requires changing the existing store architecture away from per-entity rows.
- Deriving neighbor scope requires sending source code or prompts to the server.
- The implementation appears to require deny behavior, dashboard UI, or hand-declared Reservation boundaries.
- Any verification command fails twice after a focused fix attempt.

## Maintenance notes

Issue #130 will use the live core `EditLock` collision for deny; do not make
Reservation radius blocking here. Issue #131 will surface Reservations in the
Owner dashboard; keep the protocol shape compact and queryable so the dashboard
can render without recomputing graph scope. Reviewers should scrutinize expiry
and push clearing because stale Reservations would make future warnings noisy.
