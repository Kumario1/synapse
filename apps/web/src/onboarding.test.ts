import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTALL_COMMAND,
  daemonCommand,
  isRoomConnected,
  serverWsUrl
} from "./onboarding";

test("INSTALL_COMMAND is the global npm install", () => {
  assert.equal(INSTALL_COMMAND, "npm install -g @kumario/synapse");
});

test("serverWsUrl converts https to wss", () => {
  assert.equal(serverWsUrl("https://app.example"), "wss://app.example");
});

test("serverWsUrl converts http to ws", () => {
  assert.equal(serverWsUrl("http://localhost:4010"), "ws://localhost:4010");
});

test("daemonCommand renders the exact start command", () => {
  assert.equal(
    daemonCommand({ repoId: "o/r", projectKey: "KEY" }, "wss://h"),
    "SYNAPSE_PROJECT_KEY=KEY synapse up --server wss://h --repo-id o/r"
  );
});

test("isRoomConnected is true when a session is present", () => {
  assert.equal(isRoomConnected({ sessions: [{}] }), true);
});

test("isRoomConnected is false for an empty session list", () => {
  assert.equal(isRoomConnected({ sessions: [] }), false);
});

test("isRoomConnected is false for null", () => {
  assert.equal(isRoomConnected(null), false);
});

test("isRoomConnected is false when sessions is absent", () => {
  assert.equal(isRoomConnected({}), false);
});
