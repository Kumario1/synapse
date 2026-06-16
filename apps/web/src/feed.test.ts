import assert from "node:assert/strict";
import test from "node:test";
import { buildSocketUrl, resolveLiveFeedConfig, type LiveFeedConnection } from "./feed";

const connection: LiveFeedConnection = {
  id: "conn-1",
  serverUrl: "wss://synapse.example.test/live",
  repoId: "acme/widgets"
};

test("resolveLiveFeedConfig composes a live feed config when a credential is present", () => {
  assert.deepEqual(resolveLiveFeedConfig({ connection, token: "server-secret" }), {
    server: "wss://synapse.example.test/live",
    repoId: "acme/widgets",
    token: "server-secret"
  });
});

test("resolveLiveFeedConfig asks for a credential when none is stored", () => {
  assert.deepEqual(resolveLiveFeedConfig({ connection, token: null }), { needsToken: true });
});

test("buildSocketUrl appends repo id and optional credential", () => {
  assert.equal(
    buildSocketUrl({
      server: "wss://synapse.example.test/room",
      repoId: "acme/widgets",
      token: "server-secret"
    }),
    "wss://synapse.example.test/room?repoId=acme%2Fwidgets&token=server-secret"
  );

  assert.equal(
    buildSocketUrl({
      server: "wss://synapse.example.test/room?existing=1",
      repoId: "acme/widgets",
      token: null
    }),
    "wss://synapse.example.test/room?existing=1&repoId=acme%2Fwidgets"
  );
});
