import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end Layer II session-start briefing: with a teammate's unpushed change
// and a recent push in shared state, the `synapse hook session-start` command
// (invoked exactly as Claude Code does) returns a catch-up as SessionStart
// context — and excludes the reader's own work. Fully deterministic.
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(rootDir, "apps/cli/dist/index.js");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const aliceRoot = await mkdtemp(join(tmpdir(), "synapse-ss-alice-"));
const bobRoot = await mkdtemp(join(tmpdir(), "synapse-ss-bob-"));

const aliceFile = "src/auth/token.ts";
const aliceSymbol = "ts:src/auth/token.ts#validate";
const bobFile = "src/util/other.ts";
const bobSymbol = "ts:src/util/other.ts#foo";

try {
  await writeFile2(aliceRoot, aliceFile, "export function validate(input: string): boolean { return !!input; }");
  await writeFile2(bobRoot, bobFile, "export function foo(a: string): string { return a; }");
  await writeLocalConfig(aliceRoot, alicePort, "alice");
  await writeLocalConfig(bobRoot, bobPort, "bob");

  startProcess("server", ["apps/server/dist/index.js"], { SYNAPSE_SERVER_PORT: String(serverPort) });
  await waitForHttp(`http://localhost:${serverPort}/health`);
  startDaemon("alice", alicePort, aliceRoot);
  startDaemon("bob", bobPort, bobRoot);
  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`)
  ]);
  await waitForState(serverPort, (s) => s.sessions.length === 2);

  // Alice changes validate (teammate's unpushed change), Bob changes his own foo.
  await report(alicePort, "alice", aliceFile);
  await writeFile2(aliceRoot, aliceFile, "export function validate(input: string): string { return input; }");
  await report(alicePort, "alice", aliceFile);

  await report(bobPort, "bob", bobFile);
  await writeFile2(bobRoot, bobFile, "export function foo(a: number): number { return a; }");
  await report(bobPort, "bob", bobFile);

  // A recent push lands too.
  await pushWebhook();

  await waitForState(
    serverPort,
    (s) =>
      s.unpushedDeltas.some((d) => d.symbolId.raw === aliceSymbol) &&
      s.unpushedDeltas.some((d) => d.symbolId.raw === bobSymbol) &&
      s.recentPushes.length >= 1
  );
  // Bob's daemon cache must reflect the shared state before it briefs.
  await waitForDaemonState(
    bobPort,
    (s) => s.unpushedDeltas.some((d) => d.symbolId.raw === aliceSymbol) && s.recentPushes.length >= 1
  );

  // Invoke Bob's SessionStart hook exactly as Claude Code would.
  const out = await runSessionStartHook(bobRoot);
  assert.ok(out, "session-start hook emitted a briefing");
  const context = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(context.includes("Synapse catch-up"), "briefing has a heading");
  assert.ok(context.includes(aliceSymbol), "briefing surfaces alice's unpushed change");
  assert.ok(context.includes("alice"), "briefing names the teammate");
  assert.ok(context.includes("Recent pushes"), "briefing surfaces the recent push");
  assert.ok(!context.includes(bobSymbol), "briefing excludes the reader's own change");

  console.log("Session-start briefing verification passed:\n");
  console.log(context);
} finally {
  await stopChildren();
  await Promise.all([
    rm(aliceRoot, { recursive: true, force: true }),
    rm(bobRoot, { recursive: true, force: true })
  ]);
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
      "--port",
      String(port),
      "--server",
      `ws://localhost:${serverPort}`,
      "--worktree-root",
      worktreeRoot
    ],
    {}
  );
}

async function writeFile2(worktreeRoot, relativePath, source) {
  const full = join(worktreeRoot, relativePath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, `${source}\n`);
}

async function writeLocalConfig(worktreeRoot, port, sessionId) {
  await mkdir(join(worktreeRoot, ".synapse"), { recursive: true });
  await writeFile(
    join(worktreeRoot, ".synapse/config.json"),
    JSON.stringify({ repoId: "local", daemonPort: port, sessionId, member: sessionId, worktreeRoot }, null, 2)
  );
}

async function report(port, sessionId, filePath) {
  return postJson(`http://localhost:${port}/tools/synapse_report`, { repoId: "local", sessionId, filePath });
}

async function pushWebhook() {
  const payload = {
    after: "deadbeef",
    repository: { full_name: "acme/widgets" },
    sender: { login: "carol" },
    head_commit: { message: "Ship the config loader" },
    commits: [{ modified: ["src/config.ts"], added: [], removed: [] }]
  };
  return postJson(`http://localhost:${serverPort}/webhooks/github?repoId=local`, payload, {
    "x-github-event": "push"
  });
}

function runSessionStartHook(worktreeRoot) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, "hook", "session-start"], {
      cwd: worktreeRoot,
      env: { ...process.env, INIT_CWD: worktreeRoot },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`hook session-start exited ${code}: ${stderr}`));
        return;
      }
      const trimmed = stdout.trim();
      resolvePromise(trimmed ? JSON.parse(trimmed) : null);
    });
    child.stdin.end(
      JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: worktreeRoot })
    );
  });
}

function startProcess(label, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  child.once("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      process.stderr.write(`[${label}] exited with code ${code ?? signal}\n`);
    }
  });
  return child;
}

async function postJson(url, body, extraHeaders = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
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

async function waitForState(port, predicate, timeoutMs = 8000) {
  await waitFor(async () => {
    const response = await fetch(`http://localhost:${port}/state?repoId=local`).catch(() => null);
    if (!response?.ok) {
      return false;
    }
    return predicate(await response.json());
  }, timeoutMs);
}

async function waitForDaemonState(port, predicate, timeoutMs = 8000) {
  await waitFor(async () => {
    const response = await fetch(`http://localhost:${port}/state`).catch(() => null);
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
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function stopChildren() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolvePromise) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolvePromise();
            return;
          }
          child.once("exit", resolvePromise);
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
