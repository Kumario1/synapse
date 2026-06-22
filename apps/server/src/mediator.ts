import {
  applyMediatorResolutionProse,
  buildMechanicalDirections,
  buildMediatorResolutionRequest,
  classifyCollision,
  type MediatorResolutionProse,
  type MediatorResolutionProvider,
  type MediatorResolutionRequest
} from "@synapse/conflict-engine";
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
 * classifies the collision, stores a transient proposal, and returns it.
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

  const adaptDelta = state.unpushedDeltas.find(
    (delta) => delta.symbolId.raw === symbolRaw && delta.sessionId === adaptSessionId
  );
  const conflictClass = classifyCollision(keepDelta, adaptDelta);
  const proposal: ResolutionProposal = {
    id,
    repoId: state.repoId,
    symbol: keepDelta.symbolId,
    conflictClass,
    before: keepDelta.before,
    after: conflictClass === "mechanical" ? keepDelta.after : null,
    status: conflictClass === "mechanical" ? "resolving" : "awaiting_owner",
    directions:
      conflictClass === "mechanical"
        ? buildMechanicalDirections(keepDelta.sessionId, adaptSessionId, keepDelta)
        : [],
    candidates: conflictClass === "semantic" ? [keepDelta.sessionId, adaptSessionId] : undefined,
    acceptedBy: [],
    createdAt: now()
  };
  state.resolutionProposals = [...proposals, proposal];
  return proposal;
}

/**
 * The Owner picks the winner of a semantic conflict. The winner keeps its
 * signature; the loser adapts to it using the deterministic call-site list.
 */
export function applyWinnerChoice(
  state: TeamState,
  proposalId: string,
  winnerSessionId: string
): boolean {
  const proposal = state.resolutionProposals?.find((candidate) => candidate.id === proposalId);
  if (!proposal || proposal.status !== "awaiting_owner") {
    return false;
  }
  if (!proposal.candidates?.includes(winnerSessionId)) {
    return false;
  }

  const loserSessionId = proposal.candidates.find((sessionId) => sessionId !== winnerSessionId);
  if (!loserSessionId) {
    return false;
  }

  const winnerDelta = state.unpushedDeltas.find(
    (delta) => delta.symbolId.raw === proposal.symbol.raw && delta.sessionId === winnerSessionId
  );
  if (!winnerDelta) {
    return false;
  }

  proposal.directions = buildMechanicalDirections(winnerSessionId, loserSessionId, winnerDelta);
  proposal.after = winnerDelta.after;
  proposal.status = "resolving";
  proposal.candidates = undefined;
  return true;
}

export function buildResolutionProseRequest(
  state: TeamState,
  proposalId: string
): MediatorResolutionRequest | null {
  const proposal = state.resolutionProposals?.find((candidate) => candidate.id === proposalId);
  if (!proposal || proposal.status !== "resolving") {
    return null;
  }

  const keepDirection = proposal.directions.find((direction) => direction.role === "keep");
  const adaptDirection = proposal.directions.find((direction) => direction.role === "adapt");
  if (!keepDirection || !adaptDirection) {
    return null;
  }

  const keepDelta = state.unpushedDeltas.find(
    (delta) =>
      delta.symbolId.raw === proposal.symbol.raw && delta.sessionId === keepDirection.sessionId
  );
  if (!keepDelta) {
    return null;
  }

  const adaptDelta = state.unpushedDeltas.find(
    (delta) =>
      delta.symbolId.raw === proposal.symbol.raw && delta.sessionId === adaptDirection.sessionId
  );
  return buildMediatorResolutionRequest(proposal, keepDelta, adaptDelta);
}

export function applyResolutionProse(
  state: TeamState,
  request: MediatorResolutionRequest,
  prose: MediatorResolutionProse | null
): boolean {
  const proposal = state.resolutionProposals?.find(
    (candidate) => candidate.id === request.proposalId
  );
  if (!proposal) {
    return false;
  }

  const currentRequest = buildResolutionProseRequest(state, request.proposalId);
  if (!currentRequest || !sameResolutionRequest(currentRequest, request)) {
    return false;
  }

  return applyMediatorResolutionProse(proposal, request, prose);
}

/**
 * I/O seam for {@link enrichResolutionProse}. In production `withState` runs its
 * callback under the per-repo lock against authoritative state and `onApplied`
 * broadcasts the fresh snapshot; tests pass an in-memory state and a spy. The
 * lock deliberately lives outside this module: the per-repo mutex is never held
 * across the provider network call, so enrichment is a two-phase transaction.
 */
export interface ResolutionEnrichIO {
  withState: <T>(fn: (state: TeamState) => T) => Promise<T>;
  onApplied: (state: TeamState) => void;
}

/**
 * Enrich a resolving proposal's adapt summary via the provider, two-phase: read
 * the request under the lock, call the provider unlocked, then re-read and apply
 * under the lock. `applyResolutionProse` re-validates the request against current
 * state, so a concurrent change voids the enrichment rather than applying stale
 * prose. Returns true only when prose was applied (the signal to broadcast).
 */
export async function enrichResolutionProse(
  proposalId: string,
  provider: MediatorResolutionProvider | null,
  io: ResolutionEnrichIO
): Promise<boolean> {
  if (!provider) {
    return false;
  }

  const request = await io.withState((state) => buildResolutionProseRequest(state, proposalId));
  if (!request) {
    return false;
  }

  let prose: MediatorResolutionProse | null;
  try {
    prose = await provider.proposeResolution(request);
  } catch {
    return false;
  }
  if (!prose) {
    return false;
  }

  const applied = await io.withState((state) =>
    applyResolutionProse(state, request, prose) ? state : null
  );
  if (!applied) {
    return false;
  }

  io.onApplied(applied);
  return true;
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
export function voidOnTimeout(state: TeamState, proposalId: string): boolean {
  const proposal = state.resolutionProposals?.find((p) => p.id === proposalId);
  if (!proposal || proposal.status !== "resolving") {
    return false;
  }
  proposal.status = "voided";
  proposal.voidReason = "timeout";
  return true;
}

function sameResolutionRequest(
  left: MediatorResolutionRequest,
  right: MediatorResolutionRequest
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
