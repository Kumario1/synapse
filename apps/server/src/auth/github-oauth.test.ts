import assert from "node:assert/strict";
import test from "node:test";
import { buildAuthorizeUrl, exchangeCodeForToken, fetchGitHubUser } from "./github-oauth.js";

const creds = { clientId: "Iv1.fakeclient", clientSecret: "fake-client-secret" };
const redirectUri = "https://app.example/auth/github/callback";

function jsonResponse(value: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => value
  } as unknown as Response;
}

test("buildAuthorizeUrl includes client_id, state, and encoded redirect_uri", () => {
  const url = buildAuthorizeUrl(creds, "state-token", redirectUri);
  assert.ok(url.startsWith("https://github.com/login/oauth/authorize?"));
  assert.ok(url.includes("client_id=Iv1.fakeclient"));
  assert.ok(url.includes("state=state-token"));
  assert.ok(url.includes(`redirect_uri=${encodeURIComponent(redirectUri)}`));
  assert.ok(url.includes("allow_signup=true"));
});

test("exchangeCodeForToken returns the access_token from an injected fetch", async () => {
  const fetchFn = (async () => jsonResponse({ access_token: "tok" })) as typeof fetch;
  const token = await exchangeCodeForToken(creds, "the-code", redirectUri, fetchFn);
  assert.equal(token, "tok");
});

test("exchangeCodeForToken rejects on a non-ok response", async () => {
  const fetchFn = (async () => jsonResponse({}, false, 401)) as typeof fetch;
  await assert.rejects(() => exchangeCodeForToken(creds, "the-code", redirectUri, fetchFn));
});

test("exchangeCodeForToken rejects when access_token is missing", async () => {
  const fetchFn = (async () => jsonResponse({ error: "bad_verification_code" })) as typeof fetch;
  await assert.rejects(() => exchangeCodeForToken(creds, "the-code", redirectUri, fetchFn));
});

test("fetchGitHubUser maps the profile and stringifies the id", async () => {
  const fetchFn = (async () =>
    jsonResponse({ id: 42, login: "octo", name: "Octo", avatar_url: "u" })) as typeof fetch;
  const user = await fetchGitHubUser("tok", fetchFn);
  assert.deepEqual(user, { id: "42", login: "octo", name: "Octo", avatarUrl: "u" });
});

test("fetchGitHubUser tolerates a null name", async () => {
  const fetchFn = (async () =>
    jsonResponse({ id: 7, login: "anon", name: null, avatar_url: null })) as typeof fetch;
  const user = await fetchGitHubUser("tok", fetchFn);
  assert.deepEqual(user, { id: "7", login: "anon", name: null, avatarUrl: null });
});

test("fetchGitHubUser rejects on a non-ok response", async () => {
  const fetchFn = (async () => jsonResponse({}, false, 403)) as typeof fetch;
  await assert.rejects(() => fetchGitHubUser("tok", fetchFn));
});
