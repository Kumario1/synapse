import assert from "node:assert/strict";
import test from "node:test";
import { authView } from "./auth";

test("authView maps a null owner to the anon view", () => {
  assert.deepEqual(authView(null), { kind: "anon" });
});

test("authView labels a signed-in owner by login", () => {
  assert.deepEqual(authView({ login: "octo", name: null, avatarUrl: null }), {
    kind: "owner",
    label: "octo"
  });
});
