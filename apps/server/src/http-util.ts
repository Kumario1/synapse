import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * A sliding one-minute counter. Ingress rate limiting (G4) keeps one of these
 * per WS connection and one global each for the webhook and HTTP-read budgets.
 */
export interface RateWindow {
  windowStartedAt: number;
  count: number;
}

/**
 * Advance `window` by one hit and report whether it has exceeded
 * `limitPerMinute`. The window resets once a minute has elapsed. A limit of 0
 * (or less) disables the budget entirely.
 */
export function overRateLimit(window: RateWindow, limitPerMinute: number, now: number): boolean {
  if (limitPerMinute <= 0) {
    return false;
  }
  if (now - window.windowStartedAt >= 60_000) {
    window.windowStartedAt = now;
    window.count = 0;
  }
  window.count += 1;
  return window.count > limitPerMinute;
}

/**
 * Read the full request body as a string, destroying the request and throwing
 * `payload_too_large` once it exceeds `maxPayloadBytes`. The ingress hard cap
 * is threaded in so nothing legitimate (deltas carry signatures, never file
 * bodies) approaches it.
 */
export async function readBody(request: IncomingMessage, maxPayloadBytes: number): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxPayloadBytes) {
      request.destroy();
      throw new Error("payload_too_large");
    }
  }

  return body;
}

/**
 * Read a single request header, collapsing the array form Node uses for
 * repeated headers to its first value.
 */
export function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

/** Write a pretty-printed JSON response with the given status code. */
export function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body, null, 2));
}
