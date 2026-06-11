# Plan 009: Write the design for incremental `state.delta` broadcast (decision D3)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c46a61..HEAD -- apps/server/src/index.ts apps/server/src/fanout.ts apps/cli/src/daemon.ts packages/protocol/src/index.ts`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> Known in-flight drift: plan 004 (daemon input hardening) was being executed
> in this worktree when this plan was written — it rewrites the daemon's
> `socket.on("message", …)` JSON parsing (excerpted below) to use
> `parseServerMessage` and shifts `apps/cli/src/daemon.ts` line numbers by
> roughly +14. The snapshot/delta apply line survives unchanged. Re-anchor by
> symbol/handler names, not line numbers; that specific change alone is NOT a
> STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (this plan produces a design document only — zero production code changes)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `8c46a61`, 2026-06-11

## Why this matters

Every mutation in the Synapse server re-broadcasts the repo's **entire**
`TeamState` to every connected client (`state.snapshot`). The roadmap
(`plan-future.md` §2 finding #5) names this the scaling ceiling: cost is
O(state × clients × mutations). The write side was fixed by per-entity store
ops (M8); the broadcast side is decision **D3** in `plan-future.md` §3 —
"incremental `state.delta` broadcast", explicitly *not started until
approved*. The owner has now approved designing it. Milestone M15 (protocol
negotiation, PR #44) was built specifically to make this change
backward-compatible: the server records an agreed protocol version per
socket, so v2 clients can receive deltas while v1 clients keep receiving
snapshots.

This plan's deliverable is a **design document**, not an implementation. The
design will be reviewed by the owner before an implementation plan is written.

## Current state

Read each of these before writing anything. All five broadcast sites send the
full state:

- `apps/server/src/index.ts` — the WS server. Broadcast sites at lines 89
  (fan-out refresh), 300 (session join), 416, 491, 509 (mutations/webhook/push).
  The broadcast primitive (lines 608–615):

  ```ts
  function broadcast<TType extends ServerMessage["type"]>(
    repoId: string,
    message: Extract<ServerMessage, WireEnvelope<TType>>
  ): void {
    for (const client of roomClients.get(repoId) ?? []) {
      send(client, message);
    }
  }
  ```

- `apps/server/src/index.ts:285–293` — the per-socket agreed dialect (the
  seam M15 left for exactly this design):

  ```ts
  const negotiated = negotiateProtocolVersion(announced === null ? undefined : Number(announced));
  // use its agreed dialect. Today there is exactly one dialect (v1), so this
  socketProtocol.set(socket, negotiated.ok ? negotiated.agreed : PROTOCOL_VERSION);
  ```

- `packages/protocol/src/index.ts:641–644` — `state.delta` is already
  reserved in the wire union, but its payload is currently a full snapshot
  (a placeholder, never sent by the server):

  ```ts
  export type ServerMessage =
    | WireEnvelope<"state.snapshot", { teamState: TeamState }>
    | WireEnvelope<"state.delta", { teamState: TeamState }>
    | WireEnvelope<"ack", { forId: string; ok: boolean; error?: string }>;
  ```

  `PROTOCOL_VERSION = 1` and `MIN_SUPPORTED_PROTOCOL_VERSION = 1` live at
  `packages/protocol/src/index.ts:7` and `:14`; `negotiateProtocolVersion`
  at `:29`.

- `apps/cli/src/daemon.ts:181–186` — the client treats `state.delta`
  identically to a snapshot (full replacement):

  ```ts
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as ServerMessage;
    if (message.type === "state.snapshot" || message.type === "state.delta") {
      teamState = message.payload.teamState;
    }
  });
  ```

- `apps/server/src/fanout.ts` (88 lines) + the subscriber callback in
  `apps/server/src/index.ts:78–92`: when a **remote** instance mutates a repo
  (Redis fan-out, M9), this instance only learns "repo X changed", re-reads
  the whole repo from the shared store under the per-repo mutex, and
  re-broadcasts a full snapshot. It does **not** know which mutation happened.
  Any delta design must answer how multi-instance deployments derive deltas.

- `apps/server/src/state.ts` — `applyMessage(state, repoId, message, store)`
  applies each `ClientMessage` to in-memory state and emits the matching
  per-entity store op (M8). The store-op vocabulary (`upsertSession`,
  `upsertEditLock`/`deleteEditLock`, `upsertDelta`, `appendPush`,
  `appendRepoEvent`, `appendSummary`, `upsertResolution`/`deleteResolution`,
  `appendFeedback`, …) is the natural candidate vocabulary for wire deltas —
  evaluate this in the design.

- Background docs in the repo root: `plan-future.md` §2 finding #5, §3 D3,
  §4 M15 entry, and the M9/M15 entries in §6 (execution log). Read them.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Confirm broadcast sites | `grep -n 'state.snapshot' apps/server/src/index.ts` | exactly 5 matches (lines ~89, 300, 416, 491, 509) |
| Confirm delta placeholder | `grep -n 'state.delta' packages/protocol/src/index.ts` | 1 match in the `ServerMessage` union |
| Confirm per-socket dialect | `grep -n 'socketProtocol' apps/server/src/index.ts` | map declared + set + read sites |
| Confirm no doc exists yet | `ls docs/design/ 2>/dev/null` | no `state-delta-broadcast.md` |

## Scope

**In scope** (the only file you create):
- `docs/design/state-delta-broadcast.md` (create `docs/design/` if absent)

**Out of scope** (do NOT touch):
- ALL source code. `packages/protocol`, `apps/server`, `apps/cli` — no edits,
  not even "harmless" type additions. The implementation happens in a future
  plan after the owner reviews this design.
- `plan-future.md` — the owner maintains it.

## Git workflow

- Branch: `advisor/009-design-state-delta-broadcast`
- One commit, conventional style, e.g. `docs(design): state.delta incremental broadcast (D3)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Read the listed code and docs

Read every file/line range in "Current state" plus `plan-future.md` §§2–6
(the M8/M9/M15 execution-log entries matter most). Do not skip this; the
design must cite real line numbers.

**Verify**: you can answer "why can't the fan-out subscriber broadcast a
delta today?" (answer: it only knows the repoId, not the mutation).

### Step 2: Write `docs/design/state-delta-broadcast.md`

The document MUST contain these sections, each answering the listed
questions concretely (choose one option and justify; do not list options
without choosing):

1. **Wire format** — the exact TypeScript type for the new `state.delta`
   payload. Evaluate: (a) per-entity ops mirroring the M8 store-op
   vocabulary vs. (b) JSON-patch vs. (c) entity-array replacement (send only
   the changed array, e.g. all `sessions`). Recommend one. The current
   placeholder payload `{ teamState: TeamState }` must be replaced; state
   explicitly that this is safe because the server has never emitted
   `state.delta` (verify with `git log -S 'state.delta' --oneline -- apps/server`).
2. **Ordering & loss detection** — per-repo monotonic sequence number on
   every `state.snapshot` and `state.delta`; client requests/receives a full
   snapshot when it observes a gap. Specify where the seq lives (server
   memory? store?), what happens on server restart, and the resync trigger.
3. **Protocol bump** — `PROTOCOL_VERSION` 1 → 2; `MIN_SUPPORTED_PROTOCOL_VERSION`
   stays 1. Sockets with agreed dialect 1 keep receiving `state.snapshot`
   (the `broadcast` function consults `socketProtocol` per client). Spell out
   the matrix: old daemon/new server, new daemon/old server, mixed rooms.
4. **Multi-instance (M9) interaction** — the hard problem. The Redis message
   today carries only the repoId. Choose and justify one of: (a) include the
   serialized mutation/ops in the Redis publish so remote instances can
   relay a delta; (b) remote-originated changes always fan out as snapshots
   (deltas only for locally-originated mutations) as a first phase; (c)
   derive a diff from old/new cache states. Address the per-repo mutex
   (`withRepo`) and the publish-after-flush invariant documented in
   `apps/server/src/index.ts:78–92` and `plan-future.md` §6 (M9 entry).
5. **Client apply path** — how `apps/cli/src/daemon.ts` applies a delta to
   `teamState`, including: deltas arriving before the post-`session.start`
   snapshot, interaction with the offline outbox/reconnect (a reconnect
   always begins with a fresh snapshot), and the TTL-pruning reads
   (locks/sessions are expiry-evaluated at read time, so deltas need not
   carry expirations).
6. **Failure modes** — enumerate at least: dropped delta (gap), reordered
   delivery within one socket (impossible over TCP/WS — say so), server
   restart mid-stream, client clock skew (irrelevant — seq not time), Redis
   outage (fan-out degraded → snapshots).
7. **Metrics & observability** — counters to add (e.g.
   `synapse_state_deltas_sent_total`, `synapse_delta_resyncs_total`),
   following the existing `metrics.count` style in `apps/server/src/index.ts`.
8. **Verification plan** — sketch `scripts/verify-delta-broadcast.mjs` in
   the style of the existing hermetic verifies (see `scripts/verify-protocol-compat.mjs`
   and `scripts/verify-multi-instance.mjs` for the two patterns): a v2
   daemon receives deltas not snapshots after join; a v1 client in the same
   room still receives snapshots; a forced gap triggers resync; the
   multi-instance variant (gated on `SYNAPSE_VERIFY_PG_URL`/`SYNAPSE_VERIFY_REDIS_URL`,
   SKIPs offline) shows a remote mutation reaching the other instance's client.
9. **Rollout** — env kill switch (`SYNAPSE_DELTA_BROADCAST=0` server-side,
   matching the repo's opt-out convention, e.g. `SYNAPSE_FILE_WATCHER=0`),
   and the implementation-plan breakdown (suggest 2–3 follow-up plans).
10. **Open questions for the owner** — anything genuinely unresolvable from
    the code; keep it short.

Every claim about current behavior must cite `file:line`.

**Verify**: `grep -c '^## ' docs/design/state-delta-broadcast.md` → ≥ 10.

### Step 3: Fact-check your own citations

For each `file:line` citation in the doc, re-open the file at that line and
confirm the claim.

**Verify**: `git status --porcelain` → only `docs/design/state-delta-broadcast.md`
(plus the `plans/README.md` status edit) listed.

## Test plan

No tests — documentation only. The "tests" are the verification greps above
and the citation fact-check in Step 3.

## Done criteria

- [ ] `docs/design/state-delta-broadcast.md` exists with all 10 required sections
- [ ] Every current-behavior claim carries a `file:line` citation that checks out
- [ ] A recommendation (not an options list) is stated in sections 1, 2, 3, 4
- [ ] `git status --porcelain` shows no modified source files
- [ ] `plans/README.md` status row for 009 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `packages/protocol/src/index.ts` or
  `apps/server/src/index.ts` changed and the excerpts above no longer match
  (someone may have started implementing D3 already).
- `git log -S 'state.delta' -- apps/server` shows the server has *emitted*
  `state.delta` at some point — the "placeholder, never sent" assumption is
  then false and the wire-format freedom in section 1 disappears.
- You find yourself editing any `.ts` file. This plan is documentation-only.

## Maintenance notes

- The design doc is the input to the D3 implementation plans; it should be
  reviewed by the owner before any of them are written.
- If plan 006 (publish live branch updates) or plan 007 (reduce check
  hot-path scans) land first, neither conflicts with this design — they sit
  on the daemon side — but re-check the broadcast-site line numbers.
- The placeholder `state.delta` union member means changing its payload type
  is *not* wire-breaking today; that stops being true the moment a server
  ships emitting it. The design should land before any experimentation.
