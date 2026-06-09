import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Prove `synapse doctor` turns the silent cross-machine failures into loud,
// specific checks: it PASSes against a reachable, authed server (and reports the
// enriched /health protocolVersion), distinguishes a 401 auth failure from a
// connection refusal, and loudly WARNs when repoId is "local".
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(rootDir, "apps/cli/dist/index.js");
const children = [];
const token = "doctor-token";

const serverPort = await freePort();
const deadPort = await freePort();

try {
  startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort),
    SYNAPSE_AUTH_TOKEN: token
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  // /health is enriched with a numeric protocolVersion (open, no auth).
  const health = await (await fetch(`http://localhost:${serverPort}/health`)).json();
  assert.equal(typeof health.protocolVersion, "number", "/health reports protocolVersion");
  assert.ok(health.version, "/health reports a version");

  // 1. Healthy + correct token + a real repoId → all green.
  const ok = await doctor(["--server", `ws://localhost:${serverPort}`, "--repo-id", "acme/widgets", "--token", token]);
  assert.match(ok.stdout, /✓ server:/, "server reachable");
  assert.match(ok.stdout, /✓ protocol:/, "protocol matches");
  assert.match(ok.stdout, /✓ websocket:/, "ws handshake authenticated");
  assert.match(ok.stdout, /peers:/, "peers line present");
  assert.match(ok.stdout, /✓ repoId: coordinating on acme\/widgets/, "repoId pass");
  assert.equal(ok.code, 0, "doctor exits 0 when all checks pass/warn");

  // 2. Wrong token → the websocket check FAILs with a 401 auth message.
  const badToken = await doctor(["--server", `ws://localhost:${serverPort}`, "--repo-id", "acme/widgets", "--token", "wrong"]);
  assert.match(badToken.stdout, /✗ websocket:.*401/, "wrong token → 401 auth failure");
  assert.equal(badToken.code, 1, "doctor exits non-zero on a failing check");

  // 3. Dead port → the server check FAILs with a connection error (not a timeout).
  const refused = await doctor(["--server", `ws://localhost:${deadPort}`, "--repo-id", "acme/widgets", "--token", token]);
  assert.match(refused.stdout, /✗ server:.*(refused|ECONNREFUSED)/i, "dead port → connection refused");
  assert.equal(refused.code, 1, "doctor exits non-zero when the server is unreachable");

  // 4. repoId "local" → the loud WARN that two clones won't coordinate.
  const local = await doctor(["--server", `ws://localhost:${serverPort}`, "--repo-id", "local", "--token", token]);
  assert.match(local.stdout, /⚠ repoId:.*will NOT coordinate/, "repoId local warns loudly");

  console.log("Doctor verification passed:");
  console.log(JSON.stringify({ protocolVersion: health.protocolVersion, healthy: "✓", badToken: "401", deadPort: "refused", localRepo: "warn" }, null, 2));
} finally {
  await stopChildren();
}

function doctor(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cli, "doctor", ...args], {
      cwd: rootDir,
      env: { ...process.env, OPENROUTER_API_KEY: "", SYNAPSE_LLM_EXPLAIN: "0", SYNAPSE_LLM_RESOLVE: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("exit", (code) => resolvePromise({ stdout, stderr, code: code ?? 0 }));
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

async function waitForHttp(url, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
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
