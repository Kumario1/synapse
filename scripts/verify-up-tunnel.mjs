import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(rootDir, "apps/cli/dist/index.js");
const children = [];

// Cover the fragile tunnel-URL capture deterministically, with no real
// cloudflared/ngrok and no internet: SYNAPSE_TUNNEL_CMD stubs the tunnel so it
// prints a fake public URL. `up --serve --tunnel` must parse it, convert
// https→wss, and record it (with the git-derived repoId) in the committed
// .synapse/team.json — never the secret token.
const serverPort = await freePort();
const daemonPort = await freePort();
const worktree = await mkdtemp(join(tmpdir(), "synapse-up-tunnel-"));
const teamConfigPath = join(worktree, ".synapse", "team.json");
const tunnelStub = "printf 'INF | Your quick Tunnel has been created! Visit it at:\\nINF | https://test-tunnel.trycloudflare.com\\n'; sleep 30";

try {
  await execFileAsync("git", ["init", "-q", worktree]);
  await execFileAsync("git", ["-C", worktree, "remote", "add", "origin", "git@github.com:acme/widgets.git"]);

  startProcess(
    "host",
    [cli, "up", "--serve", "--tunnel", "--server-port", String(serverPort), "--port", String(daemonPort), "--member", "alice"],
    { INIT_CWD: worktree, SYNAPSE_TUNNEL_CMD: tunnelStub },
    worktree
  );

  const team = JSON.parse(await waitForFile(teamConfigPath, 15000));

  assert.equal(team.serverUrl, "wss://test-tunnel.trycloudflare.com", "https tunnel URL is recorded as wss");
  assert.equal(team.repoId, "github.com/acme/widgets", "git-derived repoId is recorded for teammates");
  assert.equal(team.schemaVersion, 1, "team.json carries a schemaVersion");

  const raw = await readFile(teamConfigPath, "utf8");
  assert.ok(!/token/i.test(raw), "team.json never contains the auth token");

  console.log("Up-tunnel verification passed:");
  console.log(JSON.stringify(team, null, 2));
} finally {
  await stopChildren();
  await rm(worktree, { recursive: true, force: true });
}

function startProcess(label, args, env, cwd = rootDir) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: {
      ...process.env,
      ...env,
      OPENROUTER_API_KEY: "",
      SYNAPSE_LLM_EXPLAIN: "0",
      SYNAPSE_LLM_RESOLVE: "0"
    },
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

async function waitForFile(path, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const contents = await readFile(path, "utf8").catch(() => null);
    if (contents) {
      return contents;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${path}`);
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
