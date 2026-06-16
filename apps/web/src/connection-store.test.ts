import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryConnectionStore } from "../lib/connection-store";

const input = {
  label: "Staging room",
  serverUrl: "wss://synapse.example.test",
  repoId: "acme/widgets"
};

test("ConnectionStore CRUD round-trips against the in-memory backend", async () => {
  const store = new InMemoryConnectionStore();
  const created = await store.create("user-a", input);

  assert.equal(created.label, input.label);
  assert.equal(created.serverUrl, input.serverUrl);
  assert.equal(created.repoId, input.repoId);
  assert.equal(created.userId, "user-a");
  assert.equal((await store.list("user-a")).length, 1);
  assert.deepEqual(await store.get("user-a", created.id), created);

  const updated = await store.update("user-a", created.id, {
    label: "Production room",
    serverUrl: "wss://prod.example.test",
    repoId: "acme/prod"
  });

  assert.ok(updated);
  assert.equal(updated.label, "Production room");
  assert.equal(updated.createdAt, created.createdAt);
  assert.notEqual(updated.updatedAt, "");

  assert.equal(await store.delete("user-a", created.id), true);
  assert.deepEqual(await store.list("user-a"), []);
});

test("ConnectionStore scopes list/get/update/delete by account", async () => {
  const store = new InMemoryConnectionStore();
  const owned = await store.create("user-a", input);
  await store.create("user-b", {
    label: "Other room",
    serverUrl: "wss://other.example.test",
    repoId: "acme/other"
  });

  assert.deepEqual(
    (await store.list("user-a")).map((row) => row.id),
    [owned.id]
  );
  assert.equal(await store.get("user-b", owned.id), null);
  assert.equal(
    await store.update("user-b", owned.id, {
      label: "Stolen",
      serverUrl: "wss://stolen.example.test",
      repoId: "acme/stolen"
    }),
    null
  );
  assert.equal(await store.delete("user-b", owned.id), false);
  assert.ok(await store.get("user-a", owned.id), "owner can still read the row");
});
