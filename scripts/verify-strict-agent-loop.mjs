#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProcessTracker,
  freePort,
  postJson,
  waitForHttp,
  waitForState
} from "./lib/verify-harness.mjs";

// Product-level strict loop: two real daemons coordinate through one server,
// using real TS extraction/reporting rather than hand-built state.
const rootDir = join(import.meta.dirname, "..");
const repoId = "strict-agent-loop";
const filePath = "src/auth/token.ts";
const symbol = { raw: "ts:src/auth/token.ts#validate" };
const { startProcess, stopChildren } = createProcessTracker(rootDir);

process.env.OPENROUTER_API_KEY = "";
process.env.SYNAPSE_LLM_EXPLAIN = "0";
process.env.SYNAPSE_LLM_RESOLVE = "0";
process.env.SYNAPSE_RAG = "0";
process.env.SYNAPSE_REPO_ID = repoId;

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const tempRoot = await mkdtemp(join(tmpdir(), "synapse-strict-agent-loop-"));
const aliceRoot = join(tempRoot, "alice");
const bobRoot = join(tempRoot, "bob");

const initialSource = `
export interface Token { value: string; }
export function validate(input: string): boolean {
  return input.length > 0;
}
`;

const aliceSource = `
export interface Token { value: string; }
export function validate(input: string): Token | null {
  return input.length > 0 ? { value: input } : null;
}
`;

const bobSource = `
export interface Token { value: string; }
export function validate(input: string): Promise<Token> {
  return Promise.resolve({ value: input });
}
`;

try {
  await writeFixture(aliceRoot, initialSource);
  await writeFixture(bobRoot, initialSource);

  startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  startDaemon("alice", alicePort, aliceRoot);
  startDaemon("bob", bobPort, bobRoot);
  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`)
  ]);
  await waitForState(serverPort, (state) => state.sessions.length === 2, 5000, repoId);

  const initialCheck = await checkValidate(bobPort);
  assert.equal(initialCheck.verdict, "none");
  assert.equal(initialCheck.conflicts.length, 0);

  const aliceBaseline = await reportFile(alicePort);
  assert.equal(aliceBaseline.ok, true);
  assert.equal(aliceBaseline.deltas.length, 0, "initial Alice report seeds the snapshot only");

  await writeFixture(aliceRoot, aliceSource);
  const aliceReport = await reportFile(alicePort);
  assert.equal(aliceReport.ok, true);
  assert.equal(aliceReport.deltas.length, 1);
  assert.equal(aliceReport.delta.symbolId.raw, symbol.raw);

  await waitForState(
    serverPort,
    (state) =>
      state.unpushedDeltas.filter(
        (delta) => delta.sessionId === "alice" && delta.symbolId.raw === symbol.raw
      ).length === 1,
    5000,
    repoId
  );
  const stateWithAliceDelta = await serverState();
  const aliceDelta = stateWithAliceDelta.unpushedDeltas.find(
    (delta) => delta.sessionId === "alice" && delta.symbolId.raw === symbol.raw
  );
  assert.ok(aliceDelta, "server recorded Alice's unpushed delta");
  assert.match(aliceDelta.before?.raw ?? "", /boolean/);
  assert.match(aliceDelta.after?.raw ?? "", /Token \| null/);

  const briefingWithDelta = await whatsup(bobPort);
  assert.equal(briefingWithDelta.degraded, false);
  assert.equal(briefingWithDelta.sessions.length, 2);
  assert.ok(
    briefingWithDelta.unpushedDeltas.some(
      (delta) => delta.memberLogin === "alice" && delta.symbolId.raw === symbol.raw
    )
  );

  const whyWithDelta = await why(bobPort, "why did validate change?");
  assert.equal(whyWithDelta.degraded, false);
  assert.ok(
    whyWithDelta.sources.some((source) => source.kind === "unpushed_delta"),
    "why cites the live unpushed delta"
  );

  const firstSameSymbol = await checkValidate(bobPort);
  const secondSameSymbol = await checkValidate(bobPort);
  const firstConflict = onlyConflict(firstSameSymbol, "same_symbol_unpushed");
  const secondConflict = onlyConflict(secondSameSymbol, "same_symbol_unpushed");
  assert.equal(firstSameSymbol.verdict, "warn");
  assert.equal(secondSameSymbol.verdict, "warn");
  assert.equal(firstConflict.counterpart.sessionId, "alice");
  assert.equal(secondConflict.counterpart.sessionId, "alice");
  assert.equal(firstConflict.id, secondConflict.id);

  await writeFixture(bobRoot, bobSource);
  const bobReport = await reportFile(bobPort);
  assert.equal(bobReport.ok, true);
  assert.equal(bobReport.deltas.length, 1);
  assert.equal(bobReport.delta.symbolId.raw, symbol.raw);
  await waitForState(
    serverPort,
    (state) =>
      state.unpushedDeltas.filter((delta) => delta.symbolId.raw === symbol.raw).length === 2,
    5000,
    repoId
  );
  const stateWithBobDelta = await serverState();
  const bobDelta = stateWithBobDelta.unpushedDeltas.find(
    (delta) => delta.sessionId === "bob" && delta.symbolId.raw === symbol.raw
  );
  assert.ok(bobDelta, "server recorded Bob's unpushed delta");
  assert.match(bobDelta.after?.raw ?? "", /Promise<Token>/);

  const divergentCheck = await checkValidate(bobPort);
  assert.equal(divergentCheck.verdict, "warn");
  const divergentConflict = onlyConflict(divergentCheck, "contract_divergent");
  assert.equal(divergentConflict.severity, "warn");
  assert.equal(divergentConflict.counterpart.sessionId, "alice");
  assert.match(divergentConflict.change?.after?.raw ?? "", /Token \| null/);
  assert.match(divergentConflict.selfChange?.after?.raw ?? "", /Promise<Token>/);
  assert.match(divergentConflict.detail, /Token \| null/);
  assert.match(divergentConflict.detail, /Promise<Token>/);

  const feedback = await postJson(`http://localhost:${bobPort}/tools/synapse_feedback`, {
    repoId,
    sessionId: "bob",
    conflictId: divergentConflict.id,
    outcome: "acted",
    rule: divergentConflict.rule,
    targetSymbol: divergentConflict.targetSymbol,
    note: "Aligned local work after seeing Alice's contract."
  });
  assert.equal(feedback.ok, true);
  assert.equal(feedback.feedback.conflictId, divergentConflict.id);
  assert.equal(feedback.feedback.outcome, "acted");

  await waitForState(
    serverPort,
    (state) =>
      state.conflictFeedback.length === 1 &&
      state.conflictFeedback[0].conflictId === divergentConflict.id,
    5000,
    repoId
  );

  const push = await postJson(`http://localhost:${alicePort}/tools/synapse_push`, {
    repoId,
    sessionId: "alice",
    sha: "strict-loop-1",
    summary: "Pushed validate Token contract",
    files: [filePath],
    symbols: [symbol]
  });
  assert.deepEqual(push, { ok: true, sha: "strict-loop-1", files: [filePath] });

  await waitForState(
    serverPort,
    (state) => state.unpushedDeltas.every((delta) => delta.symbolId.raw !== symbol.raw),
    5000,
    repoId
  );

  const postPushCheck = await checkValidate(bobPort);
  const postPushRules = postPushCheck.conflicts.map((conflict) => conflict.rule);
  assert.equal(postPushCheck.verdict, "warn");
  assert.ok(postPushRules.includes("stale_base"));
  assert.ok(!postPushRules.includes("same_symbol_unpushed"));
  assert.ok(!postPushRules.includes("contract_divergent"));

  const postPushBriefing = await whatsup(bobPort);
  assert.equal(postPushBriefing.degraded, false);
  assert.equal(postPushBriefing.sessions.length, 2);
  assert.ok(
    postPushBriefing.sessions.every((session) => session.status === "active"),
    "Alice and Bob remain active after push"
  );

  const summary = {
    initialCheck: initialCheck.verdict,
    sameSymbolStableId: firstConflict.id === secondConflict.id,
    divergentConflict: divergentConflict.rule === "contract_divergent",
    feedbackRecorded: feedback.feedback.conflictId === divergentConflict.id,
    pushCleared: postPushRules.every(
      (rule) => rule !== "same_symbol_unpushed" && rule !== "contract_divergent"
    ),
    postPushStaleBase: postPushRules.includes("stale_base")
  };

  assert.deepEqual(summary, {
    initialCheck: "none",
    sameSymbolStableId: true,
    divergentConflict: true,
    feedbackRecorded: true,
    pushCleared: true,
    postPushStaleBase: true
  });

  console.log("Strict agent-loop verification passed:");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await stopChildren();
  await rm(tempRoot, { recursive: true, force: true });
}

function startDaemon(member, port, worktreeRoot) {
  return startProcess(
    member,
    [
      "apps/cli/dist/index.js",
      "daemon",
      "--member",
      member,
      "--session",
      member,
      "--repo-id",
      repoId,
      "--port",
      String(port),
      "--server",
      `ws://localhost:${serverPort}`,
      "--worktree-root",
      worktreeRoot
    ],
    {
      OPENROUTER_API_KEY: "",
      SYNAPSE_LLM_EXPLAIN: "0",
      SYNAPSE_LLM_RESOLVE: "0",
      SYNAPSE_RAG: "0",
      SYNAPSE_REPO_ID: repoId
    }
  );
}

async function writeFixture(worktreeRoot, source) {
  await mkdir(join(worktreeRoot, "src/auth"), { recursive: true });
  await writeFile(join(worktreeRoot, filePath), `${source.trim()}\n`);
}

async function checkValidate(port) {
  return postJson(`http://localhost:${port}/tools/synapse_check`, {
    repoId,
    sessionId: port === bobPort ? "bob" : "alice",
    files: [filePath],
    symbols: [symbol],
    task: "update token validation"
  });
}

async function reportFile(port) {
  return postJson(`http://localhost:${port}/tools/synapse_report`, {
    repoId,
    sessionId: port === bobPort ? "bob" : "alice",
    filePath
  });
}

async function whatsup(port) {
  return postJson(`http://localhost:${port}/tools/synapse_whatsup`, {
    repoId,
    sessionId: "bob"
  });
}

async function why(port, question) {
  return postJson(`http://localhost:${port}/tools/synapse_why`, {
    repoId,
    sessionId: "bob",
    question,
    limit: 5
  });
}

async function serverState() {
  const response = await fetch(`http://localhost:${serverPort}/state?repoId=${repoId}`);
  assert.equal(response.ok, true);
  return response.json();
}

function onlyConflict(check, rule) {
  assert.equal(check.conflicts.length, 1, `${rule} should be the only conflict`);
  assert.equal(check.conflicts[0].rule, rule);
  return check.conflicts[0];
}
