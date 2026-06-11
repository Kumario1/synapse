# Plan 011: Spike `synapse onboard` — a first-session deep briefing on the RAG layer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c46a61..HEAD -- apps/cli/src/briefings.ts apps/cli/src/daemon.ts apps/cli/src/mcp.ts apps/cli/src/commands apps/cli/src/index.ts packages/protocol/src/index.ts`
> If any of these changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> Known in-flight drift: plan 004 (daemon input hardening) was being executed
> in this worktree when this plan was written — it shifts
> `apps/cli/src/daemon.ts` line numbers by roughly +14 and routes request-body
> parsing through `JsonBodyError`. The `/tools/synapse_whatsup` and
> `/tools/synapse_why` handlers survive unchanged in substance. Re-anchor by
> handler path strings, not line numbers; that change alone is NOT a STOP
> condition — your new handler should match whatever body-parsing idiom the
> merged `synapse_why` handler then uses.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (new user-facing surface; must degrade cleanly without RAG)
- **Depends on**: none (RAG C1/C2 already merged, PR #47)
- **Category**: direction (C4 first slice — "onboarding mode" from the vision doc)
- **Planned at**: commit `8c46a61`, 2026-06-11

## Why this matters

The vision doc (`synapse-context.md`, Phase 3) promises an **onboarding
mode**: "new hire's agent gets briefed in one conversation" — and calls the
accumulated team memory the product's moat. It was deferred because it
needed a vector memory; that blocker is gone (PR #47 shipped pgvector
`VectorMemory`, hybrid `synapse why`, and an authed `POST /recall`). What's
missing is purely composition: today's `SessionStart` catch-up
(`sessionStartBriefing`) is a *diff* briefing ("what changed while you were
away") — useless to someone with no "away" baseline. This spike builds
`synapse onboard`: a one-shot deep briefing for a member's first session in
a room, composed from existing pieces — the full whatsup digest plus
`why`-style recall over the room's decision history, with the same numbered
citations.

It is a spike: deterministic floor, additive RAG, one new daemon endpoint,
one CLI command, one MCP tool, one verify script. No new storage, no LLM
calls, no server changes.

## Current state

- `apps/cli/src/briefings.ts` — pure render/build functions:
  - `sessionStartBriefing(briefing, selfSessionId)` (lines 12–58) — the
    existing catch-up text builder; returns `null` when nothing is new. Use
    it as the *style* exemplar (sections with `•` bullets, emoji-prefixed
    header).
  - `buildWhatsupResponse(state, {degraded, limit})` (line 60) — the
    deterministic team digest.
  - `buildWhyResponse(state, question, {degraded, limit})` (lines 134–163) —
    lexical-floor memory search; answer format is
    `Found N Synapse memor(ies) related to "Q":` + numbered `title — summary`
    lines.
  - `mergeRecallIntoWhy(response, matches, limit)` (lines 172–209) — folds
    vector matches in *additively* (floor sources keep rank, dedupe by
    `reference ?? title`, sets `rag: true`). Reuse this exact mechanism.
- `apps/cli/src/daemon.ts`:
  - `/tools/synapse_whatsup` handler (lines 305–316) and `/tools/synapse_why`
    handler (lines 318–345) — the composition pattern to copy. The why
    handler shows the hybrid idiom:

    ```ts
    const floor = buildWhyResponse(teamState, body.question, { degraded: ..., limit: body.limit });
    const merged =
      process.env.SYNAPSE_RAG === "0"
        ? floor
        : mergeRecallIntoWhy(floor, await fetchRecall(config, body.question, body.limit), body.limit);
    ```

  - `fetchRecall(config, query, limit)` (line 586) — POSTs the server's
    `/recall`; returns `[]` on any failure. Reuse as-is.
  - `degraded` flag convention: `socket?.readyState !== WebSocket.OPEN`.
- `apps/cli/src/commands/whatsup.ts` — the exemplar CLI command (15 lines):
  `parseFlags` → `commandDefaults` → `postJson('http://localhost:<port>/tools/synapse_whatsup', …)`
  → `console.log(JSON.stringify(response, null, 2))`. Match it exactly.
- `apps/cli/src/index.ts` — the dispatcher (≈119 lines): maps command names
  to `run<Command>` imports from `commands/`. Add `onboard` here.
- `apps/cli/src/mcp.ts` — `server.registerTool` blocks at lines 50–276; each
  defines a zod input schema and `daemonPost(args.port ?? defaultPort, "<tool>", request)`.
  `synapse_whatsup` (line 248) is the simplest exemplar.
- `packages/protocol/src/index.ts` — request/response interfaces for the
  existing tools (`SynapseWhatsupRequest/Response`, `SynapseWhyRequest/Response`,
  `RecallMatch`). New types go next to them, same naming style.
- Verify-script conventions: hermetic Node scripts `scripts/verify-*.mjs`,
  auto-discovered by `scripts/ci-verify-all.mjs`; add an npm alias
  `"verify:onboard": "npm run build && node scripts/verify-onboard.mjs"` in
  the root `package.json` (match neighbors at lines 22–67). Scripts that
  need Postgres/pgvector gate on `SYNAPSE_VERIFY_PG_URL` and print a SKIP
  line otherwise — see `scripts/verify-why-rag.mjs` for the pattern.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Build all | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | all pass |
| New verify | `npm run verify:onboard` | prints PASS lines, exit 0 |
| Adjacent verifies stay green | `node scripts/ci-verify-all.mjs --only why,why-rag,whatsup 2>/dev/null \|\| npm run verify:why` | exit 0 |

(If `--only whatsup` names no script, drop it — check `ls scripts/verify-*.mjs` first.)

## Scope

**In scope**:
- `packages/protocol/src/index.ts` — add `SynapseOnboardRequest`/`SynapseOnboardResponse`
- `apps/cli/src/briefings.ts` — add `buildOnboardResponse(...)` (pure)
- `apps/cli/src/briefings.test.ts` or the existing CLI test location — unit tests (see Test plan)
- `apps/cli/src/daemon.ts` — add the `/tools/synapse_onboard` handler
- `apps/cli/src/commands/onboard.ts` (create) + the dispatcher entry in `apps/cli/src/index.ts`
- `apps/cli/src/mcp.ts` — register `synapse_onboard`
- `scripts/verify-onboard.mjs` (create) + the root `package.json` alias
- `README.md` — one feature-table row + one short usage block

**Out of scope** (do NOT touch):
- `apps/server/**` — the server already exposes `/recall`; no server changes.
- `apps/cli/src/hooks.ts` — wiring onboard into the SessionStart hook
  (auto-detecting "first session") is a deliberate follow-up, not this spike.
- `packages/conflict-engine`, analyzers, store, fan-out.
- Any LLM/OpenRouter call — this briefing is deterministic + vector recall only.

## Git workflow

- Branch: `advisor/011-onboard-briefing`
- Conventional commits, e.g. `feat(cli): synapse onboard — first-session deep briefing (C4 slice)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Protocol types

In `packages/protocol/src/index.ts`, next to `SynapseWhyResponse`, add:

```ts
export interface SynapseOnboardRequest {
  repoId: string;
  sessionId: string;
  limit?: number;     // per-section cap, same clamp semantics as why
}

export interface SynapseOnboardResponse {
  repoId: string;
  generatedAt: string;
  degraded: boolean;          // daemon↔server socket not OPEN
  rag?: boolean;              // true when vector recall contributed
  briefing: string;           // the rendered text an agent injects as context
  sections: {
    activity: SynapseWhatsupResponse;        // the full digest
    decisions: SynapseWhySource[];           // resolutions/summaries/events, cited
  };
}
```

**Verify**: `npm run typecheck` → exit 0.

### Step 2: `buildOnboardResponse` in `briefings.ts` (pure, deterministic floor)

Signature: `buildOnboardResponse(state: TeamState, options: { degraded: boolean; limit?: number }): SynapseOnboardResponse`.

Behavior:
1. `activity` = `buildWhatsupResponse(state, options)` (reuse).
2. `decisions` floor = the why-source list built from the room's durable
   memory with **no question filter**: take `whySources(state)` ordering by
   recency (`createdAt` desc) capped at the clamped limit. `whySources` is
   currently module-private (line 211) — export it or add a thin
   `recentWhySources(state, limit)` next to it; do not duplicate its logic.
3. `briefing` = rendered text in the `sessionStartBriefing` style: a
   `🧭 Synapse onboarding briefing for <repoId>:` header, then sections —
   active sessions, recent pushes, recent GitHub activity, teammates'
   unpushed contract changes (all from `activity`), then
   `Decisions & history:` as numbered `title — summary` citation lines
   (same format as the why answer, lines 150–153). Empty room → a briefing
   that says the room has no recorded history yet (never `null` — unlike the
   catch-up, an onboarding request always deserves an answer).

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Daemon endpoint with additive RAG

In `apps/cli/src/daemon.ts`, after the `synapse_why` handler (line ~345),
add `POST /tools/synapse_onboard`:

1. Floor: `buildOnboardResponse(teamState, { degraded: socket?.readyState !== WebSocket.OPEN, limit: body.limit })`.
2. RAG (skip when `process.env.SYNAPSE_RAG === "0"`): call
   `fetchRecall(config, q, body.limit)` for a *fixed, deterministic* query
   derived from the room — use the literal query
   `"key decisions, architecture choices, and gotchas in this repository"`.
   Fold matches into `decisions` using the same dedupe rule as
   `mergeRecallIntoWhy` (key = `reference ?? title`, appended after floor
   sources, capped); set `rag: true` and re-render `briefing` when anything
   was added. Reuse `mergeRecallIntoWhy` by mapping through a
   `SynapseWhyResponse` if that is simpler than duplicating the dedupe —
   either is acceptable; duplicated *logic* is not.
3. Count a metric: `metrics.count("synapse_onboard_total")` (and
   `synapse_onboard_rag_total` when rag contributed) — match the
   `synapse_why_rag_total` idiom at line 341.

**Verify**: `npm run build` → exit 0, then a smoke test:
`node apps/cli/dist/index.js onboard --help 2>&1 || true` (command not wired
yet — just confirm the build).

### Step 4: CLI command + dispatcher + MCP tool

1. `apps/cli/src/commands/onboard.ts` — copy `whatsup.ts` verbatim, change
   the path to `/tools/synapse_onboard` and the export to `runOnboard`.
2. Wire `onboard` into the dispatcher in `apps/cli/src/index.ts`, matching
   how `whatsup` is wired (import + case/map entry + help text line).
3. `apps/cli/src/mcp.ts` — `server.registerTool("synapse_onboard", …)`
   modeled on the `synapse_whatsup` block (line 248): description must tell
   the agent *when* to call it ("Call once at the start of your first
   session in a repository to absorb the team's history: activity, decisions,
   and cited memories."), zod schema `{ repoId?, sessionId?, limit?, port? }`
   matching whatsup's.

**Verify**: `npm run build && npm test` → exit 0; manually:
start nothing, run `node apps/cli/dist/index.js onboard` in a temp dir →
clean connection-refused-style error (same behavior as `whatsup` with no
daemon), not a stack trace, exit code non-zero.

### Step 5: `scripts/verify-onboard.mjs`

Model the harness on `scripts/verify-why-rag.mjs` (it already boots a
server + daemon and stubs embeddings). Assertions:

1. **Floor (no Postgres needed)**: server + one daemon (alice), seed via the
   existing tool endpoints — a `synapse_report` contract delta, a push, a
   resolution or session summary (see how `verify-why-rag.mjs` or
   `verify-adaptive-severity.mjs` seed state). `POST /tools/synapse_onboard`
   → response has `briefing` containing the repoId, a pushes section, and at
   least one numbered decision line; `rag` absent/false; `degraded: false`.
2. **Empty room**: fresh repoId → `briefing` states there is no history yet;
   exit 0, never a throw.
3. **RAG (gated)**: when `SYNAPSE_VERIFY_PG_URL` is set, configure the stub
   embedding provider exactly as `verify-why-rag.mjs` does, index a memory
   whose prose does NOT lexically overlap the seeded floor content, call
   onboard → that memory appears in `sections.decisions` and `rag === true`.
   Without the env var, print `SKIP (no SYNAPSE_VERIFY_PG_URL)` for this
   section and still exit 0.

Add the root alias `"verify:onboard"` next to `"verify:why-rag"` in
`package.json`.

**Verify**: `npm run verify:onboard` → PASS lines for sections 1–2 (and 3
or its SKIP), exit 0.

### Step 6: README

Add one row to the features `<table>` (after "Memory search"):
`synapse onboard` — first-session deep briefing: full team digest + cited
decision history, vector-recall-enriched when RAG is configured. And a
two-line usage mention near the `synapse why` documentation.

**Verify**: `grep -n 'onboard' README.md` → ≥ 2 matches.

## Test plan

Unit tests for the pure builder, colocated the way existing CLI tests are
(check `ls apps/cli/src/*.test.ts` — if none exist, put
`briefings.test.ts` next to `briefings.ts` using `node --test` style like
`packages/conflict-engine/src/adaptive.test.ts`):

1. populated state → briefing contains all non-empty sections, numbered
   decision citations, `degraded` passthrough;
2. empty state → "no recorded history" text, `sections.decisions` empty;
3. limit clamping matches `why`'s (reuse its clamp, test one over-limit value);
4. dedupe: a recall match whose `reference` equals a floor source's is not
   appended twice (if you reused `mergeRecallIntoWhy`, this is covered by
   its existing tests — then test your mapping instead).

Verification: `npm test` → all pass including the new file;
`npm run verify:onboard` → exit 0.

## Done criteria

- [ ] `npm run build`, `npm run typecheck`, `npm test` all exit 0
- [ ] `npm run verify:onboard` exits 0 (floor + empty-room sections PASS; RAG section PASS or explicit SKIP)
- [ ] `node scripts/ci-verify-all.mjs --only why-rag` still exits 0
- [ ] `synapse onboard` appears in CLI help output and `synapse_onboard` in `mcp.ts`
- [ ] No files outside the in-scope list modified (`git status --porcelain`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `whySources` cannot be exported/wrapped without changing its behavior for
  `buildWhyResponse` (e.g. it turns out to be stateful) — report instead of
  forking the logic.
- The fixed recall query keeps returning zero matches against the
  `verify-why-rag.mjs` stub provider — the stub may be synonym-group-based
  and incompatible with a generic query; report the stub's matching rules
  rather than inventing a different query scheme.
- Wiring the dispatcher requires touching hook installation
  (`apps/cli/src/hooks.ts`) — that's the deferred follow-up; stop.
- Any step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Deliberate follow-up (not this spike): auto-run onboard from the
  SessionStart hook when the daemon sees a member's first-ever session in a
  room (`hooks.ts:162` `runSessionStartHook` is the seam; "first session"
  needs a durable has-been-briefed marker — design that then).
- The fixed recall query is a placeholder heuristic; if/when per-question
  onboarding ("ask the room anything") is wanted, that's `synapse why` —
  keep onboard a digest, don't grow a question parameter into it.
- Reviewer focus: the briefing must never throw on sparse/empty rooms, and
  RAG failures must never degrade the floor (same contract as `synapse_why`).
