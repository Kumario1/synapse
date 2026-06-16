# Plan 046 (SPIKE): Close-the-loop — structured fix handoff to the downstream agent

> **Executor instructions**: This is a **design + prototype spike**, not a
> build-everything plan. Produce the design doc and the small deterministic
> prototype described below; do NOT auto-edit user code or change conflict
> verdicts. Run the verification commands. If a STOP condition occurs, stop and
> report. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 6781b81..HEAD -- apps/cli/src/analysis.ts packages/conflict-engine/src/index.ts packages/protocol/src/command-catalog.ts`
> If these changed materially, re-confirm the cited symbols before prototyping.

## Status

- **Priority**: P2 (direction)
- **Effort**: M–L (spike scopes the deterministic core; LLM/auto-edit are out)
- **Risk**: LOW as a spike (additive payload + design doc; suggest-only)
- **Depends on**: none (complements the existing resolution layer)
- **Category**: direction
- **Planned at**: commit `6781b81`, 2026-06-15

## Why this matters

Synapse today **detects** a breaking contract change and **warns**. Competitive
research (June 2026) shows the market moving from detect → **resolve**: Vibe
Kanban offers agent-assisted rebase resolution, Composio auto-fixes conflicts,
Graphite resolves at merge time. Synapse is uniquely positioned to close the loop
*better* than any of them because its detection is deterministic and
signature-level: when symbol `X` changes from signature `A` to `B`, Synapse
already knows (via its dependency graph) **which downstream call sites are
affected**. So it can hand the downstream agent a precise, scoped instruction —
"`getUser(id)` → `getUser(id, opts)`; 3 call sites affected: a.ts:12, b.ts:40,
c.ts:7" — instead of a bare warning. This spike defines that **fix-handoff**
payload and prototypes the deterministic core (enumerate affected call sites from
the existing graph); it explicitly leaves auto-editing and LLM patch synthesis
out (they carry resolution-correctness liability — keep the agent in the loop).

## Goal of this spike

Answer in a design doc and prove the deterministic core with a prototype:

1. **Payload shape.** Define a `FixHandoff` object: the changed symbol, its
   `before`/`after` signature, a human/agent-readable change summary, and the
   list of affected downstream call sites (`{ symbolId, filePath, line? }[]`),
   derived deterministically from the dependency graph. Decide where it attaches
   — recommended: on the relevant conflict's `analysis.actions[]` /
   `analysis.resolution`, so it flows through the existing check response and hook
   output, not a new channel.
2. **Which conflicts get a handoff.** Map the engine rules
   (`dependency_changed`, `transitive_dependency`, `contract_divergent`) to what
   a useful handoff says for each. Decide the deterministic floor (call-site list
   + before/after) vs. the optional-LLM enrichment (suggested edit prose), with
   the LLM strictly *additive* (the existing "LLM can raise, never replace"
   discipline).
3. **Call-site enumeration.** The dependency graph already knows incident edges.
   Decide how to turn a changed symbol into the list of dependents
   (reuse `dependenciesOf` / `neighborsOf` in `apps/cli/src/analysis.ts`) and
   whether line numbers are available/needed.
4. **Surfacing.** How the handoff reaches the downstream agent: in the
   `synapse_check` response actions, as an MCP tool (e.g. `synapse_fix_handoff`),
   and/or in the hook output. Decide the minimal surface.
5. **Human/agent-in-loop boundary.** The handoff is a **suggestion**, never an
   auto-edit. State this explicitly and decide whether even the LLM "suggested
   edit" is opt-in (it should be, like the other LLM layers).

## Current state (building blocks)

- `apps/cli/src/analysis.ts` — the dependency graph layer: `buildDependencyGraph`,
  `dependenciesOf(symbol)` (keyed adjacency), `neighborsOf(symbolRaw)` (incident
  edges), and `attachResolutions` (the existing place where merged-contract
  resolutions are attached to `contract_divergent` conflicts). **The call-site
  enumeration the handoff needs already exists here.**
- `packages/conflict-engine/src/index.ts` — `evaluateConflicts` produces the
  conflicts; rules `dependency_changed` / `transitive_dependency` /
  `contract_divergent` are where a handoff is meaningful. `packages/conflict-engine/src/explain.ts`
  builds the human-readable explanation (the place an affected-sites list could
  render).
- `ContractChange` / `Signature` carry `before`/`after` (the signature diff).
- `packages/protocol/src/command-catalog.ts` — `SYNAPSE_COMMAND_CATALOG` + the
  `actions[]` `command` mechanism the README documents (`→ run: ...`); a handoff
  could surface as a validated suggested command.
- `apps/cli/src/explain-openrouter.ts` — the optional LLM layer; any LLM
  "suggested edit" enrichment must be gated like the existing
  `SYNAPSE_LLM_*` flags and validated.
- `docs/design/coordination-channel.md` — design-doc format to follow.

## Commands you will need

| Purpose   | Command                              | Expected on success |
|-----------|--------------------------------------|---------------------|
| Build     | `npm run build`                      | exit 0              |
| Typecheck | `npm run typecheck`                   | exit 0              |
| Engine unit tests | `npm test --workspace @synapse/conflict-engine` | all pass |
| Dependency check verify | `npm run verify:dependency-ts-check` | exit 0, ends `PASS` |

## Scope

**In scope**:
- `docs/design/fix-handoff.md` (create) — the design doc answering the 5
  questions, following the existing design-doc format.
- A **deterministic prototype** that, for a `dependency_changed` /
  `contract_divergent` conflict, enumerates the affected downstream call sites
  from the existing dependency graph and attaches them to the conflict's
  analysis (additive field, e.g. `analysis.affectedSites`). Reuse
  `dependenciesOf` / `neighborsOf`; do not re-implement graph building.
- A unit test for the deterministic enumeration.

**Out of scope** (design only, do NOT build):
- **Auto-editing user code** — never. The handoff is suggest-only.
- **LLM patch synthesis** — design the optional enrichment; do not implement it.
- A new MCP tool / wire-schema change — design it; the prototype attaches to the
  existing analysis structure only.
- Changing any conflict **verdict** or severity — the handoff is metadata on an
  existing conflict, not a new detection.

## Steps

### Step 1: Write the design doc

Create `docs/design/fix-handoff.md` (format per `docs/design/coordination-channel.md`):
- Status header: `Status: SPIKE` + ground-truth commit `6781b81`.
- §0 Problem (detect→resolve gap, competitive grounding, Synapse's deterministic
  advantage).
- §1 `FixHandoff` payload shape (TypeScript interface).
- §2 Rule→handoff mapping (deterministic floor vs optional LLM).
- §3 Call-site enumeration from the graph.
- §4 Surfacing (actions / MCP tool / hook).
- §5 In-loop boundary (suggest-only; LLM opt-in).
- §6 Open questions.

**Verify**: the file exists and covers all six sections.

### Step 2: Prototype deterministic affected-site enumeration

Add a small, pure, exported function (in `apps/cli/src/analysis.ts` or a sibling
module) that, given a changed symbol and the existing dependency graph, returns
the downstream sites `{ symbolId, filePath }[]` that depend on it — reusing
`dependenciesOf` / the adjacency the graph already builds. Attach the result to
the relevant conflict's analysis as an additive field (e.g.
`analysis.affectedSites`) where `attachResolutions` already enriches
`contract_divergent` conflicts. Keep it deterministic — no LLM.

**Verify**: `npm run build && npm run typecheck` → exit 0.

### Step 3: Unit-test the enumeration

Add a unit test (model after the existing dependency-graph tests, e.g. the
patterns exercised by `verify:dependency-ts-check` and the engine's
`index.test.ts`): given a small fixture graph where `b` and `c` depend on `a`,
changing `a` yields affected sites `[b, c]`; a symbol with no dependents yields
`[]`.

**Verify**: `npm test --workspace @synapse/conflict-engine` (or the workspace
that owns the new function) → all pass, including the new test.

### Step 4: Confirm no detection regression

**Verify**: `npm run verify:dependency-ts-check` → exit 0, ends `PASS` (the
existing dependency-change detection is unchanged; the handoff is additive).

## Done criteria

ALL must hold:

- [ ] `docs/design/fix-handoff.md` exists and answers the 5 design questions + open questions
- [ ] `npm run build` exits 0
- [ ] `npm run typecheck` exits 0
- [ ] A deterministic affected-sites enumerator exists, is unit-tested, and attaches to the conflict analysis additively
- [ ] `npm run verify:dependency-ts-check` exits 0 (no detection regression)
- [ ] No auto-edit / LLM-patch code added; no verdict/severity changes (`git diff` review)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Enumerating affected sites requires line numbers the analyzer doesn't currently
  produce — document that the symbol/file granularity is the floor and line-level
  is a follow-on; do NOT add line tracking to the analyzers in this spike.
- Attaching `affectedSites` to the analysis means a wire-schema change (it should
  not — it's local analysis metadata on the check response, not persisted/broadcast
  state). If it would touch `packages/protocol/src/wire-schema.ts`, STOP and
  scope that into the design doc instead.
- The deterministic enumeration would meaningfully slow the check hot path
  (it walks the graph once per breaking conflict — should be cheap; if it isn't,
  note it and gate the enumeration behind the existing enrich path that already
  runs for these conflicts).

## Maintenance notes

- After this spike the maintainer decides: the surfacing (actions vs new MCP
  tool), whether to add the optional LLM "suggested edit" (opt-in, validated like
  the existing resolver), and whether line-level call sites are worth analyzer
  changes.
- Keep the deterministic floor strong and separate from any LLM layer — the
  whole value proposition vs. competitors is that the *detection and the affected
  sites are deterministic*, only the prose suggestion is optional.
- This pairs with plan 045 (contract surface): the surface answers "what is the
  contract," the handoff answers "you broke it — here's where and what to do."
