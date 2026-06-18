import { buildMechanicalDirections } from "@synapse/conflict-engine";
import type { ConflictFeedback, ResolutionProposal, TeamState } from "@synapse/protocol";
import { randomUUID } from "node:crypto";

/** Deterministic proposal id for a contested pair, so we do not double-propose. */
export function proposalId(
  symbolRaw: string,
  keepSessionId: string,
  adaptSessionId: string
): string {
  return `rp:${symbolRaw}:${keepSessionId}:${adaptSessionId}`;
}

/**
 * Called at the contested moment. Finds the keep-side delta in unpushedDeltas,
 * builds a mechanical proposal, stores it transiently, and returns it.
 */
export function proposeOnContest(
  state: TeamState,
  symbolRaw: string,
  adaptSessionId: string,
  now: () => string = () => new Date().toISOString()
): ResolutionProposal | null {
  const keepDelta = state.unpushedDeltas.find(
    (delta) => delta.symbolId.raw === symbolRaw && delta.sessionId !== adaptSessionId
  );
  if (!keepDelta) {
    return null;
  }

  const id = proposalId(symbolRaw, keepDelta.sessionId, adaptSessionId);
  const proposals = state.resolutionProposals ?? [];
  if (proposals.some((proposal) => proposal.id === id)) {
    return null;
  }

  const proposal: ResolutionProposal = {
    id,
    repoId: state.repoId,
    symbol: keepDelta.symbolId,
    conflictClass: "mechanical",
    before: keepDelta.before,
    after: keepDelta.after,
    status: "resolving",
    directions: buildMechanicalDirections(keepDelta.sessionId, adaptSessionId, keepDelta),
    acceptedBy: [],
    createdAt: now()
  };
  state.resolutionProposals = [...proposals, proposal];
  return proposal;
}

/**
 * Record an accept. Returns true only when the proposal changed and the caller
 * should broadcast a fresh snapshot.
 */
export function applyResolutionAck(
  state: TeamState,
  proposalId: string,
  sessionId: string
): boolean {
  const proposal = state.resolutionProposals?.find((candidate) => candidate.id === proposalId);
  if (!proposal || proposal.status !== "resolving") {
    return false;
  }
  if (!proposal.directions.some((direction) => direction.sessionId === sessionId)) {
    return false;
  }
  if (proposal.acceptedBy.includes(sessionId)) {
    return false;
  }

  proposal.acceptedBy = [...proposal.acceptedBy, sessionId];
  const allAccepted = proposal.directions.every((direction) =>
    proposal.acceptedBy.includes(direction.sessionId)
  );
  if (allAccepted) {
    proposal.status = "resolved";
  }
  return true;
}

export interface RejectResult {
  changed: boolean;
  feedback?: ConflictFeedback;
}

/**
 * Record a reject from one party. Voids the coordinated pair (terminal) and
 * returns conflict feedback (dismiss) for the caller to persist. No-op unless
 * the proposal is still `resolving` and the rejecter is a party.
 */
export function applyResolutionReject(
  state: TeamState,
  proposalId: string,
  sessionId: string,
  now: () => string = () => new Date().toISOString()
): RejectResult {
  const proposal = state.resolutionProposals?.find((p) => p.id === proposalId);
  if (!proposal || proposal.status !== "resolving") {
    return { changed: false };
  }
  if (!proposal.directions.some((d) => d.sessionId === sessionId)) {
    return { changed: false };
  }
  proposal.status = "voided";
  proposal.voidReason = "rejected";
  proposal.voidedBy = sessionId;
  const feedback: ConflictFeedback = {
    id: randomUUID(),
    repoId: state.repoId,
    conflictId: proposal.id,
    sessionId,
    memberId: sessionId,
    outcome: "dismissed",
    targetSymbol: proposal.symbol,
    createdAt: now()
  };
  return { changed: true, feedback };
}

/**
 * Void a proposal whose TTL elapsed before both sides accepted. Terminal.
 * No-op unless the proposal is still `resolving`.
 */
export function voidOnTimeout(
  state: TeamState,
  proposalId: string,
  now: () => string = () => new Date().toISOString()
): boolean {
  const proposal = state.resolutionProposals?.find((p) => p.id === proposalId);
  if (!proposal || proposal.status !== "resolving") {
    return false;
  }
  proposal.status = "voided";
  proposal.voidReason = "timeout";
  void now;
  return true;
}
