import type { Session } from "@synapse/protocol";

export function relativeTime(value: string, now = Date.now()) {
  const elapsed = Math.max(0, now - Date.parse(value));
  const seconds = Math.round(elapsed / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

export function ttlRemaining(acquiredAt: string, ttlSec: number, now = Date.now()) {
  const elapsed = Math.floor((now - Date.parse(acquiredAt)) / 1000);
  return Math.max(0, ttlSec - elapsed);
}

export function initials(value: string) {
  return value
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function labelFor(sessionId: string, sessions: Map<string, Session>) {
  const session = sessions.get(sessionId);
  return session?.memberLogin ?? session?.memberId ?? sessionId;
}
