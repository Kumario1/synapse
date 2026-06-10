import {
  type ClientMessage,
  type ConflictFeedback,
  type ContractDelta,
  type ContractResolution,
  type EditLock,
  type RecentRepoEvent,
  type RecentPush,
  type Session,
  type SessionSummary,
  type TeamState
} from "@synapse/protocol";
import { resolutionInputsHash, resolutionSidesForSymbol } from "@synapse/conflict-engine";

/**
 * Pure team-state mutations, kept free of any networking so they can be unit
 * tested directly. `apps/server/src/index.ts` owns the transport (HTTP +
 * WebSocket fanout) and the per-repo state store; it delegates every state
 * change here.
 */
export function applyMessage(
  state: TeamState,
  repoId: string,
  message: ClientMessage,
  now: string = new Date().toISOString()
): void {
  switch (message.type) {
    case "session.start":
      upsertSession(state, {
        ...message.payload.session,
        repoId,
        lastSeen: now,
        status: "active"
      });
      break;
    case "session.heartbeat":
      touchSession(state, message.payload.sessionId, now);
      break;
    case "session.end":
      endSession(state, message.payload.sessionId, now);
      break;
    case "edit.intent":
      upsertEditLock(state, {
        sessionId: message.payload.sessionId,
        symbolId: message.payload.symbolId,
        filePath: message.payload.filePath,
        acquiredAt: now,
        ttlSec: 90
      });
      markSessionEditing(state, message.payload.sessionId, message.payload.filePath, now);
      break;
    case "contract.delta":
      upsertDelta(state, message.payload.delta);
      markSessionEditing(
        state,
        message.payload.delta.sessionId,
        message.payload.delta.filePath,
        now
      );
      break;
    case "push.notify":
      addRecentPush(state, {
        id: randomId(),
        repoId,
        memberId: message.payload.memberId,
        summary: message.payload.summary,
        filesAffected: message.payload.files,
        symbols: message.payload.symbols,
        sha: message.payload.sha,
        pushedAt: now,
        branch: message.payload.branch
      });
      clearPushedLiveState(state, message.payload.files, message.payload.symbols);
      break;
    case "repo.event":
      addRecentRepoEvent(state, {
        id: randomId(),
        repoId,
        kind: message.payload.kind,
        action: message.payload.action,
        actor: message.payload.actor,
        title: message.payload.title,
        number: message.payload.number,
        url: message.payload.url,
        summary: message.payload.summary,
        createdAt: now
      });
      break;
    case "resolution.propose":
      storeResolution(state, message.payload.resolution);
      break;
    case "session.summary":
      storeSessionSummary(state, message.payload.summary);
      break;
    case "conflict.feedback":
      addConflictFeedback(state, message.payload.feedback);
      break;
    case "query.briefing":
      break;
    default:
      assertNever(message);
  }
}

export function repoIdFor(message: ClientMessage): string | null {
  switch (message.type) {
    case "session.start":
      return message.payload.session.repoId;
    case "session.heartbeat":
    case "session.end":
    case "edit.intent":
    case "query.briefing":
      return message.payload.repoId;
    case "contract.delta":
      return message.payload.delta.repoId;
    case "push.notify":
      return message.payload.repoId;
    case "repo.event":
      return message.payload.repoId;
    case "resolution.propose":
      return message.payload.repoId;
    case "session.summary":
      return message.payload.repoId;
    case "conflict.feedback":
      return message.payload.repoId;
    default:
      assertNever(message);
  }
}

export function pruneExpiredLocks(state: TeamState): void {
  const now = Date.now();
  state.editLocks = state.editLocks.filter((lock) => {
    const acquiredAt = Date.parse(lock.acquiredAt);
    return Number.isNaN(acquiredAt) || now - acquiredAt <= lock.ttlSec * 1000;
  });
}

function upsertSession(state: TeamState, session: Session): void {
  const index = state.sessions.findIndex((candidate) => candidate.id === session.id);
  if (index === -1) {
    state.sessions.push(session);
    return;
  }

  state.sessions[index] = {
    ...state.sessions[index],
    ...session,
    filesOpen: unique([...state.sessions[index].filesOpen, ...session.filesOpen]),
    filesEditing: unique([...state.sessions[index].filesEditing, ...session.filesEditing])
  };
}

function touchSession(state: TeamState, sessionId: string, now: string): void {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (session) {
    session.lastSeen = now;
    if (session.status !== "ended") {
      session.status = "active";
    }
  }
}

function endSession(state: TeamState, sessionId: string, now: string): void {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (session) {
    session.lastSeen = now;
    session.status = "ended";
    session.filesEditing = [];
  }

  state.editLocks = state.editLocks.filter((lock) => lock.sessionId !== sessionId);
}

function upsertEditLock(state: TeamState, lock: EditLock): void {
  const index = state.editLocks.findIndex(
    (candidate) =>
      candidate.sessionId === lock.sessionId && candidate.symbolId.raw === lock.symbolId.raw
  );

  if (index === -1) {
    state.editLocks.push(lock);
    return;
  }

  state.editLocks[index] = lock;
}

function markSessionEditing(
  state: TeamState,
  sessionId: string,
  filePath: string,
  now: string
): void {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) {
    return;
  }

  session.filesEditing = unique([...session.filesEditing, filePath]);
  session.lastSeen = now;
}

function upsertDelta(state: TeamState, delta: ContractDelta): void {
  const index = state.unpushedDeltas.findIndex((candidate) => candidate.id === delta.id);
  if (index === -1) {
    state.unpushedDeltas.push(delta);
  } else {
    state.unpushedDeltas[index] = delta;
  }

  // A new/changed delta for this symbol can shift the live contributing pair,
  // making any stored resolution stale. Drop the ones that no longer match.
  invalidateResolutionsForSymbol(state, delta.symbolId.raw);
}

function addRecentPush(state: TeamState, push: RecentPush): void {
  state.recentPushes.unshift(push);
  state.recentPushes = state.recentPushes.slice(0, 50);
}

function addRecentRepoEvent(state: TeamState, event: RecentRepoEvent): void {
  state.recentRepoEvents.unshift(event);
  state.recentRepoEvents = state.recentRepoEvents.slice(0, 50);
}

function clearPushedLiveState(
  state: TeamState,
  files: string[],
  symbols: ContractDelta["symbolId"][] = []
): void {
  const fileSet = new Set(files);
  const symbolSet = new Set(symbols.map((symbol) => symbol.raw));

  state.unpushedDeltas = state.unpushedDeltas.filter(
    (delta) => !fileSet.has(delta.filePath) && !symbolSet.has(delta.symbolId.raw)
  );
  state.editLocks = state.editLocks.filter(
    (lock) => !fileSet.has(lock.filePath) && !symbolSet.has(lock.symbolId.raw)
  );

  for (const session of state.sessions) {
    session.filesEditing = session.filesEditing.filter((filePath) => !fileSet.has(filePath));
  }

  // A push changes the live deltas, so re-check every stored resolution against
  // the (now possibly empty) contributing pair for its symbol.
  for (const symbol of new Set(state.resolutions.map((resolution) => resolution.symbol.raw))) {
    invalidateResolutionsForSymbol(state, symbol);
  }
}

/**
 * First-writer-wins per `(symbol, inputsHash)`: if a resolution for this symbol
 * with this exact hash already exists, keep it (two racing generators converge
 * on the first stored object). Otherwise replace any stale entry for the symbol
 * so at most one resolution per symbol is ever stored.
 */
function storeResolution(state: TeamState, resolution: ContractResolution): void {
  const alreadyStored = state.resolutions.some(
    (candidate) =>
      candidate.symbol.raw === resolution.symbol.raw &&
      candidate.inputsHash === resolution.inputsHash
  );
  if (alreadyStored) {
    return;
  }

  state.resolutions = state.resolutions.filter(
    (candidate) => candidate.symbol.raw !== resolution.symbol.raw
  );
  state.resolutions.push(resolution);
}

/**
 * Drop any stored resolution for `symbolRaw` whose `inputsHash` no longer
 * matches the live contributing deltas (or whose deltas have all been cleared).
 */
function invalidateResolutionsForSymbol(state: TeamState, symbolRaw: string): void {
  const sides = resolutionSidesForSymbol(state.unpushedDeltas, symbolRaw);
  const liveHash = sides.length > 0 ? resolutionInputsHash(symbolRaw, sides) : null;

  state.resolutions = state.resolutions.filter(
    (resolution) =>
      resolution.symbol.raw !== symbolRaw || resolution.inputsHash === liveHash
  );
}

/**
 * Record a session's narrative summary, most-recent-first. Re-ending the same
 * session replaces its prior summary so a session has at most one entry.
 */
function storeSessionSummary(state: TeamState, summary: SessionSummary): void {
  state.sessionSummaries = state.sessionSummaries.filter(
    (candidate) => candidate.sessionId !== summary.sessionId
  );
  state.sessionSummaries.unshift(summary);
  state.sessionSummaries = state.sessionSummaries.slice(0, 50);
}

/**
 * Keep explicit warning feedback bounded and most-recent-first. Re-sending the
 * same feedback id replaces the prior entry so clients can safely retry.
 */
function addConflictFeedback(state: TeamState, feedback: ConflictFeedback): void {
  state.conflictFeedback = state.conflictFeedback.filter(
    (candidate) => candidate.id !== feedback.id
  );
  state.conflictFeedback.unshift(feedback);
  state.conflictFeedback = state.conflictFeedback.slice(0, 100);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

function assertNever(value: never): never {
  throw new Error(`Unhandled message: ${JSON.stringify(value)}`);
}
