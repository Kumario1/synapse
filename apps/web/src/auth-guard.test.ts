import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationRequired, requireUser } from "../lib/auth-guard";

test("requireUser returns a stable user id from an authenticated session", () => {
  assert.deepEqual(requireUser({ user: { id: "12345" } }), { userId: "12345" });
});

test("requireUser raises a redirect signal for an unauthenticated session", () => {
  assert.throws(() => requireUser(null), AuthenticationRequired);
  assert.throws(() => requireUser({ user: {} }), AuthenticationRequired);
});
