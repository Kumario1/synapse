import assert from "node:assert/strict";
import test from "node:test";
import { createUserStore } from "./user-store.js";

test("upsertUser is idempotent on id and refreshes mutable fields", async () => {
  const store = await createUserStore({ path: ":memory:" });
  try {
    await store.upsertUser({ id: "42", login: "octo", name: "Octo", avatarUrl: "u1" });
    await store.upsertUser({ id: "42", login: "octocat", name: "Octo Cat", avatarUrl: "u2" });

    const user = await store.getUserById("42");
    assert.deepEqual(user, {
      id: "42",
      login: "octocat",
      name: "Octo Cat",
      avatarUrl: "u2"
    });
  } finally {
    await store.close();
  }
});

test("getUserById returns null for an unknown id", async () => {
  const store = await createUserStore({ path: ":memory:" });
  try {
    assert.equal(await store.getUserById("nope"), null);
  } finally {
    await store.close();
  }
});
