# Plan 036: Make `synapse_check` register intent and read peer locks in one atomic server round-trip

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 27f5bb7..HEAD -- packages/protocol/src/index.ts packages/protocol/src/wire-schema.ts packages/protocol/src/wire-schema.test.ts apps/server/src/index.ts apps/server/src/state.ts apps/cli/src/daemon.ts packages/conflict-engine/src/index.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch that affects the cited lines, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: none (builds on already-merged plan 028 — protocol v2 `state.delta`/seq machinery — and plan 032 — edit-lock liveness/TTL; both on `main`)
- **Category**: tech-debt / correctness (concurrency)
- **Planned at**: commit `27f5bb7`, 2026-06-15

## Why this matters

When two sessions edit the same symbol at the same time, Synapse's pre-edit
warning depends on **ordering**: the first editor must save (PostToolUse →
`synapse_report` → `contract.delta`) before the second's pre-edit
`synapse_check` can see anything. README's "Gotchas" section says this outright
(`README.md:156`). There is a second, faster signal — the edit-intent lock
emitted at check time (`daemon.ts:459-466` → server `edit.intent` →
`same_symbol_active`) — but it has a **time-of-check-to-time-of-use race**: the
daemon sends `edit.intent` *fire-and-forget* and then immediately evaluates
conflicts against its **local** `teamState` mirror, which does not yet reflect
its own just-sent intent nor a concurrent peer's intent still in flight over the
wire. So two genuinely simultaneous checks can each miss the other.

This plan closes the client-side gap by making `synapse_check` **register the
session's intent AND read back the authoritative peer locks for the checked
symbol in a single server round-trip**, before evaluating. The server is already
the single writer (it serializes every message per repo via `withRepo` and
Node's single-threaded apply), so it linearizes concurrent checks: whichever
intent the server applies second sees the first's lock in its ack. The blind
window collapses from "check → save+report" down to "both intents in flight to
the server at the same instant" — and at least the later arrival always warns.

This preserves the "agents query, humans decide" principle (the hook still
defaults to `ask`, never `deny`) and never blocks an edit: if the round-trip
times out or the server is unreachable, the check silently falls back to today's
local-mirror evaluation.

## Current state

Relevant files (each with its role):

- `packages/protocol/src/index.ts` — wire type unions. The `ack` server message
  is `{ forId; ok; error? }` (no locks).
- `packages/protocol/src/wire-schema.ts` — Zod validation for the wire. The ack
  payload schema (a `looseObject`) mirrors the type union.
- `packages/protocol/src/wire-schema.test.ts` — round-trip validation tests for
  the wire schemas (pattern to follow for the new ack field).
- `apps/server/src/index.ts` — `handleMessage` applies a client message inside
  `withRepo`, then `sendAck`. `sendAck` is a **targeted single-socket reply**
  correlated to the client message's envelope `id` via `forId` — this is the
  request/reply primitive we reuse.
- `apps/server/src/state.ts` — `applyMessage`'s `edit.intent` case upserts the
  lock (`ttlSec: 90`). No change needed here.
- `apps/cli/src/daemon.ts` — `startDaemon`: maintains the local `teamState`
  mirror from seq-ordered broadcasts, has a fire-and-forget `sendToServer`, and
  the `/tools/synapse_check` handler that sends intent then evaluates.
- `packages/conflict-engine/src/index.ts` — `evaluateConflicts` reads
  `context.state.editLocks` and emits `same_symbol_active` for any **peer**
  lock (it already skips `lock.sessionId === selfSessionId`). **No change
  needed** — the whole point is to feed it the authoritative locks.

### Excerpts as they exist today

**`packages/protocol/src/index.ts:762-765`** — server message union:

```ts
export type ServerMessage =
  | WireEnvelope<"state.snapshot", { teamState: TeamState; seq?: number }>
  | WireEnvelope<"state.delta", { repoId: string; seq: number; ops: StateOp[] }>
  | WireEnvelope<"ack", { forId: string; ok: boolean; error?: string }>;
```

`EditLock` is already declared and exported in this file (`index.ts:290-296`):

```ts
export interface EditLock {
  sessionId: string;
  symbolId: SymbolId;
  filePath: string;
  acquiredAt: string;
  ttlSec: number;
}
```

**`packages/protocol/src/wire-schema.ts:317-326`** — ack payload schema:

```ts
  z.looseObject({
    ...envelope,
    type: z.literal("ack"),
    payload: z.looseObject({
      forId: z.string().min(1),
      ok: z.boolean(),
      error: z.string().optional()
    })
  })
```

The `editLock` Zod schema already exists at `wire-schema.ts:120-126` (reuse it).

**`apps/server/src/index.ts:419-435`** — apply + ack + broadcast:

```ts
    const repoId = messageRepoId ?? fallbackRepoId;
    const startedAt = performance.now();
    const ops: StateOp[] = [];
    const state = await withRepo(repoId, async () => {
      const current = await getState(repoId);
      applyMessage(current, repoId, message, teeStateStoreOps(ops));
      return current;
    });
    metrics.count("synapse_messages_total", { type: message.type });
    metrics.observe("synapse_message_apply_ms", performance.now() - startedAt);
    indexMemory(repoId, message);
    log.debug("message.applied", { type: message.type, repoId, sessions: state.sessions.length });
    sendAck(socket, { forId: message.id, ok: true });
    if (ops.length > 0) {
      broadcastStateChange(repoId, state, ops);
      fanout?.publish(repoId);
    }
```

**`apps/server/src/index.ts:649-654`** — `sendAck` (payload type is derived from
the `ServerMessage` ack member, so widening that type automatically widens this):

```ts
function sendAck(
  socket: WebSocket,
  payload: Extract<ServerMessage, WireEnvelope<"ack">>["payload"]
): void {
  send(socket, envelope("ack", payload, socketVersion(socket)));
}
```

**`apps/cli/src/daemon.ts:125-143`** — fire-and-forget transport:

```ts
  const outbox: ClientMessage[] = [];
  const OUTBOX_CAP = 500;
  const sendToServer = (type: ClientMessage["type"], payload: unknown): void => {
    const message = envelope(type, payload);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      if (type === "session.heartbeat") {
        return;
      }
      outbox.push(message);
      metrics.count("synapse_outbox_enqueued_total", { type });
      log.debug("outbox.enqueued", { type, queued: outbox.length });
      if (outbox.length > OUTBOX_CAP) {
        outbox.shift();
        metrics.count("synapse_outbox_dropped_total");
        log.warn("outbox.dropped_oldest", { cap: OUTBOX_CAP });
      }
      return;
    }

    socket.send(JSON.stringify(message));
  };
```

**`apps/cli/src/daemon.ts:206-250`** — the receive loop currently handles only
`state.snapshot` and `state.delta`; **`ack` frames are silently ignored**:

```ts
    socket.on("message", (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        log.warn("ws.invalid_frame", { error: "invalid_json" });
        return;
      }

      const parsed = parseServerMessage(raw);
      if (!parsed.ok) {
        log.warn("ws.invalid_frame", { error: parsed.error });
        return;
      }

      const message = parsed.message;
      if (message.type === "state.snapshot") {
        teamState = message.payload.teamState;
        hasStateBaseline = true;
        lastStateSeq = message.payload.seq ?? 0;
      } else if (message.type === "state.delta") {
        // ... seq-ordered op application ...
      }
    });
```

**`apps/cli/src/daemon.ts:454-474`** — the check handler we are changing:

```ts
      if (request.method === "POST" && url.pathname === "/tools/synapse_check") {
        const checkStartedAt = performance.now();
        const body = (await readJson(request)) as Partial<SynapseCheckRequest>;
        const targets = await resolveCheckTargets(config, body, analysisCache);

        for (const target of targets) {
          sendToServer("edit.intent", {
            repoId: config.repoId,
            sessionId: config.sessionId,
            symbolId: target.symbolId,
            filePath: target.filePath
          });
        }

        const { graph, neighborsOf } = await buildDependencyGraph(config, analysisCache);
        const rawConflicts = evaluateConflicts({
          selfSessionId: config.sessionId,
          targets,
          state: teamState,
          graph
        });
```

(`checkStartedAt` is observed later as `synapse_check_duration_ms` at
`daemon.ts:502`, and the comment at `daemon.ts:500-501` states that metric is
meant to measure **only the deterministic hot path** — the new round-trip must
be excluded from it; Step 4 handles that.)

`resolveCheckTargets` returns `ConflictTarget[]` where each target is
`{ filePath: string; symbolId: SymbolId; selfSignature?: Signature }`
(`apps/cli/src/analysis.ts:112-146`).

### Conventions to match

- **Wire changes are additive and backward-compatible.** Schemas use
  `z.looseObject` and protocol negotiation already exists (plan M15). Adding an
  **optional** field to the ack does **not** require a `PROTOCOL_VERSION` bump:
  old servers omit `locks` (daemon treats absent as "fall back to local"), old
  daemons ignore acks entirely. See `028-implement-state-delta-broadcast-v2.md`
  for how a *breaking* wire change is gated by version — this plan is explicitly
  the non-breaking kind.
- **A hook/check must never block or fail the edit** (`hooks.ts:146-151`,
  `daemon.ts:189-194`). Every new path needs a timeout and a silent fallback.
- Comment style: short rationale comments above non-obvious blocks, explaining
  *why* (see the existing comments around `sendToServer` and the receive loop).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build all | `npm run build` | exit 0 |
| Typecheck all | `npm run typecheck` | exit 0, no errors |
| Unit tests (all) | `npm test` | all pass |
| Protocol unit tests | `npm test --workspace @synapse/protocol` | all pass |
| Server unit tests | `npm test --workspace @synapse/server` | all pass |
| Wire compat verifier | `npm run verify:protocol-compat` | exit 0 |
| Delta broadcast verifier (regression) | `npm run verify:delta-broadcast` | exit 0 |
| New integration verifier (Step 6) | `npm run verify:atomic-intent` | exit 0 |

Run `npm run build` before any `verify:*` script — those scripts run the
compiled `dist/` output, not the TypeScript sources.

## Scope

**In scope** (the only files you should modify or create):

- `packages/protocol/src/index.ts` — widen the `ack` server message type.
- `packages/protocol/src/wire-schema.ts` — add optional `locks` to the ack
  payload schema.
- `packages/protocol/src/wire-schema.test.ts` — add an ack-with-locks round-trip
  test.
- `apps/server/src/index.ts` — compute and attach peer locks to the ack for
  `edit.intent` messages.
- `apps/server/src/state.test.ts` **or** a new `apps/server/src/intent-ack.test.ts`
  — unit test that an `edit.intent` ack carries peer locks and excludes self.
- `apps/cli/src/daemon.ts` — pending-ack registry, `requestIntent`, ack handling
  in the receive loop, check-handler integration, metrics.
- `scripts/verify-atomic-intent.mjs` (create) — two-daemon integration proof.
- `package.json` — add the `verify:atomic-intent` script entry.
- `plans/README.md` — status row.

**Out of scope** (do NOT touch, even though they look related):

- `packages/conflict-engine/src/index.ts` — the `same_symbol_active` rule
  already does exactly what we need. Feeding it authoritative locks is the whole
  fix; do not change rule logic or severities.
- `apps/server/src/state.ts` `applyMessage` `edit.intent` case — the lock upsert
  and `ttlSec: 90` stay as-is. You only *read* locks for the ack.
- `PROTOCOL_VERSION` / `MIN_SUPPORTED_PROTOCOL_VERSION` in
  `packages/protocol/src/index.ts` — must NOT change (this is an additive,
  negotiation-free wire change; see STOP conditions if you think it must).
- The fire-and-forget `sendToServer` semantics for every other message type
  (heartbeats, `contract.delta`, `session.*`, `push.notify`) — unchanged.
- The offline outbox behavior for non-check messages — unchanged.

## Git workflow

- Branch: `advisor/036-atomic-server-authoritative-check`.
- Commit per step or per logical unit. The repo uses Conventional Commits — e.g.
  `feat(protocol): carry peer edit locks on edit.intent ack`,
  `feat(daemon): await authoritative locks before evaluating check`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

Order matters: land the protocol widening first (compiles standalone), then the
server (producer), then the daemon (consumer), then tests. The tree stays green
between steps.

### Step 1: Widen the `ack` server message type to carry optional peer locks

In `packages/protocol/src/index.ts`, change the `ack` member of `ServerMessage`
(currently `index.ts:765`) to include an optional `locks` field:

```ts
  | WireEnvelope<"ack", { forId: string; ok: boolean; error?: string; locks?: EditLock[] }>;
```

`EditLock` is already declared in this file (`index.ts:290`), so no import is
needed. Because `sendAck`'s payload type on the server is
`Extract<ServerMessage, WireEnvelope<"ack">>["payload"]`, this single change
also widens the server's `sendAck` signature.

**Verify**: `npm run typecheck --workspace @synapse/protocol` → exit 0, no errors.

### Step 2: Add the optional `locks` field to the ack Zod schema

In `packages/protocol/src/wire-schema.ts`, extend the ack payload schema
(`wire-schema.ts:320-324`) to validate the new field, reusing the existing
`editLock` schema (`wire-schema.ts:120-126`):

```ts
    payload: z.looseObject({
      forId: z.string().min(1),
      ok: z.boolean(),
      error: z.string().optional(),
      locks: z.array(editLock).optional()
    })
```

**Verify**: `npm test --workspace @synapse/protocol` → all pass (existing tests
still green; the field is optional so nothing breaks yet).

### Step 3: Server — attach peer locks to the ack for `edit.intent`

In `apps/server/src/index.ts` `handleMessage`, after the `withRepo` apply and
before/at the success `sendAck` (`index.ts:422-431`), compute the authoritative
peer locks **for an `edit.intent` message only** and pass them to `sendAck`.

Target shape (place a small helper near the other module-local helpers, e.g.
beside `sendAck` at `index.ts:649`):

```ts
// Peer edit locks held on `symbol` right now (excludes the requesting session
// and expired leases). Returned on the edit.intent ack so the requester's check
// evaluates against server-authoritative state, not its async local mirror.
function peerLocksForIntent(
  state: TeamState,
  selfSessionId: string,
  symbolRaw: string,
  now: number
): EditLock[] {
  return state.editLocks.filter((lock) => {
    if (lock.sessionId === selfSessionId) {
      return false;
    }
    if (lock.symbolId.raw !== symbolRaw) {
      return false;
    }
    const acquiredAt = Date.parse(lock.acquiredAt);
    return Number.isNaN(acquiredAt) || now - acquiredAt <= lock.ttlSec * 1000;
  });
}
```

Then change the success-ack site (`index.ts:431`) from:

```ts
    sendAck(socket, { forId: message.id, ok: true });
```

to:

```ts
    const ackLocks =
      message.type === "edit.intent"
        ? peerLocksForIntent(
            state,
            message.payload.sessionId,
            message.payload.symbolId.raw,
            Date.now()
          )
        : undefined;
    sendAck(socket, { forId: message.id, ok: true, ...(ackLocks ? { locks: ackLocks } : {}) });
```

Notes for the executor:
- `state` returned from `withRepo` is the post-apply in-memory TeamState, so it
  already includes the just-applied intent lock. Reading peer locks here is the
  linearization point — any concurrent same-repo message is serialized by
  `withRepo`.
- Import `EditLock` and `TeamState` types from `@synapse/protocol` if not
  already imported in this file (check the existing import block near
  `index.ts:13-25`; `TeamState` is already imported, add `EditLock` if absent).
- The expiry filter mirrors `pruneExpiredLocks` in `apps/server/src/state.ts:167-178`
  — do not call that function here (it mutates); filter in the read instead.

**Verify**: `npm run typecheck --workspace @synapse/server` → exit 0. Then
`npm run build && npm run verify:delta-broadcast` → exit 0 (regression: existing
ack/broadcast flow still works).

### Step 4: Daemon — pending-ack registry and `requestIntent`

In `apps/cli/src/daemon.ts` `startDaemon`, add a request/reply layer over the
existing socket.

**4a.** Near the `outbox`/`sendToServer` declaration (`daemon.ts:123-143`), add a
pending-ack registry and a small shared sender so `requestIntent` can own the
envelope id:

```ts
  // Pending edit.intent round-trips, keyed by the envelope id we sent; resolved
  // when the server's correlated ack arrives (see the receive loop). A check
  // must never hang, so each waiter also has a timeout that resolves null →
  // caller falls back to the local mirror.
  const pendingAcks = new Map<string, { resolve: (locks: EditLock[] | null) => void; timer: NodeJS.Timeout }>();
  const INTENT_SYNC_MS = Number(process.env.SYNAPSE_INTENT_SYNC_MS ?? 150);

  const sendEnvelope = (message: ClientMessage): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      if (message.type === "session.heartbeat") {
        return false;
      }
      outbox.push(message);
      metrics.count("synapse_outbox_enqueued_total", { type: message.type });
      if (outbox.length > OUTBOX_CAP) {
        outbox.shift();
        metrics.count("synapse_outbox_dropped_total");
        log.warn("outbox.dropped_oldest", { cap: OUTBOX_CAP });
      }
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  };
```

Refactor `sendToServer` to delegate to `sendEnvelope` (preserve its current
signature and behavior exactly):

```ts
  const sendToServer = (type: ClientMessage["type"], payload: unknown): void => {
    sendEnvelope(envelope(type, payload));
  };
```

**4b.** Add `requestIntent` — sends one `edit.intent` and resolves with the
server's authoritative peer locks, or `null` on timeout/offline:

```ts
  // Send an edit.intent and wait (briefly) for the server's correlated ack to
  // come back with the authoritative peer locks for this symbol. Resolves null
  // if the socket is down or the ack does not arrive within INTENT_SYNC_MS — the
  // caller then evaluates against the local mirror, exactly as before. This is
  // what linearizes two simultaneous checks: the server applies intents in
  // order, so the later one's ack includes the earlier one's lock.
  const requestIntent = (payload: {
    repoId: string;
    sessionId: string;
    symbolId: SymbolId;
    filePath: string;
  }): Promise<EditLock[] | null> => {
    const message = envelope("edit.intent", payload);
    return new Promise<EditLock[] | null>((resolve) => {
      const open = sendEnvelope(message);
      if (!open) {
        resolve(null); // offline → enqueued for the team, but no sync read now
        return;
      }
      const timer = setTimeout(() => {
        if (pendingAcks.delete(message.id)) {
          metrics.count("synapse_intent_sync_timeouts_total");
          resolve(null);
        }
      }, INTENT_SYNC_MS);
      timer.unref?.();
      pendingAcks.set(message.id, { resolve, timer });
    });
  };
```

**4c.** In the receive loop (`daemon.ts:221-249`), add an `ack` branch that
resolves the matching waiter. Add it alongside the existing
`state.snapshot`/`state.delta` handling:

```ts
      const message = parsed.message;
      if (message.type === "ack") {
        const pending = pendingAcks.get(message.payload.forId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingAcks.delete(message.payload.forId);
          pending.resolve(message.payload.locks ?? []);
        }
        return;
      }
      if (message.type === "state.snapshot") {
        // ... unchanged ...
```

**4d.** In `socket.on("close")` (`daemon.ts:271-280`), drain pending waiters so
no check hangs across a disconnect — add at the top of the close handler:

```ts
      for (const [, pending] of pendingAcks) {
        clearTimeout(pending.timer);
        pending.resolve(null);
      }
      pendingAcks.clear();
```

Ensure `EditLock` and `SymbolId` are imported from `@synapse/protocol` at the
top of `daemon.ts` (check the existing import block; add whichever is missing).

**Verify**: `npm run typecheck --workspace @synapse/cli` → exit 0, no errors.

### Step 5: Daemon — use authoritative locks in the check handler

Replace the fire-and-forget intent loop in the check handler
(`daemon.ts:455-474`) with an awaited round-trip, then evaluate against a
**per-check augmented copy** of `teamState` (never mutate the long-lived mirror —
that would corrupt the seq-ordered delta application).

Change `const checkStartedAt` to `let checkStartedAt` and restructure:

```ts
      if (request.method === "POST" && url.pathname === "/tools/synapse_check") {
        let checkStartedAt = performance.now();
        const body = (await readJson(request)) as Partial<SynapseCheckRequest>;
        const targets = await resolveCheckTargets(config, body, analysisCache);

        // Register intent AND read back the server-authoritative peer locks in
        // one round-trip, so a simultaneous peer check cannot slip past us. Off
        // the deterministic latency budget: measure it separately and shift
        // checkStartedAt forward so synapse_check_duration_ms stays "hot path
        // only" (extract + graph + evaluate).
        const intentSyncStartedAt = performance.now();
        const lockResults = await Promise.all(
          targets.map((target) =>
            requestIntent({
              repoId: config.repoId,
              sessionId: config.sessionId,
              symbolId: target.symbolId,
              filePath: target.filePath
            })
          )
        );
        metrics.observe("synapse_intent_sync_ms", performance.now() - intentSyncStartedAt);
        checkStartedAt += performance.now() - intentSyncStartedAt;

        // Union the authoritative peer locks (null = timeout/offline → keep the
        // local mirror's view for that target) into a per-check state copy. The
        // engine de-dupes by (sessionId, symbol) via same_symbol_active, but we
        // also key the union to avoid duplicate lock rows.
        const authoritativeLocks = lockResults.flatMap((locks) => locks ?? []);
        const mergedLocks = unionLocks(teamState.editLocks, authoritativeLocks);
        const checkState = mergedLocks === teamState.editLocks
          ? teamState
          : { ...teamState, editLocks: mergedLocks };

        const { graph, neighborsOf } = await buildDependencyGraph(config, analysisCache);
        const rawConflicts = evaluateConflicts({
          selfSessionId: config.sessionId,
          targets,
          state: checkState,
          graph
        });
```

Leave the rest of the handler (branch-aware severity, adaptive severity, the
`synapse_check_duration_ms` observe at the old `:502`, enrichment, resolutions,
snapshot seeding, response) unchanged — it already reads from the `conflicts`
computed above.

Add a small module-local `unionLocks` helper (near the other daemon helpers, or
just above `startDaemon`), returning the original array unchanged when there is
nothing to add (so the common "no peer locks" path allocates nothing):

```ts
function unionLocks(base: EditLock[], extra: EditLock[]): EditLock[] {
  if (extra.length === 0) {
    return base;
  }
  const seen = new Set(base.map((lock) => `${lock.sessionId} ${lock.symbolId.raw}`));
  const merged = [...base];
  for (const lock of extra) {
    const key = `${lock.sessionId} ${lock.symbolId.raw}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(lock);
    }
  }
  return merged;
}
```

**Verify**: `npm run build` → exit 0. Then `npm run typecheck` → exit 0.

### Step 6: Tests

**6a. Protocol round-trip** — in `packages/protocol/src/wire-schema.test.ts`, add
a test (model it on the existing ack/server-message tests in that file) that a
server `ack` envelope carrying a `locks` array `parseServerMessage`s back with
the locks intact, and that an ack without `locks` still validates. Use a minimal
`EditLock` literal (`{ sessionId, symbolId: { raw, ... }, filePath, acquiredAt,
ttlSec }` — copy the `symbolId` shape from an existing test in the file).

**6b. Server intent ack** — add `apps/server/src/intent-ack.test.ts` (or extend
`apps/server/src/state.test.ts`), modeled on `state.test.ts`'s structure
(`apply...` then assert). Because `peerLocksForIntent` is currently module-local
in `index.ts`, either (a) export it from `index.ts` for direct unit testing, or
(b) assert the behavior through `applyMessage` + the same filter inline. Prefer
(a): export `peerLocksForIntent` and test:
  - returns a peer's lock on the same symbol,
  - excludes the requesting session's own lock,
  - excludes an expired lock (`acquiredAt` older than `ttlSec` seconds),
  - excludes a lock on a different symbol.

**6c. Two-daemon integration** — create `scripts/verify-atomic-intent.mjs`,
modeled closely on `scripts/verify-delta-broadcast.mjs` (same imports, port
helper, `startProcess`, `openSocket`, cleanup). It must prove the race is
closed:
  1. Start one server (`apps/server/dist/index.js`) on a free port.
  2. Open two raw client sockets in the same repo room, `sessionId` `alice` and
     `bob`, both protocol v2.
  3. Have `alice` send an `edit.intent` envelope for symbol
     `ts:src/widget.ts#area` and await her ack.
  4. **Without alice sending any `contract.delta`**, have `bob` send an
     `edit.intent` for the **same** symbol and await his ack.
  5. Assert bob's ack `payload.locks` contains a lock with `sessionId: "alice"`
     on `ts:src/widget.ts#area`. (Before this plan, bob would have to wait for
     alice's *report*; now her *intent* alone is visible in his ack.)
  6. Optionally assert alice's earlier ack `locks` is empty (she was first).

Construct envelopes with the same `envelope(...)` helper the other verifier
imports from the built protocol package, or inline a minimal
`{ v: 2, id, ts, type, payload }` object (copy the shape the delta verifier
sends). Exit non-zero on any failed assertion (use `node:assert/strict`, as the
sibling scripts do).

**6d.** Register the script in root `package.json` scripts, next to
`verify:delta-broadcast`:

```json
"verify:atomic-intent": "npm run build && node scripts/verify-atomic-intent.mjs",
```

**Verify**:
- `npm test --workspace @synapse/protocol` → all pass incl. the new ack test.
- `npm test --workspace @synapse/server` → all pass incl. the new intent-ack test.
- `npm run verify:atomic-intent` → exit 0.

## Test plan

- New unit tests: protocol ack-with-locks round-trip (6a); server
  `peerLocksForIntent` (6b: peer-included, self-excluded, expired-excluded,
  other-symbol-excluded).
- New integration test: `scripts/verify-atomic-intent.mjs` (6c) — two daemons,
  later intent sees earlier intent's lock with no intervening report.
- Structural patterns to follow: `apps/server/src/state.test.ts` for unit shape,
  `scripts/verify-delta-broadcast.mjs` for the multi-socket integration harness,
  `packages/protocol/src/wire-schema.test.ts` for wire round-trips.
- Regression: `npm run verify:delta-broadcast` and `npm run verify:protocol-compat`
  must still pass (the ack change is additive).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run build` exits 0
- [ ] `npm test` exits 0; new protocol + server tests exist and pass
- [ ] `npm run verify:atomic-intent` exits 0
- [ ] `npm run verify:delta-broadcast` exits 0 (regression)
- [ ] `npm run verify:protocol-compat` exits 0 (additive wire change)
- [ ] `grep -n "PROTOCOL_VERSION = " packages/protocol/src/index.ts` still shows `2` (no version bump)
- [ ] `grep -n "locks" packages/protocol/src/wire-schema.ts` shows the new optional ack field
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts (the
  in-scope files drifted since `27f5bb7`).
- `sendAck`'s payload type is no longer derived from the `ServerMessage` ack
  member (Step 1 would then not auto-widen the server signature) — report so the
  approach can be re-confirmed.
- You conclude a `PROTOCOL_VERSION` bump is actually required (e.g. a downstream
  parser rejects the optional `locks` field rather than ignoring it). The design
  intent is an additive, negotiation-free change; if that no longer holds, stop
  rather than bumping the version, because a bump ripples into negotiation,
  `verify:protocol-compat`, and v1 fallbacks.
- The integration verifier shows bob's ack does **not** contain alice's lock —
  that means the server is not reading post-apply state or `withRepo` no longer
  serializes; report rather than papering over it with a sleep/retry.
- A verification command fails twice after a reasonable fix attempt.
- The change appears to require editing `packages/conflict-engine/src/index.ts`
  or `apps/server/src/state.ts`'s `edit.intent` apply — both are out of scope.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- **Residual window**: this linearizes concurrent checks at the server, so the
  *later* arrival always sees the earlier lock. It does **not** make both sides
  see each other when their intents are genuinely in flight at the same instant —
  that's inherent to optimistic detection. Coordination still fires on the next
  check and at push (git). Do not advertise this as a mutex.
- **Latency**: `requestIntent` adds one synchronous round-trip to the pre-edit
  check, bounded by `SYNAPSE_INTENT_SYNC_MS` (default 150 ms). It is measured as
  `synapse_intent_sync_ms` and deliberately excluded from
  `synapse_check_duration_ms`. If a future change moves the deterministic
  measurement, preserve that exclusion. Watch `synapse_intent_sync_timeouts_total`
  in `/metrics` — a high rate means the server hop is too slow and checks are
  silently degrading to local-mirror eval.
- **Multi-instance**: with the `fanout` (plan 028) across server instances, two
  daemons may be connected to *different* server instances. This plan linearizes
  per-instance via `withRepo`; cross-instance simultaneity is still subject to
  fanout propagation. If true cross-instance linearization is needed later, that
  belongs to the coordination-channel design (plan 034), not here — note it
  there rather than expanding this plan.
- **Reviewer focus**: confirm the daemon never blocks on a missing ack (timeout
  + close-drain both resolve `null`), that `teamState` is never mutated by the
  check (per-check copy only), and that the ack `locks` are filtered for expiry
  server-side so a dead lease can't resurrect a `same_symbol_active` warning.
- **Deferred**: batching multiple targets into one `edit.intent`/ack round-trip
  (today it is one per target, awaited in parallel). Not worth it until checks
  routinely carry many symbols; revisit if `synapse_intent_sync_ms` p95 grows.
