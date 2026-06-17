import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCookies,
  serializeCookie,
  sessionKeyFromClientSecret,
  signSession,
  verifySession
} from "./session.js";

const key = sessionKeyFromClientSecret("fake-client-secret");

test("sign then verify round-trips the same userId", () => {
  const token = signSession("user-42", key);
  assert.deepEqual(verifySession(token, key), { userId: "user-42" });
});

test("a tampered token does not verify", () => {
  const token = signSession("user-42", key);
  const tampered = `${token}x`;
  assert.equal(verifySession(tampered, key), null);
});

test("a token signed with another key does not verify", () => {
  const other = sessionKeyFromClientSecret("different-secret");
  const token = signSession("user-42", other);
  assert.equal(verifySession(token, key), null);
});

test("an expired token does not verify", () => {
  const expired = signSession("user-42", key, Date.now() - 40 * 86400000);
  assert.equal(verifySession(expired, key), null);
});

test("missing and malformed tokens return null without throwing", () => {
  assert.equal(verifySession(undefined, key), null);
  assert.equal(verifySession("", key), null);
  assert.equal(verifySession("no-dot", key), null);
  assert.equal(verifySession(".onlysig", key), null);
  assert.equal(verifySession("onlypayload.", key), null);
});

test("parseCookies and serializeCookie round-trip a value", () => {
  const cookie = serializeCookie("synapse_session", "abc.def", {
    maxAgeSec: 3600,
    httpOnly: true,
    sameSite: "Lax",
    path: "/"
  });
  assert.ok(cookie.startsWith("synapse_session=abc.def"));
  assert.ok(cookie.includes("HttpOnly"));
  assert.ok(cookie.includes("SameSite=Lax"));
  assert.ok(cookie.includes("Max-Age=3600"));

  const parsed = parseCookies("synapse_session=abc.def; other=1");
  assert.equal(parsed.synapse_session, "abc.def");
  assert.equal(parsed.other, "1");
});

test("serializeCookie url-encodes and parseCookies decodes", () => {
  const cookie = serializeCookie("k", "a b/c", {});
  const parsed = parseCookies(cookie.split(";")[0]);
  assert.equal(parsed.k, "a b/c");
});
