# Design: A Direct Decision/Coordination Channel (`synapse_note`)

> Status: PROPOSED — written per advisor plan 034; awaiting owner review
> before any implementation plan is written. Ground truth: this worktree at
> commit `8c0d788` (post PR #64), 2026-06-13. Every current-behavior claim
> below cites `file:line` at that commit.

## 1. Problem & scope

**The dead-end warning.** When `synapse_check` detects a real collision, the
response is a `Conflict` whose `analysis.actions` is an ordered list of
`ConflictAction` (`packages/protocol/src/index.ts:185-195`). Each action has
an `audience` (`"you" | "counterpart" | "both"`) and an optional `command`
naming another Synapse tool to call next — but every tool in the command
catalog is **read-only or self-describing**: `synapse_whatsup`,
`synapse_why`, `synapse_report`, `synapse_push`, `synapse_feedback`,
`synapse_session`, `synapse_check`, `synapse_onboard`
(`packages/protocol/src/command-catalog.ts:30-90`). `deterministicAnalysis`
(`packages/conflict-engine/src/explain.ts:94-215`) renders steps like "Agree
on the final signature of `symbol` before either side continues" (the
`contract_divergent` case, line 114) or "Coordinate before you both write to
`symbol`" (`same_symbol_active`, line 191) — but there is **no tool an agent
or developer can call to actually do that agreeing/coordinating**. The hook
surfaces the step as inert prose (`renderActionLine`,
`apps/cli/src/hooks.ts:241-257`, which renders `    ↳ <step> [→ run: <cli>]`
only when `action.command` is set — and for `"both"`-audience steps like the
two above, no command is attached). The loop dead-ends: Synapse told you
there's a collision and that you should "agree," and then has nothing more to
offer.

**The passive-only memory gap.** `indexMemory` (`apps/server/src/index.ts:527-566`)
feeds the vector memory from exactly three message kinds — `session.summary`
(line 531), `resolution.propose` (line 541), and `repo.event` (line 551).
All three are **byproducts of other activity**: a session ending, a conflict
resolution being computed, or a GitHub webhook firing. None of them is "a
person or agent deliberately recording a decision." Scenario 03 from the
product context — "A product decision gets made in Slack at 4pm... The
decision lived in Slack. The agents live in the IDE. There was no bridge"
(`synapse-context.md:56-57`) — has **no capture path** in the current system
short of the deferred Slack ingestion (`synapse-context.md:599`,
"What gets deferred until revenue").

**What is IN scope.** A `CoordinationNote`: a short, prose, optionally-targeted
record that a session (agent or developer, via the agent) deliberately writes
— "I'm taking the `User` interface in this direction because X," "we agreed
in standup that auth stays on JWT for this sprint," "don't touch
`PaymentProcessor.charge` until I push, I'm mid-refactor." It is surfaced (a)
to whoever's `synapse_check` next touches the targeted symbol/file, and (b)
into `synapse_why`/`synapse_onboard` as cited memory.

**What is explicitly NOT in scope:**
- **Task assignment.** Synapse "does not assign tasks, track tickets, or
  manage sprints... It is a coordination layer, not a management layer"
  (`synapse-context.md:118-120`). A note is not a TODO with an owner and a
  due date.
- **Auto-blocking.** Writing a note never raises a conflict's severity or
  changes a verdict. "Agents query, agents decide. Synapse does not make
  decisions on behalf of agents... No central orchestrator"
  (`synapse-context.md:607-608`, "Not a central orchestrator,"
  `synapse-context.md:122-124`).
- **An orchestration directive.** The note is information, like everything
  else Synapse stores — never a command Synapse enforces or that one agent
  can issue *to* another agent's execution.

Adjacent concurrent work this design must not duplicate (per plan 034's
verified note — these exist in separate, unmerged worktrees as of
2026-06-13):
- **Plan 029 (MCP-native context RESOURCES)** is a **read-side** change:
  exposing existing `TeamState` entities as MCP `resources` instead of (or
  alongside) tool-call JSON. It does not add a new entity or a write path —
  this design's `CoordinationNote` would simply become one more resource type
  029 could expose, once it exists.
- **Plan 013 (distill PR-thread prose into memory)** is **passive capture**:
  it widens `indexMemory`'s `repo.event` branch (already line 551-565 here)
  to ingest more of a PR thread's prose automatically, with no new entity and
  no write surface for the *current* session's own session. It addresses
  "what was decided in a GitHub thread," not "what I, the agent running right
  now, want to tell my teammate."
- **Plan 030 (`synapse insights`)** is a **value-metrics rollup** over
  existing state/feedback — read-only aggregation for justifying the tool's
  value to a team lead, not a new entity or write path.

This design is the missing **write** channel: the first time an agent or
developer deliberately tells Synapse "here is a decision, remember it / pass
it to my teammate" rather than Synapse inferring it from a side effect.

## 2. The entity — RECOMMENDED: a dedicated `CoordinationNote`, not a `RecentRepoEvent`

```ts
// packages/protocol — new exported interface
export interface CoordinationNote {
  id: string;
  repoId: string;
  /** The authoring session (always known — every write goes through a session). */
  authorSessionId: string;
  /** Denormalized for display without a session lookup (sessions can end). */
  authorMemberLogin: string;
  /** Prose body, distilled (capped, code-stripped) before storage — see §6. */
  body: string;
  /**
   * Optional target. `none` (room-wide) when omitted. Exactly one of
   * `symbol` / `filePath` / `counterpartSessionId` may be set; `none` is the
   * absence of all three, not a fourth tagged variant — keeps the wire shape
   * additive over the untargeted case.
   */
  target?:
    | { kind: "symbol"; symbolId: SymbolId }
    | { kind: "file"; filePath: string }
    | { kind: "session"; sessionId: string };
  createdAt: string;
  /**
   * `"active"` until cleared (see §3); `"cleared"` notes are retained as
   * memory (indexed) but no longer surfaced on `synapse_check`/`whatsup`.
   * Mirrors `ContractDelta.pushedAt` (null = live) but as an explicit enum
   * because a note's clearing trigger varies by target kind (§3).
   */
  status: "active" | "cleared";
}
```

**Decision: a dedicated entity, not a reuse of `RecentRepoEvent`.**

`RecentRepoEvent` (`packages/protocol/src/index.ts:306-323`) is shaped around
a GitHub webhook: `kind: RepoEventKind` is the closed union
`"pull_request" | "pull_request_review" | "issue_comment"`
(`packages/protocol/src/index.ts:304`), `actor` is a GitHub login string, and
`action`/`number`/`url` are GitHub-specific. Reusing it would mean either (a)
widening `RepoEventKind` with a `"coordination_note"` member that has none of
GitHub's fields populated — a leaky abstraction every consumer of
`recentRepoEvents` (whatsup, why, the GitHub webhook handler itself) would
need to special-case — or (b) overloading `actor`/`title`/`summary` to carry
session-targeting data they were never designed for. Both options make the
*existing* entity worse to save adding a *new* one.

The cost of a new entity, honestly accounted:
- **Store table**: one new table (`coordination_notes`), one set of
  `StateStoreOps` (`upsertCoordinationNote`/`appendCoordinationNote`,
  `clearCoordinationNote`) — same shape as the existing
  `appendRepoEvent`/`appendPush` pair (`apps/server/src/state.ts:275-284`,
  `269-273`).
- **Wire message**: one new `ClientMessage` variant (`"coordination.note"`,
  §4) and one new `applyMessage` case (`apps/server/src/state.ts:39-121`,
  alongside `repo.event` at line 93-107 — same `addRecentRepoEvent`-shaped
  helper, `addCoordinationNote`).
- **`TeamState` field**: `coordinationNotes: CoordinationNote[]`
  (`packages/protocol/src/index.ts:367-380`).
- **Briefing source**: one new map in `whySources`
  (`apps/cli/src/briefings.ts:352-438`, §5/§6).
- **Memory index**: one new `else if` in `indexMemory`
  (`apps/server/src/index.ts:527-566`, §6).
- **Cap**: one new constant alongside `RECENT_REPO_EVENT_CAP`
  (`apps/server/src/state.ts:17`, §9).

This is *exactly* the marginal cost every existing entity
(`RecentPush`, `RecentRepoEvent`, `ConflictFeedback`) already paid — the
codebase's pattern is "new coordination primitive = new entity with this
checklist," not "force-fit into the nearest existing shape." A dedicated
entity also lets `status` and `target` be typed precisely, which a
`RecentRepoEvent.kind` discriminated union could not do without polluting
GitHub-event consumers. **Recommendation: dedicated `CoordinationNote`,
following the `RecentRepoEvent` template exactly (same cap/store/index/source
checklist), but with its own fields.**

## 3. Lifecycle / clearing — RECOMMENDED: targeted notes clear with their target; room-wide notes persist as memory

Three sub-cases, all tied to the existing `clearPushedLiveState`
(`apps/server/src/state.ts:286-324`), which today runs on every
`push.notify` and removes `unpushedDeltas`, `editLocks`, and
`session.filesEditing` entries matching the pushed `files`/`symbols`
(lines 296-317), then re-validates `resolutions` (lines 319-323):

- **`target.kind === "symbol"` or `target.kind === "file"`**: the note is
  "don't touch X until I push" — its purpose ends when X is pushed. Add one
  more filter inside `clearPushedLiveState`: any **active**
  `coordinationNotes` entry whose `target.symbolId.raw`/`target.filePath`
  matches the pushed `files`/`symbols` transitions to `status: "cleared"`
  (not deleted — see below). This is additive to the existing function: one
  more `state.coordinationNotes = state.coordinationNotes.map(...)` alongside
  the existing filters.
- **`target.kind === "session"`** (a note addressed to a specific
  counterpart): clears when **either** side ends — `endSession`
  (`apps/server/src/state.ts:204-221`) is the natural hook: if
  `note.authorSessionId === sessionId || note.target.sessionId ===
  sessionId`, mark `cleared`. A note addressed to someone who is gone is
  noise on `synapse_check` but still a record of "I told them X" for `why`.
- **`target` absent (room-wide)**: never auto-clears. This is the Scenario-03
  case — "we decided X for this sprint" has no natural "done" signal from
  push/session-end. It persists as durable memory exactly like a
  `session.summary` or `resolution.propose` does today (neither of those
  clears on push either — `clearPushedLiveState` touches only
  `unpushedDeltas`/`editLocks`/`filesEditing`/`resolutions`, never
  `sessionSummaries`).

**Why "cleared" not "deleted":** Principle 3, "Synapse clears itself... Once
a change is pushed to GitHub, it's cleared from Synapse"
(`synapse-context.md:613-614`), describes *live, in-flight* state — the
`synapse_check`/`whatsup` surface. A note's *prose* is durable memory the
moment it's written (it was indexed at creation time, §6) — clearing only
removes it from the **live** surfaces (`synapse_check` advisories,
`whatsup`), not from `why`/`onboard`, which read `sessionSummaries`-style
durable history. `status: "cleared"` is the one-bit distinction between "live
advisory" and "historical record," computed once at the clearing trigger
rather than re-derived per read. A cleared note is filtered out of
`coordinationNotes` consumers in §5 but stays in `whySources` (§6) — same
two-tier pattern `unpushedDeltas` already has via `pushedAt: string | null`
(`packages/protocol/src/index.ts:141`, filtered at
`apps/cli/src/briefings.ts:409`).

## 4. Write surface — `synapse_note` (MCP tool + CLI + daemon + wire message)

**Wire message** (`packages/protocol/src/index.ts:642-683`, new
`ClientMessage` variant):

```ts
| WireEnvelope<
    "coordination.note",
    {
      repoId: string;
      sessionId: string;
      body: string;
      target?:
        | { kind: "symbol"; symbolId: SymbolId }
        | { kind: "file"; filePath: string }
        | { kind: "session"; sessionId: string };
    }
  >
```

`repoIdFor` (`apps/server/src/state.ts:124-148`) gets one more case returning
`message.payload.repoId`, identical to `repo.event` (line 138).
`applyMessage` (`apps/server/src/state.ts:32-122`) gets one more case calling
a new `addCoordinationNote` helper (same shape as `addRecentRepoEvent`,
lines 275-284), generating `id`/`createdAt`/`status: "active"` server-side
(matching how `push.notify` generates `id`/`pushedAt`, lines 78-88) and
resolving `authorMemberLogin` from `state.sessions` (same
`memberBySession`-style lookup as `whySources`,
`apps/cli/src/briefings.ts:353-357`).

**Daemon endpoint** (`apps/server/src/index.ts` — alongside the existing
`/tools/synapse_*` POST handlers, e.g. the `synapse_check` handler at
line 399): `POST /tools/synapse_note`, body `SynapseNoteRequest =
{ repoId, sessionId, body, target? }`, response
`SynapseNoteResponse = { ok: true; note: CoordinationNote }`. It validates
`body` is non-empty after `distillProse` (§6/§9 — an all-noise note like
"+1" is rejected the same way `distillProse` returns `undefined` for it,
`apps/server/src/github.ts:151-176`), then `sendToServer("coordination.note",
{...})` exactly as `synapse_check` does for `edit.intent`
(`apps/cli/src/daemon.ts:404-411`).

**MCP tool** (`apps/cli/src/mcp.ts`, registered alongside `synapse_feedback`
at line 136 — matching shape):

```ts
server.registerTool(
  "synapse_note",
  {
    title: "Leave a Synapse Coordination Note",
    description:
      "Record a short decision or note for your team — optionally addressed " +
      "to a symbol, file, or teammate's session. Surfaces to the counterpart " +
      "on their next synapse_check and is recalled by synapse_why/onboard. " +
      "Use this when you've made a decision teammates should know about, or " +
      "want to flag something before editing a shared symbol.",
    inputSchema: {
      ...commonShape,
      body: z.string().min(1),
      symbol: z.string().min(1).optional(),
      filePath: z.string().min(1).optional(),
      counterpartSessionId: z.string().min(1).optional()
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false
    }
  },
  async (args) => {
    const target = args.symbol
      ? { kind: "symbol" as const, symbolId: { raw: args.symbol } }
      : args.filePath
        ? { kind: "file" as const, filePath: args.filePath }
        : args.counterpartSessionId
          ? { kind: "session" as const, sessionId: args.counterpartSessionId }
          : undefined;

    const request: SynapseNoteRequest = {
      repoId: args.repoId ?? defaultRepoId,
      sessionId: args.sessionId ?? defaultSessionId,
      body: args.body,
      target
    };

    return jsonResult(await daemonPost(args.port ?? defaultPort, "synapse_note", request));
  }
);
```

(`annotations` match `synapse_check`/`synapse_report`/`synapse_feedback` —
`readOnlyHint: false` because it mutates shared state, `idempotentHint:
false` because two identical calls create two notes — same as
`synapse_feedback`, lines 160-164.)

**CLI command**: `synapse note "<body>" [--symbol <raw>] [--file <path>]
[--to <sessionId>]` — same flag style as `synapse feedback --conflict-id
<id> --outcome <outcome>` (`packages/protocol/src/command-catalog.ts:60`).

**Command catalog entry** (`packages/protocol/src/command-catalog.ts:30-90`,
new entry so `actions[].command` can suggest it):

```ts
{
  tool: "synapse_note",
  cli: "synapse note",
  when: "To leave a decision or note for a teammate before/instead of blocking on a conflict — e.g. 'I'm taking this symbol in direction X' or 'don't touch this until I push'.",
  args: [
    { name: "body", type: "string", required: true, hint: "the note text" },
    { name: "symbol", type: "string", required: false, hint: "raw symbol id to target, if any" }
  ],
  usage: "synapse note \"<body>\" --symbol <symbol>"
}
```

**Writing is always a choice, never automatic.** Nothing in `applyMessage`,
`indexMemory`, or the conflict engine emits `coordination.note` as a side
effect of anything else — it is the *only* `ClientMessage` variant whose sole
producer is an explicit tool call (`synapse_note`/`synapse note`), the same
way `conflict.feedback` is only ever produced by `synapse_feedback`
(`apps/cli/src/mcp.ts:136-179`) and never inferred. `deterministicAnalysis`
(`packages/conflict-engine/src/explain.ts:94-215`) MAY attach
`{ tool: "synapse_note" }` as a *suggested* `command` on a `"both"`-audience
action (e.g. `contract_divergent`'s "Agree on the final signature..." at
line 114, `same_symbol_active`'s "Coordinate before you both write..." at
line 191) via the existing `withCommand` helper (line 18-29) — but
"suggested" is exactly what every other catalog entry already is: "Synapse
only ever SUGGESTS these commands — nothing here executes them"
(`packages/protocol/src/command-catalog.ts:11`).

## 5. Read surface — ride the existing `Conflict`/`ConflictAction` shape, addressed via a synthetic conflict

**Decision: a targeted note surfaces on the counterpart's next
`synapse_check` as a new, synthetic `Conflict` with `rule:
"coordination_note"` and `severity: "info"`** — not a new top-level list on
`SynapseCheckResponse`.

Why ride the existing shape rather than add `advisories:
CoordinationNote[]` to `SynapseCheckResponse`
(`packages/protocol/src/index.ts:440-444`):
- Every consumer of a `synapse_check` response — the PreToolUse hook
  (`apps/cli/src/hooks.ts`, the `renderActionLine`/heading logic around
  lines 200-233), the MCP tool's raw JSON passthrough
  (`apps/cli/src/mcp.ts:71-86`), and any future consumer — already knows how
  to render a `Conflict`: `detail`, `suggestion`, `counterpart`,
  `analysis.actions`. A new top-level array would need its own rendering path
  in the hook (a second heading, a second loop) for what is, from the
  reader's point of view, the same kind of thing: "here's something about
  this symbol you should know before you edit it."
- `severity: "info"` already exists in `Severity`
  (`packages/protocol/src/index.ts:67`) and is the correct level: a note
  never raises `verdict` past `"info"` on its own (it cannot turn a clean
  check into a `"warn"`) — `verdictFor`
  (`packages/conflict-engine/src/index.ts:51-60`) takes the max severity
  across conflicts (`"warn"` if any conflict is `"warn"`, else `"info"` if
  any is `"info"`, else `"none"`), so an `"info"`-only note alongside zero
  other conflicts yields `verdict: "info"`, distinct from today's
  `verdict: "none"` (silent) but below `"warn"` (the threshold that triggers
  the hook's "ask" permission decision, `apps/cli/src/hooks.ts:226-232` vs the
  nonblocking `additionalContext` path at 216-224). This needs a small
  widening: today `evaluateConflicts` only returns the seven rules in
  `Conflict["rule"]`
  (`packages/protocol/src/index.ts:386-393`); add an eighth,
  `"coordination_note"`, synthesized by the daemon's check handler (not the
  conflict-engine's `evaluateConflicts`, since it isn't a contract-graph
  finding) by scanning `state.coordinationNotes` for active entries whose
  `target` matches one of the request's `files`/`symbols`, or whose
  `target.kind === "session"` matches `request.sessionId`.
- `Conflict.counterpart` (`packages/protocol/src/index.ts:395-401`) maps
  naturally: `memberLogin`/`sessionId`/`agentType`/`branch` of the note's
  *author* (looked up from `state.sessions` the same way
  `whySources`/`addCoordinationNote` do). `Conflict.detail` becomes the
  note's `body` (already distilled, §6/§9 — short enough to use directly,
  no truncation needed beyond what storage already capped).
  `Conflict.analysis` is the **deterministic** floor only — no LLM
  enrichment needed for a note (it's already prose from a human/agent, not a
  diff needing analysis): `assessment: note.body`, `recommendation: "info"`,
  `actions: [{ audience: "you", step: "Acknowledge or reply with
  synapse_note." }]` with `command: { tool: "synapse_note" }` via
  `withCommand` — closing the loop (§1's dead-end) by letting the reader
  reply in kind.
- **No verdict-severity escalation beyond `"info"`.** This is the orchestrator
  boundary (§7): a note is "FYI," never "BLOCK." If the owner later wants a
  note to be able to say "this is a `warn`," that is a *separate*,
  explicitly-reviewed escalation (flagged in §12, not decided here).

**`whatsup`/`onboard`/`why` via `whySources`** (§6 covers the memory-index
side; this is the *live-state* side): `buildWhatsupResponse`
(`apps/cli/src/briefings.ts:61`) gains one more field,
`coordinationNotes: CoordinationNote[]` (filtered to `status: "active"`), on
`SynapseWhatsupResponse` (`packages/protocol/src/index.ts:529-542`) —
mirroring `editLocks`/`recentRepoEvents` already there. `sessionStartBriefing`
(`apps/cli/src/briefings.ts:13-59`) gets one more `sections.push(...)` block,
"Notes for you:" — filtered to notes whose `target.kind === "session" &&
target.sessionId === selfSessionId`, or room-wide notes, excluding the
reader's own (mirrors the `othersDeltas`/`summaries` self-filtering at
lines 34, 44).

## 6. Memory integration — new `indexMemory` branch + new `SynapseWhySourceKind`

**`indexMemory`** (`apps/server/src/index.ts:527-566`) gets a fourth
`else if`:

```ts
} else if (message.type === "coordination.note") {
  const note = message.payload;
  memory.index(repoId, {
    id: `note:${note.id}`,  // note.id assigned by addCoordinationNote before indexMemory runs
    kind: "coordination_note",
    title: `${note.authorMemberLogin}'s note${note.target ? ` on ${targetLabel(note.target)}` : ""}`,
    summary: note.body,
    reference: note.target?.kind === "symbol" ? note.target.symbolId.raw : undefined,
    createdAt: note.createdAt
  });
}
```

This follows the `repo.event` branch's comment exactly: "Only prose...
embedded — never raw code" (`apps/server/src/index.ts:524-526`). `note.body`
is **already** the output of `distillProse` (applied at write time in the
daemon's `/tools/synapse_note` handler, §4/§9) — `indexMemory` indexes it
verbatim, same as `repo.event`'s `message.payload.detail`
(`apps/server/src/index.ts:559-561`), which is *also* pre-distilled at
ingestion (`apps/server/src/github.ts:215,251,285`). No new distillation step
in `indexMemory` itself — distillation happens once, at the write boundary,
consistent with "Store distillations, not raw content"
(`synapse-context.md:610-611`).

**`SynapseWhySourceKind`** (`packages/protocol/src/index.ts:552-559`) gains
`"coordination_note"` as an eighth member. `whySources`
(`apps/cli/src/briefings.ts:352-438`) gains one more `.map(...)` block over
`state.coordinationNotes` (all of them, active or cleared — `why`/`onboard`
read durable history, §3), shaped like the `recentRepoEvents` block
(lines 369-377): `title` = `` `${note.authorMemberLogin}'s note` ``,
`summary` = `note.body`, `reference` = `note.target?.kind === "symbol" ?
note.target.symbolId.raw : undefined`.

## 7. The orchestrator boundary — why this stays "agents decide"

This is the section most likely to be scrutinized, so the argument is laid
out explicitly against the three concrete risks:

1. **Does Synapse ever WRITE a note on an agent's behalf?** No. §4 is
   explicit: `coordination.note` has exactly one producer —
   `synapse_note`/`synapse note`, an explicit tool call. No conflict-engine
   rule, no `applyMessage` case, no webhook handler ever constructs a
   `CoordinationNote`. Contrast with `ConflictFeedback`
   (`packages/protocol/src/index.ts:354-365`), which is *also*
   human/agent-authored only (`synapse_feedback`) — this design adds a
   second member to that same "deliberate, never inferred" category, not a
   new category of "Synapse-authored" record.

2. **Does a note ever change a VERDICT or BLOCK an edit?** No. §5 caps a
   note's contribution at `severity: "info"` — below the `"warn"` threshold
   that the hook treats as "ask the developer"
   (`apps/cli/src/hooks.ts:226-232`). A room with zero real conflicts but
   three coordination notes still returns `verdict: "info"`, never
   `verdict: "warn"`. The hook's *existing* nonblocking/blocking split
   (`SYNAPSE_HOOK_NONBLOCKING`, lines 216-224 vs 226-232) is untouched by this
   design — it operates on `verdict`, and `verdict` cannot reach `"warn"` via
   a note alone. This is the literal meaning of "Silent on no-conflict, loud
   on conflict" (`synapse-context.md:616-617`): a note is not a conflict, so
   it stays at the volume of an FYI.

3. **Does Synapse ever MESSAGE a human or agent OUT OF BAND** (a GitHub PR
   comment, a Slack DM, a push notification) **to deliver a note?** No. The
   *only* delivery mechanism is "the next time the targeted
   session/symbol/file is the subject of a `synapse_check` /
   `synapse_whatsup` / `synapse_why` / `synapse_onboard` call **that session
   itself makes**." If the counterpart never calls any of those — never edits
   the targeted file, never checks in — the note sits unread, exactly as a
   Slack message sits unread if nobody opens Slack. Synapse does not have an
   outbound integration to any human-facing channel (no email, no Slack API,
   no GitHub comment-posting — confirmed absent from
   `apps/server/src/github.ts`, which only *receives* webhooks, never posts).
   Adding one would be a structurally different, much larger decision
   (flagged as out of scope in §12) — this design's notes are exclusively
   **pull**, never **push**.

Put together: a `CoordinationNote` is data Synapse stores and returns when
asked, with the same passivity as a `RecentPush` or `SessionSummary`. The
*decision* — what the note means, whether to act on it, how to reply — stays
with the reading agent and the developer behind it. Synapse's only active
choice is *when* to surface it (on the next check/whatsup/why touching the
target), which is timing, not judgment — identical to how an existing
`same_symbol_active` conflict is surfaced "when you next check that symbol,"
not pushed to you the instant it becomes true.

## 8. Alternative considered: lock claim/release — REJECTED for this primitive (future feature)

The plan asks whether exposing the existing `EditLock`/`edit.intent`
machinery as a deliberate "claim this symbol" tool should be part of this
primitive. Current state: `edit.intent` acquires a 90-second `EditLock`
(`ttlSec: 90`, `apps/server/src/state.ts:60`) **implicitly**, as a side
effect of `synapse_check` (`apps/cli/src/daemon.ts:404-411` calls
`sendToServer("edit.intent", ...)` for every check target). There is no tool
that lets a session say "hold this lock for longer" or "release it now" —
locks only expire via `pruneExpiredLocks`
(`apps/server/src/state.ts:150-162`) or get cleared on push
(`clearPushedLiveState`, lines 303-309) or session end
(`apps/server/src/state.ts:219-220`).

**Decision: reject bundling lock-claim into this primitive; treat it as a
separate, later, EXPLICITLY-DEFERRED feature — not part of `synapse_note`.**

Justification:
- **Different failure mode if done wrong.** A `CoordinationNote` that nobody
  reads is inert — the status quo (silence). A *claimed* lock that nobody
  releases is **active interference**: every other session's
  `same_symbol_active` conflict (`packages/conflict-engine`'s
  `same_symbol_active` rule, surfaced via
  `deterministicAnalysis` line 186-195) fires against a stale claim,
  producing exactly the "noisy, gets turned off" failure principle 4 warns
  about (`synapse-context.md:617`, "If the system is noisy, developers will
  turn it off"). A note has no such blast radius.
- **A note can express "claim" intent without the lock machinery.** "Don't
  touch `PaymentProcessor.charge` until I push" *is* a claim — expressed as
  prose with a `target.kind: "symbol"`, surfaced as an `"info"`-severity
  advisory (§5), with the same self-clearing-on-push lifecycle (§3) a real
  lock has, but **without** the TTL-extension/release-API surface area that a
  first-class claim primitive would need (what happens if the claimant's
  session crashes? who can override a stale claim? does a claim's `"warn"`
  on conflict differ from a note's `"info"`?) — all real design questions
  that a "claim" feature would have to answer and a "note" does not.
- **Sequencing**: if `synapse_note` ships and teams use targeted notes
  primarily as informal claims ("don't touch X"), that *usage data*
  (which targets get noted, how often, whether the counterpart's
  `same_symbol_active` conflict still fires anyway) is exactly the evidence
  an owner would want before specifying a first-class claim/release tool with
  real teeth. Shipping the lighter primitive first de-risks the heavier one.

This is listed as a candidate for **Plan C** in §11, explicitly gated on
`synapse_note` usage data — not rejected outright, deferred with a reason.

## 9. Privacy, caps, opt-out

- **Distillation**: `body` passes through `distillProse`
  (`apps/server/src/github.ts:151-176`) at write time (in the daemon's
  `/tools/synapse_note` handler, before `sendToServer`), with the existing
  default cap (`maxChars = 500`, line 151) — same cap `repo.event`'s `detail`
  uses (`apps/server/src/github.ts:215` passes no override). Code fences,
  inline code, links, and "+1"/"LGTM"-style noise are stripped/rejected
  exactly as for PR bodies (`apps/server/src/github.test.ts:142-157`). If
  `distillProse` returns `undefined` (all-noise input), `/tools/synapse_note`
  responds `400 { ok: false, error: "note_empty_after_distillation" }` —
  same "absent bodies stay absent" discipline
  (`apps/server/src/github.ts:151` doc comment).
- **Cap**: `COORDINATION_NOTE_CAP = 50`, alongside `RECENT_REPO_EVENT_CAP`,
  `RECENT_PUSH_CAP`, `SESSION_SUMMARY_CAP` (all `50`,
  `apps/server/src/state.ts:16-18`) and `CONFLICT_FEEDBACK_CAP` (`100`,
  line 19) — `addCoordinationNote` follows the identical
  `unshift`/`slice(0, CAP)`/`store.appendX(repoId, entry, CAP)` pattern as
  `addRecentRepoEvent` (lines 275-284). 50 matches the other narrative-entity
  caps (vs. 100 for the higher-volume `conflictFeedback`).
- **Opt-out**: `SYNAPSE_COORDINATION_NOTES=0` disables the
  `/tools/synapse_note` endpoint server-side (`501`/`disabled` response) —
  following the existing `SYNAPSE_<FEATURE>=0` kill-switch convention used by
  `SYNAPSE_RAG=0` (`apps/cli/src/daemon.ts:374`),
  `SYNAPSE_BRANCH_AWARE_SEVERITY=0`
  (`apps/cli/src/daemon.ts:426`), and `SYNAPSE_ADAPTIVE_SEVERITY=0`
  (`apps/cli/src/daemon.ts:437`). When disabled, `synapse_note`/`synapse
  note` surface the daemon's `disabled` error (same `toolError` path,
  `apps/cli/src/mcp.ts:380-385`), `coordination.note` messages are rejected
  by `applyMessage` before mutation (early return, matching how other
  kill-switches gate *before* the state change rather than after), and §5's
  synthetic `coordination_note` conflict is never synthesized (so a room with
  the feature off behaves exactly as it does today — zero wire/behavior
  change for opted-out rooms beyond the new, unused `ClientMessage` variant
  existing in the type union).
- **No PII beyond what's already exposed**: `authorMemberLogin` is the same
  identity already visible in every `Session`/`RecentPush`/`SessionSummary`
  (`memberLogin`/`memberId` fields throughout
  `packages/protocol/src/index.ts`) — a note adds no new identity surface.

## 10. Verification plan — `scripts/verify-coordination-note.mjs`

Modeled on `scripts/verify-why.mjs` (two daemons + one server, hermetic
`SYNAPSE_REPO_ID=local`, `freePort()`/`startProcess`/`waitForState` helpers)
and `scripts/verify-github-briefing.mjs`'s pattern of asserting on
`recentRepoEvents`/`why` sources after a synthetic event:

1. Boot `server`, `alice` daemon, `bob` daemon (as in `verify-why.mjs`
   lines 1-30); wait for `state.sessions.length === 2`.
2. **A writes a targeted note**: `postJson(alicePort, "/tools/synapse_note",
   { repoId: "local", sessionId: "alice", body: "Refactoring
   TokenValidator.validate to return Result<Token, AuthError> — hold off on
   that symbol until I push.", target: { kind: "symbol", symbolId: { raw:
   symbol } } })`. Assert `ok: true` and `note.id` present.
3. `waitForState(serverPort, (state) => state.coordinationNotes?.length ===
   1)`.
4. **B checks that symbol and sees it**: `postJson(bobPort,
   "/tools/synapse_check", { repoId: "local", sessionId: "bob", files:
   [filePath], symbols: [{ raw: symbol }] })`. Assert the response contains a
   conflict with `rule: "coordination_note"`, `severity: "info"`,
   `counterpart.memberLogin === "alice"`, and `detail` containing "hold off."
   Assert `verdict === "info"` (not `"warn"` — §5/§7's severity cap), and (if
   no other conflicts exist for this pair/symbol) that this is the *only*
   conflict.
5. **Appears in `why`/`onboard`**: `postJson(bobPort, "/tools/synapse_why", {
   repoId: "local", sessionId: "bob", question: "TokenValidator" })` — assert
   `sources` includes one with `kind: "coordination_note"` and `reference ===
   symbol`. Similarly assert `synapse_onboard`'s `sections.decisions` includes
   it.
6. **Clears on push** (§3): `alice` pushes `filePath`/`symbol` via
   `synapse_push`; `waitForState` until the note's `status === "cleared"`;
   re-run step 4's check — the synthetic `coordination_note` conflict is gone
   (note no longer "active"), but step 5's `why` query still returns it
   (durable memory, unaffected by clearing).
7. **Opt-out**: a second server instance with `SYNAPSE_COORDINATION_NOTES=0`
   — `/tools/synapse_note` returns non-200/`disabled`; `coordination.note`
   wire messages are rejected.

This is fully hermetic (no Postgres/Redis/RAG required for steps 1-4, 6-7;
step 5's `why` floor is deterministic/lexical without `SYNAPSE_RAG`, matching
`verify-why.mjs`'s non-RAG assertions — `verify-why-rag.mjs` is the separate
RAG-gated variant).

## 11. Rollout & implementation breakdown

Recommended order — each plan is independently shippable and testable, but B
depends on A's types, and C is explicitly usage-gated (§8):

1. **Plan A — Core entity + write path (protocol + server + daemon + MCP +
   CLI)**: `CoordinationNote` type, `coordination.note` wire message,
   `TeamState.coordinationNotes`, `addCoordinationNote`/store ops/cap (§2,
   §4, §9), `synapse_note` MCP tool + `synapse note` CLI + daemon endpoint +
   command-catalog entry, `SYNAPSE_COORDINATION_NOTES=0` kill switch.
   `scripts/verify-coordination-note.mjs` steps 1-3, 7. No read-surface
   changes yet — notes are writable and visible only via raw `/state`/store
   inspection. PR-sized, additive-only (new union member, new optional
   `TeamState` field).
2. **Plan B — Read surfaces + lifecycle clearing**: §5's synthetic
   `coordination_note` conflict (`rule` union widened to 8 members,
   `severity: "info"` cap, `withCommand`-attached reply suggestion), §3's
   clearing in `clearPushedLiveState`/`endSession`, §6's `indexMemory`
   branch + `SynapseWhySourceKind` widened to 8 + `whySources` block,
   `whatsup`'s `coordinationNotes` field +
   `sessionStartBriefing`'s "Notes for you" section.
   `scripts/verify-coordination-note.mjs` steps 4-6 complete the suite. This
   is the PR where the primitive becomes *useful* — A alone is a write with
   no reader.
3. **Plan C — Lock-claim evaluation (gated, NOT committed)**: after A+B ship
   and accrue real usage, revisit §8 with data: how often are targeted notes
   used as informal claims, and does the counterpart's
   `same_symbol_active` conflict still fire redundantly? If yes often enough
   to be noise, *that* finding becomes the motivating case for a first-class
   claim/release tool — a new design doc, not an extension of this one.

Env opt-out (`SYNAPSE_COORDINATION_NOTES=0`, §9) ships with Plan A so Plan B
can be merged behind the same flag if the owner wants a soak period between
"writable" and "surfaced."

## 12. Open questions for the owner

1. **Should a note ever be able to raise verdict severity above `"info"`?**
   §5/§7 cap it at `"info"` by design (the orchestrator-boundary argument).
   But a plausible counter-case: Alice writes "DO NOT merge anything touching
   `PaymentProcessor` — there's a live incident." Is `"info"` (same volume as
   "FYI, I'm working on this") the right ceiling for that, or does the
   *severity* of a note need to be author-settable (with `"warn"` only
   reachable via an explicit, rarer choice — not the default)? This is
   genuinely a product call about how much "loud" Synapse is allowed to be on
   human-authored content, not something the code resolves.
2. **Outbound delivery** (a GitHub PR comment, a Slack message) **for
   room-wide decisions that nobody happens to `synapse_check` again soon**:
   §7 establishes notes are pull-only by design, and the repo has zero
   outbound integrations today (`apps/server/src/github.ts` only receives
   webhooks). Is "pull-only, surfaces on next check/why/onboard" sufficient
   for Scenario 03 (`synapse-context.md:56-57`), or does closing that gap
   eventually require an outbound channel — which would be a different,
   much larger architectural decision (and arguably *is* "Slack ingestion,"
   `synapse-context.md:599`, just in the opposite direction)? Flagging, not
   proposing.
3. **Cross-session "reply" threading**: §5's deterministic action suggests
   `synapse_note` as a reply. Should a reply *reference* the note it's
   replying to (a `inReplyTo: noteId` field), making a visible thread in
   `why`, or is each note independent prose (simpler, and arguably sufficient
   — `why`'s recency ordering already surfaces a reply near its parent in
   most cases)? This is a schema question the owner may want to settle before
   Plan A locks the wire shape, since adding `inReplyTo` later is additive
   but changes how `why`/`onboard` would ideally *render* a thread (a
   rendering decision, not just a field).
