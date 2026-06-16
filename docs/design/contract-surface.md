# Design: Auto-maintained Contract Surface

> Status: SPIKE — bounded prototype exposes a read-only MCP resource only.
> Ground truth: `main` @ `d32f1c5`, 2026-06-15. No conflict-detection,
> analyzer, or committed-artifact behavior changes are part of this spike.

## 0. Problem

Parallel agents still depend on hand-written `contracts.md`-style notes to
avoid semantic drift. That document can be useful prose, but it is not
ground truth: agents forget to update it, reviewers have to notice drift by
inspection, and the current state is hard to compare mechanically.

The competitive baseline is "summarize what changed" from chat history,
diffs, or a manually curated file. Synapse has a stronger deterministic
input: it already extracts symbol-level contracts for TypeScript, Python, and
Go, assigns stable symbol ids, captures signatures, and builds a dependency
graph. The contract surface should be a live read model over those existing
facts, not another place for agents to write narrative state.

## 1. What the surface is

The recommended surface is the current worktree's public/exported symbol
contracts:

- key: stable `SymbolId.raw`, for example `ts:apps/cli/src/mcp.ts#runMcp`
- display fields: `name`, `kind`, `visibility`, `filePath`
- contract field: `signature.raw` when the analyzer has one, otherwise
  `null`

Included:

- symbols with `visibility === "exported"` or `visibility === "public"`
- supported analyzer languages only: TypeScript-like, Python, and Go
- source files under the current worktree, respecting the existing ignored
  directories used by analysis

Excluded:

- `visibility === "internal"` symbols
- file-level fallback symbols for unsupported languages
- dependency edges, dependents, conflict verdicts, edit locks, and team state
- generated committed output such as `CONTRACTS.md` or
  `.synapse/contracts.json`

This keeps the resource small enough to be scan-friendly and stable enough to
diff. A future full surface can add dependency edges as a separate field, but
the first contract should be "what callable/public API exists now?"

## 2. Surfacing options

Recommended for the first production direction: a read-only MCP resource,
`synapse://contracts`.

Why MCP first:

- It fits the existing context resources (`synapse://briefing`,
  `synapse://team-state`, `synapse://decisions`, `synapse://pr-brief`).
- It avoids merge churn from generated artifacts.
- Agents can read it on demand without changing conflict-engine behavior.
- The server can return structured JSON, so downstream tools can diff by
  symbol id instead of parsing prose.

A committed artifact remains useful for teams that want code-review-visible
contract drift or CI snapshots. The tradeoff is noise: a generated file can
become another conflict hotspot, and every analyzer formatting change creates
repo diffs. If built later, it should be opt-in and generated from the same
read model as the MCP resource, not independently maintained.

## 3. Freshness and hot-path tradeoff

There are two viable freshness models:

- Read-time direct scan: when `synapse://contracts` is read, scan analyzable
  files and extract symbols with the existing helpers.
- Precompute on watcher events: keep a warm contract-surface cache current as
  source files change, similar in spirit to the dependency graph cache.

The spike uses read-time direct scan because it is additive, local to MCP, and
proves that the surface can be produced without a new daemon endpoint. Its
cost is latency proportional to the supported source tree. That is acceptable
for a prototype resource read, but it should not be put on a frequent check
hot path.

For production, precompute-on-watcher is the better default if large repos
make read-time extraction slow. The staleness contract should be explicit:
warm cache reads are fast but may lag by one watcher event; direct reads are
fresh but slower. A resource payload can carry `generatedAt` and, later,
`sourceFingerprint` or cache status so clients know which mode answered.

## 4. Noise control and diff presentation

Noise control starts with scope: public/exported symbols only. Internal
helpers are usually implementation detail, and surfacing them would make the
resource too twitchy for multi-agent coordination.

Diff presentation should be keyed by symbol id:

- added/removed symbol ids
- signature changes for stable ids
- visibility changes into or out of the public surface
- file path changes as metadata, not as identity, unless the analyzer changes
  the symbol id

The default view should be a compact summary by symbol, with optional expanded
signatures. Prose summaries can help humans, but machines should consume the
structured JSON directly.

## 5. Boundary vs `synapse://team-state`

`synapse://contracts` is static worktree surface. It answers: "what public
contracts does this checkout expose right now?"

`synapse://team-state` is live coordination state. It answers: "who is active,
what is unpushed, what locks/resolutions/recent pushes exist, and what has the
team broadcast?"

The two resources should not merge. Team state changes because people and
sessions move; contract surface changes because source files change. Keeping
them separate prevents a static API inventory from becoming another channel
for coordination events, and prevents live team-state reads from paying source
analysis cost.

## 6. Open questions

- Should production serve the surface from the daemon cache, from MCP-local
  direct reads, or support both with a freshness field?
- What repo-size threshold makes read-time extraction too slow for MCP
  clients?
- Should dependency edges appear in `synapse://contracts`, or should they be a
  separate `synapse://dependency-graph` resource?
- Should a committed artifact be opt-in per repo, per CI job, or not built at
  all?
- How should analyzers represent overloads, generated declarations, and
  language-specific visibility conventions in a unified surface?
