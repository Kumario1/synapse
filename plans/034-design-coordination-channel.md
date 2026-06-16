# Plan 034: Design a direct decision/coordination channel (design + spike)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- packages/protocol/src/index.ts apps/server/src/index.ts apps/server/src/state.ts apps/server/src/memory.ts apps/cli/src/mcp.ts packages/conflict-engine/src/explain.ts`
> These are the seams the design must cite. If any changed since this plan was
> written, re-read it before citing line numbers; a moved seam is not a STOP for
> a design doc, but your citations must be accurate.
>
> **Adjacent concurrent plans (verified 2026-06-13)**: a separate audit at this
> same commit produced plans 017–031 (executed in isolated worktrees, NOT merged
> into HEAD). Three are adjacent and the design MUST position against them so it
> does not duplicate: 029 (MCP-native context *resources* — read-side), 013
> (distilled PR-thread prose into memory — passive capture), 030 (`synapse
> insights` — value metrics). This design is the missing *write* channel for
> agent-authored decisions/notes; state how it differs from each.

## Status

- **Priority**: P2
- **Effort**: M (design only — no production code)
- **Risk**: LOW (this plan produces a design document; zero source changes)
- **Depends on**: none (informed by Plans 032/033 but independent)
- **Category**: direction
- **Planned at**: commit `e3c46f2`, 2026-06-13

## Why this matters

Synapse's thesis is that human coordination rituals (Slack, standups) break when
agents do the typing — yet today, when Synapse detects a real collision, the
loop **dead-ends at a warning string**. The PreToolUse output lists the conflict
and a suggestion, and the only structured `actions` an agent can act on are
read-only tool calls — `synapse_whatsup`, `synapse_why`
(`packages/conflict-engine/src/explain.ts`, surfaced via `apps/cli/src/hooks.ts:241`).
There is no way for the blocked agent (or developer) to **leave a note for the
teammate editing that symbol**, record the decision they just made, or negotiate
intent. The resolution of a detected conflict is still, in effect, "go talk to
your teammate in Slack."

This is also the missing half of the **memory** pillar. Memory accretes only
*passively* — session summaries, contract resolutions, and GitHub repo events
(`apps/server/src/index.ts:527` `indexMemory`). Scenario 03 from the vision ("a
decision made in Slack at 4pm" that agents never receive) has **no capture path**
short of the deferred Slack ingestion. An agent or developer cannot say "record
this decision" directly.

One primitive plausibly closes both gaps: a lightweight, durable **note /
decision** an agent or developer writes — optionally addressed to a symbol or a
session — that (1) feeds the existing memory/`why`/`onboard` surfaces and (2)
surfaces on the counterpart's next `synapse_check`. This plan **designs** that
primitive and its product boundaries; it deliberately writes no code, because the
shape is a product decision (how much coordination before Synapse becomes the
"central orchestrator" the vision explicitly rejects). The owner reviews the
design before any implementation plan is written — the same discipline used for
the D3 broadcast design (`plans/009`).

## Current state

Read each before writing; the design must cite real `file:line`:

- `apps/server/src/index.ts:527-566` — `indexMemory(repoId, message)` indexes
  exactly three message kinds into vector memory (`session.summary`,
  `resolution.propose`, `repo.event`). A new "decision" would slot in here.
- `apps/server/src/state.ts:93-107` — the `repo.event` handler
  (`addRecentRepoEvent`): a locally-originated decision could reuse the
  `RecentRepoEvent` shape (it already has `detail` prose and flows to memory) or
  warrant its own entity. Evaluate both.
- `packages/protocol/src/index.ts:185-219` — `ConflictAction` already has an
  `audience: "you" | "counterpart" | "both"` and an optional `command`
  (validated against the command catalog). This is the seam for surfacing a
  note *to the counterpart* on a check.
- `packages/protocol/src/index.ts:283-289` — `EditLock` and the `edit.intent`
  message exist; locks are acquired on check (`apps/cli/src/daemon.ts:405`) but
  there is **no** CLI/MCP surface to deliberately claim/release one. A
  "claim this symbol" affordance is an alternative/companion to a note —
  evaluate it.
- `apps/cli/src/mcp.ts:51-330` — the MCP tool registrations (`synapse_check`,
  `synapse_report`, `synapse_feedback`, `synapse_push`, `synapse_session`,
  `synapse_whatsup`, `synapse_onboard`, `synapse_why`). A new tool is registered
  here; match the existing shape (zod `inputSchema`, `annotations`,
  `daemonPost`).
- `packages/protocol/src/command-catalog.ts` (referenced by
  `apps/cli/src/hooks.ts:246` and the LLM prompt) — the allowlist of tools a
  suggested `command` may name. A new tool added to coordination must be added
  here to be suggestable.
- `apps/cli/src/briefings.ts:352-438` — `whySources` maps state entities into
  `why`/`onboard` sources; a decision entity must appear here to be recalled.
- Design principles the proposal must not violate (`synapse-context.md` §12):
  "agents query, agents decide" (no central orchestrator deciding for agents),
  "store distillations, not raw content," "Synapse clears itself" (in-flight
  state self-clears on push — does a decision self-clear or persist as memory?),
  "silent on no-conflict."
- The prior design doc to match for format/depth: `docs/design/state-delta-broadcast.md`
  (produced by `plans/009`).

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Confirm memory index sites | `grep -n 'memory.index' apps/server/src/index.ts` | the 3 index calls in `indexMemory` |
| Confirm ConflictAction audience | `grep -n 'audience' packages/protocol/src/index.ts` | the `ConflictAction` definition |
| Confirm no doc exists yet | `ls docs/design/coordination-channel.md 2>/dev/null` | no such file |

## Scope

**In scope** (the only file you create):
- `docs/design/coordination-channel.md` (the `docs/design/` directory already
  exists)

**Out of scope** (do NOT touch):
- ALL source code — `packages/protocol`, `apps/server`, `apps/cli`,
  `packages/conflict-engine`. No type additions, no "harmless" stubs. The
  implementation happens in follow-up plans after the owner reviews this design.
- `synapse-context.md`, `plan-future.md`, `README.md` — the owner maintains the
  product/roadmap docs.

## Git workflow

- Branch: `advisor/034-design-coordination-channel`
- One commit, conventional style: `docs(design): direct coordination/decision channel`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Read the listed seams and principles

Read every `file:line` in "Current state", plus `synapse-context.md` §§2 (the
four scenarios, esp. Scenario 03), §4 ("Not a central orchestrator"), §12
(design principles), and the existing `docs/design/state-delta-broadcast.md` for
format. Take notes; the design must cite real seams.

**Verify**: `grep -n 'audience' packages/protocol/src/index.ts` → confirms the
`ConflictAction.audience` field exists; write into your notes that this is the
surfacing seam for a counterpart-addressed note.

### Step 2: Write `docs/design/coordination-channel.md`

The document MUST contain these sections; each must **choose** an option and
justify it, not merely list options:

1. **Problem & scope** — the dead-end warning and the passive-only memory gap,
   each with a `file:line` citation. State explicitly what is NOT in scope (this
   is a coordination *note*, not task assignment, not auto-blocking — cite the
   "agents decide / not an orchestrator" principle).
2. **The entity** — define the new record (proposed name e.g. `Decision` or
   `CoordinationNote`). Fields: id, repoId, authoring session/member, the prose
   body (capped, code-stripped — reuse `distillProse`?), an optional **target**
   (a `SymbolId`, a `filePath`, a counterpart `sessionId`, or none = room-wide),
   createdAt, and a lifecycle marker. Decide: **reuse `RecentRepoEvent`** (it
   already carries `detail` prose and flows to memory) **vs. a dedicated
   entity**. Recommend one; justify against the cost of a new entity (store
   table, wire message, schema, briefing source, memory index, cap).
3. **Lifecycle / clearing** — the hardest product question. Does a note
   self-clear like in-flight deltas (`Synapse clears itself`) or persist as
   durable memory (the moat)? Propose a rule (e.g. targeted notes clear when the
   target symbol is pushed; room-wide decisions persist as memory). Tie to the
   existing `clearPushedLiveState` behavior (`apps/server/src/state.ts:286`).
4. **Write surface** — the new MCP tool (e.g. `synapse_note` / `synapse_decision`)
   registered in `apps/cli/src/mcp.ts` and a matching CLI command + daemon
   endpoint, plus its `command-catalog.ts` entry so the LLM/deterministic layer
   can *suggest* it as a `ConflictAction.command`. Specify the tool's
   `inputSchema` and `annotations` in the style of the existing tools. State
   clearly that writing a note is the agent's/developer's choice (no auto-write).
5. **Read surface** — how a targeted note reaches the counterpart: on the next
   `synapse_check`, a note targeting the checked symbol/file is surfaced as a
   `Conflict` (or a new advisory entry) with `counterpart`-addressed text. Decide
   whether it rides the existing `Conflict`/`ConflictAction` shape or a new
   advisory list on `SynapseCheckResponse`. Address how it appears in
   `synapse whatsup`/`onboard`/`why` (via `whySources`).
6. **Memory integration** — how it feeds `indexMemory` (a new `else if` branch)
   and `SynapseWhySourceKind` (a new kind). Confirm only prose is embedded
   (privacy boundary), citing `apps/server/src/memory.ts` and `distillProse`.
7. **The orchestrator boundary** — explicitly argue why this stays "agents
   decide": the note is information surfaced to the *reading* agent/human, never
   a directive Synapse enforces; no auto-block; no Synapse-initiated messaging
   to a human out-of-band. This is the section the owner will scrutinize most.
8. **Alternative: lock claim/release** — evaluate the companion idea of exposing
   the existing `EditLock`/`edit.intent` as a deliberate "claim this symbol"
   tool (vs. the implicit 90s lock on check). Decide whether it is part of this
   primitive, a separate future feature, or rejected; justify.
9. **Privacy, caps, opt-out** — distillation/cap rules, a `SYNAPSE_*=0` opt-out,
   and a per-entity cap consistent with `RECENT_REPO_EVENT_CAP` etc.
   (`apps/server/src/state.ts:16-19`).
10. **Verification plan** — sketch a `scripts/verify-*.mjs` in the hermetic
    style (model on `scripts/verify-github-briefing.mjs` and
    `scripts/verify-why.mjs`): agent A writes a note targeting a symbol → agent B
    checking that symbol sees it → the note appears in `why`/`onboard`.
11. **Rollout & implementation breakdown** — propose 2–3 follow-up
    implementation plans (e.g. "entity + wire + store", "MCP/CLI write surface +
    catalog", "check-surfacing + memory + verify") with a recommended order, and
    the env opt-out. This is the spike output: a concrete, reviewable plan set,
    not code.
12. **Open questions for the owner** — only what is genuinely unresolvable from
    the code (e.g. should a note ever raise a verdict severity? should it notify
    via GitHub PR comment — an *outbound* integration the repo does not yet have?).

Every claim about current behavior cites `file:line`.

**Verify**: `grep -c '^## ' docs/design/coordination-channel.md` → ≥ 11.

### Step 3: Fact-check your own citations

For each `file:line` citation, re-open the file at that line and confirm the
claim. Fix any that drifted.

**Verify**: `git status --porcelain` → only `docs/design/coordination-channel.md`
(plus the `plans/README.md` status edit).

## Test plan

No tests — documentation only. The "tests" are the verification greps above and
the citation fact-check in Step 3.

## Done criteria

- [ ] `docs/design/coordination-channel.md` exists with all 12 required sections
- [ ] Sections 2, 3, 4, 5, and 8 each state a **recommendation**, not an
      options list
- [ ] Every current-behavior claim carries a `file:line` citation that checks out
- [ ] Section 7 explicitly defends the "agents decide / not an orchestrator"
      boundary
- [ ] Section 11 proposes a concrete 2–3 plan implementation breakdown
- [ ] `git status --porcelain` shows no modified source files
- [ ] `plans/README.md` status row for 034 updated

## STOP conditions

Stop and report back (do not improvise) if:

- You find yourself editing any `.ts` file — this plan is documentation-only.
- The seams in "Current state" have drifted so far that the design cannot cite
  them accurately (e.g. `indexMemory` or `ConflictAction` no longer exist in the
  shape described) — report what changed.
- The design appears to require Synapse to *enforce* a decision or message a
  human out-of-band — that crosses the orchestrator boundary; stop and surface
  the tension to the owner rather than designing past it.

## Maintenance notes

- This design is the input to the coordination-channel implementation plans; the
  owner reviews it before any are written (same gate as `plans/009`).
- It composes with Plan 033: both add an "agent reports prose intent" seam. Keep
  truncation, distillation, and opt-out conventions consistent between them.
- If the owner later greenlights Slack/Notion ingestion (deferred in the vision),
  this entity is the natural landing spot for an ingested decision — note that so
  the two designs converge rather than duplicate.
