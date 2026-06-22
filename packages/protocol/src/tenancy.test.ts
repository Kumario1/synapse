import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveProjectKey } from "./index.js";

test("deriveProjectKey is deterministic for the same secret and repo", () => {
  assert.equal(deriveProjectKey("s3cret", "repo-a"), deriveProjectKey("s3cret", "repo-a"));
});

test("deriveProjectKey isolates repos: one repo's key never matches another's", () => {
  const secret = "s3cret";
  assert.notEqual(deriveProjectKey(secret, "repo-a"), deriveProjectKey(secret, "repo-b"));
});

test("deriveProjectKey depends on the secret: rotating it changes the key", () => {
  assert.notEqual(deriveProjectKey("old", "repo-a"), deriveProjectKey("new", "repo-a"));
});

test("deriveProjectKey emits url-safe base64 (no +, /, or = padding)", () => {
  const key = deriveProjectKey("s3cret", "repo-a");
  assert.ok(key.length > 0);
  assert.doesNotMatch(key, /[+/=]/);
});

test("deriveProjectKey pins HMAC-SHA256/base64url so CLI mint and server validate cannot drift", () => {
  // Externally computed: base64url(HMAC-SHA256(key="test-secret", msg="repo-a")).
  assert.equal(
    deriveProjectKey("test-secret", "repo-a"),
    "1ddrJoUUN-cBgaBoMf7CjJihmbUT8DJ39Az8sVDeGvE"
  );
});
