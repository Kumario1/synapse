import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { deriveProjectKey } from "@synapse/protocol";
import { buildAuthorizeUrl, type GitHubUser, type OAuthCreds } from "./github-oauth.js";
import { buildInstallUrl, type ClaimedRepo } from "./github-app.js";
import {
  SESSION_COOKIE,
  parseCookies,
  serializeCookie,
  signSession,
  verifySession
} from "./session.js";
import type { UserStore } from "./user-store.js";
import type { ProjectStore } from "./project-store.js";

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
const INSTALL_STATE_COOKIE = "synapse_install_state";
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
  appSlug: string | null;
  masterSecret: string;
  projectStore: ProjectStore;
  listInstallationReposForUser: (
    installationId: string,
    userToken: string
  ) => Promise<ClaimedRepo[]>;
  readRoomState: (repoId: string) => Promise<unknown>;
  kickSession: (repoId: string, sessionId: string) => Promise<void>;
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

/** The authenticated Owner behind a request, or null. Reuses the session HMAC. */
function requireOwner(
  cookies: Record<string, string>,
  ctx: AuthContext
): { userId: string } | null {
  return verifySession(cookies[SESSION_COOKIE], ctx.sessionKey);
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

  // Start a repo claim: send the signed-in Owner through the App install flow.
  if (method === "GET" && pathname === "/auth/projects/add") {
    const owner = requireOwner(cookies, ctx);
    if (!owner) {
      return { status: 401, body: { error: "unauthenticated" } };
    }
    if (!ctx.appSlug || !ctx.masterSecret) {
      return { status: 503, body: { error: "claiming_unavailable" } };
    }
    const state = signState(ctx.sessionKey);
    return {
      status: 302,
      redirect: buildInstallUrl(ctx.appSlug, state),
      setCookies: [
        serializeCookie(INSTALL_STATE_COOKIE, state, {
          httpOnly: true,
          sameSite: "Lax",
          secure: ctx.isSecure,
          maxAgeSec: STATE_MAX_AGE_SEC,
          path: "/"
        })
      ]
    };
  }

  // Install setup callback: verify push access, record Owner↔repo, mint key.
  if (method === "GET" && pathname === "/auth/github/setup") {
    const owner = requireOwner(cookies, ctx);
    if (!owner) {
      return { status: 401, body: { error: "unauthenticated" } };
    }
    if (!verifyStateSigned(query.get("state"), cookies[INSTALL_STATE_COOKIE], ctx.sessionKey)) {
      return { status: 400, body: { error: "bad_state" } };
    }
    const installationId = query.get("installation_id");
    const code = query.get("code");
    if (!installationId || !code) {
      return { status: 400, body: { error: "missing_installation" } };
    }
    let repos: ClaimedRepo[];
    try {
      // The user access token is used once here and discarded — never stored.
      const userToken = await ctx.exchangeCodeForToken(code);
      repos = await ctx.listInstallationReposForUser(installationId, userToken);
    } catch {
      return { status: 502, body: { error: "github_install_failed" } };
    }
    // Only repos the Owner can push to are claimed; non-push repos are ignored.
    const claimable = repos.filter((r) => r.pushAccess);
    for (const repo of claimable) {
      const key = deriveProjectKey(ctx.masterSecret, repo.fullName);
      await ctx.projectStore.claimProject(owner.userId, repo.fullName, key);
    }
    return {
      status: 302,
      redirect: "/",
      setCookies: [clearCookie(INSTALL_STATE_COOKIE)]
    };
  }

  // The Owner's own claimed projects + their per-repo daemon credential.
  if (method === "GET" && pathname === "/auth/projects") {
    const owner = requireOwner(cookies, ctx);
    if (!owner) {
      return { status: 401, body: { error: "unauthenticated" } };
    }
    const projects = await ctx.projectStore.listProjectsForOwner(owner.userId);
    return {
      status: 200,
      body: { projects: projects.map((p) => ({ repoId: p.repoId, projectKey: p.projectKey })) }
    };
  }

  // Owner dashboard read: cookie-authed, authorized by ownership. An Owner may read
  // the live Room only for a repo they have claimed. Distinct from the machine
  // GET /state (project-key) path — the boundary stays separate.
  if (method === "GET" && pathname === "/auth/projects/state") {
    const owner = requireOwner(cookies, ctx);
    if (!owner) {
      return { status: 401, body: { error: "unauthenticated" } };
    }
    const repoId = query.get("repoId");
    if (!repoId) {
      return { status: 400, body: { error: "missing_repo" } };
    }
    const project = await ctx.projectStore.getProject(owner.userId, repoId);
    if (!project) {
      return { status: 403, body: { error: "not_owner" } };
    }
    const state = await ctx.readRoomState(repoId);
    return { status: 200, body: state };
  }

  // Owner kick: force-end an agent Session in a Project the Owner owns. HTTP only,
  // cookie-authed, authorized by ownership — never a browser WS message. repoId and
  // sessionId ride the query string (resolveAuthRoute has no request body).
  if (method === "POST" && pathname === "/auth/projects/kick") {
    const owner = requireOwner(cookies, ctx);
    if (!owner) {
      return { status: 401, body: { error: "unauthenticated" } };
    }
    const repoId = query.get("repoId");
    const sessionId = query.get("sessionId");
    if (!repoId || !sessionId) {
      return { status: 400, body: { error: "missing_params" } };
    }
    const project = await ctx.projectStore.getProject(owner.userId, repoId);
    if (!project) {
      return { status: 403, body: { error: "not_owner" } };
    }
    await ctx.kickSession(repoId, sessionId);
    return { status: 200, body: { ok: true } };
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
