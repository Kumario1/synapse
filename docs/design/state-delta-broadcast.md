# Design: Incremental `state.delta` Broadcast (Decision D3)

> Status: PROPOSED — written per `plans/009-design-state-delta-broadcast.md`;
> awaiting owner review before any implementation plan is written.
> Ground truth: `main` @ `65bc8a3` (post PR #54), 2026-06-11. Every
> current-behavior claim below cites `file:line` at that commit.

## 0. Problem

Every mutation re-broadcasts the repo's **entire** `TeamState` to every
client in the room. There are five emit sites in `apps/server/src/index.ts`
— fan-out refresh (line 89), session join (line 300), message apply
(line 416), webhook repo event (line 491), webhook push (line 509) — all
sending `envelope("state.snapshot", { teamState })` through the
`broadcast()` primitive (lines 608–615), which serializes the full state
per client. Cost is O(state × clients × mutations); `plan-future.md` §2
finding #5 names it the scaling ceiling. The write side was fixed by
per-entity store ops (M8); this design fixes the broadcast side.

`state.delta` is already reserved in the wire union
(`packages/protocol/src/index.ts:644`) with a placeholder full-snapshot
payload, and the daemon already accepts the type
(`apps/cli/src/daemon.ts:197` treats it identically to a snapshot).
`git log -S 'state.delta' -- apps/server` is empty: the server has never
emitted it, so **changing the placeholder payload is not a wire break**.

## 1. Wire format — RECOMMENDED: per-entity ops (the M8 vocabulary)

```ts
// packages/protocol — replaces the placeholder at index.ts:644
| WireEnvelope<"state.delta", {
    repoId: string;
    seq: number;            // §2 — per-repo, monotonically increasing
    ops: StateOp[];         // ordered; apply in sequence
  }>

type StateOp =
  | { op: "upsertSession"; session: Session }
  | { op: "upsertEditLock"; lock: EditLock }
  | { op: "deleteEditLock"; sessionId: string; symbolRaw: string }
  | { op: "deleteEditLocksForSession"; sessionId: string }
  | { op: "upsertDelta"; delta: ContractDelta }
  | { op: "deleteDelta"; deltaId: string }
  | { op: "appendPush"; push: RecentPush; cap: number }
  | { op: "appendRepoEvent"; event: RecentRepoEvent; cap: number }
  | { op: "upsertResolution"; resolution: ContractResolution }
  | { op: "deleteResolution"; symbolRaw: string; inputsHash: string }
  | { op: "appendSummary"; summary: SessionSummary; cap: number }
  | { op: "appendFeedback"; feedback: ConflictFeedback; cap: number };
```

This is **exactly the `StateStoreOps` interface**
(`apps/server/src/store.ts:31–47`), which `applyMessage` already emits
alongside every in-memory mutation (M8: "applyMessage takes the store and
emits the matching store op alongside each in-memory mutation",
`plan-future.md` §6). The server gets deltas for free by teeing the ops it
already produces: give `applyMessage` a second `StateStoreOps` sink that
accumulates the ops for the current message, then broadcast them.

Why not the alternatives:

- **JSON-patch (RFC 6902)** — path-based patches against an object tree are
  brittle under array reordering (every `TeamState` collection is an
  array), can't express domain semantics like "replace prior summary for
  this session" (`store.ts:43`), and need a generic patch engine on the
  client that validates nothing. The ops vocabulary is already validated,
  already tested (`store.test.ts` parameterizes it over two backends), and
  already proven equivalent to the in-memory mutations by M8.
- **Entity-array replacement** (send the changed array whole) — simpler,
  but worst-case (e.g. `unpushedDeltas` on a busy repo) approaches snapshot
  size, and it still loses op semantics, so client caps/ordering must be
  re-derived. It saves nothing in implementation: the ops exist already.

The client applies each op to its local `teamState` with a small
`applyStateOp(state, op)` function in `@synapse/protocol` (shared, unit
tested against `applyMessage` for equivalence — see §8). Caps travel with
the append ops (as in `StateStoreOps`) so client and server trim
identically.

## 2. Ordering & loss detection — RECOMMENDED: per-repo seq, reconnect on gap

- The server keeps `seq: number` per repo **in memory only** (next to
  `roomClients`), incremented once per mutation; every `state.delta`
  carries it, and every `state.snapshot` carries the seq it was generated
  at (additive optional field on the snapshot payload).
- The client records `lastSeq` from the snapshot it receives on join
  (server sends one at session start — `apps/server/src/index.ts:300`).
  A delta with `seq === lastSeq + 1` applies; `seq <= lastSeq` is a
  duplicate and is dropped; `seq > lastSeq + 1` is a **gap**.
- **On gap: the daemon closes the socket and reconnects.** Reconnect
  already exists with backoff + jitter + outbox (M2,
  `apps/cli/src/daemon.ts:146–159`), and the reconnect's `session.start`
  gets a fresh snapshot (line 300) which resets `lastSeq`. No new wire
  message ("resync request") is needed; the recovery path is one that is
  already tested by `verify:reconnect`.
- **Server restart:** in-memory seq resets to 0, but a restart drops every
  socket, every client reconnects, and the fresh snapshot re-baselines
  them. A seq regression observed without a disconnect (impossible in this
  design, but cheap to detect) is treated as a gap.
- Within one socket, TCP/WS ordering makes reordering impossible; the only
  realistic gap sources are server-side send failures and bugs — which is
  why gap handling is "reconnect", not "buffer and hope".

## 3. Protocol bump — v2, min stays 1

- `PROTOCOL_VERSION` 1 → 2; `MIN_SUPPORTED_PROTOCOL_VERSION` stays 1
  (`packages/protocol/src/index.ts:7,14`).
- The handshake already records each socket's agreed dialect:
  `socketProtocol` (declared `apps/server/src/index.ts:242`, set at
  line 289 — the seam M15 built for exactly this). `broadcast()` gains a
  per-client decision: agreed ≥ 2 → send `state.delta`; agreed 1 (or
  pre-negotiation clients, which negotiate to 1 per
  `negotiateProtocolVersion`, `packages/protocol/src/index.ts:29`) → send
  `state.snapshot` exactly as today.
- Compatibility matrix:
  | client \ server | v1 server (today) | v2 server (this design) |
  |---|---|---|
  | v1 daemon (no announce / `&v=1`) | snapshots | snapshots (per-socket dialect 1) |
  | v2 daemon | announces v2, server max 1 → agreed 1 → snapshots; daemon's snapshot path unchanged | deltas + join snapshot |
  | out-of-range | 426 refusal (M15) | 426 refusal |
- Mixed rooms work per-socket: one broadcastable mutation produces one ops
  array, serialized once as a delta for v2 sockets and once as a snapshot
  for v1 sockets (serialize each variant at most once per broadcast, not
  per client).

## 4. Multi-instance (M9) — RECOMMENDED: phase 1 sends snapshots for remote mutations

The hard constraint: the Redis fan-out message carries **only the repoId**.
The subscriber callback re-reads the whole repo from the shared store and
re-broadcasts a snapshot (`apps/server/src/index.ts:79–90`); it never sees
the mutation, so it cannot relay ops it doesn't have.

- **Phase 1 (this design): locally-originated mutations broadcast deltas to
  the instance's own sockets; remote-originated changes keep broadcasting
  snapshots** (with the post-reload seq — see below). Correct because a
  snapshot is always a valid re-baseline (client replaces state and adopts
  its seq), and it changes nothing about the M9 invariants: the reload
  still happens under the per-repo `withRepo` mutex with dirty-marking
  (lines 80–86), and publishes still happen after `store.flush()` so a
  subscriber's re-read can never miss rows (the M9 publish-after-flush
  invariant, `plan-future.md` §6 M9 entry).
- Seq under multi-instance: each instance maintains its own per-repo seq,
  and a remote-triggered snapshot **bumps it** (snapshot seq = local seq +
  1 after reload). Clients of instance A only ever see A's seq stream, so
  monotonicity per socket is preserved; cross-instance global ordering is
  not promised (it isn't today either — each instance re-broadcasts
  independently).
- **Phase 2 (deferred, separate decision): include the serialized ops in
  the Redis publish** so remote instances relay deltas too. Rejected for
  phase 1 because it changes the Redis message contract, requires versioning
  that channel as well, and the single-instance + local-mutation case is
  where the broadcast amplification actually hurts today.
- Option (c) (diff old/new cache states to synthesize ops) is rejected:
  array diffing re-derives information the system already had, with
  correctness risk for zero saved work.

## 5. Client apply path

`apps/cli/src/daemon.ts:181–199` (post-PR-#52 it parses via
`parseServerMessage` and applies at line 197):

- `state.snapshot` → replace `teamState`, set `lastSeq = payload.seq ?? 0`,
  set `hasBaseline = true`.
- `state.delta` → if `!hasBaseline`, ignore (a delta cannot arrive before
  the join snapshot on the same socket, but a cheap guard beats an
  assumption); else gap-check per §2, then `ops.forEach(op =>
  applyStateOp(teamState, op))`.
- Reconnect: socket close clears `hasBaseline`; the M2 outbox/backoff path
  is untouched; the fresh `session.start` snapshot re-baselines.
- TTL semantics are unchanged: lock/session expiry is evaluated at read
  time against `acquiredAt + ttlSec`/`lastSeen` (the M9 decision — no
  TTL state in transit), so deltas need not carry expirations and the
  client's pruning behavior needs no changes.

## 6. Failure modes

| Failure | Behavior |
|---|---|
| Dropped/failed delta send → gap | client reconnects (§2); fresh snapshot re-baselines; `synapse_delta_resyncs_total` increments |
| Reordering within a socket | impossible over TCP/WS; seq check makes it loud (treated as gap) if a bug ever produces it |
| Server restart mid-stream | all sockets drop → reconnect → snapshot; in-memory seq reset is invisible to clients |
| Duplicate delivery | `seq <= lastSeq` dropped idempotently |
| Redis outage | fan-out degrades exactly as today (M9 path); local deltas unaffected; remote changes stall until Redis returns (existing behavior) |
| Client clock skew | irrelevant — ordering is seq-based, never time-based |
| Malformed delta from a hostile/buggy server | `parseServerMessage` (PR #52) validates server frames; the delta schema extends it; invalid frames are logged and dropped (existing behavior `daemon.ts:190–194`) |
| Kill switch | `SYNAPSE_DELTA_BROADCAST=0` (server) forces snapshot-only for all sockets, regardless of negotiated version |

## 7. Metrics & observability

Following the existing `metrics.count` idiom (`apps/server/src/index.ts`):

- server: `synapse_state_deltas_sent_total`,
  `synapse_state_snapshots_sent_total{reason="join"|"v1_socket"|"remote_change"|"kill_switch"}`,
  delta payload size histogram (vs. snapshot size — the headline win).
- daemon: `synapse_delta_applied_total`, `synapse_delta_resyncs_total`
  (gap-triggered reconnects), `synapse_delta_ignored_total{reason="duplicate"|"no_baseline"}`.

## 8. Verification plan

- **Unit (protocol):** property test that for every `ClientMessage`
  fixture, `applyMessage(state, msg)` and
  `ops.forEach(op => applyStateOp(stateCopy, op))` (ops captured from the
  same call) produce deep-equal states — the op stream is provably
  equivalent to the mutation. This is the load-bearing test.
- **`scripts/verify-delta-broadcast.mjs`** (style of
  `verify-protocol-compat.mjs`): one server, a v2 daemon and a v1-pinned
  client in the same room → v2 socket receives `state.delta` after a
  report (and only a join snapshot before it); the v1 socket receives only
  snapshots; both end with identical `/state`; a forced gap (test hook:
  drop one delta via an env-gated server fault injection, or synthesize by
  sending a doctored seq) makes the v2 daemon reconnect and converge;
  kill switch forces snapshots for everyone.
- **Multi-instance variant** (gated on `SYNAPSE_VERIFY_PG_URL` +
  `SYNAPSE_VERIFY_REDIS_URL`, SKIPs offline, style of
  `verify-multi-instance.mjs`): alice on instance A, bob on B; alice's
  report → A's sockets get a delta, B's sockets get a snapshot with a
  bumped seq; both daemons converge to the same state.
- Full regression: `verify:reconnect`, `verify:protocol-compat`,
  `verify:multi-instance` unchanged and green.

## 9. Rollout

1. **Plan A (protocol + server + client):** v2 bump, `StateOp` +
   `applyStateOp` + equivalence property test in `@synapse/protocol`;
   server op-tee + per-socket broadcast switch + seq; daemon apply path;
   `SYNAPSE_DELTA_BROADCAST=0` kill switch; `verify-delta-broadcast.mjs`.
   Single PR-sized, no migration (additive negotiation).
2. **Plan B (observability + soak):** size histograms, resync counters,
   README/protocol docs; run the two-agent demo + multi-instance verify in
   a loop to soak the gap path.
3. **Phase 2 (separate owner decision):** Redis op relay (§4) once
   delta traffic dominates and multi-instance deployments are real.

## 10. Open questions for the owner

1. Is per-socket dual serialization (one delta + one snapshot per
   broadcast in mixed rooms) acceptable until v1 clients age out, or
   should v1 support be dropped on a deadline (bump
   `MIN_SUPPORTED_PROTOCOL_VERSION` to 2 later)?
2. Phase 2 (Redis op relay): wait for real multi-instance usage, or build
   immediately after Plan A while the context is warm?
3. Should the join snapshot eventually become optional for v2 clients with
   a persisted local cache (a "resume from seq" handshake)? Deferred here —
   it adds server-side seq retention/replay complexity that nothing needs
   yet.
