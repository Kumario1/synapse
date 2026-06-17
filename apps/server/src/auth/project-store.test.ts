import assert from "node:assert/strict";
import test from "node:test";
import { createProjectStore } from "./project-store.js";

test("claimProject mints the key once: a repeat claim keeps the original key", async () => {
  const store = await createProjectStore({ path: ":memory:" });
  try {
    const first = await store.claimProject("o1", "a/b", "key-1");
    assert.deepEqual(first, { ownerId: "o1", repoId: "a/b", projectKey: "key-1" });
    const second = await store.claimProject("o1", "a/b", "key-2");
    assert.equal(second.projectKey, "key-1", "repeat claim must keep the original key");
    const stored = await store.getProject("o1", "a/b");
    assert.equal(stored?.projectKey, "key-1");
  } finally {
    await store.close();
  }
});

test("listProjectsForOwner returns only the owner's own projects", async () => {
  const store = await createProjectStore({ path: ":memory:" });
  try {
    await store.claimProject("o1", "a/b", "k1");
    await store.claimProject("o1", "c/d", "k2");
    await store.claimProject("o2", "e/f", "k3");
    const mine = await store.listProjectsForOwner("o1");
    assert.deepEqual(mine.map((p) => p.repoId).sort(), ["a/b", "c/d"]);
    assert.ok(!mine.some((p) => p.repoId === "e/f"));
  } finally {
    await store.close();
  }
});

test("getProject returns null for an unclaimed repo", async () => {
  const store = await createProjectStore({ path: ":memory:" });
  try {
    assert.equal(await store.getProject("o1", "nope/none"), null);
  } finally {
    await store.close();
  }
});
