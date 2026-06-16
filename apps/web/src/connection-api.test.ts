import assert from "node:assert/strict";
import test from "node:test";
import { createConnection, deleteConnection, listConnections, updateConnection } from "../lib/connection-api";
import { InMemoryConnectionStore } from "../lib/connection-store";

const sessionA = { user: { id: "user-a" } };
const sessionB = { user: { id: "user-b" } };

test("connection handlers reject unauthenticated requests", async () => {
  const response = await listConnections(new Request("http://local.test/api/connections"), {
    session: null,
    store: new InMemoryConnectionStore()
  });

  assert.equal(response.status, 401);
});

test("connection handlers only expose the authenticated user's rows", async () => {
  const store = new InMemoryConnectionStore();
  const ownedResponse = await createConnection(
    jsonRequest("POST", {
      label: "Owned",
      serverUrl: "wss://owned.example.test",
      repoId: "acme/owned"
    }),
    { session: sessionA, store }
  );
  const otherResponse = await createConnection(
    jsonRequest("POST", {
      label: "Other",
      serverUrl: "wss://other.example.test",
      repoId: "acme/other"
    }),
    { session: sessionB, store }
  );
  const owned = await ownedResponse.json();
  const other = await otherResponse.json();

  const listA = await listConnections(new Request("http://local.test/api/connections"), {
    session: sessionA,
    store
  });
  assert.deepEqual(
    (await listA.json()).map((row: { id: string }) => row.id),
    [owned.id]
  );

  const crossUpdate = await updateConnection(
    jsonRequest("PUT", {
      label: "Changed",
      serverUrl: "wss://changed.example.test",
      repoId: "acme/changed"
    }),
    { id: owned.id, session: sessionB, store }
  );
  assert.equal(crossUpdate.status, 404);

  const crossDelete = await deleteConnection(new Request("http://local.test/api/connections"), {
    id: owned.id,
    session: sessionB,
    store
  });
  assert.equal(crossDelete.status, 404);

  const listB = await listConnections(new Request("http://local.test/api/connections"), {
    session: sessionB,
    store
  });
  assert.deepEqual(
    (await listB.json()).map((row: { id: string }) => row.id),
    [other.id]
  );
});

function jsonRequest(method: string, body: unknown) {
  return new Request("http://local.test/api/connections", {
    method,
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json"
    }
  });
}
