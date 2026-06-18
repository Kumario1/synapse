import { buildMechanicalDirections } from "@synapse/conflict-engine";
import type { ResolutionProposal, TeamState } from "@synapse/protocol";

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
  if (!proposal || proposal.status === "resolved") {
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
