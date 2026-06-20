# Plan 064: Surface live Reservations in the Owner dashboard

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 6ac5c4b..HEAD -- apps/web/src/derive.ts apps/web/src/derive.test.ts apps/web/src/panels.tsx apps/web/src/Dashboard.tsx apps/web/src/fixture.ts README.md apps/web/CONTEXT.md synapse-technical-spec.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/062-persist-session-reservations.md
- **Category**: direction
- **Planned at**: commit `6ac5c4b`, 2026-06-19
- **Issue**: https://github.com/Kumario1/synapse/issues/131

## Why this matters

Issue #131 asks for the human-visible counterpart to the agent-facing live
Reservation briefing. The protocol and server now persist per-session
Reservations from reported edits, but the Owner dashboard still shows only
current sessions, raw edit locks, mediator proposals, the flow graph, and the
ship trail. Owners need a read-only view of which active agent session has
reserved which root symbols and dependency-neighbor symbols, and that view must
clear when the live Room state clears or expires the Reservation.

## Current state

- `packages/protocol/src/index.ts` already defines `Reservation` and
  `TeamState.reservations`; no protocol or server change is needed.
- `apps/web/src/derive.ts` centralizes pure dashboard derivations such as active
  sessions, contested symbols, graph nodes, and mediator proposal groups.
- `apps/web/src/panels.tsx` contains the dashboard cards. Existing cards are
  read-only except for explicit Owner actions already passed as callbacks
  (`Kick`, winner choice).
- `apps/web/src/Dashboard.tsx` lays out the summary metrics and the live grid.
  It currently imports `CommitsPanel`, `OnlinePanel`, `ResolutionPanel`, and
  `SignalsPanel`.
- `apps/web/src/fixture.ts` already has a demo flow where Alice reports a
  contract delta and later pushes; every frame defaults `reservations` to `[]`.
- `apps/web/src/derive.test.ts` uses Node's built-in test runner and pure
  `TeamState` fixtures. It already covers active-session filtering for graph and
  contention.
- Documentation says the Owner dashboard shows sessions, edit locks, contested
  symbols, mediator proposals, and the ship trail, but it does not yet mention
  Reservations as a dashboard surface.

Relevant excerpts at `6ac5c4b`:

`apps/web/src/derive.ts:15-17`

```ts
export function activeSessions(state: TeamState) {
  return state.sessions.filter((session) => session.status !== "ended");
}
```

`apps/web/src/derive.ts:47-80`

```ts
export function deriveGraph(state: TeamState): FlowGraph {
  const sessions = activeSessions(state);
  const activeIds = new Set(sessions.map((session) => session.id));
  const contested = deriveContestedSymbols(state);
  const symbolSet = new Set<string>();
  ...
  return { sessions, symbols, edges };
}
```

`apps/web/src/Dashboard.tsx:60-65`

```tsx
<section className="grid gap-5 lg:grid-cols-2" aria-label="Synapse room dashboard">
  <OnlinePanel sessions={sessions} onKick={onKick} />
  <SignalsPanel state={snapshot.state} />
  <ResolutionPanel state={snapshot.state} onChooseWinner={onChooseWinner} />
  <FlowGraph state={snapshot.state} />
  <CommitsPanel pushes={snapshot.state.recentPushes} events={snapshot.state.recentRepoEvents} />
</section>
```

`apps/web/src/panels.tsx:84-130`

```tsx
export function SignalsPanel({ state }: { state: TeamState }) {
  const contested = deriveContestedSymbols(state);
  const sessions = new Map(state.sessions.map((session) => [session.id, session]));
  ...
  {state.editLocks.length === 0 ? (
    <PanelEmpty icon={LockKeyholeIcon} title="No active signals" description="No one is holding an edit lock right now." />
  ) : (
    <div className="flex flex-col gap-4">
      {state.editLocks.map((lock, index) => {
        const holder = sessions.get(lock.sessionId);
```

`apps/web/src/fixture.ts:135-152`

```ts
function state(step: number, patch: Partial<TeamState>): TeamState {
  return {
    repoId,
    editLocks: [],
    reservations: [],
    unpushedDeltas: [],
    recentPushes: [],
    recentRepoEvents: [],
    resolutions: [],
    resolutionProposals: [],
    sessionSummaries: [],
    conflictFeedback: [],
    ...patch,
```

`packages/protocol/src/index.ts:344-366`

```ts
/** Derived Reservation region carried by a reported edit. */
export interface ReservationSeed {
  /** Dependency graph radius used to derive `symbols`. */
  radius: number;
  /** Edited root symbol plus dependency-graph neighbors. */
  symbols: SymbolId[];
}

/** One edited root's contribution to a per-session Reservation. */
export interface ReservationRoot extends ReservationSeed {
  symbolId: SymbolId;
  filePath: string;
  acquiredAt: string;
  ttlSec: number;
}

/** Durable, queryable per-session region derived from reported edits. */
export interface Reservation {
  repoId: string;
  sessionId: string;
  radius: number;
  symbols: SymbolId[];
  roots: ReservationRoot[];
  updatedAt: string;
}
```

## Commands you will need

| Purpose        | Command                                                                                          | Expected on success                                 |
| -------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Install        | `npm ci`                                                                                         | exit 0                                              |
| Web tests      | `npm test --workspace @synapse/web`                                                              | exit 0; includes Reservation derivation/story tests |
| Web typecheck  | `npm run typecheck --workspace @synapse/web`                                                     | exit 0, no TS errors                                |
| Web build      | `npm run build --workspace @synapse/web`                                                         | exit 0                                              |
| Root build     | `npm run build`                                                                                  | exit 0                                              |
| Root typecheck | `npm run typecheck`                                                                              | exit 0                                              |
| Root tests     | `SYNAPSE_PYTHON_BASE=/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12 npm test` | exit 0                                              |
| Lint           | `npm run lint`                                                                                   | exit 0; warning-level findings may remain           |
| Format check   | `npm run format:check`                                                                           | exit 0                                              |
| Diff hygiene   | `git diff --check`                                                                               | no whitespace errors                                |

## Suggested executor toolkit

- Use `vercel-react-best-practices` if available when writing the React panel:
  derive display data during render or with the existing pure helpers, avoid new
  polling/fetching paths, and use `Map`/`Set` for repeated session and symbol
  lookups.

## Scope

**In scope**:

- `apps/web/src/derive.ts`
- `apps/web/src/derive.test.ts`
- `apps/web/src/panels.tsx`
- `apps/web/src/Dashboard.tsx`
- `apps/web/src/fixture.ts`
- `README.md`
- `apps/web/CONTEXT.md`
- `synapse-technical-spec.md`
- `plans/064-owner-dashboard-reservations.md`
- `plans/README.md`

**Out of scope**:

- Any `apps/server`, `apps/cli`, or `packages/protocol` behavior change.
  Reservation state already exists from issue #129.
- Any new Owner mutation, action button, WebSocket message, or authenticated HTTP
  route. This issue is read-only visibility only.
- Changing Reservation persistence, TTL pruning, push clearing, dependency-graph
  radius, or PreToolUse `deny` behavior.
- Reworking the dashboard's polling model. The existing `ProjectsDashboard`
  polling and live feed state updates should naturally refresh this panel.

## Git workflow

- Branch: `feat/131-owner-dashboard-reservations`
- Commit message: `feat(web): surface owner dashboard reservations`
- Keep one focused PR for issue #131.
- Do not push or merge until local gates pass.

## Steps

### Step 1: Add a pure active-Reservation dashboard derivation

In `apps/web/src/derive.ts`, import `Reservation` and `ReservationRoot` types
from `@synapse/protocol` and add a new exported view model plus derivation. The
helper should:

1. Reuse `activeSessions(state)` and build a `Map` of active session id to
   `Session`.
2. Iterate `state.reservations`.
3. Exclude reservations whose `sessionId` does not belong to an active session.
4. Exclude roots whose TTL has elapsed using `acquiredAt + ttlSec`. Accept an
   optional `now = Date.now()` parameter so tests are deterministic.
5. Exclude a reservation entirely when it has no unexpired roots.
6. Split display symbols into:
   - root symbols: each active root's `symbolId.raw`, deduped and sorted,
   - dependency neighbor symbols: `reservation.symbols` minus root symbols,
     deduped and sorted,
   - all symbols: root symbols followed by dependency neighbor symbols.
7. Return the active session, original reservation, active roots, symbol lists,
   and the next root TTL remaining in seconds.

Keep the function pure. Do not add React state or effects for this derivation.

**Verify**: `npm run typecheck --workspace @synapse/web` -> exit 0.

### Step 2: Test active, inactive, expired, and cleared Reservation behavior

In `apps/web/src/derive.test.ts`, import the new helper and add focused tests:

1. An active session with a Reservation containing root
   `src/api.ts#loadRoom` and neighbor `src/client.ts#renderRoom` returns one
   active region with root symbols and dependency neighbor symbols separated.
2. A Reservation for an ended session is excluded.
3. A Reservation whose only root TTL has elapsed is excluded.
4. The demo/live-grid story covers issue #131's "after push disappears"
   acceptance: import `demoFrames` from `apps/web/src/fixture.ts`, assert that
   the reporting/conflict frame with a Reservation returns one region, and the
   final pushed frame returns no regions.

Use the existing `baseState` object style in the file. Pass a fixed `now`
timestamp to the helper; do not assert against wall-clock time.

**Verify**: `npm test --workspace @synapse/web` -> exit 0, including the new
tests.

### Step 3: Populate the demo fixture with a Reservation that clears after push

In `apps/web/src/fixture.ts`, import the `Reservation` type. Add an
`aliceReservation` near `aliceDelta`:

- `sessionId: alice.id`
- `radius: 2`
- `symbols`: `src/room.ts#loadRoom` plus `src/sidebar.ts#renderRoom`
- one `roots` entry for `src/room.ts#loadRoom` with `filePath`, `acquiredAt`,
  `ttlSec`, `radius`, and the same symbol list
- `updatedAt` matching the report time

Add this Reservation to the frames where Alice has reported work and before the
final push. Leave the final pushed frame with `reservations: []` through the
default state builder. This makes the demo/live-grid story show the region while
held and disappear after push.

**Verify**: `npm test --workspace @synapse/web` -> exit 0.

### Step 4: Render a read-only Reservations panel in the dashboard

In `apps/web/src/panels.tsx`, add and export a `ReservationsPanel`:

- Use `deriveActiveReservations(state)` as the source of truth.
- Show a `Card` consistent with `SignalsPanel` and `ResolutionPanel`.
- Title: `Reservations`.
- Description should make clear these are reported edit regions, not Contracts.
- Badge count should be the number of active Reservation regions.
- Empty state should say no active Reservations are held.
- For each region, show the session label using the existing `labelFor`
  convention, radius, active root count, total symbol count, and next TTL
  remaining.
- Render roots under a `Held symbols` label and dependency neighbors under a
  `Dependency neighbors` label. If there are no dependency neighbors, show a
  muted `No dependency neighbors` line instead of omitting the section.
- Do not add any button, form, click handler, fetch, or mutation.

Use the existing Tailwind density and `Badge`/`Separator` patterns from
`SignalsPanel` rather than introducing a new styling system.

In `apps/web/src/Dashboard.tsx`, import `ReservationsPanel`, compute a
Reservation count with `deriveActiveReservations(snapshot.state)`, add a
summary metric labeled `Reservations`, and place the panel in the live grid near
`SignalsPanel`.

**Verify**:

- `npm run typecheck --workspace @synapse/web` -> exit 0.
- `npm run build --workspace @synapse/web` -> exit 0.

### Step 5: Update user-facing and architecture documentation

Update docs narrowly:

- `README.md`: in the Owner dashboard section, add live Reservations to the list
  of Room surfaces and state that the Reservations card is read-only and clears
  as persisted state clears after push or TTL expiry.
- `apps/web/CONTEXT.md`: add a glossary entry for **Reservation** distinct from
  **Contract delta** and **Edit lock**. Update **Live grid** so it no longer
  says "4-panel" if the dashboard now has another card.
- `synapse-technical-spec.md`: add the Owner dashboard read behavior to the
  ownership/browser boundary section. It should say the Owner read path surfaces
  persisted `TeamState.reservations` alongside sessions/locks/mediator state and
  does not add a browser mutation.

If a changelog exists, update it. If no changelog exists, do not create one.

**Verify**:

- `rg -n "4-panel|live Room .*edit locks, contested symbols, mediator proposals" README.md apps/web/CONTEXT.md synapse-technical-spec.md` -> no stale dashboard wording unless historically marked.
- `npm run format:check` -> exit 0.

### Step 6: Run local gates and close the plan

Run all commands listed in "Commands you will need". If `npm run lint` exits 0
with existing warnings, record that in the PR body; do not chase unrelated
warning cleanup.

Update `plans/README.md` row 064 to `DONE` only after all local gates pass.
Mention that #131 is read-only and intentionally excludes new Owner actions or
Reservation state changes.

**Verify**:

- `npm run build` -> exit 0.
- `npm run typecheck` -> exit 0.
- `SYNAPSE_PYTHON_BASE=/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12 npm test` -> exit 0.
- `npm run lint` -> exit 0.
- `npm run format:check` -> exit 0.
- `git diff --check` -> exit 0.

## Test plan

- New pure derivation tests in `apps/web/src/derive.test.ts` for:
  - active Reservation root/dependency display shape,
  - ended sessions excluded,
  - expired roots/reservations excluded,
  - demo frame with Reservation renders a region and final pushed frame clears.
- Existing web tests continue to pass.
- Web typecheck/build prove the new panel integrates with React and protocol
  types.
- Root build/typecheck/tests/lint/format/diff checks prove no monorepo gate
  regressed.

## Done criteria

- [ ] `deriveActiveReservations` (or equivalently named helper) exists and is
      exported from `apps/web/src/derive.ts`.
- [ ] `ReservationsPanel` exists, is imported by `Dashboard`, and renders a
      read-only card with held symbols and dependency neighbors.
- [ ] The dashboard shows only active sessions' non-expired Reservations.
- [ ] Demo frames include a Reservation before push and no Reservation after
      push.
- [ ] `README.md`, `apps/web/CONTEXT.md`, and `synapse-technical-spec.md` are
      updated for the Owner Reservations surface.
- [ ] No `apps/server`, `apps/cli`, or `packages/protocol` files are modified.
- [ ] All commands in Step 6 exit 0.
- [ ] `plans/README.md` status row 064 is `DONE`.

## STOP conditions

Stop and report back if:

- The live code no longer has `TeamState.reservations` in `@synapse/protocol`;
  this plan depends on issue #129's persisted Reservation state.
- The dashboard has moved away from `Dashboard.tsx` + `panels.tsx` + pure
  `derive.ts` helpers, making the current excerpts stale.
- Satisfying the issue appears to require changing server persistence, protocol
  schemas, Owner auth routes, or daemon behavior.
- A verification command fails twice after a focused fix attempt.

## Maintenance notes

The panel intentionally trusts `TeamState.reservations` as the canonical live
state and only applies client-side active-session/TTL filtering for display
correctness between polls. If the server later changes Reservation semantics
(for example multiple independent per-root records instead of one per session),
review `deriveActiveReservations` first. Reviewer focus should be on read-only
scope, active-session filtering, deterministic tests, and avoiding confusion
between Reservations, edit locks, and contract deltas in the UI copy.
