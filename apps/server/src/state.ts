import {
  applyStateOp,
  type ClientMessage,
  type ConflictFeedback,
  type ContractDelta,
  type ContractResolution,
  type EditLock,
  type Reservation,
  type ReservationRoot,
  type RecentRepoEvent,
  type RecentPush,
  type Session,
  type SessionSummary,
  type StateOp,
  type TeamState
} from "@synapse/protocol";
import { resolutionInputsHash, resolutionSidesForSymbol } from "@synapse/conflict-engine";

/**
 * Records each mutation as a canonical {@link StateOp}. `applyMessage` and the
 * prune sweeps apply every op in-memory via {@link applyStateOp} (the single
 * source of in-memory mutation) and collect the same ops here; the caller then
 * persists them (`applyStateOpToStore`) and, for `applyMessage`, broadcasts
 * them as a `state.delta`. The sweeps return their ops too so the caller can
 * persist the eviction without broadcasting (matching the prior raw-store path).
 */
type OpSink = StateOp[];

function emit(state: TeamState, sink: OpSink, op: StateOp): void {
  applyStateOp(state, op);
  sink.push(op);
}

const RECENT_PUSH_CAP = 50;
const RECENT_REPO_EVENT_CAP = 50;
const SESSION_SUMMARY_CAP = 50;
const CONFLICT_FEEDBACK_CAP = 100;
const EDIT_LOCK_TTL_SEC = 90;
const EDIT_LOCK_PER_SESSION_CAP = Number(process.env.SYNAPSE_EDIT_LOCK_CAP ?? 200);

// Session liveness sweep (plan 032): a session that misses heartbeats for
// SESSION_STALE_MS (e.g. a crashed daemon, closed laptop) is marked ended —
// dropping it from whatsup/onboard and same_file_no_overlap conflicts — and a
// session that has been ended for SESSION_PRUNE_MS is removed from state and
// the store entirely, so `state.sessions` stays bounded. SYNAPSE_SESSION_SWEEP=0
// disables the sweep for diagnostics.
const SESSION_STALE_MS = Number(process.env.SYNAPSE_SESSION_TTL_MS ?? 300_000); // 5 min
const SESSION_PRUNE_MS = Number(process.env.SYNAPSE_SESSION_PRUNE_MS ?? 86_400_000); // 24 h

/**
 * Pure team-state mutations, kept free of any networking or storage so they can
 * be unit tested directly. `apps/server/src/index.ts` owns the transport (HTTP +
 * WebSocket fanout); it delegates every state change here.
 *
 * Each mutation is expressed as a canonical {@link StateOp}: it is applied
 * in-memory through {@link applyStateOp} (the same function clients run on a
 * `state.delta`, so server memory and client memory can never diverge) and
 * returned to the caller. The caller persists the ops (`applyStateOpToStore`)
 * and broadcasts them. The in-memory `TeamState` stays the source of truth.
 */
export function applyMessage(
  state: TeamState,
  repoId: string,
  message: ClientMessage,
  now: string = new Date().toISOString()
): StateOp[] {
  const ops: StateOp[] = [];
  switch (message.type) {
    case "session.start":
      upsertSession(state, repoId, ops, {
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
        ops,
        message.payload.sessionId,
        now,
        message.payload.branch,
        message.payload.task
      );
      break;
    case "session.end":
      endSession(state, repoId, ops, message.payload.sessionId, now);
      break;
    case "edit.intent":
      upsertEditLock(state, repoId, ops, {
        sessionId: message.payload.sessionId,
        symbolId: message.payload.symbolId,
        filePath: message.payload.filePath,
        acquiredAt: now,
        ttlSec: EDIT_LOCK_TTL_SEC
      });
      markSessionEditing(
        state,
        repoId,
        ops,
        message.payload.sessionId,
        message.payload.filePath,
        now
      );
      break;
    case "contract.delta":
      upsertDelta(state, repoId, ops, message.payload.delta);
      accreteReservation(state, repoId, ops, message.payload.delta, now);
      markSessionEditing(
        state,
        repoId,
        ops,
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
      addRecentPush(state, repoId, ops, push);
      clearPushedLiveState(state, repoId, ops, message.payload.files, message.payload.symbols, now);
      break;
    }
    case "repo.event":
      addRecentRepoEvent(state, repoId, ops, {
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
      storeResolution(state, repoId, ops, message.payload.resolution);
      break;
    case "resolution.ack":
      break;
    case "session.summary":
      storeSessionSummary(state, repoId, ops, message.payload.summary);
      break;
    case "conflict.feedback":
      addConflictFeedback(state, repoId, ops, message.payload.feedback);
      break;
    case "query.briefing":
      break;
    default:
      assertNever(message);
  }
  return ops;
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
    case "resolution.ack":
      return message.payload.repoId;
    case "session.summary":
      return message.payload.repoId;
    case "conflict.feedback":
      return message.payload.repoId;
    default:
      assertNever(message);
  }
}

export function pruneExpiredLocks(state: TeamState): StateOp[] {
  const ops: StateOp[] = [];
  const now = Date.now();
  for (const lock of [...state.editLocks]) {
    const acquiredAt = Date.parse(lock.acquiredAt);
    if (!(Number.isNaN(acquiredAt) || now - acquiredAt <= lock.ttlSec * 1000)) {
      emit(state, ops, {
        op: "deleteEditLock",
        sessionId: lock.sessionId,
        symbolRaw: lock.symbolId.raw
      });
    }
  }
  pruneExpiredReservationRoots(state, state.repoId, ops, now);
  return ops;
}

/**
 * True when a repo's prune sweep is due: the previous sweep was at least
 * `intervalMs` ago. Gating the per-read sweeps (plan 038) behind this removes
 * the full-array rebuild from the hot per-message path; TTL correctness is
 * unaffected because lock/session expiry is re-checked at the point of use
 * (peerLocksForIntent, conflict evaluation), never trusted from the pruned
 * array.
 */
export function dueForSweep(lastSweptAt: number, now: number, intervalMs: number): boolean {
  return now - lastSweptAt >= intervalMs;
}

/**
 * Peer edit locks held on `symbolRaw` right now, excluding the requesting
 * session and expired leases. Returned on the edit.intent ack so a checking
 * session evaluates against server-authoritative state, not its async local
 * mirror. Mirrors the expiry rule in {@link pruneExpiredLocks} without mutating.
 */
export function peerLocksForIntent(
  state: TeamState,
  selfSessionId: string,
  symbolRaw: string,
  now: number
): EditLock[] {
  return state.editLocks.filter((lock) => {
    if (lock.sessionId === selfSessionId) {
      return false;
    }
    if (lock.symbolId.raw !== symbolRaw) {
      return false;
    }
    const acquiredAt = Date.parse(lock.acquiredAt);
    return Number.isNaN(acquiredAt) || now - acquiredAt <= lock.ttlSec * 1000;
  });
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
export function pruneStaleSessions(state: TeamState, now: number = Date.now()): StateOp[] {
  const ops: StateOp[] = [];
  if (process.env.SYNAPSE_SESSION_SWEEP === "0") {
    return ops;
  }
  const repoId = state.repoId;
  for (const session of [...state.sessions]) {
    const lastSeen = Date.parse(session.lastSeen);
    const age = Number.isNaN(lastSeen) ? 0 : now - lastSeen;
    if (session.status === "ended" && age > SESSION_PRUNE_MS) {
      emit(state, ops, { op: "deleteSession", sessionId: session.id });
      deleteReservation(state, repoId, ops, session.id);
      continue;
    }
    if (session.status !== "ended" && age > SESSION_STALE_MS) {
      // Mutate before emitting so the upsert op carries the ended session.
      session.status = "ended";
      session.filesEditing = [];
      emit(state, ops, { op: "deleteEditLocksForSession", sessionId: session.id });
      deleteReservation(state, repoId, ops, session.id);
      emit(state, ops, { op: "upsertSession", session });
    }
  }
  return ops;
}

function upsertSession(state: TeamState, repoId: string, ops: OpSink, session: Session): void {
  const existing = state.sessions.find((candidate) => candidate.id === session.id);
  // On replace, merge the open/editing file sets exactly as before; the op then
  // carries the merged session so applyStateOp's replace-by-id reproduces it.
  const next: Session = existing
    ? {
        ...existing,
        ...session,
        filesOpen: unique([...existing.filesOpen, ...session.filesOpen]),
        filesEditing: unique([...existing.filesEditing, ...session.filesEditing])
      }
    : session;
  emit(state, ops, { op: "upsertSession", session: next });
}

function touchSession(
  state: TeamState,
  repoId: string,
  ops: OpSink,
  sessionId: string,
  now: string,
  branch?: string,
  task?: string
): void {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (session && session.status !== "ended") {
    session.lastSeen = now;
    session.status = "active";

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
    emit(state, ops, { op: "upsertSession", session });
  }
}

function endSession(
  state: TeamState,
  repoId: string,
  ops: OpSink,
  sessionId: string,
  now: string
): void {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (session) {
    session.lastSeen = now;
    session.status = "ended";
    session.filesEditing = [];
    emit(state, ops, { op: "upsertSession", session });
  }

  emit(state, ops, { op: "deleteEditLocksForSession", sessionId });
  deleteReservation(state, repoId, ops, sessionId);
}

function upsertEditLock(state: TeamState, repoId: string, ops: OpSink, lock: EditLock): void {
  const existing = state.editLocks.some(
    (candidate) =>
      candidate.sessionId === lock.sessionId && candidate.symbolId.raw === lock.symbolId.raw
  );

  if (!existing) {
    let oldestIndex = -1;
    let oldestTime = Infinity;
    let sessionLockCount = 0;

    for (let candidateIndex = 0; candidateIndex < state.editLocks.length; candidateIndex += 1) {
      const candidate = state.editLocks[candidateIndex];
      if (candidate.sessionId !== lock.sessionId) {
        continue;
      }

      sessionLockCount += 1;
      const acquiredAt = Date.parse(candidate.acquiredAt);
      if (acquiredAt < oldestTime) {
        oldestTime = acquiredAt;
        oldestIndex = candidateIndex;
      }
    }

    if (
      EDIT_LOCK_PER_SESSION_CAP > 0 &&
      sessionLockCount >= EDIT_LOCK_PER_SESSION_CAP &&
      oldestIndex !== -1
    ) {
      const oldest = state.editLocks[oldestIndex];
      emit(state, ops, {
        op: "deleteEditLock",
        sessionId: oldest.sessionId,
        symbolRaw: oldest.symbolId.raw
      });
      removeReservationRoots(
        state,
        repoId,
        ops,
        oldest.sessionId,
        (root) => root.symbolId.raw === oldest.symbolId.raw,
        lock.acquiredAt
      );
    }
  }
  emit(state, ops, { op: "upsertEditLock", lock });
}

function markSessionEditing(
  state: TeamState,
  repoId: string,
  ops: OpSink,
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
  emit(state, ops, { op: "upsertSession", session });
}

function upsertDelta(state: TeamState, repoId: string, ops: OpSink, delta: ContractDelta): void {
  emit(state, ops, { op: "upsertDelta", delta });

  // A new/changed delta for this symbol can shift the live contributing pair,
  // making any stored resolution stale. Drop the ones that no longer match.
  invalidateResolutionsForSymbol(state, repoId, ops, delta.symbolId.raw);
}

function accreteReservation(
  state: TeamState,
  repoId: string,
  ops: OpSink,
  delta: ContractDelta,
  now: string
): void {
  const lease = state.editLocks.find(
    (lock) => lock.sessionId === delta.sessionId && lock.symbolId.raw === delta.symbolId.raw
  );
  const root: ReservationRoot = {
    symbolId: delta.symbolId,
    filePath: delta.filePath,
    acquiredAt: lease?.acquiredAt ?? now,
    ttlSec: lease?.ttlSec ?? EDIT_LOCK_TTL_SEC,
    radius: delta.reservation?.radius ?? 0,
    symbols: uniqueSymbols([delta.symbolId, ...(delta.reservation?.symbols ?? delta.dependents)])
  };
  const existing =
    state.reservations.find((reservation) => reservation.sessionId === delta.sessionId) ?? null;
  const roots = [
    ...(existing?.roots ?? []).filter((candidate) => candidate.symbolId.raw !== root.symbolId.raw),
    root
  ];
  writeReservationRoots(
    state,
    repoId,
    ops,
    existing ?? {
      repoId,
      sessionId: delta.sessionId,
      radius: root.radius,
      symbols: [],
      roots: [],
      updatedAt: now
    },
    roots,
    now
  );
}

function addRecentPush(state: TeamState, repoId: string, ops: OpSink, push: RecentPush): void {
  emit(state, ops, { op: "appendPush", push, cap: RECENT_PUSH_CAP });
}

function addRecentRepoEvent(
  state: TeamState,
  repoId: string,
  ops: OpSink,
  event: RecentRepoEvent
): void {
  emit(state, ops, { op: "appendRepoEvent", event, cap: RECENT_REPO_EVENT_CAP });
}

function clearPushedLiveState(
  state: TeamState,
  repoId: string,
  ops: OpSink,
  files: string[],
  symbols: ContractDelta["symbolId"][] = [],
  now: string
): void {
  const fileSet = new Set(files);
  const symbolSet = new Set(symbols.map((symbol) => symbol.raw));

  for (const delta of [...state.unpushedDeltas]) {
    if (fileSet.has(delta.filePath) || symbolSet.has(delta.symbolId.raw)) {
      emit(state, ops, { op: "deleteDelta", deltaId: delta.id });
    }
  }
  for (const lock of [...state.editLocks]) {
    if (fileSet.has(lock.filePath) || symbolSet.has(lock.symbolId.raw)) {
      emit(state, ops, {
        op: "deleteEditLock",
        sessionId: lock.sessionId,
        symbolRaw: lock.symbolId.raw
      });
    }
  }
  clearPushedReservations(state, repoId, ops, fileSet, symbolSet, now);

  for (const session of state.sessions) {
    const filtered = session.filesEditing.filter((filePath) => !fileSet.has(filePath));
    if (filtered.length !== session.filesEditing.length) {
      session.filesEditing = filtered;
      emit(state, ops, { op: "upsertSession", session });
    }
  }

  // A push changes the live deltas, so re-check every stored resolution against
  // the (now possibly empty) contributing pair for its symbol.
  for (const symbol of new Set(state.resolutions.map((resolution) => resolution.symbol.raw))) {
    invalidateResolutionsForSymbol(state, repoId, ops, symbol);
  }
}

function clearPushedReservations(
  state: TeamState,
  repoId: string,
  ops: OpSink,
  fileSet: Set<string>,
  symbolSet: Set<string>,
  now: string
): void {
  for (const reservation of [...state.reservations]) {
    const roots = reservation.roots.filter(
      (root) => !fileSet.has(root.filePath) && !symbolSet.has(root.symbolId.raw)
    );
    writeReservationRoots(state, repoId, ops, reservation, roots, now);
  }
}

function pruneExpiredReservationRoots(
  state: TeamState,
  repoId: string,
  ops: OpSink,
  now: number
): void {
  const updatedAt = new Date(now).toISOString();
  for (const reservation of [...state.reservations]) {
    const roots = reservation.roots.filter((root) => reservationRootIsActive(root, now));
    writeReservationRoots(state, repoId, ops, reservation, roots, updatedAt);
  }
}

function reservationRootIsActive(root: ReservationRoot, now: number): boolean {
  const acquiredAt = Date.parse(root.acquiredAt);
  return Number.isNaN(acquiredAt) || now - acquiredAt <= root.ttlSec * 1000;
}

function removeReservationRoots(
  state: TeamState,
  repoId: string,
  ops: OpSink,
  sessionId: string,
  shouldRemove: (root: ReservationRoot) => boolean,
  now: string
): void {
  const reservation = state.reservations.find((candidate) => candidate.sessionId === sessionId);
  if (!reservation) {
    return;
  }
  writeReservationRoots(
    state,
    repoId,
    ops,
    reservation,
    reservation.roots.filter((root) => !shouldRemove(root)),
    now
  );
}

function writeReservationRoots(
  state: TeamState,
  repoId: string,
  ops: OpSink,
  reservation: Reservation,
  roots: ReservationRoot[],
  updatedAt: string
): void {
  if (roots.length === 0) {
    deleteReservation(state, repoId, ops, reservation.sessionId);
    return;
  }

  const next: Reservation = {
    ...reservation,
    repoId,
    roots,
    radius: Math.max(...roots.map((root) => root.radius)),
    symbols: uniqueSymbols(roots.flatMap((root) => root.symbols)),
    updatedAt
  };
  emit(state, ops, { op: "upsertReservation", reservation: next });
}

function deleteReservation(state: TeamState, repoId: string, ops: OpSink, sessionId: string): void {
  // Emitted unconditionally, exactly as the prior dual-write called
  // store.deleteReservation on every teardown: a delete for a session with no
  // reservation is a no-op both in-memory (applyStateOp's filter) and in the
  // store, so the delta stream stays byte-identical to before.
  emit(state, ops, { op: "deleteReservation", sessionId });
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
  ops: OpSink,
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

  // applyStateOp's upsertResolution drops any prior entry for the symbol before
  // pushing, so one row per symbol is preserved exactly as before.
  emit(state, ops, { op: "upsertResolution", resolution });
}

/**
 * Drop any stored resolution for `symbolRaw` whose `inputsHash` no longer
 * matches the live contributing deltas (or whose deltas have all been cleared).
 */
function invalidateResolutionsForSymbol(
  state: TeamState,
  repoId: string,
  ops: OpSink,
  symbolRaw: string
): void {
  const sides = resolutionSidesForSymbol(state.unpushedDeltas, symbolRaw);
  const liveHash = sides.length > 0 ? resolutionInputsHash(symbolRaw, sides) : null;

  for (const resolution of [...state.resolutions]) {
    if (resolution.symbol.raw === symbolRaw && resolution.inputsHash !== liveHash) {
      emit(state, ops, {
        op: "deleteResolution",
        symbolRaw: resolution.symbol.raw,
        inputsHash: resolution.inputsHash
      });
    }
  }
}

/**
 * Record a session's narrative summary, most-recent-first. Re-ending the same
 * session replaces its prior summary so a session has at most one entry.
 */
function storeSessionSummary(
  state: TeamState,
  repoId: string,
  ops: OpSink,
  summary: SessionSummary
): void {
  emit(state, ops, { op: "appendSummary", summary, cap: SESSION_SUMMARY_CAP });
}

/**
 * Keep explicit warning feedback bounded and most-recent-first. Re-sending the
 * same feedback id replaces the prior entry so clients can safely retry.
 */
function addConflictFeedback(
  state: TeamState,
  repoId: string,
  ops: OpSink,
  feedback: ConflictFeedback
): void {
  emit(state, ops, { op: "appendFeedback", feedback, cap: CONFLICT_FEEDBACK_CAP });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueSymbols(values: ContractDelta["symbolId"][]): ContractDelta["symbolId"][] {
  const seen = new Set<string>();
  const symbols: ContractDelta["symbolId"][] = [];
  for (const value of values) {
    if (seen.has(value.raw)) {
      continue;
    }
    seen.add(value.raw);
    symbols.push(value);
  }
  return symbols;
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

function assertNever(value: never): never {
  throw new Error(`Unhandled message: ${JSON.stringify(value)}`);
}
