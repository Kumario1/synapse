# Plan 016: Ground the LLM layer in Synapse's own command vocabulary

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c46a61..HEAD -- apps/cli/src/explain-openrouter.ts apps/cli/src/hooks.ts apps/cli/src/mcp.ts packages/protocol/src/index.ts packages/conflict-engine/src/explain.ts`
> If any of these changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> Known drift (verified post-review): plan 004 (daemon input hardening)
> MERGED after this plan was stamped (PR #52, commit `776a717`), so the
> drift check WILL report `apps/cli/src/daemon.ts` — expected, not a STOP.
> This plan's only daemon citation is the `enrichConflicts` call site
> (verified still at ~line 412 post-merge); re-anchor by the symbol name. All
> `explain-openrouter.ts`, `hooks.ts`, `protocol`, and `conflict-engine`
> citations were re-verified against the post-merge tree and match.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (changes two LLM prompt contracts; mitigated by strict allowlist validation, unchanged fallbacks, and a stub-LLM verify)
- **Depends on**: none
- **Category**: direction (LLM layer value)
- **Planned at**: commit `8c46a61`, 2026-06-11

## Why this matters

Synapse's optional LLM layer analyzes conflicts and emits `actions` — but
they are free-text prose ("coordinate with alice before merging") because
the model is never told Synapse *has* commands. The agent reading that
output is an MCP client that could literally call `synapse_why`,
`synapse_feedback`, or `synapse_whatsup` next — if the suggestion were
structured. This plan feeds the prompts a deterministic catalog of
Synapse's agent-facing tools and lets each action carry a **validated,
never-auto-executed** command suggestion, rendered in the Claude Code hook
output and consumed structurally by MCP agents. The same catalog also
upgrades the *deterministic* analysis floor (rule-appropriate command
suggestions with zero LLM key), so the feature degrades exactly like
everything else in this codebase.

Two principles constrain this plan and must survive it (both documented in
the repo): **detection is never the LLM** (the verdict is decided before
enrichment — `apps/cli/src/daemon.ts:409-412`), and **agents query, agents
decide** (suggestions are surfaced, never executed by Synapse). The LLM
stays optional; this makes it worth configuring, not mandatory.

## Current state

- `apps/cli/src/explain-openrouter.ts` (478 lines) — all three OpenRouter
  providers. The analysis contract (lines 99–110):

  ```ts
  const SYSTEM_PROMPT = [
    "You coordinate AI coding agents working on the same repository.",
    ...
    "Reply with STRICT JSON only (no markdown, no prose outside the object) of the shape:",
    '{"assessment": string, "recommendation": "block"|"warn"|"info"|"proceed",',
    '"actions": [{"audience": "you"|"counterpart"|"both", "step": string}]}',
    ...
  ].join(" ");
  ```

  `parseAnalysis` (line 129) and `asActions` (lines 167–191) validate the
  reply; anything malformed → `null` → deterministic fallback. The
  resolution provider's `RESOLUTION_SYSTEM_PROMPT` is at lines 297–307;
  config env vars are documented at the top of the file
  (`OPENROUTER_API_KEY`, `SYNAPSE_LLM_MODEL` default
  `anthropic/claude-haiku-4.5`, `SYNAPSE_LLM_TIMEOUT_MS` default 8000,
  `SYNAPSE_LLM_RESOLVE=0`). The analysis provider caches by `cacheKey`
  (line 193); the resolution provider caches by `inputsHash` and retries
  once (lines 238–247). **Cache note:** the resolution prompt is
  deliberately symmetric across machines (file header lines 211–213) — your
  prompt additions must not introduce per-machine text into it.

- `packages/protocol/src/index.ts:184–188` — the type to extend:

  ```ts
  export interface ConflictAction {
    /** `you` = the agent running the check; `counterpart` = the other agent. */
    audience: "you" | "counterpart" | "both";
    step: string;
  }
  ```

- `packages/conflict-engine/src/explain.ts` — `AnalysisProvider` interface
  (line 50), `deterministicAnalysis(conflict)` (line 75: the no-LLM floor
  that always populates `analysis`), `enrichConflicts` (line 327: applies
  the provider, falls back on null). Tests for the enrich/fallback behavior
  live in `packages/conflict-engine/src/compare.test.ts:129–166` — your new
  tests follow that pattern.

- `apps/cli/src/hooks.ts:192–219` — `preToolUseDecision` renders conflicts
  for Claude Code. It currently prints `assessment`/`detail` + `suggestion`
  per conflict and **does not render `actions` at all**:

  ```ts
  const lines = result.conflicts.map((conflict) => {
    const who = conflict.counterpart.memberLogin;
    const detail = conflict.analysis?.assessment ?? conflict.detail;
    const next = conflict.suggestion ? ` → ${conflict.suggestion}` : "";
    return `• [${conflict.rule}] ${detail} (with ${who})${next}`;
  });
  ```

- `apps/cli/src/mcp.ts` — the agent-facing tool surface the catalog must
  describe: `server.registerTool` blocks at lines 50–276 register (read the
  file to confirm the exact set) `synapse_check`, `synapse_report`,
  `synapse_push`, `synapse_feedback`, `synapse_session`, `synapse_whatsup`,
  `synapse_why`. The MCP server also ships usage guidance via its
  `instructions` field (grep `instructions` in this file).

- Verify conventions: no stub-LLM harness exists yet —
  `scripts/verify-resolution.mjs` deliberately runs key-less to prove the
  deterministic fallback. The stub-HTTP-provider pattern to copy is in
  `scripts/verify-why-rag.mjs` (a local server impersonating an
  OpenAI-compatible embeddings endpoint; this plan does the same for
  `/chat/completions` via `OPENROUTER_BASE_URL`).

- Conventions: on-by-default features take a `SYNAPSE_<X>=0` opt-out
  (`SYNAPSE_FILE_WATCHER`, `SYNAPSE_BRANCH_AWARE_SEVERITY` precedents);
  conventional commits; hermetic `scripts/verify-*.mjs` + root alias.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | all pass |
| New verify | `npm run verify:llm-actions` | exit 0 |
| Fallback regression | `npm run verify:resolution` | exit 0 (still key-less) |
| Hook regression | `npm run verify:hooks` | exit 0 |

## Scope

**In scope**:
- `packages/protocol/src/command-catalog.ts` (create) + export from `packages/protocol/src/index.ts`
- `packages/protocol/src/index.ts` — optional `command` field on `ConflictAction`
- `apps/cli/src/explain-openrouter.ts` — prompts + validation (+ `export` on the parse helpers for testing)
- `apps/cli/src/explain-openrouter.test.ts` (create)
- `packages/conflict-engine/src/explain.ts` — deterministic command suggestions in `deterministicAnalysis`
- `packages/conflict-engine/src/compare.test.ts` or a sibling test file — floor tests
- `apps/cli/src/hooks.ts` — render command suggestions in `preToolUseDecision`
- `apps/cli/src/mcp.ts` — mention the `command` field in the `instructions` text and the `synapse_check` tool description (text only)
- `scripts/verify-llm-actions.mjs` (create) + root `package.json` alias
- `README.md` — extend the LLM/Privacy paragraphs with one or two sentences

**Out of scope** (do NOT touch):
- Executing suggested commands anywhere — Synapse never runs them; it
  surfaces them. No "auto-apply" flag, even behind an env var.
- The session-summary provider — no command grounding there (summaries are
  narrative).
- Agentic tool-calling by the LLM (multi-turn function calls) — Phase 2,
  see the appendix; do not implement any of it.
- `packages/protocol/src/wire-schema.ts` — `ConflictAction` travels inside
  check *responses* (daemon→agent over local HTTP), not in client→server
  wire messages; confirm with `grep -n 'ConflictAction\|actions' packages/protocol/src/wire-schema.ts`
  (expect no hits) and leave the file alone.
- Making the LLM mandatory in any path.

## Git workflow

- Branch: `advisor/016-command-grounded-llm-actions`
- Conventional commits, e.g. `feat(llm): ground analysis actions in the synapse command catalog`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: The command catalog (deterministic, single source)

Create `packages/protocol/src/command-catalog.ts`:

```ts
export interface SynapseCommandSpec {
  tool: string;                      // MCP tool name, e.g. "synapse_why"
  cli: string;                       // CLI equivalent, e.g. "synapse why"
  when: string;                      // one sentence: when an agent should reach for it
  args: { name: string; type: "string" | "number"; required: boolean; hint: string }[];
  /**
   * CLI render template with <argName> placeholders, used verbatim by the
   * hook output (Step 5) so all executors format identically.
   * e.g. `synapse why "<question>"`, `synapse whatsup`.
   */
  usage: string;
}

export const SYNAPSE_COMMAND_CATALOG: SynapseCommandSpec[] = [ /* 7 entries */ ];

export function isKnownSynapseCommand(tool: string): boolean { ... }

/** Compact prompt block: one line per tool — "name(args): when". */
export function renderCommandCatalogForPrompt(): string { ... }
```

Populate the 7 entries from the `registerTool` blocks in
`apps/cli/src/mcp.ts` — the `when` sentences should match the tool
descriptions there (keep each under ~20 words; the gate on prompt size is
the <900-character check below — this block rides on every analysis call,
so shorter is better). Export everything from
`packages/protocol/src/index.ts`.

**Verify**: `npm run typecheck` → exit 0;
`node -e "const p=require('./packages/protocol/dist/index.js');console.log(p.renderCommandCatalogForPrompt().length)"`
(after `npm run build`) → a number, sanity-check < 900 chars.

### Step 2: Extend `ConflictAction` (additive)

In `packages/protocol/src/index.ts:184–188` add:

```ts
export interface ConflictAction {
  audience: "you" | "counterpart" | "both";
  step: string;
  /**
   * Optional structured suggestion mapping this step to a Synapse tool the
   * reading agent can call. Validated against the command catalog; Synapse
   * only ever SUGGESTS — it never executes these.
   */
  command?: { tool: string; args?: Record<string, string> };
}
```

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Prompt + validation changes in `explain-openrouter.ts`

Gating rule — read carefully: ONLY the **prompt additions** (items 1 and 3)
are gated behind `process.env.SYNAPSE_LLM_COMMANDS !== "0"` (on by
default). The **validation** (item 2) and the **export keywords** (item 4)
are unconditional — even with the feature off, a model that volunteers a
`command` field must still pass through the allowlist; an env flag must
never create an unvalidated path.

1. `SYSTEM_PROMPT`: extend the JSON shape line so actions read
   `{"audience": ..., "step": string, "command": {"tool": string, "args": object}|null}`,
   and append: the rendered catalog
   (`renderCommandCatalogForPrompt()`), plus
   `"When a step maps to one of these tools, set command accordingly; otherwise command=null. These are suggestions for the reading agent — never claim they were executed."`
2. `asActions` (lines 167–191): accept the optional `command`; keep it only
   when `isKnownSynapseCommand(record.command.tool)` and every arg value is
   a string (drop non-string args individually); on an unknown tool, DROP
   the `command` field but KEEP the action's step text. Never reject the
   whole analysis because of a bad command — the existing
   assessment/recommendation validation rules are unchanged.
3. `RESOLUTION_SYSTEM_PROMPT` (lines 297–307): append one sentence telling
   the model the `instruction` text may reference the CLI commands from the
   catalog (e.g. "after adopting the contract, report via synapse_report")
   — **text only, no schema change**, and nothing machine-specific (the
   prompt must stay symmetric; the catalog is identical on both machines,
   so including it is safe).
4. Export `parseAnalysis` and `asActions` (add `export` keywords) so they
   are unit-testable.

**Verify**: `npm run build && npm run typecheck` → exit 0.

### Step 4: Deterministic floor suggestions

In `packages/conflict-engine/src/explain.ts` `deterministicAnalysis`
(line 75), attach rule-appropriate `command` suggestions to the actions it
already produces (read the function first; it builds per-rule actions).
Mapping (only where it reads naturally — do not force one per rule):

- `dependency_changed` / `stale_base` → `{ tool: "synapse_why", args: { question: <symbol raw id> } }`
  on the action whose step is about understanding the counterpart's change
  (attach to the FIRST `you`/`both`-audience action if no step matches
  better).
- `same_symbol_active` / `same_symbol_unpushed` → `{ tool: "synapse_whatsup" }`
  on the action about seeing what the other agent is doing (same first-action
  fallback).
- `{ tool: "synapse_feedback" }` ONLY if an existing action's step text
  mentions dismissing or giving feedback on the conflict; if no such action
  exists, do not add one — record that in your report.

The conflict-engine package must not read env vars (pure functions
convention) — the floor suggestions are unconditional; only the LLM-side
prompt gating uses `SYNAPSE_LLM_COMMANDS`.

**Verify**: `npm test --workspace @synapse/conflict-engine` → existing
tests pass (they assert on actions' steps, not exhaustive shapes — if any
test does exact-deepEqual on actions and breaks, update that expectation to
include the new `command` field, and say so in the commit body).

### Step 5: Render in the hook output

In `apps/cli/src/hooks.ts` `preToolUseDecision` (lines 192–219), after each
conflict line, render up to 2 actions whose audience is `you` or `both`:

```
    ↳ <step> [→ run: synapse why "<args.question>"]
```

Format the runnable form by taking the catalog entry's `usage` template and
substituting each `<argName>` placeholder with the action's corresponding
arg value (placeholders with no matching arg stay literal); omit the
bracketed part when the action has no `command`. This template substitution
is the single formatting rule — Step 7's assertions depend on it. Keep the
total message compact (it lands in a permission prompt) — conflicts beyond
the first 3 keep today's one-line form.

**Verify**: `npm run verify:hooks` → exit 0 (the existing hook verify must
stay green; it asserts on the heading/decision shape, not exact lines —
check `scripts/verify-hooks.mjs` if it fails and report rather than
loosening its assertions).

### Step 6: MCP text updates

In `apps/cli/src/mcp.ts`: add one sentence to the server `instructions`
field and to the `synapse_check` tool description noting that conflict
analyses may include `actions[].command` — a suggested Synapse tool call
the agent should consider making next.

**Verify**: `grep -n 'command' apps/cli/src/mcp.ts` → ≥ 2 new mentions.

### Step 7: Stub-LLM verify

`scripts/verify-llm-actions.mjs` (model the server/daemon boot on
`scripts/verify-dependency-ts-check.mjs`, the stub provider on
`scripts/verify-why-rag.mjs`):

1. Start a local HTTP stub answering `POST /chat/completions` with a canned
   strict-JSON analysis whose actions include: (a) a valid
   `{"tool":"synapse_why","args":{"question":"validate"}}`, (b) an unknown
   `{"tool":"rm_rf_everything"}`, (c) an action with `command: null`.
2. Boot server + two daemons with `OPENROUTER_API_KEY=stub`,
   `OPENROUTER_BASE_URL=http://localhost:<stubPort>`, manufacture a
   `dependency_changed` conflict (copy the fixture story from
   `verify-dependency-ts-check.mjs`).
3. Assert on the check response: action (a) carries its command through;
   (b) arrives with the command **stripped** but the step text intact;
   (c) has no command. Assert the stub received the catalog in the system
   prompt (the stub records request bodies; grep for `synapse_why(`or the
   catalog's first line).
4. Opt-out leg: re-run the check with `SYNAPSE_LLM_COMMANDS=0` daemons —
   the system prompt the stub receives contains no catalog block.
5. No-key leg: daemon without `OPENROUTER_API_KEY` → deterministic floor
   still attaches the Step 4 command suggestions (assert `synapse_why` on
   the `dependency_changed` analysis actions).

Add root alias `"verify:llm-actions"`.

**Verify**: `npm run verify:llm-actions` → exit 0;
`npm run verify:resolution` → still exit 0.

### Step 8: README

Extend the existing LLM paragraph (the "Deterministic first" feature row
and/or the Privacy section): analyses can now suggest concrete Synapse
commands; suggestions are validated against a fixed catalog and never
executed by Synapse; `SYNAPSE_LLM_COMMANDS=0` opts out; the deterministic
floor includes catalog suggestions without any key.

**Verify**: `grep -n 'SYNAPSE_LLM_COMMANDS' README.md` → ≥ 1 match.

## Test plan

1. `apps/cli/src/explain-openrouter.test.ts` (new, `node --test`, model on
   `apps/server/src/github.test.ts` structure): `parseAnalysis` accepts a
   valid command; strips unknown tools; strips non-string arg values
   individually; `command: null`/absent → absent; malformed `actions` still
   → null analysis (existing behavior).
2. Conflict-engine: floor tests asserting the Step 4 rule→command mapping
   (next to the `enrichConflicts` tests at `compare.test.ts:129`); and one
   enrich test where the provider returns actions with commands — they
   survive `enrichConflicts` untouched.
3. End-to-end: `verify:llm-actions` (Step 7) covering valid/unknown/absent
   commands, the opt-out leg, and the no-key floor leg.

Verification: `npm test` → all pass; `npm run verify:llm-actions`,
`verify:resolution`, `verify:hooks` → exit 0.

## Done criteria

- [ ] `npm run build`, `npm run typecheck`, `npm test` exit 0
- [ ] `npm run verify:llm-actions` exits 0 (all five assertions incl. opt-out and no-key floor)
- [ ] `npm run verify:resolution` and `npm run verify:hooks` exit 0 unchanged
- [ ] `grep -rn 'isKnownSynapseCommand' apps/cli/src/explain-openrouter.ts` → ≥ 1 (validation wired)
- [ ] `grep -rn 'exec\|spawn' packages/protocol/src/command-catalog.ts` → 0 matches (catalog is data, never execution)
- [ ] No files outside the in-scope list modified (`git status --porcelain`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `deterministicAnalysis` turns out not to produce per-rule actions you can
  attach commands to (i.e., its action steps are generic one-liners with no
  rule branching) — attaching commands would then need new rule logic;
  report the function's actual shape instead of inventing it.
- The hook message rendering breaks `verify:hooks` because that verify
  asserts exact message text — report which assertion, don't weaken the
  verify.
- Any test or verify needs `ConflictAction.command` to cross the
  client→server wire (i.e., `wire-schema.ts` hits for actions) — the
  out-of-scope assumption is then wrong; stop and report.
- You find yourself adding ANY code path that executes a suggested command.

## Maintenance notes

- The catalog is now the single description of the agent-facing tool
  surface — when a new MCP tool ships (e.g. plan 011's `synapse_onboard`),
  add a catalog entry in the same PR; the prompt and validation pick it up
  automatically. A drift check between `mcp.ts` registrations and catalog
  entries would make a good follow-up test.
- Reviewer focus: the validation in `asActions` (unknown tools must strip
  the command, never the action; the analysis must never fail closed
  because of a command), and prompt-size discipline (the catalog block is
  on every analysis call — watch token growth).
- Phase 2 (deferred, see appendix) builds directly on this catalog.

## Appendix: Phase 2 design sketch — agentic tool-calling enrichment (DO NOT BUILD IN THIS PLAN)

Recorded so a future plan can start from the owner-approved shape:

- **What**: give the analysis/resolution LLM calls OpenAI-style
  function-calling access to *read-only, daemon-local* queries —
  `synapse_whatsup`, `synapse_why`/recall, `GET /state`, dependency-graph
  neighbors — so the model gathers grounding before answering. The Phase-1
  catalog entries become the function definitions (add JSON-schema arg
  types then).
- **Constraints discovered in this audit**: the analysis call is awaited
  inside `synapse_check` (`daemon.ts:409-412`) under
  `SYNAPSE_LLM_TIMEOUT_MS` (8s) — a tool loop needs a per-call budget
  (suggest: max 2 tool calls, total wall-clock unchanged at 8s, loop
  abandons to the single-shot answer on budget exhaustion). Tools must be
  read-only and daemon-local (never mutate state, never reach the server
  with new writes). The resolution prompt's cross-machine symmetry
  (`explain-openrouter.ts:211-213`) is incompatible with per-machine tool
  results — either exclude resolution from Phase 2 or scope its tools to
  inputs already in `inputsHash`.
- **Go/no-go signal**: Phase 1's command suggestions getting acted on
  (observable as `synapse_why`/`synapse_feedback` calls following checks —
  the daemon metrics already count tool calls) is the demand evidence that
  justifies Phase 2's latency/cost.
