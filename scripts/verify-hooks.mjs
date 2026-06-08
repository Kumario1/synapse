import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Dogfood the Claude Code hook path end-to-end: `synapse join` installs the
// hooks, then the exact `synapse hook pre|post` commands Claude Code runs are
// invoked with real hook JSON on stdin. We assert (1) join writes the hooks,
// (2) `hook pre` surfaces a live conflict as an ask-decision, and (3)
// `hook post` reports a contract change to the daemon. Fully deterministic.
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(rootDir, "apps/cli/dist/index.js");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const aliceRoot = await mkdtemp(join(tmpdir(), "synapse-hooks-alice-"));
const bobRoot = await mkdtemp(join(tmpdir(), "synapse-hooks-bob-"));
const joinRoot = await mkdtemp(join(tmpdir(), "synapse-hooks-join-"));
const filePath = "src/auth/token.ts";
const symbol = "ts:src/auth/token.ts#validate";

const base = `
  export interface Token { value: string; }
  export interface Result<T> { value: T; }
  export function validate(input: string): boolean {
    return input.length > 0;
  }
`;
const aliceVersion = base.replace(
  "export function validate(input: string): boolean {\n    return input.length > 0;\n  }",
  "export function validate(input: string): Result<Token> {\n    return { value: { value: input } };\n  }"
);
const bobVersion = base.replace(
  "export function validate(input: string): boolean {\n    return input.length > 0;\n  }",
  "export function validate(input: string): Promise<Token> {\n    return Promise.resolve({ value: input });\n  }"
);

try {
  // --- Phase 1: `synapse join` installs the Claude Code hooks. ---
  await runCli(["join", "--member", "carol", "--session", "carol", "--port", "4099"], joinRoot);
  const settings = JSON.parse(await readFile(join(joinRoot, ".claude/settings.json"), "utf8"));
  const preCmd = settings.hooks.PreToolUse.flatMap((g) => g.hooks).map((h) => h.command);
  const postCmd = settings.hooks.PostToolUse.flatMap((g) => g.hooks).map((h) => h.command);
  assert.ok(preCmd.some((c) => c.includes("hook pre")), "join installed a PreToolUse hook");
  assert.ok(postCmd.some((c) => c.includes("hook post")), "join installed a PostToolUse hook");
  assert.ok(
    settings.hooks.PreToolUse.some((g) => g.matcher === "Edit|Write|MultiEdit"),
    "hook matches Edit|Write|MultiEdit"
  );

  // --- Phase 2 setup: server + two daemons with divergent contracts. ---
  await writeFixture(aliceRoot, base);
  await writeFixture(bobRoot, base);
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

  // Baselines, then each side rewrites validate to its own incompatible contract.
  await report(alicePort, "alice");
  await report(bobPort, "bob");
  await writeFixture(aliceRoot, aliceVersion);
  await report(alicePort, "alice");
  await writeFixture(bobRoot, bobVersion);
  await report(bobPort, "bob");
  await waitForState(
    serverPort,
    (s) => s.unpushedDeltas.filter((d) => d.symbolId.raw === symbol).length === 2
  );

  // --- Phase 2 assert: `hook pre` surfaces the conflict as Claude Code would. ---
  const preOut = await runHookStage("pre", bobRoot, join(bobRoot, filePath));
  assert.ok(preOut, "hook pre emitted a decision for a conflicting edit");
  const out = preOut.hookSpecificOutput;
  assert.equal(out.hookEventName, "PreToolUse");
  assert.equal(out.permissionDecision, "ask", "warn surfaces as ask — the developer decides");
  assert.ok(out.permissionDecisionReason.includes("Synapse"), "reason is a Synapse heads-up");
  assert.ok(
    out.permissionDecisionReason.includes("contract_divergent"),
    "reason names the contract_divergent rule"
  );
  assert.ok(out.permissionDecisionReason.includes("alice"), "reason names the counterpart");

  // A non-conflicting file stays silent (no decision emitted).
  await writeFile(join(bobRoot, "src/lonely.ts"), "export function lonely(): void {}\n");
  const quiet = await runHookStage("pre", bobRoot, join(bobRoot, "src/lonely.ts"));
  assert.equal(quiet, null, "hook pre is silent when there is no conflict");

  // --- Phase 3: `hook post` reports a contract change to the daemon. ---
  const extra = "src/extra.ts";
  await writeFile(join(bobRoot, extra), "export function extra(a: string): string { return a; }\n");
  await runHookStage("post", bobRoot, join(bobRoot, extra)); // baseline snapshot
  await writeFile(join(bobRoot, extra), "export function extra(a: number): number { return a; }\n");
  await runHookStage("post", bobRoot, join(bobRoot, extra)); // should report a delta
  await waitForState(
    serverPort,
    (s) => s.unpushedDeltas.some((d) => d.filePath === extra && d.sessionId === "bob"),
    8000
  );

  console.log("Hook verification passed:");
  console.log(JSON.stringify({ join: "ok", pre: preOut, post: "reported extra.ts delta" }, null, 2));
} finally {
  await stopChildren();
  await Promise.all([
    rm(aliceRoot, { recursive: true, force: true }),
    rm(bobRoot, { recursive: true, force: true }),
    rm(joinRoot, { recursive: true, force: true })
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

async function writeFixture(worktreeRoot, source) {
  await mkdir(join(worktreeRoot, "src/auth"), { recursive: true });
  await writeFile(join(worktreeRoot, filePath), `${source.trim()}\n`);
}

async function writeLocalConfig(worktreeRoot, port, sessionId) {
  await mkdir(join(worktreeRoot, ".synapse"), { recursive: true });
  await writeFile(
    join(worktreeRoot, ".synapse/config.json"),
    JSON.stringify({ repoId: "local", daemonPort: port, sessionId, member: sessionId, worktreeRoot }, null, 2)
  );
}

async function report(port, sessionId) {
  return postJson(`http://localhost:${port}/tools/synapse_report`, {
    repoId: "local",
    sessionId,
    filePath
  });
}

/** Invoke `synapse hook <stage>` exactly as Claude Code does: hook JSON on stdin. */
function runHookStage(stage, worktreeRoot, absFilePath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, "hook", stage], {
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
        reject(new Error(`hook ${stage} exited ${code}: ${stderr}`));
        return;
      }
      const trimmed = stdout.trim();
      resolvePromise(trimmed ? JSON.parse(trimmed) : null);
    });
    child.stdin.end(
      JSON.stringify({
        hook_event_name: stage === "pre" ? "PreToolUse" : "PostToolUse",
        tool_name: "Edit",
        cwd: worktreeRoot,
        tool_input: { file_path: absFilePath }
      })
    );
  });
}

function runCli(args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, INIT_CWD: cwd },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`cli ${args[0]} exited ${code}: ${stderr}`))
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
