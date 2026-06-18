# Plan 056: Resolution mediator — deterministic proposal + two-phase happy path (tracer)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> STOP condition occurs, stop and report — do not improvise. This is a
> cross-cutting tracer; build it in the step order given (protocol types →
> conflict-engine → server mediator → wiring → MCP surface → verifier), keeping
> the tree compiling between steps. When done, update the status row for this
> plan in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat e1b420b..HEAD -- packages/protocol/src/index.ts packages/protocol/src/wire-schema.ts apps/server/src/index.ts apps/server/src/state.ts packages/conflict-engine/src/index.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts below against the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED-HIGH (cross-cutting tracer: new protocol types + state machine + delivery surface)
- **Depends on**: none buildable (builds on already-merged plan 036 atomic intent round-trip).
- **Category**: direction (feature)
- **Planned at**: commit `e1b420b`, 2026-06-17
- **Issue**: https://github.com/Kumario1/synapse/issues/110 (parent PRD #109; ADR `docs/adr/0002-llm-resolution-mediator-suggest-only.md`)
- **Executed**: PR #122 on `feat/mediator-tracer`; CI green after verifier/index updates.

## Why this matters

Synapse today **detects** a contested symbol (two live agents editing the same
symbol) and **warns**, but resolution is fully manual. This tracer builds the
end-to-end spine of a **resolution mediator** — **with no LLM** (directions are
deterministic/templated) — so a contested symbol produces a coordinated
**proposal**, both agents receive a scoped **Direction**, and the conflict is
marked **resolved** only when **both** accept. It is suggest-only: Synapse never
edits code, never kicks, never changes a detection verdict. Later slices add
reject/timeout (#111), semantic classification (#112), and the LLM layer (#113).

**Scope guard for THIS slice**: mechanical (both-satisfiable) collisions and the
**both-accept happy path only**. No reject, no timeout, no semantic split, no LLM.

## Current state (the facts this tracer builds on)

- **The contested moment already exists (plan 036).** In
  `apps/server/src/index.ts` `handleMessage`, when a session sends `edit.intent`,
  the server applies it (creating the session's edit lock) then computes peer
  locks and ships them on the ack (lines ~535-547):
  ```ts
  const ackLocks =
    message.type === "edit.intent"
      ? peerLocksForIntent(state, message.payload.sessionId, message.payload.symbolId.raw, Date.now())
      : undefined;
  sendAck(socket, { forId: message.id, ok: true, ...(ackLocks ? { locks: ackLocks } : {}) });
  if (ops.length > 0) { broadcastStateChange(repoId, state, ops); fanout?.publish(repoId); }
  ```
  `peerLocksForIntent(state, selfSessionId, symbolRaw, now)` (`apps/server/src/state.ts`)
  returns the **other** sessions' live locks on that symbol. **`ackLocks.length > 0`
  is exactly the contested moment** — the mediator's trigger. No new detection path.
- **The before/after signatures and affected call-sites are ALREADY in server
  state.** `packages/protocol/src/index.ts` `ContractDelta` (lines ~135-149) has
  `before: Signature | null`, `after: Signature | null`, and
  `dependents: SymbolId[]` (the downstream call-sites, computed daemon-side via
  `apps/cli/src/analysis.ts` when the daemon reported the delta). These deltas live
  in `TeamState.unpushedDeltas`. So a **server-hosted** mediator reads everything it
  needs from state — **no `edit.intent` wire change, no source-tree access on the
  server.** The "keep" side is the session whose reported delta changed the
  contract; the "adapt" side is the contesting `edit.intent` sender, whose
  affected call-sites = the keep delta's `dependents`.
- `TeamState` (`packages/protocol/src/index.ts:374-387`) currently has
  `sessions, editLocks, unpushedDeltas, recentPushes, recentRepoEvents, resolutions,
  sessionSummaries, conflictFeedback`. You add `resolutionProposals: ResolutionProposal[]`.
  `createEmptyTeamState` (find it in `packages/protocol/src/index.ts` — it builds the
  empty arrays) must initialize it to `[]`.
- `ContractResolution`/`ProposedResolution` (`index.ts:235-261`) and the
  `resolution.propose` client message (`wire-schema.ts:280-284`) are the **shape to
  mirror** for the new types/message — read them.
- The client/server wire unions are `clientMessageSchema` (discriminated on `type`,
  `wire-schema.ts:~200-300`) and `serverMessageSchema` (state.snapshot / state.delta /
  ack, `wire-schema.ts:302-327`). `parseClientMessage` validates inbound. The
  `teamState` zod schema in `wire-schema.ts` must gain the new `resolutionProposals`
  field or snapshots will fail validation on the daemon.
- **Broadcast**: `broadcast(repoId, envelope("state.snapshot", { teamState, seq }))`
  and `broadcastStateChange(...)` are module-scope in `index.ts`. Because proposals
  are **transient and NOT persisted** (see below), the mediator broadcasts a fresh
  `state.snapshot` directly on change (do NOT add StateOps / the delta path).
- **Persistence: NONE for proposals.** `resolutionProposals` is transient
  coordination state (like a short-lived lock). Do NOT add a store table, a
  `StateStoreOps` method, an `ENTITY_TABLES` entry, or a `StateOp`. `load()` rebuilds
  only the persisted arrays; the new field defaults to `[]` from `createEmptyTeamState`.
- `packages/conflict-engine/src/index.ts` exports pure functions (`evaluateConflicts`,
  `symbolForFile(filePath): SymbolId`, etc.) and re-exports from sibling modules. The
  **deterministic call-site derivation** for this slice lives here as a new pure
  module + test (AC: "unit tests for call-site derivation in `packages/conflict-engine`").
- **MCP/daemon tool pattern** (`apps/cli/src/mcp.ts`): `server.registerTool("synapse_check", { description, inputSchema }, async (args) => jsonResult(await daemonPost(args.port ?? defaultPort, "synapse_check", request)))`. Tools proxy to a daemon HTTP endpoint. The daemon keeps a local mirror of room `TeamState` (it receives `state.snapshot`) and can send client messages over its socket.
- **Verifier prior art**: `scripts/verify-atomic-intent.mjs` opens raw WebSockets,
  sends `edit.intent` envelopes, and asserts ack/broadcast payloads. The mediator
  verifier mirrors it — it proves the protocol end-to-end with raw sockets (it does
  NOT need the MCP tool).

## New types (add to `packages/protocol/src/index.ts`)

```ts
/** A downstream call-site that must be updated to match a contract change. */
export interface AffectedSite {
  symbolId: SymbolId;
  filePath: string;
}

export type ResolutionRole = "keep" | "adapt";

/** One side's scoped direction in a coordinated resolution. */
export interface Direction {
  sessionId: string;
  role: ResolutionRole;
  /** Templated, deterministic prose (NO LLM in this slice). */
  summary: string;
  /** For an "adapt" role: the call-sites to update. Empty for "keep". */
  affectedSites: AffectedSite[];
}

export type ResolutionProposalStatus = "resolving" | "resolved";

/**
 * A coordinated, two-phase proposal to resolve a contested symbol. Transient
 * (not persisted) — it lives in TeamState while a pair is being reconciled and
 * is broadcast in state.snapshot. Tracer scope: mechanical class + happy path.
 */
export interface ResolutionProposal {
  /** Deterministic id, stable for the same contested pair: see mediator. */
  id: string;
  repoId: string;
  symbol: SymbolId;
  conflictClass: "mechanical";
  before: Signature | null;
  after: Signature | null;
  status: ResolutionProposalStatus;
  /** One Direction per side (keep + adapt). */
  directions: Direction[];
  /** sessionIds that have accepted. status flips to "resolved" when both have. */
  acceptedBy: string[];
  createdAt: string;
}
```
Add `resolutionProposals: ResolutionProposal[]` to `TeamState` and `[]` to
`createEmptyTeamState`.

## New client message (add to `packages/protocol/src/wire-schema.ts`)

Add to `clientMessageSchema` (mirror the `session.end` entry):
```ts
z.looseObject({
  ...envelope,
  type: z.literal("resolution.ack"),
  payload: z.looseObject({
    repoId: z.string().min(1),
    sessionId: z.string().min(1),
    proposalId: z.string().min(1),
    accept: z.literal(true) // tracer: accept-only; reject is #111
  })
})
```
Add zod schemas for `affectedSite`, `direction`, `resolutionProposal` and include
`resolutionProposals: z.array(resolutionProposal)` in the `teamState` schema (so a
snapshot carrying proposals validates on the daemon). Match how `resolution`/
`contractResolution` schemas are defined in this file.

## Scope

**In scope** (create unless noted):
- `packages/protocol/src/index.ts` (modify — the new types + TeamState field + createEmptyTeamState)
- `packages/protocol/src/wire-schema.ts` (modify — resolution.ack message + the new zod schemas + teamState field)
- `packages/conflict-engine/src/mediator.ts` (create — pure deterministic proposal builder)
- `packages/conflict-engine/src/mediator.test.ts` (create — call-site derivation + builder tests)
- `packages/conflict-engine/src/index.ts` (modify — re-export the new module)
- `apps/server/src/mediator.ts` (create — `proposeOnContest` + `applyResolutionAck` over TeamState)
- `apps/server/src/mediator.test.ts` (create — propose-on-contest + both-accept→resolved)
- `apps/server/src/index.ts` (modify — trigger on contested edit.intent; handle resolution.ack; broadcast snapshot on change)
- `apps/server/src/state.ts` (modify — ONLY if applyMessage must accept `resolution.ack` without erroring; see Step 4)
- `apps/cli/src/mcp.ts` (modify — register `synapse_resolution` tool)
- `apps/cli/src/daemon.ts` + `apps/cli/src/http.ts` (modify — `/tools/synapse_resolution` endpoint reading the mirror + optionally sending resolution.ack) — match the existing `synapse_check` endpoint pattern; if this proves deeper than mirroring an existing tool, see the STOP condition.
- `scripts/verify-mediator.mjs` (create — end-to-end both-accept happy path)
- `package.json` (modify — add a `verify:mediator` script next to `verify:atomic-intent`)
- `README.md` (modify — short mediator note)

**Out of scope** (do NOT touch / do NOT build):
- Any LLM call, OpenRouter, or `apps/server/src/embeddings.ts` — directions are templated.
- Reject, timeout, escalation, or semantic classification (those are #111/#112).
- Persistence of proposals: NO store table / `StateStoreOps` / `ENTITY_TABLES` / `StateOp` / delta-apply changes.
- `authorized()`, the WS handshake, `handleGitHubWebhook`, the auth routes, the web app.
- Changing any detection verdict or the `evaluateConflicts` engine output.

## Commands you will need (from repo root /private/tmp/synapse-issue-110)

| Purpose | Command | Expected |
|---|---|---|
| Install (FIRST) | `npm install` | exit 0 |
| Build all | `npm run build` | exit 0 |
| Typecheck all | `npm run typecheck` | exit 0 |
| Test protocol | `npm test --workspace @synapse/protocol` | all pass |
| Test conflict-engine | `npm test --workspace @synapse/conflict-engine` | all pass |
| Test server | `npm test --workspace @synapse/server` | all pass |
| Mediator verifier | `npm run verify:mediator` | prints success, exit 0 |
| Lint | `npm run lint` | exit 0 |
| Format check | `npm run format:check` | exit 0 |

(The verifier needs a build first — `npm run build` then `npm run verify:mediator`, mirroring how `verify:atomic-intent` is run.)

## Steps

### Step 1: Protocol types + wire schema
Add the types above to `packages/protocol/src/index.ts`; add the `resolution.ack`
message + the `resolutionProposal`/`direction`/`affectedSite` zod schemas + the
`teamState.resolutionProposals` field to `wire-schema.ts`; add `resolutionProposals: []`
to `createEmptyTeamState`. If there is a protocol wire-schema round-trip test
(`wire-schema.test.ts`), add a case that a snapshot with a `resolutionProposals`
entry and a `resolution.ack` message both parse.
**Verify**: `npm run build --workspace @synapse/protocol` → 0; `npm test --workspace @synapse/protocol` → pass.

### Step 2: Deterministic builder in conflict-engine — `mediator.ts`
Pure functions, no I/O, no LLM:
```ts
import type { AffectedSite, ContractDelta, Direction, SymbolId } from "@synapse/protocol";
import { symbolForFile } from "./index.js"; // already exported

/** Call-sites a contesting side must update = the keep delta's dependents. */
export function affectedSitesFromDelta(keepDelta: ContractDelta): AffectedSite[] {
  return keepDelta.dependents.map((symbolId) => ({
    symbolId,
    filePath: filePathOf(symbolId)
  }));
}

/** The keep/adapt direction pair for a mechanical collision (templated prose). */
export function buildMechanicalDirections(
  keepSessionId: string,
  adaptSessionId: string,
  keepDelta: ContractDelta
): Direction[] {
  const sites = affectedSitesFromDelta(keepDelta);
  const symbol = keepDelta.symbolId.raw;
  return [
    { sessionId: keepSessionId, role: "keep", summary: `Keep your change to ${symbol}.`, affectedSites: [] },
    { sessionId: adaptSessionId, role: "adapt", summary: `Update ${sites.length} call-site(s) to match ${symbol}'s new signature.`, affectedSites: sites }
  ];
}
```
`filePathOf(symbolId)`: derive the file from the symbol id. A `SymbolId.raw` looks
like `ts:src/auth/token.ts#Foo.bar` (see fixtures in `analysis.test.ts` /
`scripts/verify-atomic-intent.mjs`). Reuse whatever the engine already uses to map
a symbol to a file; if `symbolForFile` is file→symbol (the inverse), write a tiny
`filePathOf` that splits `raw` on `:` and `#` to recover the path. Keep it pure.

`packages/conflict-engine/src/mediator.test.ts`: assert
`affectedSitesFromDelta` maps each `dependents` entry to an `AffectedSite` with the
right `filePath`; assert `buildMechanicalDirections` yields exactly one `keep`
(empty sites) and one `adapt` (sites = dependents) with the right sessionIds.
Re-export both from `packages/conflict-engine/src/index.ts`.
**Verify**: `npm test --workspace @synapse/conflict-engine` → pass (incl. the new tests).

### Step 3: Server mediator — `apps/server/src/mediator.ts`
Operates on an in-memory `TeamState`. No persistence.
```ts
import { randomUUID } from "node:crypto";
import type { ResolutionProposal, TeamState } from "@synapse/protocol";
import { buildMechanicalDirections } from "@synapse/conflict-engine";

/** Deterministic proposal id for a contested pair (stable, so we don't double-propose). */
export function proposalId(symbolRaw: string, keepSessionId: string, adaptSessionId: string): string {
  return `rp:${symbolRaw}:${keepSessionId}:${adaptSessionId}`;
}

/**
 * Called at the contested moment (an edit.intent revealed a peer lock). Finds the
 * keep-side delta in unpushedDeltas, builds a mechanical proposal, stores it in
 * state.resolutionProposals (idempotent on id), returns it — or null if there's no
 * keep-side delta to ground the proposal or one already exists.
 */
export function proposeOnContest(
  state: TeamState,
  symbolRaw: string,
  adaptSessionId: string,
  now: () => string = () => new Date().toISOString()
): ResolutionProposal | null {
  // keep side = the OTHER session that reported a contract delta on this symbol.
  const keepDelta = state.unpushedDeltas.find(
    (d) => d.symbolId.raw === symbolRaw && d.sessionId !== adaptSessionId
  );
  if (!keepDelta) return null;
  const id = proposalId(symbolRaw, keepDelta.sessionId, adaptSessionId);
  if (state.resolutionProposals.some((p) => p.id === id)) return null; // already proposing
  const proposal: ResolutionProposal = {
    id, repoId: state.repoId, symbol: keepDelta.symbolId, conflictClass: "mechanical",
    before: keepDelta.before, after: keepDelta.after, status: "resolving",
    directions: buildMechanicalDirections(keepDelta.sessionId, adaptSessionId, keepDelta),
    acceptedBy: [], createdAt: now()
  };
  state.resolutionProposals = [...state.resolutionProposals, proposal];
  return proposal;
}

/**
 * Record an accept. Flips status to "resolved" when every direction's session has
 * accepted. Returns true if the proposal changed (caller re-broadcasts).
 */
export function applyResolutionAck(state: TeamState, proposalId: string, sessionId: string): boolean {
  const proposal = state.resolutionProposals.find((p) => p.id === proposalId);
  if (!proposal || proposal.status === "resolved") return false;
  if (!proposal.directions.some((d) => d.sessionId === sessionId)) return false; // not a party
  if (proposal.acceptedBy.includes(sessionId)) return false;
  proposal.acceptedBy = [...proposal.acceptedBy, sessionId];
  const allAccepted = proposal.directions.every((d) => proposal.acceptedBy.includes(d.sessionId));
  if (allAccepted) proposal.status = "resolved";
  return true;
}
```
`apps/server/src/mediator.test.ts` (node:test): build a `TeamState` (use
`createEmptyTeamState` from `@synapse/protocol`) with a session-A delta on `sym` and
a session-B as the contesting side. Assert: `proposeOnContest` adds one `resolving`
proposal with a keep (A) + adapt (B) direction and the adapt sites = the delta's
dependents; a second call is idempotent (returns null, still one proposal); after
`applyResolutionAck(state, id, "A")` status stays `resolving`, and after
`applyResolutionAck(state, id, "B")` status becomes `resolved`; an ack from a
non-party returns false and changes nothing.
**Verify**: `npm run build --workspace @synapse/server` → 0; `npm test --workspace @synapse/server` → pass.

### Step 4: Wire into the server — `apps/server/src/index.ts` (+ `state.ts`)
- `resolution.ack` must be an accepted `ClientMessage`. In `state.ts` `applyMessage`,
  add `case "resolution.ack": return;` (a no-op in the state machine — the mediator
  handles it in index.ts; this just prevents an "unhandled type" error if the switch
  is exhaustive). If the switch already silently ignores unknown types, skip this.
- In `index.ts` `handleMessage`:
  - **Contested trigger**: in the `edit.intent` path, you already compute `ackLocks`.
    When `ackLocks && ackLocks.length > 0`, call `proposeOnContest(state, message.payload.symbolId.raw, message.payload.sessionId)` **inside the same `withRepo`** (so it mutates the authoritative in-memory state under the lock). If it returns a proposal, after sending the ack, `broadcast(repoId, envelope("state.snapshot", { teamState: state, seq: bumpRepoSeq(repoId) }))`.
  - **Ack handling**: when `message.type === "resolution.ack"`, run
    `const changed = await withRepo(repoId, async () => { const s = await getState(repoId); return applyResolutionAck(s, message.payload.proposalId, message.payload.sessionId); });`
    then `sendAck(socket, { forId: message.id, ok: true })`; if `changed`,
    `broadcast(repoId, envelope("state.snapshot", { teamState: <the state>, seq: bumpRepoSeq(repoId) }))`.
    (Capture the state from `withRepo` so you broadcast the post-ack snapshot.)
  - Keep these additive — do not disturb the existing apply/ack/broadcast flow for
    other message types.
**Verify**: `npm run build --workspace @synapse/server` → 0.

### Step 5: MCP/hook surface — `synapse_resolution`
The daemon already mirrors room `TeamState` and proxies tool calls. Add a
`synapse_resolution` tool that **surfaces** (never applies) the calling session's
pending Direction, and accepts it on request:
- `apps/cli/src/daemon.ts` / `http.ts`: add a `/tools/synapse_resolution` endpoint
  (mirror `/tools/synapse_check`). It reads the daemon's room-state mirror, finds the
  `resolutionProposal` whose `directions[].sessionId === <this session>` and
  `status === "resolving"`, and returns that `Direction` (+ proposalId, symbol,
  before/after). With `{ accept: true }` in the request, it ALSO sends a
  `resolution.ack { repoId, sessionId, proposalId, accept: true }` over the daemon
  socket (mirror however the daemon sends `edit.intent`).
- `apps/cli/src/mcp.ts`: `server.registerTool("synapse_resolution", { description: "Surface the pending resolution Direction for this session; pass accept:true to accept.", inputSchema: { /* optional accept:boolean, port:number */ } }, async (args) => jsonResult(await daemonPost(args.port ?? defaultPort, "synapse_resolution", { accept: args.accept === true })))`.
**Verify**: `npm run build --workspace @synapse/cli` → 0; `npm run typecheck` → 0.

### Step 6: End-to-end verifier — `scripts/verify-mediator.mjs`
Mirror `scripts/verify-atomic-intent.mjs` (raw WebSockets; the verifier proves the
protocol without the MCP tool). Sequence:
1. Boot the server (`apps/server/dist/index.js`) on a free port; wait for `/health`.
2. Open a socket for **alice** and **bob** (same `repoId`, e.g. `local`).
3. alice reports a `contract.delta` on a symbol (e.g. `ts:src/auth/token.ts#getUser`)
   with `before`/`after` signatures and `dependents: [<a call-site symbol>]`, and
   sends `edit.intent` on that symbol (so she holds the lock). Use the message
   shapes from `verify-atomic-intent.mjs` + the `contract.delta` schema.
4. bob sends `edit.intent` on the **same** symbol → contested. Read bob's ack:
   `payload.locks` is non-empty (alice's lock).
5. Read the broadcast `state.snapshot` until `resolutionProposals` has one entry with
   `status: "resolving"`, a `keep` direction for alice, and an `adapt` direction for
   bob whose `affectedSites` match the delta's `dependents`.
6. Send `resolution.ack` for alice, then bob. Read snapshots: assert the proposal's
   `status` becomes `resolved` after both acks (and stays `resolving` after only one).
7. Print a success line and exit 0; tear down child processes (copy the
   `stopChildren`/`freePort`/`openSocket`/`readUntil` helpers from the prior verifier).
Add `"verify:mediator": "npm run build && node scripts/verify-mediator.mjs"` to the
root `package.json` scripts (next to `verify:atomic-intent`).
**Verify**: `npm run verify:mediator` → prints success, exit 0.

### Step 7: Docs
`README.md`: a short "Resolution mediator (preview)" note — a contested symbol now
produces a deterministic, suggest-only coordinated proposal delivered to both agents;
it resolves only when both accept; no LLM, no auto-edit (cite ADR-0002). Note this is
the tracer (mechanical + happy path); reject/timeout/semantic/LLM land in later slices.
**Verify**: `npm run format:check` and `npm run lint` → 0.

## Done criteria (ALL must hold)

- [ ] `npm run build` exits 0 and `npm run typecheck` exits 0
- [ ] `npm test --workspace @synapse/protocol` / `@synapse/conflict-engine` / `@synapse/server` all pass, including the new conflict-engine call-site derivation tests and the server mediator tests (propose-on-contest, idempotent, both-accept→resolved, non-party ack ignored)
- [ ] `npm run verify:mediator` prints success and exits 0 (contested → resolving proposal with keep/adapt directions + call-site list; both ack → resolved)
- [ ] `npm run lint` exits 0 and `npm run format:check` exits 0
- [ ] `git grep -n "openrouter\|OpenRouter\|fetchCompletion\|llm" packages/conflict-engine/src/mediator.ts apps/server/src/mediator.ts` returns nothing (no LLM in this slice)
- [ ] No store table / `StateStoreOps` / `ENTITY_TABLES` / `StateOp` change (`git diff e1b420b..HEAD -- apps/server/src/store.ts apps/server/src/store-pg.ts` is empty)
- [ ] `authorized()` / WS handshake / `handleGitHubWebhook` / auth routes / web app unchanged
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 056 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows the listed files changed since `e1b420b` and the excerpts
  no longer match (especially the `edit.intent` ack/`peerLocksForIntent` flow, the
  `ContractDelta.dependents`/`before`/`after` fields, or the `TeamState` shape).
- `ContractDelta` does NOT carry `dependents` / `before` / `after` as described — the
  whole "server reads facts from state" premise depends on it. STOP and report.
- The daemon does NOT keep a room-state mirror or has no path to send a client
  message, so Step 5's `synapse_resolution` endpoint would require inventing daemon
  infrastructure — STOP and report (the verifier already proves the protocol via raw
  sockets; do not build a large daemon subsystem to satisfy the MCP surface).
- Making the proposal broadcast work appears to require adding a `StateOp` / the
  delta-apply path — it must not; broadcast a `state.snapshot` instead.
- A step's verification fails twice after a reasonable fix attempt.
- You find you must touch persistence, `evaluateConflicts`, an LLM, or any
  reject/timeout/semantic logic to make the happy path work.

## Maintenance notes

- **Tracer boundaries**: this slice is mechanical + both-accept only. #111 adds
  reject/timeout → void + Owner escalation (it will need a persisted or
  timer-tracked proposal and a `reject` ack variant — note `accept: z.literal(true)`
  is the seam to widen). #112 adds mechanical-vs-semantic classification (the
  `conflictClass` field is the seam). #113 adds the LLM adapt-edit prose (the
  `Direction.summary` is the seam — today templated, later LLM-augmented, still
  additive). #114 surfaces proposals in the Owner dashboard (reads
  `TeamState.resolutionProposals`).
- **Transient by design**: proposals are not persisted; a server restart drops
  in-flight `resolving` state and the next `edit.intent` re-proposes. If #111's
  timeout needs durability, that slice adds persistence deliberately.
- **Determinism**: every field on the proposal comes from server state
  (`unpushedDeltas`) — the LLM (later) only rephrases `Direction.summary`, never
  invents a signature or call-site. A reviewer should confirm no fact originates
  outside state.
- **Reviewer focus**: confirm the proposal is built under `withRepo` (no lost
  update), the snapshot is broadcast on both propose and resolve, and the
  `synapse_resolution` tool only *surfaces* (never edits/acks without `accept:true`).
