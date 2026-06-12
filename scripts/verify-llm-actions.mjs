import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Plan 016 (command-grounded LLM actions): a conflict's analysis.actions may
// carry a `command` suggesting a Synapse tool to call next. The allowlist
// (packages/protocol/src/command-catalog.ts) is validated regardless of any
// LLM, but the catalog is only added to the LLM prompt when
// SYNAPSE_LLM_COMMANDS !== "0". This proves, with a deterministic stub LLM
// (no network, no real API key):
//   (a) a model-suggested command naming a known tool passes through with args,
//   (b) a model-suggested command naming an unknown tool is stripped but the
//       step text is kept,
//   (c) command:null on an action stays absent,
//   (d) SYNAPSE_LLM_COMMANDS=0 drops the catalog from the system prompt, and
//   (e) with no API key at all, the deterministic floor still attaches a
//       synapse_whatsup command for an unpushed breaking change.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const filePath = "src/auth/token.ts";
const symbol = "ts:src/auth/token.ts#validate";

const base = `
  export interface Token {
    value: string;
  }

  export interface Result<T> {
    value: T;
  }

  export function validate(input: string): boolean {
    return input.length > 0;
  }
`;

// Alice's unpushed change is a breaking return-type change (boolean -> Token).
const aliceVersion = base.replace(
  "export function validate(input: string): boolean {\n    return input.length > 0;\n  }",
  "export function validate(input: string): Token {\n    return { value: input };\n  }"
);

// (a)/(b)/(c): one action with a valid command, one with an unknown tool, one
// with command:null. Always returned (the daemon may also enrich conflicts in
// the background, ahead of our explicit checks; the cached/served analysis is
// identical either way, so the explicit check's result is deterministic).
const carolStubActions = [
  {
    audience: "you",
    step: "ask why validate changed",
    command: { tool: "synapse_why", args: { question: symbol } }
  },
  {
    audience: "you",
    step: "do something drastic",
    command: { tool: "rm_rf_everything" }
  },
  { audience: "you", step: "no command on this one", command: null }
];

// (d): just needs to be a valid analysis; the assertion is about the
// outgoing prompt (no command catalog), not this response.
const daveStubActions = [{ audience: "you", step: "adopt alice's contract" }];

const carolRequests = [];
const daveRequests = [];
const stubCarol = await startStubLlm(carolRequests, carolStubActions);
const stubDave = await startStubLlm(daveRequests, daveStubActions);
const stubCarolUrl = `http://localhost:${stubCarol.address().port}/v1`;
const stubDaveUrl = `http://localhost:${stubDave.address().port}/v1`;

async function startStubLlm(requests, actions) {
  const server = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push(JSON.parse(body));
      const content = JSON.stringify({
        assessment: "alice changed validate to return Token instead of boolean.",
        recommendation: "warn",
        actions
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const carolPort = await freePort();
const davePort = await freePort();

const aliceRoot = await mkdtemp(join(tmpdir(), "synapse-llm-actions-alice-"));
const bobRoot = await mkdtemp(join(tmpdir(), "synapse-llm-actions-bob-"));
const carolRoot = await mkdtemp(join(tmpdir(), "synapse-llm-actions-carol-"));
const daveRoot = await mkdtemp(join(tmpdir(), "synapse-llm-actions-dave-"));

try {
  for (const root of [aliceRoot, bobRoot, carolRoot, daveRoot]) {
    await writeFixture(root, base);
  }

  const server = startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  const alice = startDaemon("alice", alicePort, aliceRoot, { OPENROUTER_API_KEY: "" });
  // (e) bob: no OPENROUTER_API_KEY at all -> deterministic floor only.
  const bob = startDaemon("bob", bobPort, bobRoot, { OPENROUTER_API_KEY: "" });
  // (a)/(b)/(c) carol: stub LLM, catalog on (default). SYNAPSE_LLM_EXPLAIN is
  // forced back on here in case ci-verify-all.mjs disabled it for hermeticity.
  const carol = startDaemon("carol", carolPort, carolRoot, {
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_BASE_URL: stubCarolUrl,
    SYNAPSE_LLM_MODEL: "stub/stub",
    SYNAPSE_LLM_EXPLAIN: "1"
  });
  // (d) dave: stub LLM, catalog explicitly off.
  const dave = startDaemon("dave", davePort, daveRoot, {
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_BASE_URL: stubDaveUrl,
    SYNAPSE_LLM_MODEL: "stub/stub",
    SYNAPSE_LLM_EXPLAIN: "1",
    SYNAPSE_LLM_COMMANDS: "0"
  });

  await Promise.all(
    [alicePort, bobPort, carolPort, davePort].map((port) => waitForHttp(`http://localhost:${port}/health`))
  );
  await waitForState(serverPort, (state) => state.sessions.length === 4);

  // Baseline snapshot, then alice's breaking change.
  await report(alicePort, "alice");
  await writeFixture(aliceRoot, aliceVersion);
  const aliceReport = await report(alicePort, "alice");
  assert.ok(aliceReport.deltas.some((d) => d.symbolId.raw === symbol), "alice delta on validate");
  await waitForState(serverPort, (state) => state.unpushedDeltas.length === 1);

  // (e) No API key: deterministic floor attaches synapse_whatsup.
  const bobCheck = await checkFileOnly(bobPort, "bob");
  const bobConflict = bobCheck.conflicts.find((c) => c.targetSymbol.raw === symbol);
  assert.ok(bobConflict, "bob sees the same_symbol_unpushed conflict");
  assert.equal(bobConflict.rule, "same_symbol_unpushed");
  assert.equal(bobConflict.analysis?.source, "deterministic");
  const bobYouAction = bobConflict.analysis?.actions.find(
    (action) => action.audience === "you" || action.audience === "both"
  );
  assert.deepEqual(bobYouAction?.command, { tool: "synapse_whatsup" }, "deterministic floor suggests synapse_whatsup");

  // (a)/(b)/(c): carol's stub LLM response actions pass through validation.
  const carolCheck = await checkFileOnly(carolPort, "carol");
  const carolConflict = carolCheck.conflicts.find((c) => c.targetSymbol.raw === symbol);
  assert.ok(carolConflict, "carol sees the same_symbol_unpushed conflict");
  assert.equal(carolConflict.analysis?.source, "stub/stub");
  const carolActions = carolConflict.analysis?.actions ?? [];
  assert.deepEqual(
    carolActions.find((a) => a.step === "ask why validate changed")?.command,
    { tool: "synapse_why", args: { question: symbol } },
    "(a) a known-tool command with args passes through"
  );
  assert.equal(
    carolActions.find((a) => a.step === "do something drastic")?.command,
    undefined,
    "(b) an unknown-tool command is stripped, step kept"
  );
  assert.equal(
    carolActions.find((a) => a.step === "no command on this one")?.command,
    undefined,
    "(c) command:null stays absent"
  );

  // (d): SYNAPSE_LLM_COMMANDS=0 drops the catalog from the prompt.
  const daveCheck = await checkFileOnly(davePort, "dave");
  assert.ok(daveCheck.conflicts.length > 0, "dave sees a conflict and triggers an LLM call");
  assert.ok(carolRequests.length > 0, "carol's daemon called its stub LLM at least once");
  assert.ok(daveRequests.length > 0, "dave's daemon called its stub LLM at least once");

  const carolSystemPrompt = carolRequests[0].messages.find((m) => m.role === "system")?.content ?? "";
  const daveSystemPrompt = daveRequests[0].messages.find((m) => m.role === "system")?.content ?? "";
  assert.ok(carolSystemPrompt.includes("synapse_why("), "carol's prompt includes the command catalog");
  assert.ok(!daveSystemPrompt.includes("synapse_why("), "dave's prompt omits the command catalog");

  console.log("LLM-grounded action verification passed:");
  console.log(
    JSON.stringify(
      {
        deterministicFloorCommand: bobYouAction?.command,
        carolActions,
        catalogInCarolPrompt: carolSystemPrompt.includes("synapse_why("),
        catalogInDavePrompt: daveSystemPrompt.includes("synapse_why(")
      },
      null,
      2
    )
  );

  server.kill();
  alice.kill();
  bob.kill();
  carol.kill();
  dave.kill();
} finally {
  await stopChildren();
  stubCarol.close();
  stubDave.close();
  await Promise.all([aliceRoot, bobRoot, carolRoot, daveRoot].map((root) => rm(root, { recursive: true, force: true })));
}

async function writeFixture(worktreeRoot, source) {
  await mkdir(join(worktreeRoot, "src/auth"), { recursive: true });
  await writeFile(join(worktreeRoot, filePath), `${source.trim()}\n`);
}

function startDaemon(member, port, worktreeRoot, env) {
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
      `ws://localhost:${serverPort}`,
      "--worktree-root",
      worktreeRoot
    ],
    env
  );
}

async function report(port, sessionId) {
  return postJson(`http://localhost:${port}/tools/synapse_report`, {
    repoId: "local",
    sessionId,
    filePath
  });
}

async function checkFileOnly(port, sessionId) {
  return postJson(`http://localhost:${port}/tools/synapse_check`, {
    repoId: "local",
    sessionId,
    files: [filePath]
  });
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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`${url} failed: ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function waitForHttp(url, timeoutMs = 5000) {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => null);
    return response?.ok === true;
  }, timeoutMs);
}

async function waitForState(port, predicate, timeoutMs = 5000) {
  await waitFor(async () => {
    const response = await fetch(`http://localhost:${port}/state?repoId=local`).catch(() => null);
    if (!response?.ok) {
      return false;
    }

    return predicate(await response.json());
  }, timeoutMs);
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
