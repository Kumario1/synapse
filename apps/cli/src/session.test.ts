import assert from "node:assert/strict";
import test from "node:test";
import { runSession, sessionAction } from "./commands/session.js";

test("sessionAction honors --action", () => {
  assert.equal(sessionAction(["--action", "start"]), "start");
});

test("sessionAction does not use flag values as positional actions", () => {
  assert.equal(sessionAction(["--task", "done", "--action", "end"]), "end");
  assert.equal(sessionAction(["--task", "done"]), "heartbeat");
});

test("sessionAction keeps the positional action form", () => {
  assert.equal(sessionAction(["end", "--task", "done"]), "end");
});

test("sessionAction rejects unknown --action values", () => {
  assert.throws(
    () => sessionAction(["--action", "nope"]),
    /Invalid session action "nope". Expected one of: start, end, heartbeat\./
  );
});

test("runSession posts the --action value", async () => {
  const calls: unknown[] = [];
  const fetch = globalThis.fetch;
  const log = console.log;
  globalThis.fetch = (async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  console.log = () => undefined;

  try {
    await runSession(["--repo-id", "repo", "--session", "s1", "--port", "4011", "--action", "start"]);
  } finally {
    globalThis.fetch = fetch;
    console.log = log;
  }

  assert.deepEqual(calls, [
    { repoId: "repo", sessionId: "s1", action: "start" }
  ]);
});

test("runSession rejects invalid --action before posting", async () => {
  const fetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      runSession(["--repo-id", "repo", "--session", "s1", "--port", "4011", "--action", "nope"]),
      /Invalid session action "nope"/
    );
  } finally {
    globalThis.fetch = fetch;
  }

  assert.equal(called, false);
});
