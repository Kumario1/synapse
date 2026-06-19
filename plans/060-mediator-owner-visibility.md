# Plan 060: Surface mediator state in insights and the Owner dashboard

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Stop
> and report if any STOP condition occurs.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat e28b7d5..HEAD -- \
>   packages/protocol/src/index.ts \
>   apps/cli/src/daemon.ts \
>   apps/cli/src/mcp.ts \
>   scripts/verify-insights.mjs \
>   apps/web/src/Dashboard.tsx \
>   apps/web/src/panels.tsx \
>   apps/web/src/derive.ts \
>   apps/web/src/derive.test.ts \
>   apps/web/src/projects.ts \
>   apps/web/src/projects.test.ts \
>   apps/web/src/components/ProjectsDashboard.tsx \
>   apps/web/src/fixture.ts \
>   apps/web/CONTEXT.md \
>   README.md \
>   plans/README.md
> ```

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/056-mediator-tracer-two-phase-happy-path.md, plans/057-mediator-reject-timeout-void-escalation.md, plans/058-mediator-mechanical-vs-semantic-classification.md
- **Category**: direction
- **Planned at**: commit `e28b7d5`, 2026-06-18
- **Issue**: https://github.com/Kumario1/synapse/issues/114

## Why this matters

Plans 056-059 created mediator proposals, rejects/timeouts, semantic Owner
winner choice, and optional adapt prose. Owners still cannot see that mediator
state where they already work. This plan adds the smallest useful visibility:
`synapse insights` counts mediator states, and the Owner Room dashboard shows
resolving pairs, resolved pairs, and escalations with winner-choice buttons.

## Current state

- `SynapseInsightsResponse.totals` currently has feedback/session/delta/lock
  counts only.
- `apps/cli/src/daemon.ts#buildInsightsResponse` ignores
  `state.resolutionProposals`.
- `apps/web/src/Dashboard.tsx` renders metrics plus `OnlinePanel`,
  `SignalsPanel`, `FlowGraph`, and `CommitsPanel`.
- `apps/web/src/projects.ts` already has the Owner kick POST helper but no
  resolve-winner helper.
- The server already exposes
  `POST /auth/projects/resolve-winner?repoId=<id>&proposalId=<id>&winnerSessionId=<id>`.

Existing dashboard design review for this slice:

- Use one compact card named `Resolution mediator` in the existing Room grid.
- Show counts as badges: resolving, resolved, escalated.
- Escalations are `awaiting_owner` and `voided`.
- For `awaiting_owner`, show one button per candidate session id. Clicking it
  calls the existing Owner-authenticated resolve-winner route.
- For `voided`, show the reason and the involved directions if present.
- Do not add a modal, wizard, new route, browser WebSocket message, or any code
  edit control. Owner action is decision-only.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Protocol tests | `npm test --workspace @synapse/protocol` | all pass |
| CLI tests | `npm test --workspace @synapse/cli` | all pass |
| Web tests | `npm test --workspace @synapse/web` | all pass |
| Web build | `npm run build --workspace @synapse/web` | exit 0 |
| Insights verifier | `npm run verify:insights` | exit 0 |
| Mediator verifier | `npm run verify:mediator` | exit 0 |
| Lint | `npm run lint` | exit 0; warnings only |
| Format check | `npm run format:check` | exit 0 |

Use Node `20.19.2` from `.nvmrc`.

## Scope

**In scope**:

- `packages/protocol/src/index.ts`
- `apps/cli/src/daemon.ts`
- `apps/cli/src/mcp.ts`
- `scripts/verify-insights.mjs`
- `apps/web/src/Dashboard.tsx`
- `apps/web/src/panels.tsx`
- `apps/web/src/derive.ts`
- `apps/web/src/derive.test.ts`
- `apps/web/src/projects.ts`
- `apps/web/src/projects.test.ts`
- `apps/web/src/components/ProjectsDashboard.tsx`
- `apps/web/src/fixture.ts`
- `apps/web/CONTEXT.md`
- `README.md`
- `plans/README.md`
- `plans/060-mediator-owner-visibility.md`

**Out of scope**:

- Do not change mediator state transitions, TTLs, proposal creation, or
  `applyWinnerChoice`.
- Do not add any code-edit action. The coding agent remains the actuator.
- Do not add a new protocol wire message or browser WebSocket action.
- Do not add a modal or broad dashboard redesign.
- Do not solve branch cleanup/governance TODOs.

## Steps

### Step 1: Add mediator counts to insights

Extend `SynapseInsightsResponse.totals` with:

- `resolutionResolving`
- `resolutionResolved`
- `resolutionEscalated`

In `apps/cli/src/daemon.ts#buildInsightsResponse`, count
`state.resolutionProposals ?? []`:

- resolving = `status === "resolving"`
- resolved = `status === "resolved"`
- escalated = `status === "awaiting_owner" || status === "voided"`

Add one summary line when any mediator proposal exists, e.g.
`Mediator proposals: 1 resolving, 0 resolved, 2 escalated.`

Update the MCP `synapse_insights` description to mention mediator proposals.

Update `scripts/verify-insights.mjs` with positive coverage. The simplest
acceptable path is to create a resolving mediator proposal through the existing
daemon/server flow, then assert `totals.resolutionResolving > 0` and the
summary line includes `Mediator proposals`.

### Step 2: Add pure web derivation for mediator overview

In `apps/web/src/derive.ts`, add a small helper:

```ts
export function deriveResolutionOverview(state: TeamState) {
  const proposals = state.resolutionProposals ?? [];
  return {
    proposals,
    resolving: proposals.filter((p) => p.status === "resolving"),
    resolved: proposals.filter((p) => p.status === "resolved"),
    escalated: proposals.filter((p) => p.status === "awaiting_owner" || p.status === "voided")
  };
}
```

Add tests in `apps/web/src/derive.test.ts` for resolving/resolved/escalated
counts and `awaiting_owner`/`voided` classification.

### Step 3: Add Owner resolve-winner helper

In `apps/web/src/projects.ts`, add:

- `resolveWinnerUrl(repoId, proposalId, winnerSessionId)`
- `chooseResolutionWinner(repoId, proposalId, winnerSessionId): Promise<boolean>`

Match `kickUrl`/`kickSession`: HTTP POST, `credentials: "include"`, false on
network error. Update `projects.test.ts` for URL encoding.

### Step 4: Add the dashboard resolution card

In `apps/web/src/panels.tsx`, add `ResolutionPanel`:

- Props: `state: TeamState`, optional
  `onChooseWinner?: (proposal: ResolutionProposal, winnerSessionId: string) => void`.
- Use existing `Card`, `Badge`, `Button`, `Separator`, `PanelEmpty` patterns.
- Header title: `Resolution mediator`.
- Header badge count: number of `state.resolutionProposals ?? []`.
- Empty state: no mediator proposals.
- Each row shows symbol, status, class, directions summary, and accepted count.
- `awaiting_owner` rows show candidate buttons. Button text can be the session
  login/member when available, else the session id.
- `voided` rows show `voidReason` and `voidedBy` when present.
- Do not expose any code-edit action.

In `Dashboard.tsx`, import and render `ResolutionPanel` in the existing grid,
and add a mediator metric if useful. Keep text compact so mobile cards do not
overflow.

In `ProjectsDashboard.tsx`, pass `onChooseWinner` to `Dashboard`. On success,
fetch the owned room state once and update state immediately; the 2s poll
remains the fallback.

### Step 5: Seed demo data and docs

Update `apps/web/src/fixture.ts` so the demo includes at least one mediator
proposal in a contested frame and one resolved/voided later frame. Keep it
small.

Update `apps/web/CONTEXT.md` with `Resolution mediator` as web vocabulary.

Update `README.md`:

- `synapse insights` now includes mediator proposal counts.
- Owner dashboard now shows resolving, resolved, awaiting-owner, and voided
  mediator proposals, with winner choice for semantic conflicts.

Update `plans/README.md` row 060 to DONE after verification.

## Test plan

- `npm test --workspace @synapse/web`
- `npm test --workspace @synapse/cli`
- `npm test --workspace @synapse/protocol`
- `npm run verify:insights`
- `npm run verify:mediator`
- `npm run build --workspace @synapse/web`
- `npm run build`
- `npm run typecheck`
- `npm run lint`
- `npm run format:check`

## Done criteria

- [ ] `synapse insights` response includes mediator resolving/resolved/escalated counts.
- [ ] `verify:insights` proves a positive mediator count.
- [ ] Dashboard shows mediator proposals and escalations in the Room view.
- [ ] Awaiting-owner semantic proposals have Owner winner-choice buttons wired
      to the existing HTTP route.
- [ ] Voided proposals are visible as escalations.
- [ ] No browser action edits code or uses the daemon WebSocket.
- [ ] Docs mention the new visibility.
- [ ] All verification commands above pass.

## STOP conditions

Stop and report if:

- The implementation requires changing mediator state transitions or server
  auth semantics.
- The dashboard needs a broad redesign or modal workflow to fit the feature.
- The winner-choice action cannot reuse the existing
  `/auth/projects/resolve-winner` route.
- A command fails twice after a focused fix.

## Maintenance notes

- Issue #114 is the final PRD #109 slice; keep it focused on visibility and
  Owner decision. Follow-up UI polish can happen later.
- The `SynapseInsightsResponse` addition is additive JSON; old consumers that
  ignore unknown totals keep working.
