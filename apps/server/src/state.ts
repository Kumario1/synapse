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
import { noopStateStore, type StateStoreOps } from "./store.js";

const RECENT_PUSH_CAP = 50;
const RECENT_REPO_EVENT_CAP = 50;
const SESSION_SUMMARY_CAP = 50;
const CONFLICT_FEEDBACK_CAP = 100;

// Session liveness sweep (plan 032): a session that misses heartbeats for
// SESSION_STALE_MS (e.g. a crashed daemon, closed laptop) is marked ended —
// dropping it from whatsup/onboard and same_file_no_overlap conflicts — and a
// session that has been ended for SESSION_PRUNE_MS is removed from state and
// the store entirely, so `state.sessions` stays bounded. SYNAPSE_SESSION_SWEEP=0
// disables the sweep for diagnostics.
const SESSION_STALE_MS = Number(process.env.SYNAPSE_SESSION_TTL_MS ?? 300_000); // 5 min
const SESSION_PRUNE_MS = Number(process.env.SYNAPSE_SESSION_PRUNE_MS ?? 86_400_000); // 24 h

/**
 * Pure team-state mutations, kept free of any networking so they can be unit
 * tested directly. `apps/server/src/index.ts` owns the transport (HTTP +
 * WebSocket fanout); it delegates every state change here.
 *
 * Persistence (plan M8): each mutation emits the matching per-entity store op
 * alongside the in-memory change, so the store always mirrors memory without
 * rewriting whole snapshots. The in-memory `TeamState` stays the source of
 * truth; `store` defaults to a no-op for callers that only need the mutation
 * (tests, dry runs).
 */
export function applyMessage(
  state: TeamState,
  repoId: string,
  message: ClientMessage,
  store: StateStoreOps = noopStateStore,
  now: string = new Date().toISOString()
): void {
  switch (message.type) {
    case "session.start":
      upsertSession(state, repoId, store, {
        ...message.payload.session,
        repoId,
        lastSeen: now,
        status: "active"
      });
      break;
    case "session.heartbeat":
      touchSession(
        state,
        repoId,
        store,
        message.payload.sessionId,
        now,
        message.payload.branch,
        message.payload.task
      );
      break;
    case "session.end":
      endSession(state, repoId, store, message.payload.sessionId, now);
      break;
    case "edit.intent":
      upsertEditLock(state, repoId, store, {
        sessionId: message.payload.sessionId,
        symbolId: message.payload.symbolId,
        filePath: message.payload.filePath,
        acquiredAt: now,
        ttlSec: 90
      });
      markSessionEditing(state, repoId, store, message.payload.sessionId, message.payload.filePath, now);
      break;
    case "contract.delta":
      upsertDelta(state, repoId, store, message.payload.delta);
      markSessionEditing(
        state,
        repoId,
        store,
        message.payload.delta.sessionId,
        message.payload.delta.filePath,
        now
      );
      break;
    case "push.notify": {
      // Optional fields are omitted (not set to undefined) so the in-memory
      // object and its JSON round-trip through the store stay identical.
      const push: RecentPush = {
        id: randomId(),
        repoId,
        memberId: message.payload.memberId,
        summary: message.payload.summary,
        filesAffected: message.payload.files,
        ...(message.payload.symbols ? { symbols: message.payload.symbols } : {}),
        sha: message.payload.sha,
        pushedAt: now,
        ...(message.payload.branch ? { branch: message.payload.branch } : {})
      };
      addRecentPush(state, repoId, store, push);
      clearPushedLiveState(state, repoId, store, message.payload.files, message.payload.symbols);
      break;
    }
    case "repo.event":
      addRecentRepoEvent(state, repoId, store, {
        id: randomId(),
        repoId,
        kind: message.payload.kind,
        action: message.payload.action,
        actor: message.payload.actor,
        title: message.payload.title,
        ...(message.payload.number !== undefined ? { number: message.payload.number } : {}),
        ...(message.payload.url !== undefined ? { url: message.payload.url } : {}),
        summary: message.payload.summary,
        ...(message.payload.detail !== undefined ? { detail: message.payload.detail } : {}),
        createdAt: now
      });
      break;
    case "resolution.propose":
      storeResolution(state, repoId, store, message.payload.resolution);
      break;
    case "session.summary":
      storeSessionSummary(state, repoId, store, message.payload.summary);
      break;
    case "conflict.feedback":
      addConflictFeedback(state, repoId, store, message.payload.feedback);
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

export function pruneExpiredLocks(state: TeamState, store: StateStoreOps = noopStateStore): void {
  const now = Date.now();
  const surviving: EditLock[] = [];
  for (const lock of state.editLocks) {
    const acquiredAt = Date.parse(lock.acquiredAt);
    if (Number.isNaN(acquiredAt) || now - acquiredAt <= lock.ttlSec * 1000) {
      surviving.push(lock);
    } else {
      store.deleteEditLock(state.repoId, lock.sessionId, lock.symbolId.raw);
    }
  }
  state.editLocks = surviving;
}

/**
 * Liveness sweep for sessions (plan 032): a session that misses heartbeats for
 * SESSION_STALE_MS is marked "ended" — same teardown as an explicit
 * `session.end` (filesEditing cleared, its edit locks dropped) — so a daemon
 * that crashed or lost its network stops showing as a live teammate and stops
 * generating same_file_no_overlap conflicts. A session already "ended" for
 * SESSION_PRUNE_MS is removed from `state.sessions` and the store, keeping the
 * array (and the full snapshot broadcast / `synapse why` corpus) bounded.
 *
 * A returning daemon re-sends `session.start`, which revives a swept session to
 * "active" (applyMessage's session.start case) — so this only affects sessions
 * that truly stopped heartbeating.
 */
export function pruneStaleSessions(
  state: TeamState,
  store: StateStoreOps = noopStateStore,
  now: number = Date.now()
): void {
  if (process.env.SYNAPSE_SESSION_SWEEP === "0") {
    return;
  }
  const surviving: Session[] = [];
  for (const session of state.sessions) {
    const lastSeen = Date.parse(session.lastSeen);
    const age = Number.isNaN(lastSeen) ? 0 : now - lastSeen;
    if (session.status === "ended" && age > SESSION_PRUNE_MS) {
      store.deleteSession(state.repoId, session.id);
      continue;
    }
    if (session.status !== "ended" && age > SESSION_STALE_MS) {
      session.status = "ended";
      session.filesEditing = [];
      state.editLocks = state.editLocks.filter((lock) => lock.sessionId !== session.id);
      store.deleteEditLocksForSession(state.repoId, session.id);
      store.upsertSession(state.repoId, session);
    }
    surviving.push(session);
  }
  state.sessions = surviving;
}

function upsertSession(state: TeamState, repoId: string, store: StateStoreOps, session: Session): void {
  const index = state.sessions.findIndex((candidate) => candidate.id === session.id);
  if (index === -1) {
    state.sessions.push(session);
    store.upsertSession(repoId, session);
    return;
  }

  state.sessions[index] = {
    ...state.sessions[index],
    ...session,
    filesOpen: unique([...state.sessions[index].filesOpen, ...session.filesOpen]),
    filesEditing: unique([...state.sessions[index].filesEditing, ...session.filesEditing])
  };
  store.upsertSession(repoId, state.sessions[index]);
}

function touchSession(
  state: TeamState,
  repoId: string,
  store: StateStoreOps,
  sessionId: string,
  now: string,
  branch?: string,
  task?: string
): void {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (session) {
    session.lastSeen = now;
    if (session.status !== "ended") {
      session.status = "active";
    }
    // New clients refresh their branch every heartbeat; old clients omit it
    // and keep the last known value (never clear on absence).
    if (branch) {
      session.branch = branch;
    }
    // Same preserve-on-omit rule as branch: a heartbeat with a task records
    // the developer's current intent (plan 033); one without leaves the
    // session's last known task untouched.
    if (task) {
      session.lastTask = task;
    }
    store.upsertSession(repoId, session);
  }
}

function endSession(
  state: TeamState,
  repoId: string,
  store: StateStoreOps,
  sessionId: string,
  now: string
): void {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (session) {
    session.lastSeen = now;
    session.status = "ended";
    session.filesEditing = [];
    store.upsertSession(repoId, session);
  }

  state.editLocks = state.editLocks.filter((lock) => lock.sessionId !== sessionId);
  store.deleteEditLocksForSession(repoId, sessionId);
}

function upsertEditLock(state: TeamState, repoId: string, store: StateStoreOps, lock: EditLock): void {
  const index = state.editLocks.findIndex(
    (candidate) =>
      candidate.sessionId === lock.sessionId && candidate.symbolId.raw === lock.symbolId.raw
  );

  if (index === -1) {
    state.editLocks.push(lock);
  } else {
    state.editLocks[index] = lock;
  }
  store.upsertEditLock(repoId, lock);
}

function markSessionEditing(
  state: TeamState,
  repoId: string,
  store: StateStoreOps,
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
  store.upsertSession(repoId, session);
}

function upsertDelta(state: TeamState, repoId: string, store: StateStoreOps, delta: ContractDelta): void {
  const index = state.unpushedDeltas.findIndex((candidate) => candidate.id === delta.id);
  if (index === -1) {
    state.unpushedDeltas.push(delta);
  } else {
    state.unpushedDeltas[index] = delta;
  }
  store.upsertDelta(repoId, delta);

  // A new/changed delta for this symbol can shift the live contributing pair,
  // making any stored resolution stale. Drop the ones that no longer match.
  invalidateResolutionsForSymbol(state, repoId, store, delta.symbolId.raw);
}

function addRecentPush(state: TeamState, repoId: string, store: StateStoreOps, push: RecentPush): void {
  state.recentPushes.unshift(push);
  state.recentPushes = state.recentPushes.slice(0, RECENT_PUSH_CAP);
  store.appendPush(repoId, push, RECENT_PUSH_CAP);
}

function addRecentRepoEvent(
  state: TeamState,
  repoId: string,
  store: StateStoreOps,
  event: RecentRepoEvent
): void {
  state.recentRepoEvents.unshift(event);
  state.recentRepoEvents = state.recentRepoEvents.slice(0, RECENT_REPO_EVENT_CAP);
  store.appendRepoEvent(repoId, event, RECENT_REPO_EVENT_CAP);
}

function clearPushedLiveState(
  state: TeamState,
  repoId: string,
  store: StateStoreOps,
  files: string[],
  symbols: ContractDelta["symbolId"][] = []
): void {
  const fileSet = new Set(files);
  const symbolSet = new Set(symbols.map((symbol) => symbol.raw));

  state.unpushedDeltas = state.unpushedDeltas.filter((delta) => {
    const keep = !fileSet.has(delta.filePath) && !symbolSet.has(delta.symbolId.raw);
    if (!keep) {
      store.deleteDelta(repoId, delta.id);
    }
    return keep;
  });
  state.editLocks = state.editLocks.filter((lock) => {
    const keep = !fileSet.has(lock.filePath) && !symbolSet.has(lock.symbolId.raw);
    if (!keep) {
      store.deleteEditLock(repoId, lock.sessionId, lock.symbolId.raw);
    }
    return keep;
  });

  for (const session of state.sessions) {
    const filtered = session.filesEditing.filter((filePath) => !fileSet.has(filePath));
    if (filtered.length !== session.filesEditing.length) {
      session.filesEditing = filtered;
      store.upsertSession(repoId, session);
    }
  }

  // A push changes the live deltas, so re-check every stored resolution against
  // the (now possibly empty) contributing pair for its symbol.
  for (const symbol of new Set(state.resolutions.map((resolution) => resolution.symbol.raw))) {
    invalidateResolutionsForSymbol(state, repoId, store, symbol);
  }
}

/**
 * First-writer-wins per `(symbol, inputsHash)`: if a resolution for this symbol
 * with this exact hash already exists, keep it (two racing generators converge
 * on the first stored object). Otherwise replace any stale entry for the symbol
 * so at most one resolution per symbol is ever stored.
 */
function storeResolution(
  state: TeamState,
  repoId: string,
  store: StateStoreOps,
  resolution: ContractResolution
): void {
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
  // One row per symbol in the store, so the upsert also replaces the stale entry.
  store.upsertResolution(repoId, resolution);
}

/**
 * Drop any stored resolution for `symbolRaw` whose `inputsHash` no longer
 * matches the live contributing deltas (or whose deltas have all been cleared).
 */
function invalidateResolutionsForSymbol(
  state: TeamState,
  repoId: string,
  store: StateStoreOps,
  symbolRaw: string
): void {
  const sides = resolutionSidesForSymbol(state.unpushedDeltas, symbolRaw);
  const liveHash = sides.length > 0 ? resolutionInputsHash(symbolRaw, sides) : null;

  state.resolutions = state.resolutions.filter((resolution) => {
    const keep = resolution.symbol.raw !== symbolRaw || resolution.inputsHash === liveHash;
    if (!keep) {
      store.deleteResolution(repoId, resolution.symbol.raw, resolution.inputsHash);
    }
    return keep;
  });
}

/**
 * Record a session's narrative summary, most-recent-first. Re-ending the same
 * session replaces its prior summary so a session has at most one entry.
 */
function storeSessionSummary(
  state: TeamState,
  repoId: string,
  store: StateStoreOps,
  summary: SessionSummary
): void {
  state.sessionSummaries = state.sessionSummaries.filter(
    (candidate) => candidate.sessionId !== summary.sessionId
  );
  state.sessionSummaries.unshift(summary);
  state.sessionSummaries = state.sessionSummaries.slice(0, SESSION_SUMMARY_CAP);
  store.appendSummary(repoId, summary, SESSION_SUMMARY_CAP);
}

/**
 * Keep explicit warning feedback bounded and most-recent-first. Re-sending the
 * same feedback id replaces the prior entry so clients can safely retry.
 */
function addConflictFeedback(
  state: TeamState,
  repoId: string,
  store: StateStoreOps,
  feedback: ConflictFeedback
): void {
  state.conflictFeedback = state.conflictFeedback.filter(
    (candidate) => candidate.id !== feedback.id
  );
  state.conflictFeedback.unshift(feedback);
  state.conflictFeedback = state.conflictFeedback.slice(0, CONFLICT_FEEDBACK_CAP);
  store.appendFeedback(repoId, feedback, CONFLICT_FEEDBACK_CAP);
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
