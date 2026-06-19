# Task-scoped reservations: derived scope, deny-core / warn-radius

Status: Accepted (2026-06-19). **Extends** ADR 0002 (`llm-resolution-mediator
suggest-only`); does not reverse it. Introduces a **Reservation** — a session's
durable, self-sizing region — and gives the PreToolUse hook its first blocking
path, scoped so tightly that the suggest-only posture survives intact. A
Reservation is the running union of the symbols a session actively holds
(`EditLock`) and their N-hop dependency-graph neighbors. Enforcement decays with
graph distance: a hard **deny** only when a second _live_ session collides on a
symbol another live session currently holds; the dependency **radius keeps the
existing `warn`/`info` advisories**. Synapse still never edits user code.

## Context

Detection today is reactive: by the time a symbol is `contested`, both sides
have already done work, so coordination means someone adapts or wastes effort.
The PreToolUse hook only ever returns `ask` — `preToolUseDecision`
(`apps/cli/src/hooks.ts`) is commented _"the 'agents query, humans decide'
principle — never an auto-block."_ Wasted parallel work is surfaced, never
pre-empted.

The owner asked whether "smart contracts" (deterministic execution, escrow,
enforceable obligations, immutable audit, automatic enforcement) could improve
the product. Grilling collapsed the framing: deterministic execution, escrow
(the two-phase _coordinated pair_), state-machine agreements (`contested →
resolving → resolved`), and an audit trail (the deterministic resolution tracer)
already exist; automatic enforcement (autofire) is forbidden by ADR 0002. The
only genuinely new, non-rename idea left is a **forward-looking, self-sizing
claim that pre-empts work before it starts**. Hand-drawn Owner boundaries in the
dashboard were rejected — the owner wants scope _derived from context_, scaling
with blast radius, not hand-maintained.

## Decisions

- **A Reservation is derived, never declared.** It is the running union of the
  symbols a session edits (captured via PostToolUse) and their dependency-graph
  neighbors (`DependencyGraph.dependenciesOf(sym, N)`, already walked at 2 hops
  in `conflict-engine`). A big refactor touches more symbols, so its reservation
  grows to cover the repo; a small change stays small. Scope is deterministic
  and emergent — no LLM guess, no dashboard knob — consistent with
  "deterministic state owns the facts."
- **Deny-core, warn-radius.** Enforcement strength decays with graph distance,
  reusing the `explain.ts` severity ladder (`dependency_changed: "warn"`,
  `transitive_dependency: "info"`). A hard `deny`
  (`permissionDecision: "deny"`) fires only when a second live session attempts a
  symbol another live session currently holds an `EditLock` on. The dependency
  radius keeps the existing advisories.
- **The `deny` is consent-clean, so 0002 is extended, not reversed.** ADR 0002
  refused auto-block because a Synapse-discovered conflict would override a human
  who never agreed. A live edit-lock collision is different: the blocked party is
  being held to a mutual-exclusion lock that exists because another session is in
  that symbol right now. Synapse still never edits code; `deny` is a coordination
  refusal at the hook, honored by cooperating agents.
- **Reservations pre-empt at session join, not just at edit time.** A joining
  session is warned about teammates' live reservations at the start of work.
  Task-to-reservation matching is semantic and fuzzy, so it drives warn-only
  context, never `deny`.
- **"Contract" stays reserved for a symbol's API surface.** The new region is a
  **Reservation**. `ContractDelta`, `ContractChange`, and `ContractResolution`
  keep their meaning. The "smart contract" framing is dropped.
- **Release reuses existing primitives.** A reservation dissolves on push (the
  work landed) or on `EditLock` TTL expiry. No net-new lifecycle machinery is
  needed for the deterministic floor.

## Consequences

- The PreToolUse hook gains a blocking path for the first time. Mitigated by
  scoping `deny` strictly to live edit-lock collisions; everything
  dependency-derived stays advisory, and `SYNAPSE_HOOK_NONBLOCKING=1` still
  downgrades to context-only.
- A Reservation is persisted, queryable per-session state. It is a union over
  reported edit roots plus deterministic graph neighbors, cleared on push or
  edit-lock TTL.
- Two sessions' growing reservations can collide on the core — that is the
  existing `contested` flow, now possibly reached via `deny` instead of `ask`.
  The reject / timeout / void / Owner-escalation paths from ADR 0002 handle it
  unchanged.
- Enforcement is only as strong as the cooperating hook: a human or non-Synapse
  agent can edit through a `deny`. Acceptable for a coordination layer.

## Remaining work

- Persist `Reservation` as queryable per-session state (protocol type + server
  store) — shipped in issue #129.
- Add task-to-reservation overlap matching using captured prompts. The warn-only
  floor shipped across issues #128 and #129: SessionStart now surfaces active
  teammates' stored Reservations from `synapse_whatsup`.
- Flip `preToolUseDecision` to return `deny` for the live edit-lock collision
  case only; keep `ask` / `warn` elsewhere.
- Surface live reservations to Owners in the dashboard.
