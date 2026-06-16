# Plan 017: Generate the agent-guidance command reference from the Synapse command catalog

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- packages/protocol/src/command-catalog.ts apps/cli/src/connect.ts apps/cli/src/mcp.ts README.md`
> If any of these changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (plans 011 and 016 already landed; this builds on both)
- **Category**: direction / dx
- **Planned at**: commit `e3c46f2`, 2026-06-12

## Execution notes (2026-06-12)

First dispatch: `/private/tmp/synapseWork-017` stopped under Node v25.4.0
after Step 2 because `node --test` discovered both compiled `dist/*.test.js`
files and source `src/*.test.ts` files. The compiled tests, including the new
markdown catalog tests, passed; the source tests failed with
`ERR_MODULE_NOT_FOUND` for `.js` imports such as `src/index.js` /
`src/command-catalog.js`.

Successful retry: the operator requested execution under the repo's supported
Node version. CI pins Node 20, and the retry ran with Node v20.19.2 in
`/private/tmp/synapseWork-017-fresh.y8CW1m` on branch
`advisor/017-catalog-grounded-agent-guidance`. The executor committed
`04eef99 feat(connect): derive agent-guidance command reference from the command catalog`.
Reviewer verification reran the done criteria under Node 20: `npm run
typecheck`, `npm test`, `npm run build`, `npm run check`, the explicit
`node -e` catalog coverage check (`guidance covers all 8 tools`), and
`grep -c "synapse_onboard" apps/cli/src/connect.ts` (`1`). `plans/README.md`
records this plan as DONE.

## Why this matters

Synapse already installs agent-facing guidance markdown into every connected
repo (`AGENTS.md` managed block, `.cursor/rules/synapse.mdc`,
`.windsurf/rules/synapse.md`, and the MCP server's `instructions` field). But
that guidance is hand-written prose that only teaches the *workflow loop*
(whatsup → check → report → push). It never mentions `synapse_onboard` at all,
and mentions `synapse_why` only in a passing aside — so an agent that hits a
confusing conflict has no standing knowledge that it can ask team memory "why
did this change?" and get a cited answer. The agent only learns about `why`
*reactively*, if a conflict analysis happens to suggest it.

Meanwhile `SYNAPSE_COMMAND_CATALOG` (built by plan 016) is a complete,
structured registry of every agent-facing tool — tool name, CLI form,
when-to-use, args, usage template — already documented as "the single source
of truth". The guidance and the catalog are two hand-maintained sources, and
they have **already drifted** (onboard is in the catalog, not the guidance).

This plan derives a "command reference" section of the guidance *from* the
catalog at module load, adds one workflow line teaching agents to investigate
before resolving, and locks the two together with a test so they can never
drift again. After this lands, every rules file, the AGENTS.md block, and the
MCP instructions automatically list every tool — including any tool added to
the catalog in the future — and agents proactively know they can run
`synapse why "<question>"` to understand a conflict before resolving it.

**Deliberate non-goal**: do NOT create a new standalone `synapse.md` file.
The existing delivery surfaces (rules files, AGENTS.md, MCP instructions) are
auto-loaded by agents; a standalone file nothing auto-reads would be strictly
weaker. This was the owner's original framing ("install a synapse.md or some
sort of md file") — the decision, after recon, is to enrich the existing
installed markdown instead, because the install mechanism already exists.

## Current state

Relevant files:

- `packages/protocol/src/command-catalog.ts` — the catalog. 8 entries
  (`synapse_check`, `synapse_report`, `synapse_push`, `synapse_feedback`,
  `synapse_session`, `synapse_whatsup`, `synapse_onboard`, `synapse_why`),
  each a `SynapseCommandSpec { tool, cli, when, args, usage }`. Exports
  `isKnownSynapseCommand()` and `renderCommandCatalogForPrompt()` (compact
  one-line-per-tool form used in LLM prompts). The header comment
  (lines 1–13) lists its consumers and says "When a new MCP tool ships, add
  its entry here in the same PR."
- `packages/protocol/src/index.ts:3` — `export * from "./command-catalog.js";`
  so the CLI imports catalog symbols from `@synapse/protocol`.
- `apps/cli/src/connect.ts:14-24` — `SYNAPSE_AGENT_GUIDANCE`, the exported
  const this plan rewrites. Today it is a single template literal: an intro
  paragraph, five numbered workflow items (SESSION START / BEFORE EDITING /
  AFTER EDITING / AFTER PUSHING / FEEDBACK), one aside about
  `actions[].command`, and an identity note. It is consumed at:
  - `apps/cli/src/connect.ts:205` — `cursorRule()` (whole-file `.mdc` rule)
  - `apps/cli/src/connect.ts:213` — `markdownBlock()` (AGENTS.md + Windsurf
    managed block, between `<!-- BEGIN SYNAPSE ... -->` markers)
  - `apps/cli/src/mcp.ts:49` —
    `new McpServer(serverInfo, { instructions: SYNAPSE_AGENT_GUIDANCE })`
- `apps/cli/src/connect.ts:220-236` — `upsertManagedBlock()` replaces the
  content between the BEGIN/END markers idempotently, so re-running
  `synapse connect` rolls the new guidance out to existing repos. No change
  needed there.
- `apps/cli/src/commands/connect.ts` — CLI wiring (`runConnect`,
  `connectAllAgents` shared by `connect`/`join`/`up`). No change needed.
- `apps/cli/src/hooks.ts:241-257` — `renderActionLine()` already renders
  per-conflict "→ run: <cli>" suggestions from the catalog. No change needed;
  this plan adds the *proactive* counterpart.

Current guidance text (connect.ts:14-24), abbreviated — confirm you see this
before editing:

```ts
export const SYNAPSE_AGENT_GUIDANCE = `Synapse is a realtime coordination layer that stops your edits from colliding with other agents and teammates working the same repository. Use these MCP tools automatically — do not wait to be asked. This mirrors the Claude Code PreToolUse/PostToolUse/SessionStart hooks for agents that do not run those hooks.

1. SESSION START — at the start of a task, call \`synapse_whatsup\` once ...
2. BEFORE EDITING — before you create, edit, or refactor a file, call \`synapse_check\` ...
3. AFTER EDITING — immediately after you finish writing a file, call \`synapse_report\` ...
4. AFTER PUSHING — after you commit or push, call \`synapse_push\` ...
5. FEEDBACK (optional) — call \`synapse_feedback\` ...

Conflict analyses may include \`actions[].command\`, a suggested Synapse tool call (e.g. \`synapse_whatsup\`, \`synapse_why\`) for resolving that specific conflict — consider making that call next when present.

Identity (repoId, sessionId, daemon port) resolves automatically from \`.synapse/config.json\`, so you usually do not need to pass it.`;
```

Repo conventions that apply:

- TypeScript ES modules, two-space indent, JSDoc block comments on exported
  symbols explaining *why* (see the existing comments in
  `packages/protocol/src/command-catalog.ts` and `apps/cli/src/connect.ts` —
  match that register).
- Tests are co-located `src/*.test.ts` files using `node:test` +
  `node:assert/strict`, compiled by `tsc -b` to `dist/` and run from there by
  `node --test`. Pattern exemplars:
  `packages/protocol/src/wire-schema.test.ts` (protocol),
  `apps/cli/src/explain-openrouter.test.ts` (CLI; note it imports from
  `./explain-openrouter.js` with the `.js` extension — always import with
  `.js` extensions).
- Because tests run from compiled output, **build before testing**. The root
  `npm test` goes through turbo, which builds first.

## Commands you will need

| Purpose | Command (run at repo root) | Expected on success |
|---|---|---|
| Install | `npm install` | exit 0 (likely already installed) |
| Build all | `npm run build` | exit 0, turbo builds all workspaces |
| Typecheck all | `npm run typecheck` | exit 0 |
| Test all | `npm test` | exit 0, all suites pass |
| Test one workspace | `npx turbo run test --filter=@synapse/protocol` | exit 0 (turbo builds deps first) |
| Test CLI workspace | `npx turbo run test --filter=@kumario/synapse` * | exit 0 |

\* Verify the CLI package name first with `grep '"name"' apps/cli/package.json`;
if it differs, use the name you find. Plain
`npm test --workspace <name>` also works but does NOT build first — prefer the
turbo form, or run `npm run build` beforehand.

## Scope

**In scope** (the only files you should modify or create):

- `packages/protocol/src/command-catalog.ts` — add one rendering function.
- `packages/protocol/src/command-catalog.test.ts` — create.
- `apps/cli/src/connect.ts` — recompose `SYNAPSE_AGENT_GUIDANCE`.
- `apps/cli/src/connect.test.ts` — create.
- `README.md` — one feature-table row tweak (step 4).
- `plans/README.md` — status row update when done.

**Out of scope** (do NOT touch, even though they look related):

- `apps/cli/src/mcp.ts` — it imports `SYNAPSE_AGENT_GUIDANCE` and gets the new
  content for free. Its per-tool descriptions stay as they are.
- `apps/cli/src/hooks.ts` — the reactive per-conflict suggestions already work.
- The catalog **entries** themselves — do not add, remove, or reword entries.
  CLI-only human commands (`synapse doctor`, `synapse demo`, `synapse up`) are
  deliberately absent: the catalog documents the agent-facing MCP surface.
- `apps/cli/src/explain-openrouter.ts` and `renderCommandCatalogForPrompt()` —
  the LLM prompt keeps its compact format.
- `.cursor/`, `.windsurf/`, `AGENTS.md`, `.mcp.json` in THIS repo — this repo
  is not synapse-connected; the new guidance reaches user repos when they
  re-run `synapse connect` (or `join`/`up`).

## Git workflow

- Branch: `advisor/017-catalog-grounded-agent-guidance` (matches the repo's
  `advisor/NNN-slug` convention).
- Conventional commits, e.g.
  `feat(connect): derive agent-guidance command reference from the command catalog`
  (style exemplar in `git log`: `feat(llm): ground conflict-analysis actions in the Synapse command catalog`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `renderCommandCatalogMarkdown()` to the protocol catalog

In `packages/protocol/src/command-catalog.ts`, below
`renderCommandCatalogForPrompt()`, add a markdown renderer. Target shape
(adjust prose freely, keep the structure):

```ts
/**
 * Markdown command reference for agent-facing guidance (rules files, AGENTS.md,
 * MCP `instructions`). One bullet per tool: MCP name, CLI form, when to reach
 * for it, and argument hints. Deriving the on-disk guidance from the catalog
 * keeps the two from drifting — a new catalog entry ships in every rules file
 * automatically.
 */
export function renderCommandCatalogMarkdown(): string {
  return SYNAPSE_COMMAND_CATALOG.map((entry) => {
    const args = entry.args.length
      ? ` Args: ${entry.args
          .map((arg) => `${arg.name}${arg.required ? "" : " (optional)"} — ${arg.hint}`)
          .join("; ")}.`
      : "";
    return `- \`${entry.tool}\` (CLI: \`${entry.usage}\`) — ${entry.when}${args}`;
  }).join("\n");
}
```

Also update the file's header comment (lines 1–13) consumer list to mention
the new consumer: the agent guidance in `apps/cli/src/connect.ts`.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Create `packages/protocol/src/command-catalog.test.ts`

Model the imports/structure after `packages/protocol/src/wire-schema.test.ts`.
Cases (import from `./command-catalog.js`):

1. `renderCommandCatalogMarkdown()` output contains every `entry.tool` from
   `SYNAPSE_COMMAND_CATALOG` (loop over the catalog, `assert.ok(out.includes(...))`).
2. The output contains every `entry.usage` string (so the CLI form for each
   tool, e.g. `synapse why "<question>"`, is always present).
3. The output of a no-args entry (find `synapse_whatsup` in the catalog) has
   no `Args:` suffix on its line; a required-args entry (`synapse_why`)
   includes its arg name and hint.

**Verify**: `npx turbo run test --filter=@synapse/protocol` → exit 0, the new
tests appear in the output and pass.

### Step 3: Recompose `SYNAPSE_AGENT_GUIDANCE` in `apps/cli/src/connect.ts`

Add the import (keep `.js` extension):

```ts
import { renderCommandCatalogMarkdown } from "@synapse/protocol";
```

Rewrite the const (connect.ts:14-24) to the following shape. The numbered
items 1–5 keep their existing wording verbatim (they mirror the Claude Code
hooks — don't reword them); the additions are item 6, the generated reference
section, and a sharper version of the `actions[].command` aside:

```ts
export const SYNAPSE_AGENT_GUIDANCE = `Synapse is a realtime coordination layer that stops your edits from colliding with other agents and teammates working the same repository. Use these MCP tools automatically — do not wait to be asked. This mirrors the Claude Code PreToolUse/PostToolUse/SessionStart hooks for agents that do not run those hooks.

1. SESSION START — <existing wording, unchanged>
2. BEFORE EDITING — <existing wording, unchanged>
3. AFTER EDITING — <existing wording, unchanged>
4. AFTER PUSHING — <existing wording, unchanged>
5. FEEDBACK (optional) — <existing wording, unchanged>
6. WHEN YOU NEED CONTEXT — Synapse is also your team memory; query it instead of guessing. If a check surfaces a conflict you don't understand, or you wonder why a contract looks the way it does, call \`synapse_why\` with a plain-language question — it searches durable team history and answers with cited sources. On your FIRST session in a repository, call \`synapse_onboard\` once instead of \`synapse_whatsup\` for a deep briefing: the full team digest plus the room's cited decision history.

Conflict analyses may include \`actions[].command\`, a suggested next Synapse tool call for resolving that specific conflict — when present, prefer making that exact call next.

Command reference (every Synapse tool, with its CLI form):
${renderCommandCatalogMarkdown()}

Identity (repoId, sessionId, daemon port) resolves automatically from \`.synapse/config.json\`, so you usually do not need to pass it.`;
```

Notes:

- The old aside's example list ("e.g. \`synapse_whatsup\`, \`synapse_why\`")
  is dropped because the full reference now follows.
- `SYNAPSE_AGENT_GUIDANCE` stays an exported `const string` — evaluated once
  at module load. Both `mcp.ts` (instructions) and the rules writers pick the
  new content up with no further changes.

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Create `apps/cli/src/connect.test.ts`

Model after `apps/cli/src/explain-openrouter.test.ts` (node:test, strict
assert, `.js` imports). Cases:

1. **The drift lock (the point of this plan)**: for every entry of
   `SYNAPSE_COMMAND_CATALOG` (import from `@synapse/protocol`),
   `SYNAPSE_AGENT_GUIDANCE` (import from `./connect.js`) contains `entry.tool`
   AND `entry.usage`. Add a comment saying this test exists so a catalog entry
   added without regenerating/recomposing the guidance fails CI.
2. The guidance still contains the five hook-mirroring anchors — assert it
   includes the substrings `SESSION START`, `BEFORE EDITING`, `AFTER EDITING`,
   `AFTER PUSHING`, and `WHEN YOU NEED CONTEXT`.
3. `connectAgents` round-trip in a temp dir (`fs.mkdtemp` under
   `os.tmpdir()`): first call returns status `"wrote"` for the `agents`
   integration (`AGENTS.md`), a second identical call returns `"unchanged"`,
   and the written `AGENTS.md` contains both managed markers and
   `synapse_why`. Use `cliEntrypoint: "/tmp/fake-cli.js"` — `connectAgents`
   never executes the entrypoint, it only embeds it in MCP JSON. Clean the
   temp dir in a `finally`/`after` block.

**Verify**: `npx turbo run test --filter=<cli package name from the Commands
section>` → exit 0, new tests pass.

### Step 5: README row + full verification

In `README.md`, the features table row **Any-agent onboarding** (begins
`<td><b>Any-agent onboarding</b></td>`) currently ends its description with
"…so non-Claude agents get hook-equivalent behavior with zero manual setup."
Extend the sentence so it also says the rules files carry a generated
command reference, e.g. append: " Rules files include a generated command
reference (from the same catalog that grounds LLM action suggestions), so
agents know they can self-serve context — e.g. <code>synapse why</code> on a
confusing conflict." Touch nothing else in the README.

Run the full suite and update the plans index.

**Verify**: `npm run check` (typecheck + full test suite) → exit 0.

## Test plan

- New `packages/protocol/src/command-catalog.test.ts` — 3 tests (renderer
  completeness for tools, completeness for usage strings, args formatting).
- New `apps/cli/src/connect.test.ts` — 3 tests (guidance⇄catalog drift lock,
  workflow anchors intact, `connectAgents` idempotent round-trip in a temp dir).
- Structural patterns: `packages/protocol/src/wire-schema.test.ts` and
  `apps/cli/src/explain-openrouter.test.ts`.
- Verification: `npm test` → all pass including the 6 new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0.
- [ ] `npm test` exits 0; the 6 new tests listed above exist and pass.
- [ ] `node -e "const p = require('./packages/protocol/dist/index.js'); const g = require('./apps/cli/dist/connect.js'); for (const e of p.SYNAPSE_COMMAND_CATALOG) { if (!g.SYNAPSE_AGENT_GUIDANCE.includes(e.tool)) throw new Error('missing ' + e.tool); } console.log('guidance covers all', p.SYNAPSE_COMMAND_CATALOG.length, 'tools')"`
      (run after `npm run build`) prints `guidance covers all 8 tools`.
- [ ] `grep -c "synapse_onboard" apps/cli/src/connect.ts` returns ≥ 1
      (the pre-existing drift is fixed).
- [ ] `git status` shows no modified files outside the in-scope list.
- [ ] `plans/README.md` status row for 017 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- `SYNAPSE_AGENT_GUIDANCE` in `apps/cli/src/connect.ts` no longer matches the
  Current-state excerpt (someone restructured the guidance after `e3c46f2`).
- `apps/cli/src/mcp.ts` registers a tool (search `server.registerTool` /
  `"synapse_`) that has NO entry in `SYNAPSE_COMMAND_CATALOG`. That means the
  catalog itself is stale — fixing it is a content decision for the owner, not
  something to slip into this plan. Report which tool is missing.
- Importing `renderCommandCatalogMarkdown` from `@synapse/protocol` in the CLI
  fails to resolve after a clean `npm run build` (would indicate a workspace
  build-order problem this plan didn't anticipate).
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **The contract going forward**: adding an MCP tool means adding a
  `SYNAPSE_COMMAND_CATALOG` entry in the same PR (already the documented rule);
  after this plan, that single edit propagates to LLM prompts, hook
  suggestions, every rules file, AGENTS.md, and MCP instructions — and the new
  drift-lock test fails if the guidance composition is ever broken.
- Existing connected repos see the new guidance only after re-running
  `synapse connect` (or `join`/`up`) — `upsertManagedBlock` swaps the managed
  block in place. Nothing auto-refreshes; consider mentioning re-running
  `connect` in release notes when this ships.
- Reviewer should scrutinize: the guidance prose (it is read by every
  connected agent on every session — wording is product surface), and that
  items 1–5 were NOT reworded (they intentionally mirror the hook behavior).
- Deferred (out of this plan): a `claude` rules integration writing a managed
  block into `CLAUDE.md`. Claude Code already gets runtime nudges from hooks
  plus MCP `instructions`, and current Claude Code reads `AGENTS.md`; add a
  CLAUDE.md target only if users on older Claude Code versions ask.
- Deferred: documenting human/CLI-only commands (`doctor`, `demo`, `up`) in
  agent guidance — they are operator commands, and the catalog is scoped to
  the agent-facing MCP surface on purpose.
