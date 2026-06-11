import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmptyTeamState, PROTOCOL_VERSION } from "./index.js";
import { parseClientMessage, parseServerMessage } from "./wire-schema.js";

const base = { v: PROTOCOL_VERSION, id: "msg-1", ts: new Date().toISOString() };

const validDelta = {
  id: "delta-1",
  repoId: "local",
  sessionId: "alice",
  symbolId: { raw: "ts:src/auth/token.ts#validate" },
  changeKind: "signature_changed",
  before: { params: [], returns: "boolean", raw: "(input: string): boolean" },
  after: { params: [], returns: "Token | null", raw: "(input: string): Token | null" },
  summary: "validate now returns Token | null",
  filePath: "src/auth/token.ts",
  baseSha: "abc123",
  dependents: [{ raw: "ts:src/auth/login.ts#login" }],
  createdAt: new Date().toISOString(),
  pushedAt: null
};

test("wire schema literal stays in lockstep with PROTOCOL_VERSION", () => {
  // wire-schema.ts pins the version literally to avoid a runtime import cycle;
  // this test fails the moment PROTOCOL_VERSION moves without it.
  assert.equal(PROTOCOL_VERSION, 1);
});

test("accepts every well-formed message type the daemon sends", () => {
  const messages = [
    {
      ...base,
      type: "session.start",
      payload: {
        session: {
          id: "alice",
          repoId: "local",
          memberId: "alice",
          agentType: "claude-code",
          filesOpen: [],
          filesEditing: [],
          lastTask: null,
          startedAt: base.ts,
          lastSeen: base.ts,
          status: "active"
        }
      }
    },
    { ...base, type: "session.heartbeat", payload: { repoId: "local", sessionId: "alice" } },
    { ...base, type: "session.end", payload: { repoId: "local", sessionId: "alice" } },
    {
      ...base,
      type: "edit.intent",
      payload: {
        repoId: "local",
        sessionId: "alice",
        symbolId: { raw: "ts:a.ts#f" },
        filePath: "a.ts"
      }
    },
    { ...base, type: "contract.delta", payload: { delta: validDelta } },
    {
      ...base,
      type: "push.notify",
      payload: { repoId: "local", memberId: "alice", sha: "abc", summary: "s", files: ["a.ts"] }
    },
    {
      ...base,
      type: "repo.event",
      payload: {
        repoId: "local",
        kind: "pull_request",
        action: "opened",
        actor: "alice",
        title: "t",
        summary: "s"
      }
    },
    { ...base, type: "query.briefing", payload: { repoId: "local" } }
  ];

  for (const message of messages) {
    const result = parseClientMessage(message);
    assert.equal(result.ok, true, `${message.type}: ${result.ok ? "" : result.error}`);
  }
});

test("tolerates unknown extra fields (forward compatibility)", () => {
  const result = parseClientMessage({
    ...base,
    type: "session.heartbeat",
    futureField: "yes",
    payload: { repoId: "local", sessionId: "alice", alsoNew: 42 }
  });
  assert.equal(result.ok, true);
});

test("rejects malformed messages with a path-bearing error", () => {
  const cases = [
    { value: null, label: "null" },
    { value: "a string", label: "non-object" },
    { value: { ...base, type: "no.such.type", payload: {} }, label: "unknown type" },
    { value: { ...base, type: "session.heartbeat", payload: {} }, label: "missing payload fields" },
    {
      value: { ...base, type: "contract.delta", payload: { delta: { ...validDelta, symbolId: {} } } },
      label: "delta without a symbol id"
    },
    {
      value: { ...base, v: 99, type: "query.briefing", payload: { repoId: "local" } },
      label: "wrong protocol version"
    },
    {
      value: {
        ...base,
        type: "push.notify",
        payload: { repoId: "local", memberId: "a", sha: "x", summary: "s", files: "not-an-array" }
      },
      label: "files as a string"
    }
  ];

  for (const { value, label } of cases) {
    const result = parseClientMessage(value);
    assert.equal(result.ok, false, `${label} must be rejected`);
    if (!result.ok) {
      assert.match(result.error, /invalid_message/, `${label} carries the error prefix`);
    }
  }
});

test("accepts valid server snapshots", () => {
  const result = parseServerMessage({
    ...base,
    type: "state.snapshot",
    payload: { teamState: createEmptyTeamState("local") }
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
});

test("accepts valid server acks", () => {
  const result = parseServerMessage({
    ...base,
    type: "ack",
    payload: { forId: "msg-1", ok: false, error: "rate_limited" }
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
});

test("rejects malformed server messages with a path-bearing error", () => {
  const cases = [
    { value: { ...base, type: "no.such.type", payload: {} }, label: "unknown type" },
    { value: { ...base, type: "state.snapshot", payload: {} }, label: "missing teamState" }
  ];

  for (const { value, label } of cases) {
    const result = parseServerMessage(value);
    assert.equal(result.ok, false, `${label} must be rejected`);
    if (!result.ok) {
      assert.match(result.error, /invalid_message/, `${label} carries the error prefix`);
    }
  }
});
