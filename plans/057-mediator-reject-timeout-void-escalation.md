# Plan 057: Mediator — reject + timeout void path with Owner escalation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> STOP condition occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md` — unless a reviewer
> dispatched you and told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 0b3403c..HEAD -- apps/server/src/mediator.ts apps/server/src/index.ts apps/server/src/state.ts packages/protocol/src/index.ts packages/protocol/src/wire-schema.ts scripts/verify-mediator.mjs`
> If any changed since this plan was written, compare the "Current state"
> excerpts below against the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (two-phase commit safety — must never reach `resolved` with one ack)
- **Depends on**: plan 056 (DONE — merged as PR #122; the deterministic mediator tracer).
- **Category**: direction (feature)
- **Planned at**: commit `0b3403c`, 2026-06-17
- **Issue**: https://github.com/Kumario1/synapse/issues/111 (parent PRD #109; ADR-0002)

## Why this matters

#110 shipped the **happy path**: a contested symbol → a coordinated
`ResolutionProposal` → both accept → `resolved`. This slice adds the **unhappy
paths** that make the two-phase commit *safe*. A proposal is a coordinated pair —
correct only if **both** sides apply. If **either** session rejects, or the
proposal's **TTL** elapses before both ack, the mediator **voids** the whole pair,
the conflict reverts from `resolving` back to `contested`, and an **escalation** is
emitted to the Owner. A reject is recorded as conflict feedback. This guarantees a
cooperating side is never left adapted to a change the other side abandoned.

## Current state (what #110 landed — extend this)

- `apps/server/src/mediator.ts` (whole file, 81 lines) has:
  - `proposalId(symbolRaw, keepSessionId, adaptSessionId)` → `rp:${symbolRaw}:${keep}:${adapt}`.
  - `proposeOnContest(state, symbolRaw, adaptSessionId, now?)` → builds + stores a
    `resolving` proposal (idempotent on id), returns it or `null`.
  - `applyResolutionAck(state, proposalId, sessionId)` → records an accept; flips to
    `resolved` only when **every** direction's session has accepted; returns whether
    it changed. **It currently guards `proposal.status === "resolved"` → false** —
    you will widen that guard to also reject acks on a `voided` proposal.
- `packages/protocol/src/index.ts`:
  - `ResolutionProposalStatus = "resolving" | "resolved"` (line ~281) — you add `"voided"`.
  - `ResolutionProposal { id, repoId, symbol, conflictClass, before, after, status,
    directions, acceptedBy, createdAt }` (line ~288) — you add `voidReason?` (and an
    optional `voidedBy?`).
  - `TeamState.resolutionProposals?: ResolutionProposal[]` (line ~425);
    `createEmptyTeamState` sets `resolutionProposals: []` (line ~928).
  - `ConflictFeedbackOutcome = "acted" | "dismissed"` and `ConflictFeedback`
    (`{ id, repoId, conflictId, sessionId, memberId, outcome, note?, rule?, targetSymbol?, createdAt }`)
    — a **reject is recorded as `ConflictFeedback` with `outcome: "dismissed"`**.
- `packages/protocol/src/wire-schema.ts`:
  - The `resolution.ack` message payload is
    `{ repoId, sessionId, proposalId, accept: z.literal(true) }` — **widen `accept`
    to `z.boolean()`** (a `false` = reject).
  - The `resolutionProposal` zod schema's `status` enum and an optional `voidReason`
    must be updated to match the protocol type (or the daemon rejects snapshots
    carrying a voided proposal).
- `apps/server/src/index.ts` `handleMessage`:
  - The `resolution.ack` branch (lines ~527-556): under `withRepo`, calls
    `applyResolutionAck(current, proposalId, sessionId)`; on `changed`, broadcasts a
    `state.snapshot`. **You branch here on `message.payload.accept`** (true → accept,
    false → reject).
  - The `edit.intent` propose path (lines ~562-600): when peer locks exist it calls
    `proposeOnContest(...)` and broadcasts a snapshot if a proposal was created.
    **You add a TTL timer here** when a proposal is created.
  - `broadcast(repoId, envelope("state.snapshot", { teamState, seq: bumpRepoSeq(repoId) }))`,
    `withRepo`, `getState`, and the `store` are all module-scope in `index.ts`.
    `store.appendFeedback(repoId, feedback, cap)` persists conflict feedback.
- `apps/server/src/state.ts`: `addConflictFeedback(state, repoId, store, feedback)`
  (line ~528) is the in-memory+store append used by the `conflict.feedback` message
  (`CONFLICT_FEEDBACK_CAP = 100`). It is **not exported**. For the reject path, build
  the `ConflictFeedback` in the mediator and let `index.ts` apply it (push to
  `state.conflictFeedback` + `store.appendFeedback(repoId, feedback, 100)`), mirroring
  `addConflictFeedback` — do NOT route a synthetic `conflict.feedback` message.
- `scripts/verify-mediator.mjs` (the #110 happy-path verifier) opens raw sockets,
  sends `contract.delta` + `edit.intent` + `resolution.ack` envelopes, and reads
  `state.snapshot` broadcasts asserting proposal status transitions. It has helpers
  `contractDeltaEnvelope(id)`, `intentEnvelope(id, sessionId)`,
  `resolutionAckEnvelope(id, sessionId, proposalId)` and a `proposalFrom` reader.
  **You extend it** with a reject case and a timeout case (new symbol/pair per case
  so ids don't collide).

### Escalation = the voided proposal in the broadcast

"The existing channel" to the Owner is the room `TeamState` broadcast in
`state.snapshot` — the #106 dashboard polls `/auth/projects/state` which returns it.
So **the escalation IS the voided proposal**: a `ResolutionProposal` with
`status: "voided"` and `voidReason: "rejected" | "timeout"`, present in the broadcast
snapshot. The #114 dashboard renders voided proposals as Owner escalations. Do NOT
invent a separate `escalations[]` array — the voided proposal is the record.

### Conventions

- Tests: `node:test` + `node:assert/strict`. Server `npm test --workspace @synapse/server`
  (`tsc -b` then `node --test dist`). Extend `apps/server/src/mediator.test.ts`.
- TS strict, ESM, `.js` import specifiers (server/protocol). No new dependency.
- The mediator stays **pure** (operates on `TeamState`, no I/O); timers + store +
  broadcast live in `index.ts`.

## Commands you will need (from repo root /private/tmp/synapse-issue-111)

| Purpose | Command | Expected |
|---|---|---|
| Install (FIRST) | `npm install` | exit 0 |
| Build all | `npm run build` | exit 0 |
| Typecheck all | `npm run typecheck` | exit 0 |
| Test protocol | `npm test --workspace @synapse/protocol` | all pass |
| Test server | `npm test --workspace @synapse/server` | all pass |
| Mediator verifier | `npm run verify:mediator` | prints success, exit 0 |
| Lint | `npm run lint` | exit 0 |
| Format check | `npm run format:check` | exit 0 |

## Scope

**In scope** (modify unless noted):
- `packages/protocol/src/index.ts` (add `"voided"` to status; add `voidReason?`/`voidedBy?` to `ResolutionProposal`)
- `packages/protocol/src/wire-schema.ts` (widen `accept` to boolean; update `resolutionProposal` status enum + `voidReason`)
- `packages/protocol/src/wire-schema.test.ts` (if it pins the resolution.ack/proposal shape, update + add a reject/voided case)
- `apps/server/src/mediator.ts` (add `applyResolutionReject` + `voidOnTimeout`; tighten `applyResolutionAck` to only act on `resolving`)
- `apps/server/src/mediator.test.ts` (reject voids + feedback; timeout voids; no partial commit; ack on voided is a no-op)
- `apps/server/src/index.ts` (branch resolution.ack on accept; persist reject feedback; TTL timer on propose; clear timer on terminal)
- `scripts/verify-mediator.mjs` (add one-reject + timeout cases)
- `README.md` (extend the mediator note: reject/timeout → void + escalation)

**Out of scope** (do NOT touch):
- Semantic classification, the LLM layer (#112/#113), the dashboard rendering (#114).
- `proposeOnContest`'s proposal-building / `buildMechanicalDirections` (unchanged).
- Persistence of *proposals* (still transient); only the reject *feedback* persists
  (via the existing `appendFeedback`, which already exists — no new store table).
- `authorized()`, WS handshake, `handleGitHubWebhook`, auth routes, web app,
  `evaluateConflicts`.

## Steps

### Step 1: Protocol — voided status + widened ack
- `packages/protocol/src/index.ts`: `ResolutionProposalStatus = "resolving" | "resolved" | "voided"`. Add to `ResolutionProposal`:
  ```ts
  /** Why the pair was voided (reject or TTL). Absent until voided. */
  voidReason?: "rejected" | "timeout";
  /** The session whose reject voided the pair (reject only). */
  voidedBy?: string;
  ```
- `packages/protocol/src/wire-schema.ts`: in the `resolution.ack` payload change
  `accept: z.literal(true)` → `accept: z.boolean()`. In the `resolutionProposal`
  schema, set `status: z.enum(["resolving", "resolved", "voided"])` and add
  `voidReason: z.enum(["rejected", "timeout"]).optional()` and
  `voidedBy: z.string().optional()` (match the file's optional-field style).
- If `wire-schema.test.ts` asserts these shapes, update it and add a case that a
  `resolution.ack` with `accept: false` parses and a snapshot with a `voided`
  proposal parses.
**Verify**: `npm run build --workspace @synapse/protocol` → 0; `npm test --workspace @synapse/protocol` → pass.

### Step 2: Mediator — reject + timeout (pure)
In `apps/server/src/mediator.ts`:
- Tighten `applyResolutionAck`: change the early guard so it acts **only** when
  `proposal.status === "resolving"` (so an ack on a `voided` or `resolved` proposal
  is a no-op — this is the "no partial commit / can't resolve after void" guarantee).
- Add:
  ```ts
  import type { ConflictFeedback, ResolutionProposal, TeamState } from "@synapse/protocol";
  import { randomUUID } from "node:crypto";

  export interface RejectResult { changed: boolean; feedback?: ConflictFeedback; }

  /** A reject from either party voids the whole pair and records dismiss feedback. */
  export function applyResolutionReject(
    state: TeamState, proposalId: string, sessionId: string,
    now: () => string = () => new Date().toISOString()
  ): RejectResult {
    const proposal = state.resolutionProposals?.find((p) => p.id === proposalId);
    if (!proposal || proposal.status !== "resolving") return { changed: false };
    if (!proposal.directions.some((d) => d.sessionId === sessionId)) return { changed: false };
    proposal.status = "voided";
    proposal.voidReason = "rejected";
    proposal.voidedBy = sessionId;
    const feedback: ConflictFeedback = {
      id: randomUUID(), repoId: state.repoId, conflictId: proposal.id,
      sessionId, memberId: sessionId, outcome: "dismissed",
      targetSymbol: proposal.symbol, createdAt: now()
    };
    return { changed: true, feedback };
  }

  /** TTL elapsed before both acks → void. Returns whether it changed. */
  export function voidOnTimeout(
    state: TeamState, proposalId: string,
    now: () => string = () => new Date().toISOString()
  ): boolean {
    const proposal = state.resolutionProposals?.find((p) => p.id === proposalId);
    if (!proposal || proposal.status !== "resolving") return false;
    proposal.status = "voided";
    proposal.voidReason = "timeout";
    void now; // createdAt already stamped; now kept for signature symmetry
    return true;
  }
  ```
  (If `ConflictFeedback.memberId` should differ from `sessionId`, leave them equal —
  the server identifies the rejecting session by id; `note`/`rule` are optional and
  omitted.)
**Verify**: `npm run build --workspace @synapse/server` → 0.

### Step 3: Mediator tests
Extend `apps/server/src/mediator.test.ts` (reuse the existing setup that seeds a
keep delta + proposes). Add:
- **reject voids + feedback**: propose, `applyResolutionAck(state, id, keep)`
  (resolving), then `applyResolutionReject(state, id, adapt)` → returns
  `{ changed: true, feedback }` with `feedback.outcome === "dismissed"` and
  `feedback.conflictId === id`; the proposal is now `status: "voided"`,
  `voidReason: "rejected"`, `voidedBy: adapt`.
- **ack after void is a no-op**: after the reject above,
  `applyResolutionAck(state, id, keep)` returns `false` and the status stays
  `voided` (never `resolved`) — the no-partial-commit guarantee.
- **timeout voids**: propose, then `voidOnTimeout(state, id)` → `true`, status
  `voided`, `voidReason: "timeout"`; a second `voidOnTimeout` returns `false`.
- **reject of a non-party / unknown proposal**: `applyResolutionReject` returns
  `{ changed: false }`, no mutation.
**Verify**: `npm test --workspace @synapse/server` → all pass.

### Step 4: Wire into the server — `apps/server/src/index.ts`
- **A proposal-timer map** at module scope:
  ```ts
  const RESOLUTION_TTL_MS = Number(process.env.SYNAPSE_RESOLUTION_TTL_MS ?? 300_000);
  const resolutionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function clearResolutionTimer(id: string): void {
    const t = resolutionTimers.get(id);
    if (t) { clearTimeout(t); resolutionTimers.delete(id); }
  }
  function scheduleResolutionTimeout(repoId: string, proposalId: string): void {
    clearResolutionTimer(proposalId);
    const timer = setTimeout(() => {
      void withRepo(repoId, async () => {
        const s = await getState(repoId);
        const changed = voidOnTimeout(s, proposalId);
        if (changed) broadcast(repoId, envelope("state.snapshot", { teamState: s, seq: bumpRepoSeq(repoId) }));
        return changed;
      }).finally(() => resolutionTimers.delete(proposalId));
    }, RESOLUTION_TTL_MS);
    timer.unref?.();
    resolutionTimers.set(proposalId, timer);
  }
  ```
  Import `applyResolutionReject`, `voidOnTimeout` from `./mediator.js`.
- **Propose path** (the `edit.intent` block): capture the proposal returned by
  `proposeOnContest` (it already returns it). After broadcasting the snapshot for a
  new proposal, `scheduleResolutionTimeout(repoId, proposal.id)`.
- **resolution.ack branch**: branch on `message.payload.accept`:
  - `accept === true`: the existing `applyResolutionAck` path. After it, if the
    proposal is now terminal (`resolved`), `clearResolutionTimer(message.payload.proposalId)`.
  - `accept === false`: `const result = applyResolutionReject(current, proposalId, sessionId)`
    inside `withRepo`; if `result.feedback`, also append it to state +
    `store.appendFeedback(repoId, result.feedback, 100)` (mirror `addConflictFeedback`:
    `current.conflictFeedback = [result.feedback, ...current.conflictFeedback].slice(0, 100)`).
    After `withRepo`, if `result.changed`: `clearResolutionTimer(proposalId)` and
    broadcast the post-state snapshot.
  - Keep `sendAck(socket, { forId: message.id, ok: true })` in both branches.
- Keep all changes additive; do not disturb other message handling.
**Verify**: `npm run build --workspace @synapse/server` → 0; `npm test --workspace @synapse/server` → pass.

### Step 5: Verifier — `scripts/verify-mediator.mjs`
Keep the existing happy-path assertions. Add two cases (use **distinct symbols**
per case so proposal ids don't collide with the happy-path one). Reuse the helpers.
- **Reject case**: alice reports a `contract.delta` on `symB` (with dependents) +
  `edit.intent`; bob `edit.intent` on `symB` → proposal `resolving`. alice acks
  (`accept: true`), bob **rejects** (`resolution.ack` with `accept: false`). Read
  snapshots until the proposal for `symB` has `status: "voided"` and
  `voidReason: "rejected"`; assert a `conflictFeedback` entry exists with
  `outcome: "dismissed"` and `conflictId === <proposalId>`; assert the proposal never
  reaches `resolved`.
- **Timeout case**: boot the server (or this verifier) with a short TTL —
  `SYNAPSE_RESOLUTION_TTL_MS=800` in the server child's env (mirror how
  `verify-mediator.mjs`/`verify-atomic-intent.mjs` set the server child env). alice
  delta+intent on `symC`, bob intent on `symC` → proposal `resolving`; send NO acks
  (or one), wait > 800ms, read snapshots until the `symC` proposal is `status: "voided"`,
  `voidReason: "timeout"`.
- The reject envelope: extend `resolutionAckEnvelope` (or add a variant) to set
  `accept: false`; the existing one stays `accept: true`.
- Print a success line covering all three cases; exit 0; tear down children.
**Verify**: `npm run verify:mediator` → prints success, exit 0.

### Step 6: Docs — `README.md`
Extend the "Resolution mediator" note: a reject from either agent, or a TTL timeout
before both accept, **voids** the coordinated pair, reverts the conflict to
`contested`, and surfaces an Owner **escalation** (the voided proposal in the live
room state); a reject is recorded as dismiss feedback. TTL is `SYNAPSE_RESOLUTION_TTL_MS`
(default 5 min). Still no LLM, no auto-edit; semantic classification is a later slice.
**Verify**: `npm run format:check` and `npm run lint` → 0.

## Done criteria (ALL must hold)

- [ ] `npm run build` exits 0 and `npm run typecheck` exits 0
- [ ] `npm test --workspace @synapse/protocol` and `@synapse/server` pass, including
      the new mediator tests: reject voids + dismiss feedback; ack-after-void is a
      no-op (never `resolved`); timeout voids; non-party/unknown reject is a no-op
- [ ] `npm run verify:mediator` prints success and exits 0, including the one-reject
      (void + `rejected` + dismiss feedback) and timeout (void + `timeout`) cases
- [ ] `npm run lint` exits 0 and `npm run format:check` exits 0
- [ ] `git grep -n "openrouter\|OpenRouter\|llm\|semantic" apps/server/src/mediator.ts` returns nothing (no LLM/semantic in this slice)
- [ ] No new store table / `ENTITY_TABLES` / `StateOp` (`git diff 0b3403c..HEAD -- apps/server/src/store.ts apps/server/src/store-pg.ts` shows at most no change; the reject reuses the existing `appendFeedback`)
- [ ] `authorized()` / WS handshake / `handleGitHubWebhook` / auth routes / web app unchanged
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 057 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows the #110 mediator/wiring changed since `0b3403c` and the
  excerpts no longer match (especially `applyResolutionAck`'s guard, the
  `resolution.ack` handler branch, or the `ResolutionProposal` shape).
- `applyResolutionAck` can flip a proposal to `resolved` from any status other than
  `resolving` — that breaks the no-partial-commit guarantee; STOP and report.
- Recording reject feedback appears to require a new store table or a `StateOp` — it
  must not; reuse `store.appendFeedback` + the in-memory `conflictFeedback` array.
- The timeout case can't be made deterministic with `SYNAPSE_RESOLUTION_TTL_MS` (the
  server doesn't read it) — STOP and report rather than adding flaky long sleeps.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Safety invariant**: a proposal reaches `resolved` ONLY from `resolving` with
  every direction accepted; `voided` is terminal. The mediator tests + the verifier
  reject case are the guards — a reviewer should confirm no path flips a voided
  proposal to resolved.
- **Timer lifecycle**: timers are cleared on resolve and reject; on a server restart,
  in-flight `resolving` proposals are dropped (transient) and their timers vanish —
  acceptable (the next `edit.intent` re-proposes). If durability is ever needed,
  that's a deliberate later change.
- **Escalation**: today the voided proposal IS the escalation (read from the
  broadcast). #114 renders it in the Owner dashboard. If a richer escalation record
  (assignee, ack-by-owner) is wanted later, extend `ResolutionProposal` or add a
  dedicated field then.
- **Seam for #112/#113**: `conflictClass` (mechanical only today) and
  `Direction.summary` (templated) remain the seams for semantic classification and
  the LLM adapt-edit prose.
