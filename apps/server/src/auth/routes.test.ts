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
import type { ClaimedRepo } from "./github-app.js";
import { createUserStore } from "./user-store.js";
import { createProjectStore, type ProjectStore } from "./project-store.js";
import { deriveProjectKey } from "@synapse/protocol";

const sessionKey = sessionKeyFromClientSecret("fake-client-secret");
const octocat: GitHubUser = { id: "42", login: "octocat", name: "Octo", avatarUrl: "u" };
const installRepos: ClaimedRepo[] = [
  { fullName: "o/r1", pushAccess: true },
  { fullName: "o/r2", pushAccess: false }
];

async function makeCtx(
  overrides: Partial<AuthContext> = {}
): Promise<{ ctx: AuthContext; projectStore: ProjectStore; close: () => Promise<void> }> {
  const userStore = await createUserStore({ path: ":memory:" });
  const projectStore = await createProjectStore({ path: ":memory:" });
  const ctx: AuthContext = {
    creds: { clientId: "Iv1.fakeclient", clientSecret: "fake-client-secret" },
    sessionKey,
    userStore,
    redirectUri: "https://app.example/auth/github/callback",
    exchangeCodeForToken: async () => "tok",
    fetchGitHubUser: async () => octocat,
    isSecure: true,
    appSlug: "my-app",
    masterSecret: "test-master",
    projectStore,
    listInstallationReposForUser: async () => installRepos,
    readRoomState: async (repoId: string) => ({
      repoId,
      sessions: [{ id: "s1" }],
      editLocks: [],
      unpushedDeltas: [],
      recentPushes: [],
      recentRepoEvents: []
    }),
    ...overrides
  };
  return {
    ctx,
    projectStore,
    close: async () => {
      await userStore.close();
      await projectStore.close();
    }
  };
}

/** Drive GET /auth/projects/add (with an authed Owner) to obtain a matching install-state value. */
async function freshInstallState(ctx: AuthContext, ownerSession: string): Promise<string> {
  const result = await resolveAuthRoute(
    "GET",
    "/auth/projects/add",
    new URLSearchParams(),
    { [SESSION_COOKIE]: ownerSession },
    ctx
  );
  assert.ok(result);
  const cookie = (result.setCookies ?? []).find((c) => c.startsWith("synapse_install_state="));
  assert.ok(cookie, "expected an install state cookie");
  return parseCookies(cookie.split(";")[0]).synapse_install_state;
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

test("install setup records ownership for a push repo and mints its project-key", async () => {
  const { ctx, projectStore, close } = await makeCtx();
  try {
    const session = signSession("42", sessionKey);
    const state = await freshInstallState(ctx, session);
    const result = await resolveAuthRoute(
      "GET",
      "/auth/github/setup",
      new URLSearchParams({ installation_id: "1", code: "c", state }),
      { [SESSION_COOKIE]: session, synapse_install_state: state },
      ctx
    );
    assert.equal(result?.status, 302);
    assert.equal(result?.redirect, "/");
    const claimed = await projectStore.getProject("42", "o/r1");
    assert.ok(claimed);
    assert.equal(claimed?.projectKey, deriveProjectKey("test-master", "o/r1"));
  } finally {
    await close();
  }
});

test("install setup does not claim a non-push repo", async () => {
  const { ctx, projectStore, close } = await makeCtx();
  try {
    const session = signSession("42", sessionKey);
    const state = await freshInstallState(ctx, session);
    await resolveAuthRoute(
      "GET",
      "/auth/github/setup",
      new URLSearchParams({ installation_id: "1", code: "c", state }),
      { [SESSION_COOKIE]: session, synapse_install_state: state },
      ctx
    );
    assert.equal(await projectStore.getProject("42", "o/r2"), null);
  } finally {
    await close();
  }
});

test("the project-key is minted once across repeated installs", async () => {
  const { ctx, projectStore, close } = await makeCtx();
  try {
    const session = signSession("42", sessionKey);
    for (let i = 0; i < 2; i++) {
      const state = await freshInstallState(ctx, session);
      const result = await resolveAuthRoute(
        "GET",
        "/auth/github/setup",
        new URLSearchParams({ installation_id: "1", code: "c", state }),
        { [SESSION_COOKIE]: session, synapse_install_state: state },
        ctx
      );
      assert.equal(result?.status, 302);
    }
    const stored = await projectStore.getProject("42", "o/r1");
    assert.equal(stored?.projectKey, deriveProjectKey("test-master", "o/r1"));
  } finally {
    await close();
  }
});

test("GET /auth/projects/add requires a session", async () => {
  const { ctx, close } = await makeCtx();
  try {
    const result = await resolveAuthRoute(
      "GET",
      "/auth/projects/add",
      new URLSearchParams(),
      {},
      ctx
    );
    assert.equal(result?.status, 401);
    assert.deepEqual(result?.body, { error: "unauthenticated" });
  } finally {
    await close();
  }
});

test("GET /auth/projects/add is 503 when claiming is unavailable", async () => {
  const { ctx, close } = await makeCtx({ appSlug: null });
  try {
    const session = signSession("42", sessionKey);
    const result = await resolveAuthRoute(
      "GET",
      "/auth/projects/add",
      new URLSearchParams(),
      { [SESSION_COOKIE]: session },
      ctx
    );
    assert.equal(result?.status, 503);
    assert.deepEqual(result?.body, { error: "claiming_unavailable" });
  } finally {
    await close();
  }
});

test("GET /auth/projects returns only the Owner's own claimed repos with their keys", async () => {
  const { ctx, close } = await makeCtx();
  try {
    const session = signSession("42", sessionKey);
    const state = await freshInstallState(ctx, session);
    await resolveAuthRoute(
      "GET",
      "/auth/github/setup",
      new URLSearchParams({ installation_id: "1", code: "c", state }),
      { [SESSION_COOKIE]: session, synapse_install_state: state },
      ctx
    );

    const mine = await resolveAuthRoute(
      "GET",
      "/auth/projects",
      new URLSearchParams(),
      { [SESSION_COOKIE]: session },
      ctx
    );
    assert.equal(mine?.status, 200);
    assert.deepEqual(mine?.body, {
      projects: [{ repoId: "o/r1", projectKey: deriveProjectKey("test-master", "o/r1") }]
    });

    // A different Owner does not see o/r1.
    const other = await resolveAuthRoute(
      "GET",
      "/auth/projects",
      new URLSearchParams(),
      { [SESSION_COOKIE]: signSession("99", sessionKey) },
      ctx
    );
    assert.deepEqual(other?.body, { projects: [] });
  } finally {
    await close();
  }
});

test("GET /auth/projects/state returns the Room state for a claimed repo", async () => {
  const { ctx, close } = await makeCtx();
  try {
    const session = signSession("42", sessionKey);
    const state = await freshInstallState(ctx, session);
    await resolveAuthRoute(
      "GET",
      "/auth/github/setup",
      new URLSearchParams({ installation_id: "1", code: "c", state }),
      { [SESSION_COOKIE]: session, synapse_install_state: state },
      ctx
    );

    const result = await resolveAuthRoute(
      "GET",
      "/auth/projects/state",
      new URLSearchParams({ repoId: "o/r1" }),
      { [SESSION_COOKIE]: session },
      ctx
    );
    assert.equal(result?.status, 200);
    assert.equal((result?.body as { repoId: string }).repoId, "o/r1");
  } finally {
    await close();
  }
});

test("GET /auth/projects/state denies a repo the Owner has not claimed", async () => {
  const { ctx, close } = await makeCtx();
  try {
    const session = signSession("42", sessionKey);
    const result = await resolveAuthRoute(
      "GET",
      "/auth/projects/state",
      new URLSearchParams({ repoId: "o/unclaimed" }),
      { [SESSION_COOKIE]: session },
      ctx
    );
    assert.equal(result?.status, 403);
    assert.deepEqual(result?.body, { error: "not_owner" });
  } finally {
    await close();
  }
});

test("GET /auth/projects/state is 401 without a session", async () => {
  const { ctx, close } = await makeCtx();
  try {
    const result = await resolveAuthRoute(
      "GET",
      "/auth/projects/state",
      new URLSearchParams({ repoId: "o/r1" }),
      {},
      ctx
    );
    assert.equal(result?.status, 401);
    assert.deepEqual(result?.body, { error: "unauthenticated" });
  } finally {
    await close();
  }
});

test("GET /auth/projects/state is 400 without a repoId", async () => {
  const { ctx, close } = await makeCtx();
  try {
    const session = signSession("42", sessionKey);
    const result = await resolveAuthRoute(
      "GET",
      "/auth/projects/state",
      new URLSearchParams(),
      { [SESSION_COOKIE]: session },
      ctx
    );
    assert.equal(result?.status, 400);
    assert.deepEqual(result?.body, { error: "missing_repo" });
  } finally {
    await close();
  }
});

test("install setup rejects a bad install-state", async () => {
  const { ctx, close } = await makeCtx();
  try {
    const session = signSession("42", sessionKey);
    const state = await freshInstallState(ctx, session);
    const result = await resolveAuthRoute(
      "GET",
      "/auth/github/setup",
      new URLSearchParams({ installation_id: "1", code: "c", state }),
      { [SESSION_COOKIE]: session, synapse_install_state: "a-different-value" },
      ctx
    );
    assert.equal(result?.status, 400);
    assert.deepEqual(result?.body, { error: "bad_state" });
  } finally {
    await close();
  }
});

test("install setup rejects a missing installation_id or code", async () => {
  const { ctx, close } = await makeCtx();
  try {
    const session = signSession("42", sessionKey);
    const state = await freshInstallState(ctx, session);
    const noInstall = await resolveAuthRoute(
      "GET",
      "/auth/github/setup",
      new URLSearchParams({ code: "c", state }),
      { [SESSION_COOKIE]: session, synapse_install_state: state },
      ctx
    );
    assert.equal(noInstall?.status, 400);
    assert.deepEqual(noInstall?.body, { error: "missing_installation" });

    const state2 = await freshInstallState(ctx, session);
    const noCode = await resolveAuthRoute(
      "GET",
      "/auth/github/setup",
      new URLSearchParams({ installation_id: "1", state: state2 }),
      { [SESSION_COOKIE]: session, synapse_install_state: state2 },
      ctx
    );
    assert.equal(noCode?.status, 400);
    assert.deepEqual(noCode?.body, { error: "missing_installation" });
  } finally {
    await close();
  }
});
