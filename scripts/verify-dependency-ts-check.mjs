import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const worktreeRoot = await mkdtemp(join(tmpdir(), "synapse-dependency-ts-check-"));
const tokenFile = "src/auth/token.ts";
const loginFile = "src/auth/login.ts";
const validateSymbol = "ts:src/auth/token.ts#validate";
const loginSymbol = "ts:src/auth/login.ts#login";

try {
  await mkdir(join(worktreeRoot, "src/auth"), { recursive: true });
  await writeToken(`
    export interface Token {
      value: string;
    }

    export function validate(input: string): boolean {
      return input.length > 0;
    }
  `);
  await writeLogin(`
    import { validate } from "./token";

    export function login(input: string): boolean {
      return validate(input);
    }
  `);

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

  const cleanCheck = await checkLoginFileOnly(bobPort);
  assert.equal(cleanCheck.verdict, "none");
  assert.deepEqual(cleanCheck.conflicts, []);

  const baseline = await reportToken(alicePort);
  assert.deepEqual(baseline.deltas, []);

  await writeToken(`
    export interface Token {
      value: string;
    }

    export function validate(input: string): Token | null {
      return input ? { value: input } : null;
    }
  `);

  const signatureChange = await reportToken(alicePort);
  assert.equal(signatureChange.deltas.length, 1);
  assert.equal(signatureChange.deltas[0].symbolId.raw, validateSymbol);
  await waitForState(serverPort, (state) => state.unpushedDeltas.length === 1);

  const check = await checkLoginFileOnly(bobPort);
  assert.equal(check.verdict, "warn");
  assert.equal(check.degraded, false);
  assert.deepEqual(
    check.conflicts.map((conflict) => [
      conflict.rule,
      conflict.targetSymbol.raw,
      conflict.counterpart.sessionId
    ]),
    [["dependency_changed", loginSymbol, "alice"]]
  );

  console.log("Dependency TypeScript check verification passed:");
  console.log(JSON.stringify({ signatureChange, check }, null, 2));

  server.kill();
  alice.kill();
  bob.kill();
} finally {
  await stopChildren();
  await rm(worktreeRoot, { recursive: true, force: true });
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
      `ws://localhost:${serverPort}`,
      "--worktree-root",
      worktreeRoot
    ],
    {}
  );
}

async function writeToken(source) {
  await writeFile(join(worktreeRoot, tokenFile), `${source.trim()}\n`);
}

async function writeLogin(source) {
  await writeFile(join(worktreeRoot, loginFile), `${source.trim()}\n`);
}

async function reportToken(port) {
  return postJson(`http://localhost:${port}/tools/synapse_report`, {
    repoId: "local",
    sessionId: "alice",
    filePath: tokenFile
  });
}

async function checkLoginFileOnly(port) {
  return postJson(`http://localhost:${port}/tools/synapse_check`, {
    repoId: "local",
    sessionId: "bob",
    files: [loginFile]
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
