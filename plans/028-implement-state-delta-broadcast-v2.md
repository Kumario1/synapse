# Plan 028: Implement protocol v2 `state.delta` broadcast

> **Executor instructions**: Follow this plan step by step. This is a large
> direction plan; do not compress steps or skip verification. Stop on any STOP
> condition. Update this plan's row in `plans/README.md` when done unless your
> reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- docs/design/state-delta-broadcast.md packages/protocol/src/index.ts packages/protocol/src/wire-schema.ts packages/protocol/src/wire-schema.test.ts apps/server/src/index.ts apps/server/src/state.ts apps/server/src/store.ts apps/cli/src/daemon.ts scripts`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: 021
- **Category**: direction / perf
- **Planned at**: commit `e3c46f2`, 2026-06-12

## Why this matters

The server currently broadcasts full `state.snapshot` payloads after every
mutation. That makes each edit cost O(room clients times full TeamState size),
even when one lock or delta changed. Plan 009 produced a design for incremental
`state.delta`, and the wire union already reserves the name. This plan turns
that design into protocol v2 while keeping v1 clients on snapshots.

## Current state

Relevant files:

- `docs/design/state-delta-broadcast.md` - accepted design, currently
  `Status: PROPOSED`.
- `packages/protocol/src/index.ts` - `ServerMessage` still defines
  `state.delta` with `{ teamState: TeamState }`.
- `packages/protocol/src/wire-schema.ts` - validates current wire shape.
- `apps/server/src/index.ts` - broadcasts snapshots at message/webhook sites.
- `apps/server/src/state.ts` and `apps/server/src/store.ts` - mutation and
  store operation vocabulary.
- `apps/cli/src/daemon.ts` - receives server frames and maintains warm state.

Current snapshot sends:

```ts
// apps/server/src/index.ts:416
broadcast(repoId, envelope("state.snapshot", { teamState: state }));

// apps/server/src/index.ts:491 and :509
broadcast(repoEvent.repoId, envelope("state.snapshot", { teamState: state }));
broadcast(push.repoId, envelope("state.snapshot", { teamState: state }));
```

Current placeholder:

```ts
// packages/protocol/src/index.ts:685
export type ServerMessage =
  | WireEnvelope<"state.snapshot", { teamState: TeamState }>
  | WireEnvelope<"state.delta", { teamState: TeamState }>
```

The design says `state.delta` has never been emitted and can change shape when
protocol v2 lands.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | exit 0 |
| Protocol compat | `npm run verify:protocol-compat` | exit 0 |
| Reconnect | `npm run verify:reconnect` | exit 0 |
| Multi-instance | `npm run verify:multi-instance` | exit 0 if service deps available |
| New delta verify | `npm run verify:delta-broadcast` | exit 0 |

Use Node `20.19.x` or newer Node 20.

## Scope

**In scope**:

- `docs/design/state-delta-broadcast.md`
- `packages/protocol/src/index.ts`
- `packages/protocol/src/wire-schema.ts`
- protocol tests under `packages/protocol/src/`
- `apps/server/src/index.ts`
- `apps/server/src/state.ts`
- `apps/server/src/store.ts` only for shared operation types if needed
- `apps/cli/src/daemon.ts`
- `scripts/verify-delta-broadcast.mjs` (create)
- `package.json` and `README.md` for the new verifier script/docs

**Out of scope**:

- Replacing Redis fanout with deltas. The design keeps fanout reloads as
  snapshots.
- Changing persistence schema.
- Removing v1 snapshot compatibility.

## Git workflow

- Branch: `advisor/028-implement-state-delta-broadcast-v2`
- Commit style: `feat(protocol): broadcast incremental state deltas`.

## Steps

### Step 1: Finalize protocol v2 shape

Define a `StateOp` union in `packages/protocol/src/index.ts` that matches the
existing `StateStoreOps` vocabulary closely enough to patch in-memory
`TeamState`. Change `state.delta` to carry:

- `repoId`;
- `seq`;
- `ops: StateOp[]`.

Add optional `seq` to `state.snapshot` payloads for v2 clients. Bump protocol
version only as required by the existing negotiation model.

**Verify**: `npm run typecheck --workspace @synapse/protocol` -> exit 0.

### Step 2: Add schemas and patch tests

Update `wire-schema.ts` and tests for the new payloads. Add a shared
`applyStateOp(teamState, op)` helper in the protocol package or a server/CLI
shared place if that better matches existing imports.

Add tests that start from an empty state, apply a sequence of ops, and match
the expected snapshot.

**Verify**: `npm run build && npm test --workspace @synapse/protocol` -> exit 0.

### Step 3: Tee server mutations into ops

Update server mutation flow so each accepted message produces both:

- the existing in-memory state mutation;
- the matching `StateOp[]` for delta broadcast.

Do this with the smallest change that preserves `applyMessage()` semantics. If
you need to make `applyMessage()` return ops, keep store writes equivalent to
today.

**Verify**: `npm run typecheck --workspace @synapse/server` -> exit 0.

### Step 4: Broadcast per-client dialect

Track per-socket negotiated protocol version using existing handshake state.
For v2 clients, send `state.delta` with `seq` and ops after mutations. For v1
or unknown clients, keep sending full `state.snapshot`.

Snapshots remain mandatory on join/reconnect and after Redis fanout reloads.

**Verify**: `npm run verify:protocol-compat` -> exit 0.

### Step 5: Teach daemon delta apply and gap recovery

In `apps/cli/src/daemon.ts`, keep replacing state on snapshots. For deltas:

- ignore deltas before a baseline snapshot;
- if `seq` is exactly next expected, apply ops;
- if there is a gap, request/rely on a fresh snapshot using the existing
  reconnect or state path; do not apply out-of-order deltas blindly.

**Verify**: `npm run verify:reconnect` -> exit 0.

### Step 6: Add a verifier

Create `scripts/verify-delta-broadcast.mjs` and add `verify:delta-broadcast`
to `package.json` and README. The verifier should:

- start a server and two daemons/clients;
- negotiate a v2 client;
- perform one edit/report;
- assert the v2 peer receives a delta and converges to the same state as a
  snapshot;
- assert a v1/legacy path still receives snapshots.

**Verify**: `npm run verify:delta-broadcast` -> exit 0.

## Test plan

- Protocol schema tests for valid/invalid delta payloads.
- State op application tests.
- Protocol compatibility verifier for v1/v2 negotiation.
- Reconnect verifier for gap/snapshot recovery.
- New delta broadcast verifier.

## Done criteria

- [ ] `npm run check` exits 0.
- [ ] `npm run verify:protocol-compat` exits 0.
- [ ] `npm run verify:reconnect` exits 0.
- [ ] `npm run verify:delta-broadcast` exits 0.
- [ ] v1 clients still receive snapshots.
- [ ] v2 clients receive deltas after mutations and snapshots on join/resync.
- [ ] No persistence schema change is required.

## STOP conditions

Stop and report if:

- Implementing deltas requires changing persistence schema.
- Protocol negotiation cannot distinguish v1/v2 clients.
- Redis fanout cannot remain snapshot-based without correctness loss.
- The plan grows into a broad server architecture refactor.

## Maintenance notes

This plan is the implementation successor to plan 009. Reviewers should check
client convergence first, payload size second. A small but correct delta path
beats a larger refactor that makes reconnects fragile.
