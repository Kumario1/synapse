# Design: Fix Handoff

> Status: SPIKE — bounded prototype adds deterministic affected-site metadata
> to check analysis only. Ground truth: `main` @ `a79b3a3`, 2026-06-15. No
> auto-editing, wire-schema change, verdict change, or severity change is part
> of this spike.

## 0. Problem

Synapse can already tell an agent that another session changed a contract it
depends on. The next useful step is narrower than "fix the repo": give the
downstream agent a structured handoff that names the changed symbol, shows the
contract movement, summarizes the risk, and lists affected downstream sites.

The handoff must remain advisory. Synapse should supply the scope and facts; a
human or supervising agent still owns judgment and code changes.

## 1. Payload Shape

The intended production object is:

```ts
interface FixHandoff {
  changedSymbol: SymbolId;
  before: Signature | null;
  after: Signature | null;
  summary: string;
  affectedSites: { symbolId: SymbolId; filePath: string; line?: number }[];
  source: "deterministic" | string;
}
```

For this spike, the deterministic floor is attached additively as
`conflict.analysis.affectedSites`:

```json
{
  "analysis": {
    "affectedSites": [
      { "symbolId": { "raw": "ts:src/caller.ts#render" }, "filePath": "src/caller.ts" }
    ]
  }
}
```

The existing conflict already carries `targetSymbol`, `change.before`,
`change.after`, `detail`, `suggestion`, and `analysis.actions`. A future
first-class `FixHandoff` can compose those fields without changing conflict
verdict semantics.

## 2. Eligible Conflicts

Handoffs should be generated for:

- `dependency_changed`: the primary close-the-loop case; a changed dependency
  has downstream callers that may need adaptation.
- `transitive_dependency`: lower urgency, but still useful for bounded review
  of second-hop sites.
- `contract_divergent`: both sides changed the same symbol and need a shared
  contract; affected downstream sites show where that final contract is used.

The deterministic floor is only the structured payload: changed symbol,
before/after signatures when available, summary, and affected sites. Optional
LLM prose can rewrite the instruction or explain migration steps, but it must
not be required for payload generation and must not alter detection, conflict
ids, verdict, or severity.

## 3. Call-site Enumeration

The prototype derives affected sites from the existing dependency graph. The
graph already has edges from dependent symbol to dependency symbol, so reverse
adjacency can answer "who directly depends on this symbol?" cheaply after the
graph is built.

The returned floor is symbol and file granularity:

- `symbolId`: the dependent symbol id
- `filePath`: inferred from analyzer symbol ids such as
  `ts:src/api.ts#handler`
- `line`: omitted for now

Line numbers require analyzer span tracking to be threaded through dependency
edges. That is a follow-on, not a requirement for this spike.

Current prototype limitation: for `dependency_changed` and
`transitive_dependency`, the conflict engine does not retain the counterpart's
changed `symbolId` as a structured field on the conflict. The spike therefore
attaches affected sites where the changed symbol is known locally from
`targetSymbol`, which is immediately useful for `contract_divergent`.
Production should carry the dependency delta symbol through the conflict draft
or compute the handoff inside the engine at the point where `delta.symbolId` is
available. That should be done without touching the wire schema unless the
field graduates into the public protocol.

## 4. Surfacing

Recommended surfacing order:

1. Additive check response metadata on `conflict.analysis`, as prototyped here.
2. MCP resource/tool projection for agents that want a handoff by conflict id.
3. Hook output that can paste the bounded instruction into downstream agent
   context.

The spike deliberately keeps this local to the CLI response with an
intersection type. `packages/protocol/src/wire-schema.ts` is not changed. If
the field becomes a supported client contract, graduate it through the protocol
and wire schema in a separate compatibility-focused plan.

Plan 045's `synapse://contracts` surface is complementary: it describes the
current public contract inventory. Fix handoff is conflict-specific and uses
team-state deltas plus the dependency graph to scope follow-up work.

## 5. Human and Agent Boundary

Synapse should suggest; it should not edit. The preferred close-the-loop
execution model is:

- A high-ceiling `xhigh` agent is the main thinker and reviewer. It owns the
  judgment loop: interpret the conflict, inspect the executor's patch, review
  the PR, wait for CI, and decide whether to merge.
- Lower-level `low` or `medium` thinking agents act as bounded executors. They
  receive the structured handoff, make scoped implementation changes, run local
  checks, and open a PR.

This keeps expensive judgment where it matters and lets cheaper/lower agents do
well-specified implementation from a structured handoff. The handoff payload is
the contract between those roles: facts, scope, affected sites, and a suggested
instruction, not permission to auto-edit or merge.

## 6. Open Questions

- Should `affectedSites` stay inside `analysis`, or should a first-class
  `fixHandoff` object sit beside `analysis` on eligible conflicts?
- Should `dependency_changed` carry the counterpart `delta.symbolId` directly
  on the conflict, or should fix handoff be computed inside conflict evaluation?
- What is the right maximum affected-site count before summarizing or requiring
  an explicit expanded query?
- Should MCP expose handoff by conflict id, symbol id, or both?
- When line numbers are added, should they point to the dependent symbol span,
  the exact reference expression, or both?
- How should optional LLM prose be cached and invalidated when signatures or
  affected sites change?
