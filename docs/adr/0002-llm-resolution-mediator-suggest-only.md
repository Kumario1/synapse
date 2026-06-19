# LLM resolution-mediator: suggest-only, coordinated-pair, Synapse never edits

Status: Accepted (2026-06-18). Introduces a background **mediator agent** that
reasons over Synapse's deterministic coordination state to *propose* a
reconciliation for a contested symbol, and delivers it as a **direction** to each
side's coding agent. The verdict rule is **preserved** — the LLM still never
raises, lowers, or replaces a detection verdict. In the current slice, the LLM
only authors optional prose for the losing side's `adapt` direction; deterministic
state still owns proposal class, status, signatures, winners, and call-site
facts. This complements, and supersedes the "suggest-only" framing of, the
close-the-loop spike (plan 046), which scoped the deterministic fix-handoff and
explicitly left LLM resolution out.

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
  exclusive, Synapse does not pretend a both-satisfying edit exists. The
  server-hosted mediator emits an `awaiting_owner` proposal, and the Owner picks
  the winner. The winner keeps its deterministic `after`; the losing side gets
  the deterministic `adapt` call-site list.
- **Deterministic state owns the facts.** The server and pure conflict engine
  own signatures, affected call-site paths, proposal status, timeout/reject
  behavior, and the Owner winner choice. The LLM can only rewrite the adapt
  `Direction.summary`, and grounding rejects invented files, symbol ids, or
  signature snippets.
- **The mediator is server-hosted with pure helpers.** Request construction and
  grounding live in `packages/conflict-engine`; transient proposal mutation and
  async provider orchestration live in `apps/server`. Optional OpenRouter calls
  happen after deterministic state is broadcast and outside the per-repo lock.

## Consequences

- New trust surface: an LLM now influences *how adapt guidance is phrased* for a
  resolving conflict. Mitigated by suggest-only + per-side surfacing + two-phase
  commit; every factual claim in a direction stays grounded in deterministic
  state, and invalid prose falls back to the deterministic summary.
- Synapse gains a "resolving" conflict state and a small consensus protocol over
  two autonomous agents — on-brand for a coordination layer, but net-new
  machinery to build and test.

## Remaining work

- Issue #114 still needs Owner visibility for resolving/awaiting-owner state in
  the dashboard.
- Future protocol work may add provenance for enriched summaries; this slice
  deliberately uses the existing `Direction.summary` field.
