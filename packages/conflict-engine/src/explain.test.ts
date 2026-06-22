import assert from "node:assert/strict";
import test from "node:test";
import { asActions, parseConflictAnalysis } from "./explain.js";

test("asActions keeps a command that names a known Synapse tool", () => {
  const actions = asActions([
    { audience: "you", step: "ask what alice is doing", command: { tool: "synapse_whatsup" } }
  ]);

  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0]?.command, { tool: "synapse_whatsup" });
});

test("asActions keeps string args alongside a known command", () => {
  const actions = asActions([
    {
      audience: "you",
      step: "ask why validate changed",
      command: { tool: "synapse_why", args: { question: "ts:src/auth/token.ts#validate" } }
    }
  ]);

  assert.deepEqual(actions[0]?.command, {
    tool: "synapse_why",
    args: { question: "ts:src/auth/token.ts#validate" }
  });
});

test("asActions strips a command naming an unknown tool but keeps the step", () => {
  const actions = asActions([
    { audience: "you", step: "do something drastic", command: { tool: "rm_rf_everything" } }
  ]);

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.step, "do something drastic");
  assert.equal(actions[0]?.command, undefined);
});

test("asActions drops non-string args individually, keeping the rest of the command", () => {
  const actions = asActions([
    {
      audience: "you",
      step: "ask why validate changed",
      command: {
        tool: "synapse_why",
        args: { question: "ts:src/auth/token.ts#validate", limit: 5 }
      }
    }
  ]);

  assert.deepEqual(actions[0]?.command, {
    tool: "synapse_why",
    args: { question: "ts:src/auth/token.ts#validate" }
  });
});

test("asActions leaves command absent when null or missing", () => {
  const actions = asActions([
    { audience: "you", step: "explicit null command", command: null },
    { audience: "you", step: "no command field at all" }
  ]);

  assert.equal(actions[0]?.command, undefined);
  assert.equal(actions[1]?.command, undefined);
});

test("parseConflictAnalysis returns null for malformed actions (missing step)", () => {
  const content = JSON.stringify({
    assessment: "alice changed validate",
    recommendation: "warn",
    actions: [{ audience: "you", command: { tool: "synapse_whatsup" } }]
  });

  assert.equal(parseConflictAnalysis(content, "test-model"), null);
});

test("parseConflictAnalysis keeps a validated command on the parsed action", () => {
  const content = JSON.stringify({
    assessment: "alice changed validate",
    recommendation: "warn",
    actions: [
      { audience: "you", step: "see what alice is doing", command: { tool: "synapse_whatsup" } }
    ]
  });

  const analysis = parseConflictAnalysis(content, "test-model");
  assert.equal(analysis?.actions[0]?.command?.tool, "synapse_whatsup");
});
