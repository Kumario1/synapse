import { randomUUID } from "node:crypto";
import type {
  ConflictFeedback,
  SynapseFeedbackRequest,
  SynapseInsightsResponse,
  TeamState
} from "@synapse/protocol";
import type { RuntimeConfig } from "./config.js";

export function createConflictFeedback(
  config: RuntimeConfig,
  input: Pick<SynapseFeedbackRequest, "conflictId" | "outcome"> &
    Partial<Pick<SynapseFeedbackRequest, "note" | "rule" | "targetSymbol">>
): ConflictFeedback {
  return {
    id: randomUUID(),
    repoId: config.repoId,
    conflictId: input.conflictId,
    sessionId: config.sessionId,
    memberId: config.member,
    outcome: input.outcome,
    note: input.note,
    rule: input.rule,
    targetSymbol: input.targetSymbol,
    createdAt: new Date().toISOString()
  };
}

export function buildInsightsResponse(
  state: TeamState,
  options: { degraded: boolean; limit?: number }
): SynapseInsightsResponse {
  const limit = clampLimit(options.limit, 5, 20);
  const feedback = state.conflictFeedback;
  const acted = feedback.filter((item) => item.outcome === "acted").length;
  const dismissed = feedback.filter((item) => item.outcome === "dismissed").length;
  const activeSessions = state.sessions.filter((session) => session.status !== "ended").length;
  const activeEditLocks = state.editLocks.length;
  const unpushedDeltas = state.unpushedDeltas.filter((delta) => delta.pushedAt === null).length;
  const resolutionProposals = state.resolutionProposals ?? [];
  const resolutionResolving = resolutionProposals.filter(
    (proposal) => proposal.status === "resolving"
  ).length;
  const resolutionResolved = resolutionProposals.filter(
    (proposal) => proposal.status === "resolved"
  ).length;
  const resolutionEscalated = resolutionProposals.filter(
    (proposal) => proposal.status === "awaiting_owner" || proposal.status === "voided"
  ).length;

  const topRulesByFeedback = bucketTop(
    feedback.map((item) => item.rule ?? "unknown_rule"),
    limit
  );
  const topConflictTargets = bucketTop(
    feedback.map((item) => item.targetSymbol?.raw ?? "unknown_target"),
    limit
  );
  const recentFeedback = feedback.slice(0, limit).map((item) => ({
    conflictId: item.conflictId,
    outcome: item.outcome,
    rule: item.rule,
    targetSymbol: item.targetSymbol,
    createdAt: item.createdAt
  }));

  const summary = [
    `${feedback.length} feedback event${feedback.length === 1 ? "" : "s"} recorded (${acted} acted, ${dismissed} dismissed).`,
    `${activeSessions} active session${activeSessions === 1 ? "" : "s"}, ${unpushedDeltas} unpushed delta${unpushedDeltas === 1 ? "" : "s"}, ${activeEditLocks} active edit lock${activeEditLocks === 1 ? "" : "s"}.`
  ];
  if (topRulesByFeedback[0]) {
    summary.push(
      `Noisiest feedback rule: ${topRulesByFeedback[0].name} (${topRulesByFeedback[0].count}).`
    );
  }
  if (resolutionProposals.length > 0) {
    summary.push(
      `Mediator proposals: ${resolutionResolving} resolving, ${resolutionResolved} resolved, ${resolutionEscalated} escalated.`
    );
  }

  return {
    repoId: state.repoId,
    generatedAt: new Date().toISOString(),
    degraded: options.degraded,
    summary,
    totals: {
      feedback: feedback.length,
      acted,
      dismissed,
      activeSessions,
      unpushedDeltas,
      activeEditLocks,
      resolutionResolving,
      resolutionResolved,
      resolutionEscalated
    },
    topRulesByFeedback,
    topConflictTargets,
    recentFeedback
  };
}

export function bucketTop(values: string[], limit: number): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, limit);
}

export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.trunc(value)));
}
