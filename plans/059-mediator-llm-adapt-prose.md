# Plan 059: Add LLM-authored mediator adapt prose without changing verdicts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report -- do not improvise. When done, update the status row for this plan
> in `plans/README.md` unless your reviewer says they maintain the index.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat f2fde2f..HEAD -- \
>   packages/conflict-engine/src/mediator.ts \
>   packages/conflict-engine/src/mediator.test.ts \
>   packages/conflict-engine/src/index.ts \
>   packages/protocol/src/index.ts \
>   apps/server/src/mediator.ts \
>   apps/server/src/mediator.test.ts \
>   apps/server/src/index.ts \
>   apps/server/src/mediator-openrouter.ts \
>   README.md \
>   .env.example \
>   docs/adr/0002-llm-resolution-mediator-suggest-only.md \
>   plans/README.md
> ```
>
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M-L
- **Risk**: MED
- **Depends on**: plans/056-mediator-tracer-two-phase-happy-path.md, plans/057-mediator-reject-timeout-void-escalation.md, plans/058-mediator-mechanical-vs-semantic-classification.md
- **Category**: direction
- **Planned at**: commit `f2fde2f`, 2026-06-18
- **Issue**: https://github.com/Kumario1/synapse/issues/113

## Why this matters

Issue #113 adds the LLM layer on top of the deterministic mediator shipped in
#110-#112. The LLM must make the `adapt` direction more useful to a downstream
coding agent, but it must not decide winners, fabricate `after` signatures,
change statuses, or affect any detection verdict. With no LLM configured,
today's deterministic `keep`/`adapt` proposal must be byte-for-byte unchanged.

The important boundary: the mediator's facts are still deterministic. The LLM
only writes optional human/agent-readable prose for the losing side's
`Direction.summary`, and invalid/untrusted prose falls back to the deterministic
summary.

## Current state

Relevant files and roles:

- `packages/conflict-engine/src/mediator.ts` -- pure deterministic mediator
  helpers. Today it classifies collisions and creates templated directions.
- `apps/server/src/mediator.ts` -- mutates transient
  `TeamState.resolutionProposals[]` for propose, winner choice, ack, reject,
  and timeout.
- `apps/server/src/index.ts` -- calls `proposeOnContest` on contested
  `edit.intent`, broadcasts proposal snapshots, and schedules TTL timers.
- `apps/cli/src/explain-openrouter.ts` -- prior art for optional OpenRouter
  config and defensive failure behavior; do not move the old CLI resolver in
  this plan.
- `packages/protocol/src/index.ts` -- public `Direction` and
  `ResolutionProposal` types.
- `README.md`, `.env.example`, and
  `docs/adr/0002-llm-resolution-mediator-suggest-only.md` -- user-facing and
  architectural docs that currently say the mediator does not use an LLM.

Current deterministic direction builder:

```ts
// packages/conflict-engine/src/mediator.ts
export function buildMechanicalDirections(
  keepSessionId: string,
  adaptSessionId: string,
  keepDelta: ContractDelta
): Direction[] {
  const sites = affectedSitesFromDelta(keepDelta);
  const symbol = keepDelta.symbolId.raw;

  return [
    {
      sessionId: keepSessionId,
      role: "keep",
      summary: `Keep your change to ${symbol}.`,
      affectedSites: []
    },
    {
      sessionId: adaptSessionId,
      role: "adapt",
      summary: `Update ${sites.length} call-site(s) to match ${symbol}'s new signature.`,
      affectedSites: sites
    }
  ];
}
```

Current proposal creation:

```ts
// apps/server/src/mediator.ts
export function proposeOnContest(
  state: TeamState,
  symbolRaw: string,
  adaptSessionId: string,
  now: () => string = () => new Date().toISOString()
): ResolutionProposal | null {
  const keepDelta = state.unpushedDeltas.find(
    (delta) => delta.symbolId.raw === symbolRaw && delta.sessionId !== adaptSessionId
  );
  if (!keepDelta) {
    return null;
  }

  // ...
  const conflictClass = classifyCollision(keepDelta, adaptDelta);
  const proposal: ResolutionProposal = {
    id,
    repoId: state.repoId,
    symbol: keepDelta.symbolId,
    conflictClass,
    before: keepDelta.before,
    after: conflictClass === "mechanical" ? keepDelta.after : null,
    status: conflictClass === "mechanical" ? "resolving" : "awaiting_owner",
    directions:
      conflictClass === "mechanical"
        ? buildMechanicalDirections(keepDelta.sessionId, adaptSessionId, keepDelta)
        : [],
    candidates: conflictClass === "semantic" ? [keepDelta.sessionId, adaptSessionId] : undefined,
    acceptedBy: [],
    createdAt: now()
  };
  state.resolutionProposals = [...proposals, proposal];
  return proposal;
}
```

Current owner pick turns a semantic conflict into deterministic keep/adapt
directions:

```ts
// apps/server/src/mediator.ts
proposal.directions = buildMechanicalDirections(winnerSessionId, loserSessionId, winnerDelta);
proposal.after = winnerDelta.after;
proposal.status = "resolving";
proposal.candidates = undefined;
```

Current server call site:

```ts
// apps/server/src/index.ts
const proposal = proposeOnContest(
  current,
  message.payload.symbolId.raw,
  message.payload.sessionId
);
proposedId = proposal?.id;
proposedStatus = proposal?.status;
```

The server has a per-repo async mutex:

```ts
// apps/server/src/index.ts
function withRepo<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(repoId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  repoLocks.set(
    repoId,
    next.catch(() => {})
  );
  return next;
}
```

Do not await an OpenRouter/network request inside that lock. The deterministic
proposal should be created and acked first; optional LLM prose enrichment should
happen afterward and broadcast a refreshed snapshot only if the proposal is
still active.

Existing OpenRouter config pattern:

```ts
// apps/cli/src/explain-openrouter.ts
function openRouterConfig(disableFlag: string): OpenRouterConfig | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  return !apiKey || process.env[disableFlag] === "0"
    ? null
    : {
        apiKey,
        baseUrl: (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, ""),
        model: process.env.SYNAPSE_LLM_MODEL ?? "anthropic/claude-haiku-4.5",
        timeoutMs: Number(process.env.SYNAPSE_LLM_TIMEOUT_MS ?? 8000)
      };
}
```

Protocol type comment still describes summaries as deterministic only:

```ts
// packages/protocol/src/index.ts
export interface Direction {
  sessionId: string;
  role: ResolutionRole;
  /** Templated, deterministic prose (no LLM in this slice). */
  summary: string;
  affectedSites: AffectedSite[];
}
```

Repo conventions:

- npm workspace monorepo, Node 20, npm 11.4.1.
- TypeScript ESM packages. Use explicit `.js` in local relative imports.
- Tests use `node:test` + `node:assert/strict`.
- Avoid new dependencies. Existing OpenRouter code uses plain `fetch` and
  `AbortController`.
- Branch name for this issue: `feat/mediator-llm-prose`.
- Commit message: `feat(mediator): add llm adapt prose enrichment`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `npm install` | exit 0 |
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0, no type errors |
| Conflict-engine tests | `npm test --workspace @synapse/conflict-engine` | all tests pass |
| Server tests | `npm test --workspace @synapse/server` | all tests pass |
| Protocol tests | `npm test --workspace @synapse/protocol` | all tests pass |
| Mediator verifier | `npm run verify:mediator` | exits 0; existing resolve/reject/semantic/timeout cases still pass |
| Lint | `npm run lint` | exit 0; warnings are acceptable only if they are existing repo baseline |
| Format check | `npm run format:check` | exit 0 |

## Scope

**In scope**:

- `packages/conflict-engine/src/mediator.ts`
- `packages/conflict-engine/src/mediator.test.ts`
- `packages/conflict-engine/src/index.ts`
- `packages/protocol/src/index.ts`
- `apps/server/src/mediator.ts`
- `apps/server/src/mediator.test.ts`
- `apps/server/src/index.ts`
- `apps/server/src/mediator-openrouter.ts` (create)
- `README.md`
- `.env.example`
- `docs/adr/0002-llm-resolution-mediator-suggest-only.md`
- `plans/README.md`
- `plans/059-mediator-llm-adapt-prose.md`

**Out of scope**:

- Do not change detection rules, severities, `evaluateConflicts`, or
  `verdictFor`.
- Do not change `ResolutionProposal.status`, `conflictClass`, `before`,
  `after`, `acceptedBy`, `candidates`, TTL behavior, owner authorization, or
  storage semantics.
- Do not bump `PROTOCOL_VERSION` or add a new wire field unless a reviewer
  explicitly approves. This plan should work by changing `Direction.summary`
  text only.
- Do not rewrite the older CLI `ResolutionProvider` or its contract-merge
  resolver. Use it only as prior art.
- Do not add browser/dashboard Owner visibility; that is issue #114.
- Do not send raw source code, full files, or neighbor source to the mediator
  prose provider. This slice sends deterministic symbol/signature/call-site
  facts only.
- Do not auto-edit code or call downstream agent tools.

## Git workflow

- Worktree: `/private/tmp/synapse-issue-113`.
- Branch: `feat/mediator-llm-prose`.
- Commit once the plan is implemented and verified.
- Commit message: `feat(mediator): add llm adapt prose enrichment`.
- Push the branch and open a PR into `main` for issue #113.

## Steps

### Step 1: Add a mediator prose provider contract in the pure engine

In `packages/conflict-engine/src/mediator.ts`, add a small, mediator-specific
interface. Do not reuse the old `ResolutionProvider` from `explain.ts`; that
provider produces merged contracts for daemon-side conflict analysis, while
this provider only enriches `Direction.summary`.

Recommended shape:

```ts
export interface MediatorResolutionRequest {
  proposalId: string;
  symbol: string;
  conflictClass: ConflictClass;
  keep: {
    sessionId: string;
    before: string | null;
    after: string | null;
    filePath: string;
    summary: string;
  };
  adapt: {
    sessionId: string;
    before: string | null;
    after: string | null;
    filePath: string | null;
    summary: string | null;
  };
  affectedSites: AffectedSite[];
  deterministicSummary: string;
}

export interface MediatorResolutionProse {
  adaptSummary: string;
}

export interface MediatorResolutionProvider {
  proposeResolution(req: MediatorResolutionRequest): Promise<MediatorResolutionProse | null>;
}
```

Also add pure helpers for grounding and application. The exact function names
can differ, but keep these responsibilities separate:

- Build a `MediatorResolutionRequest` from the deterministic proposal, the
  winner/keep delta, the loser/adapt delta if present, and the existing
  deterministic adapt direction.
- Apply provider prose only to the `adapt` direction summary.
- Preserve the existing summary exactly if no provider is configured, if the
  provider throws/returns `null`, if the proposal is not `resolving`, or if
  grounding validation rejects the text.

Grounding requirements:

- Final enriched summaries must include deterministic facts: target symbol,
  target `after.raw` when available, and affected call-site file paths from
  `affectedSites`.
- Reject provider prose that mentions a file path, symbol id, or signature-like
  backtick snippet not present in the request's deterministic facts.
- A rejected provider result falls back to the deterministic summary and does
  not fail the proposal.

Export the new types/functions from `packages/conflict-engine/src/index.ts`.

**Verify**:

```bash
npm run build --workspace @synapse/conflict-engine
```

Expected: exit 0.

### Step 2: Cover provider and grounding behavior with pure unit tests

Extend `packages/conflict-engine/src/mediator.test.ts`.

Add tests for:

- no provider path remains identical to the current `buildMechanicalDirections`
  output;
- a fake provider receives only deterministic facts: `proposalId`, symbol,
  keep/adapt session ids, `before`/`after` raw signatures, and affected sites;
- valid fake provider prose appears only on the `adapt` direction summary while
  the `keep` direction remains unchanged;
- invented call-site file paths are rejected and the deterministic summary is
  preserved;
- invented signature snippets are rejected and the deterministic summary is
  preserved.

Use the existing `keepDelta` fixture with `src/routes/me.ts` and
`src/audit/log.ts` as the known call sites. Keep these tests in
`node:test`/`assert` style.

**Verify**:

```bash
npm test --workspace @synapse/conflict-engine
```

Expected: all conflict-engine tests pass.

### Step 3: Integrate optional prose enrichment into server mediator state

In `apps/server/src/mediator.ts`, import the new pure helpers/types from
`@synapse/conflict-engine`.

Add an async helper that the server can call after deterministic proposal
creation:

```ts
export async function enrichResolutionProse(
  state: TeamState,
  proposalId: string,
  provider: MediatorResolutionProvider | null
): Promise<boolean>
```

Implementation requirements:

- If `provider` is `null`, return `false` without calling anything.
- If the proposal does not exist or is not `resolving`, return `false`.
- Build the deterministic request from current state. If the request cannot be
  built, return `false`.
- Call `provider.proposeResolution(request)` defensively; thrown errors and
  `null` results return `false`.
- Apply only a grounded `adaptSummary` to the proposal's `adapt` direction.
- Return `true` only when the proposal's stored direction summary changed.
- Do not change proposal status, `conflictClass`, `before`, `after`,
  `acceptedBy`, `candidates`, `voidReason`, or `voidedBy`.

Extend `apps/server/src/mediator.test.ts` for:

- `proposeOnContest` no-provider behavior is unchanged for mechanical
  proposals;
- `enrichResolutionProse` with `null` provider does not call and does not
  mutate;
- fake provider enrichment changes only the `adapt` summary and leaves proposal
  state fields unchanged;
- semantic `awaiting_owner` proposals are not enriched before owner choice;
- after `applyWinnerChoice`, the resolving proposal can be enriched for the
  losing side;
- provider exceptions are swallowed and preserve deterministic summaries.

**Verify**:

```bash
npm run build --workspace @synapse/server
npm test --workspace @synapse/server
```

Expected: build succeeds and all server tests pass.

### Step 4: Add the server-side OpenRouter mediator provider

Create `apps/server/src/mediator-openrouter.ts`.

Follow the defensive config/failure posture in `apps/cli/src/explain-openrouter.ts`:

- `OPENROUTER_API_KEY` required; no key returns `null`.
- `SYNAPSE_LLM_RESOLVE=0` disables this mediator prose layer too.
- `OPENROUTER_BASE_URL` defaults to `https://openrouter.ai/api/v1`.
- `SYNAPSE_LLM_MODEL` defaults to `anthropic/claude-haiku-4.5`.
- `SYNAPSE_LLM_TIMEOUT_MS` defaults to `8000`.
- Use plain `fetch`; do not add an SDK dependency.
- Use a short timeout and return `null` on HTTP failure, abort, malformed JSON,
  empty prose, or parse failure.

Prompt contract:

- The model writes only concise adapt prose for the losing side.
- It must not choose the winner, change the verdict/status, propose a new
  merged contract, or claim code was edited.
- It receives only `MediatorResolutionRequest` facts.
- It returns strict JSON only:

```json
{"adaptSummary":"..."}
```

Cache results by a stable key derived from the request facts so repeated
broadcast/enrichment attempts do not repeatedly call the provider for the same
proposal facts. Keep the cache in memory, matching the current OpenRouter
provider pattern.

Add focused tests if the server test setup can import this module without
environment leakage. At minimum, cover parsing and disabled/no-key behavior
through exported small helpers or by direct provider creation with env mutation
restored in `finally`.

**Verify**:

```bash
npm run build --workspace @synapse/server
npm test --workspace @synapse/server
```

Expected: build succeeds and all server tests pass.

### Step 5: Wire background enrichment into the server without blocking the repo lock

In `apps/server/src/index.ts`:

- Instantiate the provider once near other process-level providers:

```ts
const mediatorResolutionProvider = createOpenRouterMediatorProvider();
```

- Add a helper similar to:

```ts
async function enrichMediatorProposal(repoId: string, proposalId: string): Promise<void> {
  if (!mediatorResolutionProvider) {
    return;
  }
  const changed = await withRepo(repoId, async () => {
    const state = await getState(repoId);
    return enrichResolutionProse(state, proposalId, mediatorResolutionProvider);
  });
  if (changed) {
    const state = await withRepo(repoId, () => getState(repoId));
    broadcast(repoId, envelope("state.snapshot", { teamState: state, seq: bumpRepoSeq(repoId) }));
    fanout?.publish(repoId);
  }
}
```

However, do not hold `withRepo` while awaiting the network request. If
`enrichResolutionProse` calls the provider internally, split the flow into:

1. build a deterministic request under `withRepo`;
2. await `provider.proposeResolution(request)` outside `withRepo`;
3. re-enter `withRepo`, re-check that the proposal is still `resolving` and the
   deterministic facts still match the request, then apply the prose;
4. broadcast a fresh snapshot if changed.

This two-step implementation is preferred even if it requires one extra helper
in `apps/server/src/mediator.ts`.

Call `void enrichMediatorProposal(repoId, proposedId)` after the initial
proposal snapshot is broadcast for a `resolving` proposal. Also call it after
`pickResolutionWinner` schedules the TTL for a semantic proposal that just moved
to `resolving`.

Keep the existing TTL behavior: schedule only when status is `resolving`, and
do not schedule anything for `awaiting_owner`.

**Verify**:

```bash
npm run build --workspace @synapse/server
npm test --workspace @synapse/server
npm run verify:mediator
```

Expected: build/test pass; mediator verifier still passes existing
resolve/reject/semantic/timeout cases with no OpenRouter key.

### Step 6: Update public comments and docs

Update `packages/protocol/src/index.ts` only for comments, not wire shape:

- `Direction.summary` should say deterministic prose by default, optionally
  enriched by mediator LLM adapt prose.
- `ResolutionProposal` should still document that decisions/statuses are
  deterministic/owner-driven.

Update `README.md`:

- In the LLM table, clarify that mediator resolution has deterministic
  proposal semantics, with optional LLM-authored adapt prose when configured.
- In "Resolution mediator (preview)", replace "does not use an LLM for mediator
  decisions" with the new boundary: the LLM can phrase adapt guidance only; it
  cannot choose winners, change `after`, alter detection verdicts, or edit code.
- In the Privacy note, distinguish the older CLI contract resolver (full file +
  neighbors) from mediator adapt prose (symbol/signature/call-site metadata
  only).

Update `.env.example`:

- Note that `SYNAPSE_LLM_RESOLVE=0` disables both the old contract resolver and
  mediator adapt prose.
- Update the privacy note with the same distinction as README.

Update `docs/adr/0002-llm-resolution-mediator-suggest-only.md`:

- Mark the #112 open questions as decided: server-hosted mediator, owner picks
  semantic winner, deterministic state owns signatures/call sites.
- Add that this slice implements optional LLM-authored adapt prose only.
- Leave issue #114 Owner visibility as remaining work if you mention it.

Update `plans/README.md` row 059 to `DONE` only after implementation and
verification.

**Verify**:

```bash
npm run format:check
```

Expected: exit 0.

### Step 7: Full verification and commit

Run the full relevant gate set:

```bash
npm run build
npm run typecheck
npm test --workspace @synapse/protocol
npm test --workspace @synapse/conflict-engine
npm test --workspace @synapse/server
npm run verify:mediator
npm run lint
npm run format:check
```

Expected:

- all commands exit 0;
- lint may show existing warnings, but no errors;
- no test depends on a real OpenRouter call;
- with no `OPENROUTER_API_KEY`, mediator directions remain deterministic.

Before committing, inspect scope:

```bash
git status --short
git diff --stat
git diff --check
```

Expected:

- only in-scope files changed;
- `git diff --check` prints nothing and exits 0.

Commit:

```bash
git add \
  packages/conflict-engine/src/mediator.ts \
  packages/conflict-engine/src/mediator.test.ts \
  packages/conflict-engine/src/index.ts \
  packages/protocol/src/index.ts \
  apps/server/src/mediator.ts \
  apps/server/src/mediator.test.ts \
  apps/server/src/index.ts \
  apps/server/src/mediator-openrouter.ts \
  README.md \
  .env.example \
  docs/adr/0002-llm-resolution-mediator-suggest-only.md \
  plans/README.md \
  plans/059-mediator-llm-adapt-prose.md
git commit -m "feat(mediator): add llm adapt prose enrichment"
```

## Test plan

- `packages/conflict-engine/src/mediator.test.ts`:
  - request construction contains deterministic symbol/signature/call-site
    facts;
  - no provider/no prose keeps existing summaries;
  - valid prose enriches only `adapt`;
  - invented file paths/signatures are rejected.
- `apps/server/src/mediator.test.ts`:
  - no-provider path no-ops without calls;
  - provider exceptions no-op;
  - enrichment does not mutate proposal status/class/after/accepted fields;
  - awaiting-owner semantic proposals are not enriched;
  - post-owner-pick semantic proposals can be enriched.
- Existing protocol/server verifier tests:
  - `npm test --workspace @synapse/protocol`
  - `npm test --workspace @synapse/conflict-engine`
  - `npm test --workspace @synapse/server`
  - `npm run verify:mediator`

## Done criteria

All must hold:

- [ ] `proposeResolution` provider interface exists for mediator adapt prose and
      can be injected in tests.
- [ ] No-provider configuration produces the exact deterministic directions
      from plans 056-058 and does not call a provider.
- [ ] Configured/fake provider can enrich the `adapt` direction summary with
      grounded LLM prose.
- [ ] Grounding validation rejects invented call-site file paths and invented
      signature snippets.
- [ ] Provider output cannot change detection verdicts, proposal class/status,
      owner winner choice, `before`, `after`, `acceptedBy`, `candidates`, or TTL
      behavior.
- [ ] Server does not await network/LLM calls while holding the per-repo
      `withRepo` lock.
- [ ] Docs describe the new boundary and privacy behavior.
- [ ] `npm run build` exits 0.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm test --workspace @synapse/protocol` exits 0.
- [ ] `npm test --workspace @synapse/conflict-engine` exits 0.
- [ ] `npm test --workspace @synapse/server` exits 0.
- [ ] `npm run verify:mediator` exits 0.
- [ ] `npm run lint` exits 0, with no errors.
- [ ] `npm run format:check` exits 0.
- [ ] `git diff --check` exits 0.
- [ ] `plans/README.md` marks plan 059 `DONE`.

## STOP conditions

Stop and report back instead of improvising if:

- The live code at the excerpts above no longer matches after the drift check.
- Implementing this appears to require changing detection rules or detection
  verdicts.
- Implementing this appears to require changing the `ResolutionProposal` wire
  shape or bumping `PROTOCOL_VERSION`.
- The only feasible design waits on a network/LLM request while holding the
  server's per-repo `withRepo` lock.
- Grounding cannot be enforced without sending raw source code to the LLM.
- Any verification command fails twice after a focused fix attempt.

## Maintenance notes

- Reviewers should scrutinize the provider boundary: LLM text must be
  optional, additive, and unable to alter proposal state.
- Reviewers should check that no raw source or full file context is sent by the
  new mediator prose provider. The older CLI resolver's privacy behavior is
  separate and already documented.
- Issue #114 will surface resolving/awaiting-owner state in Owner visibility;
  this plan should not add UI.
- Future protocol changes may eventually add provenance for summaries, but this
  plan deliberately avoids a wire change by enriching the existing
  `Direction.summary`.
