import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyStateOp,
  createEmptyTeamState,
  PROTOCOL_VERSION,
  type ContractDelta,
  type ResolutionProposal,
  type StateOp
} from "./index.js";
import { parseClientMessage, parseServerMessage } from "./wire-schema.js";

const base = { v: PROTOCOL_VERSION, id: "msg-1", ts: new Date().toISOString() };

const validDelta: ContractDelta = {
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

const validProposal: ResolutionProposal = {
  id: "rp:ts:src/auth/token.ts#validate:alice:bob",
  repoId: "local",
  symbol: validDelta.symbolId,
  conflictClass: "mechanical",
  before: validDelta.before,
  after: validDelta.after,
  status: "resolving",
  directions: [
    {
      sessionId: "alice",
      role: "keep",
      summary: "Keep your change to ts:src/auth/token.ts#validate.",
      affectedSites: []
    },
    {
      sessionId: "bob",
      role: "adapt",
      summary: "Update 1 call-site(s) to match ts:src/auth/token.ts#validate's new signature.",
      affectedSites: [
        { symbolId: { raw: "ts:src/auth/login.ts#login" }, filePath: "src/auth/login.ts" }
      ]
    }
  ],
  acceptedBy: [],
  createdAt: base.ts
};

test("wire schema literal stays in lockstep with PROTOCOL_VERSION", () => {
  // wire-schema.ts pins the supported version range literally to avoid a
  // runtime import cycle; this fails if the protocol moves without the schema.
  assert.equal(PROTOCOL_VERSION, 2);
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
    {
      ...base,
      type: "session.heartbeat",
      payload: { repoId: "local", sessionId: "alice", branch: "feature-x" }
    },
    {
      ...base,
      type: "session.heartbeat",
      payload: { repoId: "local", sessionId: "alice", task: "add JWT refresh" }
    },
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
    {
      ...base,
      type: "repo.event",
      payload: {
        repoId: "local",
        kind: "issue_comment",
        action: "created",
        actor: "bob",
        title: "t",
        summary: "s",
        detail: "Decision: keep HMAC project keys."
      }
    },
    {
      ...base,
      type: "resolution.ack",
      payload: {
        repoId: "local",
        sessionId: "alice",
        proposalId: validProposal.id,
        accept: true
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
      value: {
        ...base,
        type: "repo.event",
        payload: {
          repoId: "local",
          kind: "issue_comment",
          action: "created",
          actor: "bob",
          title: "t",
          summary: "s",
          detail: "x".repeat(2001)
        }
      },
      label: "repo event detail over the 2000-char cap"
    },
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
    payload: { teamState: createEmptyTeamState("local"), seq: 1 }
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
});

test("accepts mediator proposals in server snapshots", () => {
  const result = parseServerMessage({
    ...base,
    type: "state.snapshot",
    payload: {
      teamState: {
        ...createEmptyTeamState("local"),
        resolutionProposals: [validProposal]
      },
      seq: 2
    }
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
});

test("accepts valid server deltas", () => {
  const result = parseServerMessage({
    ...base,
    type: "state.delta",
    payload: {
      repoId: "local",
      seq: 2,
      ops: [
        {
          op: "upsertDelta",
          delta: validDelta
        }
      ]
    }
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
});

test("accepts downgraded v1 envelopes for compatibility", () => {
  const result = parseServerMessage({
    ...base,
    v: 1,
    type: "state.snapshot",
    payload: { teamState: createEmptyTeamState("local") }
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
});

test("applies state ops to converge with an equivalent snapshot", () => {
  const state = createEmptyTeamState("local");
  const session = {
    id: "alice",
    repoId: "local",
    memberId: "alice",
    agentType: "claude-code" as const,
    filesOpen: [],
    filesEditing: [],
    lastTask: null,
    startedAt: base.ts,
    lastSeen: base.ts,
    status: "active" as const
  };
  const ops: StateOp[] = [
    { op: "upsertSession", session },
    {
      op: "upsertEditLock",
      lock: {
        symbolId: { raw: "ts:a.ts#f" },
        filePath: "a.ts",
        sessionId: "alice",
        acquiredAt: base.ts,
        ttlSec: 90
      }
    },
    { op: "upsertDelta", delta: validDelta },
    {
      op: "appendPush",
      push: {
        id: "push-1",
        repoId: "local",
        memberId: "alice",
        summary: "pushed",
        filesAffected: ["a.ts"],
        sha: "abc",
        pushedAt: base.ts
      },
      cap: 50
    },
    { op: "deleteEditLock", sessionId: "alice", symbolRaw: "ts:a.ts#f" }
  ];

  for (const op of ops) {
    applyStateOp(state, op);
  }

  assert.deepEqual(state, {
    ...createEmptyTeamState("local"),
    sessions: [session],
    unpushedDeltas: [validDelta],
    recentPushes: [
      {
        id: "push-1",
        repoId: "local",
        memberId: "alice",
        summary: "pushed",
        filesAffected: ["a.ts"],
        sha: "abc",
        pushedAt: base.ts
      }
    ]
  });
});

test("accepts valid server acks", () => {
  const result = parseServerMessage({
    ...base,
    type: "ack",
    payload: { forId: "msg-1", ok: false, error: "rate_limited" }
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
});

test("round-trips an ack carrying peer edit locks", () => {
  const lock = {
    symbolId: { raw: "ts:src/widget.ts#area" },
    filePath: "src/widget.ts",
    sessionId: "alice",
    acquiredAt: base.ts,
    ttlSec: 90
  };
  const result = parseServerMessage({
    ...base,
    type: "ack",
    payload: { forId: "msg-1", ok: true, locks: [lock] }
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (result.ok && result.message.type === "ack") {
    assert.deepEqual(result.message.payload.locks, [lock]);
  }
});

test("accepts an ack without locks", () => {
  const result = parseServerMessage({
    ...base,
    type: "ack",
    payload: { forId: "msg-1", ok: true }
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (result.ok && result.message.type === "ack") {
    assert.equal(result.message.payload.locks, undefined);
  }
});

test("rejects malformed server messages with a path-bearing error", () => {
  const cases = [
    { value: { ...base, type: "no.such.type", payload: {} }, label: "unknown type" },
    { value: { ...base, type: "state.snapshot", payload: {} }, label: "missing teamState" },
    {
      value: { ...base, type: "state.delta", payload: { repoId: "local", seq: 1, ops: [{}] } },
      label: "invalid state op"
    },
    {
      value: { ...base, type: "state.delta", payload: { repoId: "local", seq: 1 } },
      label: "missing state ops"
    }
  ];

  for (const { value, label } of cases) {
    const result = parseServerMessage(value);
    assert.equal(result.ok, false, `${label} must be rejected`);
    if (!result.ok) {
      assert.match(result.error, /invalid_message/, `${label} carries the error prefix`);
    }
  }
});
