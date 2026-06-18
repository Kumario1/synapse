import type { TeamState } from "@synapse/protocol";
import type { FeedSnapshot, FeedStatus } from "./feed";

/**
 * The Owner dashboard read path: cookie-authed and authorized by ownership.
 * The server returns the live Room only for repos the session Owner has claimed
 * (401 without a session, 403 for an unowned repo). Distinct from the machine
 * `GET /state` (project-key) boundary.
 */
export function ownedRoomStateUrl(repoId: string): string {
  return `/auth/projects/state?repoId=${encodeURIComponent(repoId)}`;
}

/**
 * The pre-first-poll placeholder Room. Mirrors the protocol's
 * `createEmptyTeamState`, but built inline so the web bundle imports only the
 * `TeamState` *type* — importing the protocol value drags `node:crypto` into
 * the browser build (the protocol package mixes server-only HMAC helpers).
 */
export function emptyRoomState(repoId: string): TeamState {
  return {
    repoId,
    sessions: [],
    editLocks: [],
    unpushedDeltas: [],
    recentPushes: [],
    recentRepoEvents: [],
    resolutions: [],
    sessionSummaries: [],
    conflictFeedback: []
  };
}

/**
 * The Owner kick write path: an authenticated HTTP POST (never a browser WS
 * message). repoId and sessionId ride the query string. The server ends the
 * Session, releases its edit locks, closes its socket, and broadcasts the new
 * Room state; a reconnecting daemon returns as a fresh Session.
 */
export function kickUrl(repoId: string, sessionId: string): string {
  return `/auth/projects/kick?repoId=${encodeURIComponent(repoId)}&sessionId=${encodeURIComponent(sessionId)}`;
}

export async function kickSession(repoId: string, sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(kickUrl(repoId, sessionId), {
      method: "POST",
      credentials: "include"
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function fetchOwnedRoomState(repoId: string): Promise<TeamState | null> {
  try {
    const response = await fetch(ownedRoomStateUrl(repoId), { credentials: "include" });
    if (!response.ok) return null;
    return (await response.json()) as TeamState;
  } catch {
    return null;
  }
}

export function toSnapshot(
  state: TeamState,
  seq: number,
  status: FeedStatus = "open"
): FeedSnapshot {
  return { mode: "live", status, state, seq, message: "Owner dashboard" };
}
