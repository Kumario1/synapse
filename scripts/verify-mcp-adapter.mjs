import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Hermetic: pin the coordination room so git-remote derivation does not pick up the host repo.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const filePath = "src/auth/token.ts";
const symbol = "ts:src/auth/token.ts#TokenValidator.validate";

let client = null;

try {
  const server = startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });

  await waitForHttp(`http://localhost:${serverPort}/health`);

  const alice = startDaemon("alice", alicePort);
  const bob = startDaemon("bob", bobPort);

  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`)
  ]);
  await waitForState(serverPort, (state) => state.sessions.length === 2);

  client = new Client({ name: "synapse-mcp-verifier", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["apps/cli/dist/index.js", "mcp", "--port", String(bobPort)],
    cwd: rootDir,
    env: process.env,
    stderr: "pipe"
  });
  transport.stderr?.on("data", (chunk) => {
    process.stderr.write(`[mcp] ${chunk}`);
  });
  await client.connect(transport);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
      "synapse_check",
      "synapse_feedback",
      "synapse_insights",
      "synapse_onboard",
      "synapse_pr_brief",
      "synapse_push",
      "synapse_report",
      "synapse_session",
      "synapse_whatsup",
      "synapse_why"
    ]
  );

  const resources = await client.listResources();
  assert.deepEqual(
    resources.resources.map((resource) => resource.uri).sort(),
    [
      "synapse://briefing",
      "synapse://contracts",
      "synapse://decisions",
      "synapse://pr-brief",
      "synapse://team-state"
    ]
  );
  assert.ok(
    resources.resources.every((resource) => resource.mimeType === "application/json"),
    "Synapse context resources should be JSON"
  );

  const session = await callJson(client, "synapse_session", {
    port: bobPort,
    sessionId: "bob",
    action: "heartbeat"
  });
  assert.deepEqual(session, { sessionId: "bob" });

  const report = await callJson(client, "synapse_report", {
    port: alicePort,
    sessionId: "alice",
    filePath,
    symbol,
    summary: "TokenValidator.validate now returns Result<Token, AuthError>"
  });
  assert.equal(report.ok, true);
  assert.equal(report.delta.symbolId.raw, symbol);

  await waitForState(serverPort, (state) => state.unpushedDeltas.length === 1);

  const briefing = await callJson(client, "synapse_whatsup", {
    port: bobPort,
    sessionId: "bob"
  });
  assert.equal(briefing.degraded, false);
  assert.equal(briefing.unpushedDeltas.length, 1);
  assert.equal(briefing.unpushedDeltas[0].symbolId.raw, symbol);

  const why = await callJson(client, "synapse_why", {
    port: bobPort,
    sessionId: "bob",
    question: "why did token validation change?"
  });
  assert.equal(why.degraded, false);
  assert.ok(why.answer.includes("TokenValidator.validate"));
  assert.ok(why.sources.some((source) => source.kind === "unpushed_delta"));

  const prBrief = await callJson(client, "synapse_pr_brief", {
    port: bobPort,
    sessionId: "bob",
    base: "main",
    head: "feature/auth"
  });
  assert.equal(prBrief.degraded, false);
  assert.equal(prBrief.base, "main");
  assert.equal(prBrief.head, "feature/auth");
  assert.ok(prBrief.briefing.includes("TokenValidator.validate"));

  const resourceReads = {
    briefing: await readJsonResource(client, "synapse://briefing"),
    contracts: await readJsonResource(client, "synapse://contracts"),
    teamState: await readJsonResource(client, "synapse://team-state"),
    decisions: await readJsonResource(client, "synapse://decisions"),
    prBrief: await readJsonResource(client, "synapse://pr-brief")
  };
  assert.equal(resourceReads.briefing.kind, "synapse_briefing");
  assert.equal(resourceReads.briefing.tool, "synapse_onboard");
  assert.equal(resourceReads.briefing.context.degraded, false);
  assert.ok(resourceReads.briefing.context.briefing.includes("TokenValidator.validate"));
  assert.ok(
    resourceReads.briefing.context.sections.decisions.some(
      (source) => source.kind === "unpushed_delta" && source.summary.includes("TokenValidator.validate")
    )
  );

  assert.equal(resourceReads.contracts.kind, "synapse_contract_surface");
  assert.equal(resourceReads.contracts.scope, "public");
  assert.ok(Array.isArray(resourceReads.contracts.symbols));
  assert.ok(resourceReads.contracts.symbols.length > 0);
  assert.ok(
    resourceReads.contracts.symbols.some(
      (symbol) =>
        typeof symbol.id === "string" &&
        typeof symbol.name === "string" &&
        ("signature" in symbol || typeof symbol.filePath === "string")
    )
  );

  assert.equal(resourceReads.teamState.kind, "synapse_team_state");
  assert.equal(resourceReads.teamState.tool, "synapse_whatsup");
  assert.equal(resourceReads.teamState.context.degraded, false);
  assert.equal(resourceReads.teamState.context.unpushedDeltas.length, 1);
  assert.equal(resourceReads.teamState.context.unpushedDeltas[0].symbolId.raw, symbol);

  assert.equal(resourceReads.decisions.kind, "synapse_decisions");
  assert.equal(resourceReads.decisions.tool, "synapse_onboard");
  assert.equal(resourceReads.decisions.context.degraded, false);
  assert.ok(
    resourceReads.decisions.context.sections.decisions.some(
      (source) => source.kind === "unpushed_delta" && source.summary.includes("TokenValidator.validate")
    )
  );

  assert.equal(resourceReads.prBrief.kind, "synapse_pr_brief");
  assert.equal(resourceReads.prBrief.tool, "synapse_pr_brief");
  assert.equal(resourceReads.prBrief.context.degraded, false);
  assert.ok(resourceReads.prBrief.context.briefing.includes("TokenValidator.validate"));

  const check = await callJson(client, "synapse_check", {
    port: bobPort,
    sessionId: "bob",
    file: filePath,
    symbol
  });
  assert.equal(check.verdict, "warn");
  assert.deepEqual(
    check.conflicts.map((conflict) => conflict.rule),
    ["same_symbol_unpushed"]
  );

  const feedback = await callJson(client, "synapse_feedback", {
    port: bobPort,
    sessionId: "bob",
    conflictId: check.conflicts[0].id,
    outcome: "acted",
    rule: check.conflicts[0].rule,
    targetSymbol: check.conflicts[0].targetSymbol,
    note: "Adjusted via MCP feedback."
  });
  assert.equal(feedback.ok, true);
  assert.equal(feedback.feedback.conflictId, check.conflicts[0].id);
  assert.equal(feedback.feedback.outcome, "acted");
  await waitForState(
    serverPort,
    (state) =>
      state.conflictFeedback.length === 1 &&
      state.conflictFeedback[0].conflictId === check.conflicts[0].id
  );

  const insights = await callJson(client, "synapse_insights", {
    port: bobPort,
    sessionId: "bob"
  });
  assert.equal(insights.degraded, false);
  assert.equal(insights.totals.feedback, 1);
  assert.equal(insights.totals.acted, 1);
  assert.equal(insights.topRulesByFeedback[0].name, "same_symbol_unpushed");
  assert.equal(insights.topRulesByFeedback[0].count, 1);

  const push = await callJson(client, "synapse_push", {
    port: alicePort,
    sessionId: "alice",
    sha: "mcp123",
    summary: "Pushed auth token changes through MCP",
    file: filePath,
    symbol
  });
  assert.deepEqual(push, { ok: true, sha: "mcp123", files: [filePath] });

  const stateAfterPush = await waitForState(
    serverPort,
    (state) =>
      state.unpushedDeltas.length === 0 &&
      state.editLocks.length === 0 &&
      state.recentPushes.length === 1
  );

  console.log("MCP adapter verification passed:");
  console.log(
    JSON.stringify(
      {
        tools: tools.tools.map((tool) => tool.name),
        resources: resources.resources.map((resource) => resource.uri),
        resourceReads,
        briefing,
        why,
        check,
        feedback,
        insights,
        stateAfterPush
      },
      null,
      2
    )
  );

  await client.close();
  client = null;
  server.kill();
  alice.kill();
  bob.kill();
} finally {
  if (client) {
    await client.close().catch(() => {});
  }
  await stopChildren();
}

function startDaemon(member, port) {
  return startProcess(
    member,
    [
      "apps/cli/dist/index.js",
      "daemon",
      "--member",
      member,
      "--session",
      member,
      "--port",
      String(port),
      "--server",
      `ws://localhost:${serverPort}`
    ],
    {}
  );
}

async function callJson(mcpClient, name, args) {
  const result = await mcpClient.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, `${name} returned MCP error`);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

async function readJsonResource(mcpClient, uri) {
  const result = await mcpClient.readResource({ uri });
  assert.equal(result.contents.length, 1);
  assert.equal(result.contents[0].uri, uri);
  assert.equal(result.contents[0].mimeType, "application/json");
  assert.equal(typeof result.contents[0].text, "string");
  assert.ok(result.contents[0].text.trim().length > 0);
  return JSON.parse(result.contents[0].text);
}

function startProcess(label, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  children.push(child);

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });

  child.once("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      process.stderr.write(`[${label}] exited with code ${code ?? signal}\n`);
    }
  });

  return child;
}

async function waitForHttp(url, timeoutMs = 5000) {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => null);
    return response?.ok === true;
  }, timeoutMs);
}

async function waitForState(port, predicate, timeoutMs = 5000) {
  let lastState = null;

  await waitFor(async () => {
    const response = await fetch(`http://localhost:${port}/state?repoId=local`).catch(() => null);
    if (!response?.ok) {
      return false;
    }

    lastState = await response.json();
    return predicate(lastState);
  }, timeoutMs);

  return lastState;
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function stopChildren() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }

          child.once("exit", resolve);
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
          }, 1000).unref();
        })
    )
  );
}
