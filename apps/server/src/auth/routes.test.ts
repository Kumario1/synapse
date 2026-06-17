import assert from "node:assert/strict";
import test from "node:test";
import { resolveAuthRoute, type AuthContext } from "./routes.js";
import {
  SESSION_COOKIE,
  parseCookies,
  sessionKeyFromClientSecret,
  signSession
} from "./session.js";
import type { GitHubUser } from "./github-oauth.js";
import { createUserStore } from "./user-store.js";

const sessionKey = sessionKeyFromClientSecret("fake-client-secret");
const octocat: GitHubUser = { id: "42", login: "octocat", name: "Octo", avatarUrl: "u" };

async function makeCtx(
  overrides: Partial<AuthContext> = {}
): Promise<{ ctx: AuthContext; close: () => Promise<void> }> {
  const userStore = await createUserStore({ path: ":memory:" });
  const ctx: AuthContext = {
    creds: { clientId: "Iv1.fakeclient", clientSecret: "fake-client-secret" },
    sessionKey,
    userStore,
    redirectUri: "https://app.example/auth/github/callback",
    exchangeCodeForToken: async () => "tok",
    fetchGitHubUser: async () => octocat,
    isSecure: true,
    ...overrides
  };
  return { ctx, close: () => userStore.close() };
}

/** Drive GET /auth/github to obtain a matching state value + its cookie. */
async function freshState(ctx: AuthContext): Promise<string> {
  const result = await resolveAuthRoute("GET", "/auth/github", new URLSearchParams(), {}, ctx);
  assert.ok(result);
  const cookie = (result.setCookies ?? []).find((c) => c.startsWith("synapse_oauth_state="));
  assert.ok(cookie, "expected an oauth state cookie");
  return parseCookies(cookie.split(";")[0]).synapse_oauth_state;
}

function setCookieFor(cookies: string[] | undefined, name: string): string | undefined {
  return (cookies ?? []).find((c) => c.startsWith(`${name}=`));
}

test("GET /auth/github redirects to GitHub and sets a signed state cookie", async () => {
  const { ctx, close } = await makeCtx();
  try {
    const result = await resolveAuthRoute("GET", "/auth/github", new URLSearchParams(), {}, ctx);
    assert.ok(result);
    assert.equal(result.status, 302);
    assert.ok(result.redirect?.startsWith("https://github.com/login/oauth/authorize"));
    assert.ok(setCookieFor(result.setCookies, "synapse_oauth_state"));
  } finally {
    await close();
  }
});

test("callback success: creates the user and sets a session cookie", async () => {
  const { ctx, close } = await makeCtx();
  try {
    const state = await freshState(ctx);
    const result = await resolveAuthRoute(
      "GET",
      "/auth/github/callback",
      new URLSearchParams({ code: "the-code", state }),
      { synapse_oauth_state: state },
      ctx
    );
    assert.ok(result);
    assert.equal(result.status, 302);
    assert.equal(result.redirect, "/");
    assert.ok(setCookieFor(result.setCookies, SESSION_COOKIE), "expected a session cookie");
    assert.deepEqual(await ctx.userStore.getUserById("42"), {
      id: "42",
      login: "octocat",
      name: "Octo",
      avatarUrl: "u"
    });
  } finally {
    await close();
  }
});

test("repeat login is idempotent: still exactly one user row", async () => {
  const { ctx, close } = await makeCtx();
  try {
    for (let i = 0; i < 2; i++) {
      const state = await freshState(ctx);
      const result = await resolveAuthRoute(
        "GET",
        "/auth/github/callback",
        new URLSearchParams({ code: "the-code", state }),
        { synapse_oauth_state: state },
        ctx
      );
      assert.equal(result?.status, 302);
    }
    // Same gh id both times → upsert keeps one row.
    assert.ok(await ctx.userStore.getUserById("42"));
  } finally {
    await close();
  }
});

test("callback with a mismatched state cookie is rejected", async () => {
  const { ctx, close } = await makeCtx();
  try {
    const state = await freshState(ctx);
    const result = await resolveAuthRoute(
      "GET",
      "/auth/github/callback",
      new URLSearchParams({ code: "the-code", state }),
      { synapse_oauth_state: "a-different-value" },
      ctx
    );
    assert.equal(result?.status, 400);
    assert.deepEqual(result?.body, { error: "bad_state" });
  } finally {
    await close();
  }
});

test("callback without a code is rejected", async () => {
  const { ctx, close } = await makeCtx();
  try {
    const state = await freshState(ctx);
    const result = await resolveAuthRoute(
      "GET",
      "/auth/github/callback",
      new URLSearchParams({ state }),
      { synapse_oauth_state: state },
      ctx
    );
    assert.equal(result?.status, 400);
    assert.deepEqual(result?.body, { error: "missing_code" });
  } finally {
    await close();
  }
});

test("callback maps a GitHub exchange failure to 502", async () => {
  const { ctx, close } = await makeCtx({
    fetchGitHubUser: async () => {
      throw new Error("boom");
    }
  });
  try {
    const state = await freshState(ctx);
    const result = await resolveAuthRoute(
      "GET",
      "/auth/github/callback",
      new URLSearchParams({ code: "the-code", state }),
      { synapse_oauth_state: state },
      ctx
    );
    assert.equal(result?.status, 502);
    assert.deepEqual(result?.body, { error: "github_exchange_failed" });
  } finally {
    await close();
  }
});

test("GET /auth/me is 401 when unauthenticated", async () => {
  const { ctx, close } = await makeCtx();
  try {
    const result = await resolveAuthRoute("GET", "/auth/me", new URLSearchParams(), {}, ctx);
    assert.equal(result?.status, 401);
  } finally {
    await close();
  }
});

test("GET /auth/me returns the owner when authenticated", async () => {
  const { ctx, close } = await makeCtx();
  try {
    await ctx.userStore.upsertUser(octocat);
    const session = signSession("42", sessionKey);
    const result = await resolveAuthRoute(
      "GET",
      "/auth/me",
      new URLSearchParams(),
      { [SESSION_COOKIE]: session },
      ctx
    );
    assert.equal(result?.status, 200);
    assert.deepEqual(result?.body, {
      owner: { login: "octocat", name: "Octo", avatarUrl: "u" }
    });
  } finally {
    await close();
  }
});

test("logout clears the session cookie with Max-Age=0", async () => {
  const { ctx, close } = await makeCtx();
  try {
    const result = await resolveAuthRoute("POST", "/auth/logout", new URLSearchParams(), {}, ctx);
    assert.equal(result?.status, 200);
    assert.deepEqual(result?.body, { ok: true });
    const cookie = setCookieFor(result?.setCookies, SESSION_COOKIE);
    assert.ok(cookie);
    assert.ok(cookie.includes("Max-Age=0"));
  } finally {
    await close();
  }
});

test("an unknown /auth path is 404 and a non-auth path is null", async () => {
  const { ctx, close } = await makeCtx();
  try {
    const unknown = await resolveAuthRoute("GET", "/auth/nope", new URLSearchParams(), {}, ctx);
    assert.equal(unknown?.status, 404);
    const nonAuth = await resolveAuthRoute("GET", "/health", new URLSearchParams(), {}, ctx);
    assert.equal(nonAuth, null);
  } finally {
    await close();
  }
});
