# Plan 058: Mediator — mechanical-vs-semantic classification + keep/adapt roles

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> STOP condition occurs, stop and report — do not improvise. Build in step order
> (conflict-engine classifier → protocol types → server mediator → owner-pick
> route → verifier), keeping the tree compiling between steps. When done, update
> the status row for this plan in `plans/README.md` — unless a reviewer
> dispatched you and told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c381efb..HEAD -- apps/server/src/mediator.ts packages/conflict-engine/src/index.ts packages/conflict-engine/src/compare.ts packages/protocol/src/index.ts packages/protocol/src/wire-schema.ts apps/server/src/auth/routes.ts apps/server/src/index.ts scripts/verify-mediator.mjs`
> If any changed since this plan was written, compare the "Current state"
> excerpts below against the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M-L
- **Risk**: MED (deterministic classification + a new Owner action surface)
- **Depends on**: plan 056 (mediator tracer, DONE) and plan 057 (void/escalation, DONE).
- **Category**: direction (feature)
- **Planned at**: commit `c381efb`, 2026-06-18
- **Executed**: PR #124 on `feat/mediator-classify`, implementation commit `d414a25`.
- **Issue**: https://github.com/Kumario1/synapse/issues/112 (parent PRD #109; ADR-0002)

## Why this matters

The mediator (#110/#111) treats every contested symbol as **mechanical** —
assuming one side's signature stands and the other adapts its call-sites. But some
collisions are **semantic**: two agents want *mutually exclusive* signatures on the
same symbol, and **no single edit satisfies both**. Fabricating a both-satisfying
proposal there would mislead the Owner into trusting an impossible merge. This slice
adds **deterministic classification** (mechanical vs semantic) and, for a semantic
conflict, **escalates the winner choice to the Owner** instead of inventing a merge.
Once the Owner picks, the winner's signature stands (`keep`) and the other side gets
an `adapt` direction with the deterministic call-site list. Still **no LLM** — the
classifier and the call-site list are deterministic.

## Current state (the landed mediator — extend this)

- `packages/conflict-engine/src/compare.ts`:
  `compareSignatures(before: Signature | null, after: Signature | null): { compatibility: "identical" | "compatible" | "breaking" | "unknown"; reasons: string[] }`
  is the deterministic signature comparator. **Two after-signatures are
  *mutually exclusive* (semantic) when `compareSignatures(a, b).compatibility !== "identical"`.**
- `packages/conflict-engine/src/index.ts` exports `buildMechanicalDirections(keepSessionId, adaptSessionId, keepDelta): Direction[]` (keep = no sites, adapt = `keepDelta.dependents` mapped to `AffectedSite[]`) and `affectedSitesFromDelta`. It also re-exports `compareSignatures` (used by `evaluateConflicts`) — confirm and reuse.
- `apps/server/src/mediator.ts` `proposeOnContest(state, symbolRaw, adaptSessionId, now?)`:
  ```ts
  const keepDelta = state.unpushedDeltas.find(
    (delta) => delta.symbolId.raw === symbolRaw && delta.sessionId !== adaptSessionId
  );
  if (!keepDelta) return null;
  const id = proposalId(symbolRaw, keepDelta.sessionId, adaptSessionId);
  // ... idempotency guard ...
  const proposal: ResolutionProposal = {
    id, repoId: state.repoId, symbol: keepDelta.symbolId,
    conflictClass: "mechanical", before: keepDelta.before, after: keepDelta.after,
    status: "resolving",
    directions: buildMechanicalDirections(keepDelta.sessionId, adaptSessionId, keepDelta),
    acceptedBy: [], createdAt: now()
  };
  ```
  It also has `applyResolutionAck` (acts only on `resolving`), `applyResolutionReject`,
  `voidOnTimeout` (both act only on `resolving`) from #111.
- `packages/protocol/src/index.ts`:
  - `ResolutionProposal.conflictClass: "mechanical"` — **widen to `"mechanical" | "semantic"`**.
  - `ResolutionProposalStatus = "resolving" | "resolved" | "voided"` — **add `"awaiting_owner"`**.
  - You add `candidates?: string[]` to `ResolutionProposal` (the two contesting
    sessionIds, present only while `awaiting_owner`).
  - `Direction { sessionId, role: "keep" | "adapt", summary, affectedSites }` — unchanged.
- `packages/protocol/src/wire-schema.ts`: the `resolutionProposal` zod schema's
  `conflictClass` (mechanical→add semantic), `status` enum (add `awaiting_owner`), and
  a new optional `candidates: z.array(z.string()).optional()` must match the type.
- **Owner action surface to mirror** — the #107 kick route
  (`apps/server/src/auth/routes.ts`, lines ~261-279):
  ```ts
  if (method === "POST" && pathname === "/auth/projects/kick") {
    const owner = requireOwner(cookies, ctx);
    if (!owner) return { status: 401, body: { error: "unauthenticated" } };
    const repoId = query.get("repoId"); const sessionId = query.get("sessionId");
    if (!repoId || !sessionId) return { status: 400, body: { error: "missing_params" } };
    const project = await ctx.projectStore.getProject(owner.userId, repoId);
    if (!project) return { status: 403, body: { error: "not_owner" } };
    await ctx.kickSession(repoId, sessionId);
    return { status: 200, body: { ok: true } };
  }
  ```
  `AuthContext` has `kickSession: (repoId, sessionId) => Promise<void>` (line ~48),
  injected in `index.ts` (line ~112). **Add `pickResolutionWinner` the same way.**
- `apps/server/src/index.ts`:
  - The propose path (lines ~588-620): `proposeOnContest(...)` → `proposedId` → broadcast
    snapshot + `scheduleResolutionTimeout(repoId, proposedId)`. The TTL timer
    (`RESOLUTION_TTL_MS`, line ~902) + `voidOnTimeout` only act on `resolving`, so an
    `awaiting_owner` proposal won't be auto-voided — but **only schedule the timer when
    the new proposal's status is `resolving`** (mechanical), not for `awaiting_owner`.
  - `withRepo`, `getState`, `broadcast`, `envelope`, `bumpRepoSeq`,
    `scheduleResolutionTimeout` are module-scope.
- `scripts/verify-mediator.mjs` proves the mechanical happy/reject/timeout paths over
  raw sockets. Extend it with a **semantic classification** case (it can prove the
  `awaiting_owner` escalation appears; the cookie-authed winner-pick is covered by
  unit tests, exactly as the #107 kick route's HTTP authz is unit-tested, not in the
  socket verifier).

### Conventions

- Tests: `node:test` + `node:assert/strict`. conflict-engine
  `npm test --workspace @synapse/conflict-engine`; server `--workspace @synapse/server`.
  Model classifier tests on `packages/conflict-engine/src/resolution.test.ts` /
  `branch-aware.test.ts`; route authz on `apps/server/src/auth/routes.test.ts`.
- TS strict, ESM, `.js` specifiers (server/protocol/conflict-engine). No new dependency. No LLM.
- Mediator stays pure; route + broadcast + timer live in server/index.ts.

## Commands you will need (from repo root /private/tmp/synapse-issue-112)

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

## Scope

**In scope** (modify unless noted):
- `packages/conflict-engine/src/mediator.ts` (add `classifyCollision`)
- `packages/conflict-engine/src/mediator.test.ts` (classification + role tests)
- `packages/conflict-engine/src/index.ts` (re-export `classifyCollision`)
- `packages/protocol/src/index.ts` (`conflictClass` widen; `awaiting_owner` status; `candidates?`)
- `packages/protocol/src/wire-schema.ts` (matching schema updates)
- `packages/protocol/src/wire-schema.test.ts` (if it pins the proposal shape, add a semantic/awaiting_owner case)
- `apps/server/src/mediator.ts` (classify in `proposeOnContest`; add `applyWinnerChoice`)
- `apps/server/src/mediator.test.ts` (semantic → awaiting_owner; winner pick → resolving + roles)
- `apps/server/src/auth/routes.ts` (add `POST /auth/projects/resolve-winner` + `pickResolutionWinner` on `AuthContext`)
- `apps/server/src/auth/routes.test.ts` (winner-pick authz: owner 200 / non-owner 403 / 401 / 400)
- `apps/server/src/index.ts` (inject `pickResolutionWinner`; only schedule TTL for `resolving` proposals)
- `scripts/verify-mediator.mjs` (semantic classification case)
- `README.md` (mediator note: mechanical vs semantic + owner winner-pick)

**Out of scope** (do NOT touch):
- The LLM layer (#113) and dashboard rendering (#114).
- The mechanical happy/reject/timeout machinery (#110/#111) — reuse `applyResolutionAck`/`applyResolutionReject`/`voidOnTimeout` unchanged for the post-pick `resolving` phase.
- A semantic-conflict *auto*-winner (the Owner always decides in this slice).
- `authorized()`, WS handshake, `handleGitHubWebhook`, the kick route, web app, `evaluateConflicts`, persistence (proposals stay transient).

## Steps

### Step 1: conflict-engine — `classifyCollision`
In `packages/conflict-engine/src/mediator.ts`:
```ts
import { compareSignatures } from "./compare.js"; // confirm the relative path
import type { ContractDelta } from "@synapse/protocol";

export type ConflictClass = "mechanical" | "semantic";

/**
 * Deterministic classification of a contested symbol. SEMANTIC when both sides
 * changed the contract to *mutually exclusive* signatures (the contesting side
 * has its own delta whose `after` is not identical to the keep side's `after`).
 * MECHANICAL otherwise (only one side changed the contract; the other adapts).
 */
export function classifyCollision(
  keepDelta: ContractDelta,
  adaptDelta: ContractDelta | undefined
): ConflictClass {
  if (!adaptDelta) return "mechanical";
  const cmp = compareSignatures(keepDelta.after, adaptDelta.after);
  return cmp.compatibility === "identical" ? "mechanical" : "semantic";
}
```
Re-export `classifyCollision` + `ConflictClass` from `packages/conflict-engine/src/index.ts`.
`packages/conflict-engine/src/mediator.test.ts`: assert mechanical when `adaptDelta`
is undefined; mechanical when both after-sigs are identical; **semantic** when the two
after-sigs diverge (build two `ContractDelta` fixtures with different `after.params`/
`after.returns`, mirroring `resolution.test.ts` fixtures). Also assert
`buildMechanicalDirections(winner, loser, winnerDelta)` puts the call-sites on the
loser's `adapt` direction (the role-assignment used for the picked winner).
**Verify**: `npm test --workspace @synapse/conflict-engine` → pass.

### Step 2: Protocol — semantic class + awaiting_owner + candidates
- `packages/protocol/src/index.ts`: `conflictClass: "mechanical" | "semantic"`;
  `ResolutionProposalStatus = "resolving" | "resolved" | "voided" | "awaiting_owner"`;
  add to `ResolutionProposal`:
  ```ts
  /** The two contesting sessionIds awaiting the Owner's winner choice (semantic only). */
  candidates?: string[];
  ```
- `packages/protocol/src/wire-schema.ts`: update the `resolutionProposal` schema —
  `conflictClass: z.enum(["mechanical", "semantic"])`, status enum gains
  `"awaiting_owner"`, add `candidates: z.array(z.string()).optional()`.
- Update `wire-schema.test.ts` if it pins these (add a semantic/awaiting_owner parse case).
**Verify**: `npm run build --workspace @synapse/protocol` → 0; `npm test --workspace @synapse/protocol` → pass.

### Step 3: Server mediator — classify on contest + winner pick
In `apps/server/src/mediator.ts`:
- In `proposeOnContest`, after finding `keepDelta`, also find the contesting side's
  own delta and classify:
  ```ts
  const adaptDelta = state.unpushedDeltas.find(
    (d) => d.symbolId.raw === symbolRaw && d.sessionId === adaptSessionId
  );
  const conflictClass = classifyCollision(keepDelta, adaptDelta); // import from @synapse/conflict-engine
  ```
  - **mechanical** → the existing proposal (unchanged: status `resolving`, directions from `buildMechanicalDirections`).
  - **semantic** → build the proposal as:
    ```ts
    { id, repoId: state.repoId, symbol: keepDelta.symbolId, conflictClass: "semantic",
      before: keepDelta.before, after: null, status: "awaiting_owner",
      directions: [], candidates: [keepDelta.sessionId, adaptSessionId],
      acceptedBy: [], createdAt: now() }
    ```
  Keep the idempotency guard (same `id`).
- Add:
  ```ts
  /**
   * The Owner picks the winner of a semantic conflict. The winner keeps its
   * signature; the loser adapts to it (deterministic call-site list). Moves the
   * proposal awaiting_owner → resolving. Returns whether it changed.
   */
  export function applyWinnerChoice(
    state: TeamState, proposalId: string, winnerSessionId: string
  ): boolean {
    const proposal = state.resolutionProposals?.find((p) => p.id === proposalId);
    if (!proposal || proposal.status !== "awaiting_owner") return false;
    if (!proposal.candidates?.includes(winnerSessionId)) return false;
    const loserSessionId = proposal.candidates.find((s) => s !== winnerSessionId);
    if (!loserSessionId) return false;
    const winnerDelta = state.unpushedDeltas.find(
      (d) => d.symbolId.raw === proposal.symbol.raw && d.sessionId === winnerSessionId
    );
    if (!winnerDelta) return false;
    proposal.directions = buildMechanicalDirections(winnerSessionId, loserSessionId, winnerDelta);
    proposal.after = winnerDelta.after;
    proposal.status = "resolving";
    proposal.candidates = undefined;
    return true;
  }
  ```
  (Import `classifyCollision` and `buildMechanicalDirections` from `@synapse/conflict-engine`.)
**Verify**: `npm run build --workspace @synapse/server` → 0.

### Step 4: Server mediator tests
Extend `apps/server/src/mediator.test.ts`:
- **semantic classification**: seed two divergent deltas (alice `after` A, bob `after` B)
  on the same symbol; `proposeOnContest(state, sym, "bob")` → proposal
  `conflictClass: "semantic"`, `status: "awaiting_owner"`, `directions: []`,
  `candidates` containing both sessions, `after: null`.
- **winner pick → resolving + roles**: after the semantic propose above,
  `applyWinnerChoice(state, id, "alice")` → `true`; the proposal is now `resolving`
  with directions: alice `keep` (empty sites), bob `adapt` (sites = alice delta's
  dependents); `after === aliceDelta.after`; `candidates` cleared. A second
  `applyWinnerChoice` returns `false` (no longer awaiting_owner).
- **winner not a candidate**: `applyWinnerChoice(state, id, "mallory")` → `false`, no change.
- **mechanical still works**: a single-delta contest still yields a `mechanical`
  `resolving` proposal (regression).
- **post-pick acks resolve**: after the pick, `applyResolutionAck(state, id, "alice")`
  then `("bob")` → status `resolved` (reuses #110/#111 machinery).
**Verify**: `npm test --workspace @synapse/server` → all pass.

### Step 5: Owner winner-pick route + wiring
- `apps/server/src/auth/routes.ts`: add to `AuthContext`
  `pickResolutionWinner: (repoId: string, proposalId: string, winnerSessionId: string) => Promise<void>;`
  and a route (mirror the kick route exactly):
  ```ts
  if (method === "POST" && pathname === "/auth/projects/resolve-winner") {
    const owner = requireOwner(cookies, ctx);
    if (!owner) return { status: 401, body: { error: "unauthenticated" } };
    const repoId = query.get("repoId");
    const proposalId = query.get("proposalId");
    const winnerSessionId = query.get("winnerSessionId");
    if (!repoId || !proposalId || !winnerSessionId) return { status: 400, body: { error: "missing_params" } };
    const project = await ctx.projectStore.getProject(owner.userId, repoId);
    if (!project) return { status: 403, body: { error: "not_owner" } };
    await ctx.pickResolutionWinner(repoId, proposalId, winnerSessionId);
    return { status: 200, body: { ok: true } };
  }
  ```
- `apps/server/src/index.ts`: inject `pickResolutionWinner` into the `authContext`
  object (next to `kickSession`):
  ```ts
  pickResolutionWinner: (repoId, proposalId, winnerSessionId) =>
    withRepo(repoId, async () => {
      const s = await getState(repoId);
      const changed = applyWinnerChoice(s, proposalId, winnerSessionId);
      if (changed) {
        broadcast(repoId, envelope("state.snapshot", { teamState: s, seq: bumpRepoSeq(repoId) }));
        scheduleResolutionTimeout(repoId, proposalId); // now resolving → TTL applies
      }
    }).then(() => undefined),
  ```
  Import `applyWinnerChoice` from `./mediator.js`. In the **propose path**, only call
  `scheduleResolutionTimeout` when the new proposal is `resolving` (mechanical) — for a
  `semantic`/`awaiting_owner` proposal, do NOT schedule a timer (it waits for the human).
  (Capture the proposal's status from `proposeOnContest`'s return alongside its id.)
- `apps/server/src/auth/routes.test.ts`: add winner-pick authz cases with an injected
  `pickResolutionWinner` recorder: owner of the repo → 200 + recorded; non-owner → 403,
  not recorded; no session → 401; missing params → 400, not recorded (mirror the kick tests).
**Verify**: `npm run build` → 0; `npm test --workspace @synapse/server` → pass.

### Step 6: Verifier — semantic classification case
Extend `scripts/verify-mediator.mjs` with a semantic case (distinct symbol `symS`):
alice reports a `contract.delta` on `symS` with `after` signature A (+ `edit.intent`),
bob reports a `contract.delta` on `symS` with a **divergent** `after` signature B
(+ `edit.intent`). bob's `edit.intent` is contested → read snapshots until a proposal
for `symS` has `conflictClass: "semantic"`, `status: "awaiting_owner"`, `directions: []`,
and `candidates` containing both `"alice"` and `"bob"`. Assert it does NOT auto-resolve
and has no fabricated `after` (`after === null`). (The cookie-authed winner-pick is
covered by the unit tests in Steps 4–5, not this socket verifier.) Extend the success
print to mention the semantic case.
**Verify**: `npm run verify:mediator` → prints success, exit 0.

### Step 7: Docs — `README.md`
Extend the mediator note: a contested symbol is classified **mechanical** (one side
changed the contract → both-satisfiable proposal as before) or **semantic** (both sides
want mutually exclusive signatures → the mediator does NOT fabricate a merge; it
escalates a **winner choice** to the Owner via `POST /auth/projects/resolve-winner`,
cookie-authed + ownership-scoped). After the Owner picks, the winner keeps its
signature and the other side gets a deterministic `adapt` call-site list. Still no LLM.
**Verify**: `npm run format:check` and `npm run lint` → 0.

## Done criteria (ALL must hold)

- [ ] `npm run build` exits 0 and `npm run typecheck` exits 0
- [ ] `npm test --workspace @synapse/conflict-engine` / `@synapse/protocol` / `@synapse/server` pass, including: `classifyCollision` mechanical/semantic; semantic propose → `awaiting_owner` + candidates + no fabricated `after`; `applyWinnerChoice` → `resolving` with keep/adapt roles + call-site list; winner-pick route authz (owner 200 / non-owner 403 / 401 / 400)
- [ ] `npm run verify:mediator` prints success and exits 0, including the semantic classification case (awaiting_owner escalation, no fabricated merge)
- [ ] `npm run lint` exits 0 and `npm run format:check` exits 0
- [ ] `git grep -n "openrouter\|OpenRouter\|llm" packages/conflict-engine/src/mediator.ts apps/server/src/mediator.ts` returns nothing
- [ ] No persistence change (`git diff c381efb..HEAD -- apps/server/src/store.ts apps/server/src/store-pg.ts` empty)
- [ ] `authorized()` / WS handshake / `handleGitHubWebhook` / the kick route / web app unchanged
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 058 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `proposeOnContest`, `compareSignatures`, the `ResolutionProposal`
  shape, or the kick-route/`AuthContext` pattern changed since `c381efb` and the
  excerpts no longer match.
- `compareSignatures` does not return a `.compatibility` of
  `"identical" | "compatible" | "breaking" | "unknown"` as described.
- A semantic proposal can be ack'd into `resolved` while still `awaiting_owner`
  (it must not — `applyResolutionAck` acts only on `resolving`); STOP and report.
- The winner-pick appears to require a browser WS message or a change to the machine
  protocol — it must be a cookie-authed HTTP route like the kick.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Honesty invariant**: a semantic proposal NEVER carries a fabricated both-satisfying
  `after` (`after: null` until the Owner picks). The classifier + the verifier semantic
  case guard this — a reviewer should confirm no path fills `after` for an
  `awaiting_owner` proposal except via `applyWinnerChoice` (the picked winner's real signature).
- **Owner-decides**: this slice never auto-picks a winner; the cookie-authed route is the
  only path out of `awaiting_owner`. Later heuristics (lock seniority, task priority) are
  out of scope and need their own plan + ADR note.
- **Timer**: `awaiting_owner` proposals are not auto-voided (they wait for the human); the
  TTL applies only after the pick moves them to `resolving`. If an `awaiting_owner` timeout
  is ever wanted, it's a deliberate later change.
- **Seam for #113**: `Direction.summary` stays templated; the LLM adapt-edit prose layers
  on top additively. **#114** renders `awaiting_owner` proposals as Owner winner-choice
  escalations and `resolving` ones as in-progress.
