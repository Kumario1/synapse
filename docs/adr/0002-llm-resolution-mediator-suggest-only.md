# LLM resolution-mediator: suggest-only, coordinated-pair, Synapse never edits

Status: Proposed (2026-06-17). Introduces a background **mediator agent** that
reasons over Synapse's deterministic coordination state to *propose* a
reconciliation for a contested symbol, and delivers it as a **direction** to each
side's coding agent. The verdict rule is **preserved** — the LLM still never
raises, lowers, or replaces a detection verdict. What this shifts is the LLM's
*role*: from detection-time **enrichment only** to also **driving resolution**
(reasoning over state to propose reconciliations, with Synapse emitting the
directions). That shift is confined to the *resolution* axis and bounded by the
decisions below. It complements, and supersedes the "suggest-only" framing of,
the close-the-loop spike (plan 046), which scoped the deterministic fix-handoff
and explicitly left LLM resolution out.

## Context

Synapse detects a contested symbol (two live sessions editing the same symbol)
deterministically and today only **warns**. The owner wants collisions resolved
"without having to look" — the agent should read both sides' intent and produce
the edit that satisfies both. Naively that is LLM auto-merge: it inverts the
deterministic core, inherits unbounded resolution-correctness liability, and —
because most contract conflicts are *semantic* (mutually exclusive intents, no
edit satisfies both) — would confidently apply wrong reconciliations silently.

## Decisions (made together)

- **Detection stays deterministic and authoritative.** The mediator runs *on top
  of* the existing engine. It never raises, lowers, or replaces a verdict. The
  principle shift is scoped strictly to **resolution**, not detection.
- **Synapse never edits user code; the coding agent is the actuator.** The
  mediator emits a *direction* (grounded in the deterministic call-site list from
  the dependency graph); the downstream coding agent (Claude Code / Cursor / any
  MCP client) makes the edit in its own context. Synapse's hands stay clean — the
  same posture plan 046 protected. The deterministic floor of a direction —
  changed symbol, before/after signatures, affected call-site list — is exactly
  the `FixHandoff` payload from plan 046 / `docs/design/fix-handoff.md`; a
  *direction* is a per-side `FixHandoff` plus a `keep`/`adapt` role and optional
  LLM-authored adapt prose. This ADR extends that payload, it does not redefine it.
- **Suggest, never autofire.** The coding agent **surfaces** the proposed edit in
  its normal review flow; it does not silently apply it. The target experience is
  *"resolve without hunting,"* not *"resolve without seeing"* — exactly one cheap
  human/agent checkpoint per side. (Autofire was rejected: it re-imports silent
  LLM auto-merge through the actuator; a wrong reconciliation on the cooperating
  side would never be caught.)
- **A resolution is a coordinated pair, committed two-phase.** The two directions
  are one transaction, correct only together. On propose, the conflict moves
  `contested → resolving`; it becomes `resolved` only when **both** coding agents
  ack. A reject or timeout voids the pair, reverts to `contested`, and escalates
  to the Owner. (Fire-and-forget was rejected: one side accepting while the other
  rejects/lags manufactures a new, worse conflict on the side that cooperated.)
  Built on existing primitives — the server-authoritative atomic round-trip
  (plan 036) and edit locks.
- **Semantic conflicts are not "both-satisfied."** When intents are mutually
  exclusive the mediator picks a winner and assigns the other an *adapt* role;
  it does not pretend a both-satisfying edit exists. (How the winner is chosen,
  and who authorizes that choice, is the next open decision — see below.)

## Consequences

- New trust surface: an LLM now influences *what an agent is told to do* to
  resolve a conflict. Mitigated by suggest-only + per-side surfacing + two-phase
  commit; every factual claim in a direction stays grounded in deterministic
  state.
- Synapse gains a "resolving" conflict state and a small consensus protocol over
  two autonomous agents — on-brand for a coordination layer, but net-new
  machinery to build and test.

## Open (not yet decided)

- **Winner selection** for semantic conflicts and who authorizes it (lock
  seniority? task priority? always escalate to Owner?).
- **Code home** for the mediator (apps/cli vs packages/conflict-engine vs
  apps/server) — glossary terms (mediator agent, direction, actuator,
  coordinated pair, mechanical vs semantic conflict) get written into that
  package's CONTEXT.md once chosen.
- **Trigger source**: reuse the atomic intent round-trip (036) as the wake event.
