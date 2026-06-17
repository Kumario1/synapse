import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless signed cookie session for the human GitHub sign-in boundary (plan
 * 051). There is no sessions table: the cookie is the session, sign-out clears
 * it, and the HMAC key is derived from the OAuth client secret so no extra env
 * var is needed. Library-free by design (node:crypto only).
 *
 * Token layout: base64url(JSON{uid,iat}) + "." + base64url(HMAC-SHA256(payload)).
 *
 * This session NEVER authorizes a daemon WS room or `/state` — it is identity
 * only, strictly distinct from the machine project-key/shared-token credential.
 */

export const SESSION_COOKIE = "synapse_session";
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface SessionPayload {
  uid: string;
  iat: number;
}

function base64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

/** Derive the session HMAC key from the OAuth client secret (no 6th env var). */
export function sessionKeyFromClientSecret(clientSecret: string): Buffer {
  return createHmac("sha256", clientSecret).update("synapse-session-v1").digest();
}

export function signSession(userId: string, key: Buffer, now = Date.now()): string {
  const payload = base64url(JSON.stringify({ uid: userId, iat: now } satisfies SessionPayload));
  const signature = base64url(createHmac("sha256", key).update(payload).digest());
  return `${payload}.${signature}`;
}

/**
 * Verify a signed session token. Returns `null` — never throws — on a missing,
 * malformed, badly-signed (constant-time compare), or expired token.
 */
export function verifySession(
  token: string | undefined,
  key: Buffer,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS
): { userId: string } | null {
  if (!token) {
    return null;
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return null;
  }
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = base64url(createHmac("sha256", key).update(payload).digest());
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as SessionPayload).uid !== "string" ||
    typeof (parsed as SessionPayload).iat !== "number"
  ) {
    return null;
  }
  const { uid, iat } = parsed as SessionPayload;
  if (Date.now() - iat > maxAgeMs) {
    return null;
  }
  return { userId: uid };
}

export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) {
      cookies[name] = decodeURIComponent(value);
    }
  }
  return cookies;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: {
    maxAgeSec?: number;
    httpOnly?: boolean;
    sameSite?: "Lax" | "Strict";
    secure?: boolean;
    path?: string;
  } = {}
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAgeSec !== undefined) {
    parts.push(`Max-Age=${opts.maxAgeSec}`);
  }
  if (opts.httpOnly) {
    parts.push("HttpOnly");
  }
  // SameSite=Lax lets the cookie ride the top-level GET redirect back from
  // GitHub, which a Strict cookie would drop.
  if (opts.sameSite) {
    parts.push(`SameSite=${opts.sameSite}`);
  }
  if (opts.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}
