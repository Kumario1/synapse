import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { URL } from "node:url";
import { deriveProjectKey } from "@synapse/protocol";
import { headerValue } from "./http-util.js";

/**
 * The daemon<->server credential mode, resolved once at startup:
 *   - "project-key": each request is validated against
 *     deriveProjectKey(masterSecret, repoId), so a key grants access to its
 *     own project only (real tenancy).
 *   - "shared-token": any valid token reads/writes any repo.
 *   - "open": no auth (local/dev and hermetic tests).
 */
export type AuthMode = "project-key" | "shared-token" | "open";

/** The credential material the request authorization check is bound to. */
export interface AuthConfig {
  authMode: AuthMode;
  masterSecret: string;
  authToken: string;
}

/**
 * True when the request is authorized for `repoId`:
 *   - open mode: always (no auth configured).
 *   - shared-token mode: the presented credential matches SYNAPSE_AUTH_TOKEN
 *     (grants any repo).
 *   - project-key mode: the presented credential matches
 *     deriveProjectKey(masterSecret, repoId) — so a key validates against its
 *     own project only.
 * The credential arrives via `?token=` or an `Authorization: Bearer` header; the
 * comparison is constant-time to avoid leaking it through timing.
 */
export function authorized(
  request: IncomingMessage,
  url: URL,
  repoId: string,
  config: AuthConfig
): boolean {
  if (config.authMode === "open") {
    return true;
  }

  const fromQuery = url.searchParams.get("token");
  const header = headerValue(request, "authorization");
  const fromHeader = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  const provided = fromQuery ?? fromHeader;
  if (!provided) {
    return false;
  }

  const expected =
    config.authMode === "project-key"
      ? deriveProjectKey(config.masterSecret, repoId)
      : config.authToken;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify a GitHub webhook HMAC-SHA256 signature (the `x-hub-signature-256`
 * header) against the configured shared secret. Constant-time comparison.
 */
export function validGitHubSignature(
  rawBody: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature?.startsWith("sha256=")) {
    return false;
  }

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
