# Plan 045 (SPIKE): Auto-maintained contract surface as an MCP resource

> **Executor instructions**: This is a **design + prototype spike**, not a
> build-everything plan. Produce the design doc and the small prototype
> described below; do NOT ship a production feature or change conflict-detection
> behavior. Run the verification commands. If a STOP condition occurs, stop and
> report. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 6781b81..HEAD -- apps/cli/src/mcp.ts apps/cli/src/analysis.ts packages/analyzer-ts/src/index.ts`
> If these changed materially, re-confirm the cited symbols exist before
> prototyping.

## Status

- **Priority**: P2 (direction)
- **Effort**: M (spike)
- **Risk**: LOW (additive resource + design doc; no detection changes)
- **Depends on**: none (complements plan 029's MCP resources)
- **Category**: direction
- **Planned at**: commit `6781b81`, 2026-06-15

## Why this matters

Competitive research (June 2026) found that across the multi-agent orchestration
ecosystem (Cursor 2.0 worktrees, Conductor, Vibe Kanban), the **openly
acknowledged unsolved problem** is semantic/contract drift between parallel
agents — "backend agent renamed a field, frontend agent didn't get the memo."
The community workaround is a **hand-written, hand-maintained `contracts.md`**.
Synapse already extracts symbol-level contracts (signatures) deterministically
for TS/Python/Go and builds a dependency graph — so it can emit a **live,
machine-maintained contract surface** that nobody has to hand-write. This is the
single strongest wedge from the research: it productizes the manual artifact
everyone admits they need, using capability Synapse already has. This spike
defines the design and prototypes the read path; it does **not** commit to the
final shape.

## Goal of this spike

Answer these questions in a design doc and prove the cheap part with a prototype:

1. **What is "the contract surface"?** The set of exported/public symbol
   signatures across the worktree (the same `CodeSymbol`/`Signature` data the
   analyzer already produces), keyed by stable symbol id. Decide: whole worktree,
   or only the "public" surface (exported symbols, route/schema kinds), or only
   files with active deltas.
2. **How is it surfaced?** Recommended: a read-only MCP resource
   `synapse://contracts` (mirrors the existing `synapse://team-state` /
   `synapse://briefing` resources at `apps/cli/src/mcp.ts:53-130`). Decide
   whether to *also* offer a committed artifact (`.synapse/contracts.json` or
   `CONTRACTS.md`) and the freshness/commit-noise tradeoff of doing so.
3. **Freshness.** The daemon already extracts contracts and maintains a
   dependency-graph cache invalidated by the file watcher and reports
   (`apps/cli/src/analysis.ts` — `extractSymbolsForFile`, the graph cache, and
   `markGraphDirty`). Decide how the resource stays current (compute on read from
   the warm cache vs. precompute on watcher events) and the latency/staleness
   tradeoff against the hot-path budget.
4. **Noise control.** A contract surface that re-churns on every internal edit is
   a stale doc nobody trusts. Decide what's included (public surface only?) and
   how diffs are presented (full surface vs. "what changed since base branch").
5. **Relationship to existing features.** It must not duplicate
   `synapse://team-state` (live sessions/locks) — this is the *static* surface,
   not live coordination state. Decide the boundary.

## Current state (building blocks the prototype reuses)

- `apps/cli/src/mcp.ts:53-130` — four existing read-only resources registered via
  `server.registerResource(name, "synapse://...", {title, description, mimeType}, async (uri) => jsonResource(uri.href, {...}))`,
  each delegating to `daemonContext(tool, request)`. `jsonResource` helper at
  `apps/cli/src/mcp.ts:524`. **This is the exact pattern to add `synapse://contracts`.**
- `apps/cli/src/analysis.ts` — `extractSymbolsForFile(config, filePath, cache)`
  returns `CodeSymbol[]` per file; `buildDependencyGraph` / the graph cache
  enumerate the worktree's analyzable files; `isAnalyzable(filePath)` filters.
- `packages/analyzer-ts/src/index.ts` — `extractTypeScriptContracts` produces the
  symbols + signatures; `CodeSymbol`/`Signature` types live in `@synapse/protocol`.
- `packages/protocol/src/command-catalog.ts` — `SYNAPSE_COMMAND_CATALOG`; if the
  surface becomes a tool/command, register it here so it appears in generated
  rules (the pattern the README documents).
- `docs/design/state-delta-broadcast.md` and `docs/design/coordination-channel.md`
  — the **design-doc format to follow** (status header with ground-truth commit,
  numbered problem/options/decision/open-questions sections).

## Commands you will need

| Purpose   | Command                              | Expected on success |
|-----------|--------------------------------------|---------------------|
| Build     | `npm run build`                      | exit 0              |
| Typecheck | `npm run typecheck`                   | exit 0              |
| MCP adapter verify | `npm run verify:mcp-adapter`    | exit 0, ends `PASS` |

## Scope

**In scope**:
- `docs/design/contract-surface.md` (create) — the design doc answering the 5
  questions, following the existing design-doc format.
- `apps/cli/src/mcp.ts` — register a **prototype** `synapse://contracts` resource
  that returns the worktree's public symbol surface as JSON (read path only,
  reusing existing extraction). Keep it additive and behind the same daemon
  context the other resources use.
- Optionally extend `scripts/verify-mcp-adapter.mjs` with a read assertion for
  the new resource (only if the prototype is wired far enough to test).

**Out of scope**:
- Any change to conflict detection, the engine, or severity.
- A committed `CONTRACTS.md` artifact writer — **design it, do not build it**
  (commit-noise decision belongs to the maintainer).
- New analyzers/languages.
- Performance optimization of extraction (note hot-path concerns in the doc;
  don't refactor `analysis.ts`).

## Steps

### Step 1: Write the design doc

Create `docs/design/contract-surface.md` following the format of
`docs/design/state-delta-broadcast.md`:
- Status header: `Status: SPIKE` + ground-truth commit `6781b81`.
- §0 Problem (the manual `contracts.md` gap, with the competitive grounding).
- §1 What the surface is (recommended: public/exported symbols + their
  signatures, keyed by symbol id) with the include/exclude decision.
- §2 Surfacing options (MCP resource — recommended; committed artifact — pros/cons).
- §3 Freshness + hot-path tradeoff (read-from-warm-cache vs precompute).
- §4 Noise control / diff presentation.
- §5 Boundary vs `synapse://team-state`.
- §6 Open questions for the maintainer.

**Verify**: the file exists and covers all six sections.

### Step 2: Prototype the `synapse://contracts` read resource

In `apps/cli/src/mcp.ts`, register a new resource `synapse://contracts` mirroring
the existing four. It should return JSON containing the worktree's public symbol
surface — reuse the existing daemon/analysis extraction (do not re-implement
parsing). If the daemon already exposes the contract/graph data through a tool or
internal endpoint, route through that (mirror how the other resources call
`daemonContext`); if not, the prototype may compute from `extractSymbolsForFile`
over `isAnalyzable` files via the existing cache. Keep it small — a prototype that
returns the symbol ids + signatures of exported symbols is enough to validate the
shape.

**Verify**: `npm run build && npm run typecheck` → exit 0.

### Step 3: Smoke-test the resource (if wired far enough)

If the prototype resource is reachable through the MCP adapter, extend
`scripts/verify-mcp-adapter.mjs` to list/read `synapse://contracts` and assert it
returns a JSON body with at least one symbol for a fixture file. If wiring it to
the adapter test is more than a small addition, instead document in the design
doc how it would be tested and skip the script change.

**Verify**: `npm run verify:mcp-adapter` → exit 0, ends `PASS` (whether or not
you added the assertion).

## Done criteria

ALL must hold:

- [ ] `docs/design/contract-surface.md` exists and answers the 5 design questions + open questions
- [ ] `npm run build` exits 0
- [ ] `npm run typecheck` exits 0
- [ ] A prototype `synapse://contracts` resource is registered in `apps/cli/src/mcp.ts` and returns JSON
- [ ] `npm run verify:mcp-adapter` exits 0
- [ ] No conflict-detection / engine files modified (`git status` — only mcp.ts, the design doc, and optionally the adapter verify script)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Computing the full worktree surface on resource-read measurably blows the
  hot-path latency budget (the daemon shares the analysis cache). If so, document
  the precompute-on-watcher option in the doc and keep the prototype scoped to a
  single file or the changed surface; report the tradeoff.
- There is no clean way to reach the contract data from the MCP adapter without a
  new daemon endpoint — that endpoint is a real feature, not a spike; document
  the needed endpoint in the design doc and STOP rather than building it.

## Maintenance notes

- The maintainer decides after this spike: (a) MCP-resource-only vs also a
  committed artifact, (b) public-surface-only vs full, (c) precompute vs
  read-time. Those become the implementation plan(s).
- If a committed artifact is chosen later, it must be idempotent and use the
  managed-block convention the README describes for `connect`-written files.
- Strongest-wedge note: this is the feature the competitive research most
  strongly supports — keep it deterministic and trustworthy (a contract surface
  agents can't trust is worse than none).
