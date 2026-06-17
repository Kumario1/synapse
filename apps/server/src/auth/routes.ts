import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildAuthorizeUrl, type GitHubUser, type OAuthCreds } from "./github-oauth.js";
import {
  SESSION_COOKIE,
  parseCookies,
  serializeCookie,
  signSession,
  verifySession
} from "./session.js";
import type { UserStore } from "./user-store.js";

/**
 * The human GitHub sign-in routes (plan 051). The decision logic
 * ({@link resolveAuthRoute}) is pure and injectable so the acceptance tests
 * never touch the network; {@link handleAuthRequest} is the thin node http
 * adapter. CSRF is covered by a signed `state` nonce echoed in a short-lived
 * cookie.
 *
 * This boundary is identity-only. A session cookie never authorizes a daemon WS
 * room or `/state`; those use the separate machine credential.
 */

const OAUTH_STATE_COOKIE = "synapse_oauth_state";
const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30 days
const STATE_MAX_AGE_SEC = 600; // 10 minutes

export interface AuthContext {
  creds: OAuthCreds;
  sessionKey: Buffer;
  userStore: UserStore;
  redirectUri: string;
  exchangeCodeForToken: (code: string) => Promise<string>;
  fetchGitHubUser: (token: string) => Promise<GitHubUser>;
  isSecure: boolean;
}

export interface RouteResult {
  status: number;
  body?: unknown;
  redirect?: string;
  setCookies?: string[];
}

/** Sign a random CSRF nonce with the session key (constant-time verify on return). */
function signState(key: Buffer): string {
  const nonce = randomUUID();
  const mac = createHmac("sha256", key).update(nonce).digest("base64url");
  return `${nonce}.${mac}`;
}

function sessionCookie(value: string, isSecure: boolean): string {
  return serializeCookie(SESSION_COOKIE, value, {
    maxAgeSec: SESSION_MAX_AGE_SEC,
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecure,
    path: "/"
  });
}

function clearCookie(name: string): string {
  return serializeCookie(name, "", { maxAgeSec: 0, path: "/", httpOnly: true });
}

export async function resolveAuthRoute(
  method: string,
  pathname: string,
  query: URLSearchParams,
  cookies: Record<string, string>,
  ctx: AuthContext
): Promise<RouteResult | null> {
  if (!pathname.startsWith("/auth/")) {
    return null;
  }

  if (method === "GET" && pathname === "/auth/github") {
    const state = signState(ctx.sessionKey);
    return {
      status: 302,
      redirect: buildAuthorizeUrl(ctx.creds, state, ctx.redirectUri),
      setCookies: [
        serializeCookie(OAUTH_STATE_COOKIE, state, {
          httpOnly: true,
          sameSite: "Lax",
          secure: ctx.isSecure,
          maxAgeSec: STATE_MAX_AGE_SEC,
          path: "/"
        })
      ]
    };
  }

  if (method === "GET" && pathname === "/auth/github/callback") {
    const state = query.get("state");
    const cookieState = cookies[OAUTH_STATE_COOKIE];
    if (!verifyStateSigned(state, cookieState, ctx.sessionKey)) {
      return { status: 400, body: { error: "bad_state" } };
    }
    const code = query.get("code");
    if (!code) {
      return { status: 400, body: { error: "missing_code" } };
    }
    let gh: GitHubUser;
    try {
      const token = await ctx.exchangeCodeForToken(code);
      // ponytail: the GitHub user access token (`token`) is intentionally not
      // persisted here — repo claiming / installation tokens are issue #104.
      gh = await ctx.fetchGitHubUser(token);
    } catch {
      return { status: 502, body: { error: "github_exchange_failed" } };
    }
    const user = await ctx.userStore.upsertUser({
      id: gh.id,
      login: gh.login,
      name: gh.name,
      avatarUrl: gh.avatarUrl
    });
    const session = signSession(user.id, ctx.sessionKey);
    return {
      status: 302,
      redirect: "/",
      setCookies: [sessionCookie(session, ctx.isSecure), clearCookie(OAUTH_STATE_COOKIE)]
    };
  }

  if (method === "GET" && pathname === "/auth/me") {
    const verified = verifySession(cookies[SESSION_COOKIE], ctx.sessionKey);
    if (!verified) {
      return { status: 401, body: { error: "unauthenticated" } };
    }
    const user = await ctx.userStore.getUserById(verified.userId);
    if (!user) {
      return { status: 401, body: { error: "unauthenticated" } };
    }
    return {
      status: 200,
      body: { owner: { login: user.login, name: user.name, avatarUrl: user.avatarUrl } }
    };
  }

  if ((method === "POST" || method === "GET") && pathname === "/auth/logout") {
    return { status: 200, body: { ok: true }, setCookies: [clearCookie(SESSION_COOKIE)] };
  }

  return { status: 404, body: { error: "not_found" } };
}

/**
 * Constant-time verification of the signed CSRF state: the query value must
 * equal the cookie value AND carry a valid HMAC over its nonce. Equality alone
 * is not enough — an attacker who can set both must also forge the MAC.
 */
function verifyStateSigned(query: string | null, cookie: string | undefined, key: Buffer): boolean {
  if (!query || !cookie) {
    return false;
  }
  const qa = Buffer.from(query);
  const cb = Buffer.from(cookie);
  if (qa.length !== cb.length || !timingSafeEqual(qa, cb)) {
    return false;
  }
  const dot = query.indexOf(".");
  if (dot <= 0 || dot === query.length - 1) {
    return false;
  }
  const nonce = query.slice(0, dot);
  const mac = query.slice(dot + 1);
  const expected = createHmac("sha256", key).update(nonce).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ctx: AuthContext
): Promise<boolean> {
  const cookieHeader = request.headers.cookie ?? null;
  const cookies = parseCookies(Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader);
  const result = await resolveAuthRoute(
    request.method ?? "GET",
    url.pathname,
    url.searchParams,
    cookies,
    ctx
  );
  if (!result) {
    return false;
  }

  const headers: Record<string, string> = {};
  if (result.setCookies && result.setCookies.length > 0) {
    response.setHeader("Set-Cookie", result.setCookies);
  }
  if (result.redirect) {
    response.writeHead(result.status, { ...headers, Location: result.redirect });
    response.end();
    return true;
  }
  response.writeHead(result.status, { ...headers, "content-type": "application/json" });
  response.end(JSON.stringify(result.body ?? {}, null, 2));
  return true;
}
