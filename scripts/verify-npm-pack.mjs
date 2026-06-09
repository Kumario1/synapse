import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Prove the published artifact is the working product: build the tarball via
// apps/cli/scripts/pack.mjs, assert the bundle is complete (server + analyzers
// + python assets, no .venv), install it into a fresh project, then run the
// real flow from the INSTALLED package — `synapse --help`, `synapse join` in a
// scratch git repo (config + hooks written), and a daemon answering a
// synapse_check against the bundled server. Requires the npm registry for the
// external deps; SKIPs (exit 0) when it is unreachable so offline runs stay green.
const execFileAsync = promisify(execFile);
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const packDir = await mkdtemp(join(tmpdir(), "synapse-pack-"));
const projectDir = await mkdtemp(join(tmpdir(), "synapse-pack-install-"));
const repoDir = join(projectDir, "repo");
const serverPort = await freePort();
const daemonPort = await freePort();
const filePath = "src/auth/token.ts";

try {
  // --- 1. Build the tarball. ---
  const { stdout: packOut } = await execFileAsync(
    process.execPath,
    ["apps/cli/scripts/pack.mjs", "--dest", packDir],
    { cwd: rootDir }
  );
  const tarball = packOut.trim().split("\n").pop();
  assert.ok(tarball.endsWith(".tgz"), `pack.mjs printed a tarball path (${tarball})`);

  // --- 2. The bundle is complete and clean. ---
  const { stdout: listing } = await execFileAsync("tar", ["-tzf", tarball]);
  const files = listing.split("\n");
  const mustShip = [
    "package/dist/index.js",
    "package/node_modules/@synapse/server/dist/index.js",
    "package/node_modules/@synapse/protocol/dist/index.js",
    "package/node_modules/@synapse/conflict-engine/dist/index.js",
    "package/node_modules/@synapse/analyzer-ts/dist/index.js",
    "package/node_modules/@synapse/analyzer-py/dist/index.js",
    "package/node_modules/@synapse/analyzer-py/requirements.txt",
    "package/node_modules/@synapse/analyzer-py/scripts/setup-venv.mjs"
  ];
  for (const file of mustShip) {
    assert.ok(files.includes(file), `tarball ships ${file}`);
  }
  assert.ok(
    files.some((file) => file.startsWith("package/node_modules/@synapse/analyzer-py/python/")),
    "tarball ships the python sidecar sources"
  );
  assert.ok(!files.some((file) => file.includes(".venv")), "no machine-specific venv rides along");
  assert.ok(!files.some((file) => file.includes("/src/")), "no TypeScript sources ride along");

  // --- 3. Install into a fresh project (registry needed for ws/zod/etc.). ---
  if (!(await registryReachable())) {
    console.log("npm-pack verification skipped: npm registry unreachable (offline).");
    process.exit(0);
  }
  await writeFile(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "synapse-pack-consumer", private: true }, null, 2)
  );
  await execFileAsync("npm", ["install", tarball, "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: projectDir,
    timeout: 300_000
  });
  const synapseBin = join(projectDir, "node_modules", ".bin", "synapse");

  // --- 4. The installed CLI runs. ---
  const { stdout: helpOut } = await execFileAsync(synapseBin, ["help"]);
  assert.match(helpOut, /synapse/i, "synapse help prints usage");
  assert.match(helpOut, /join/, "usage mentions join");

  // --- 5. join in a scratch git repo writes config + hooks. ---
  await mkdir(join(repoDir, "src/auth"), { recursive: true });
  await execFileAsync("git", ["init", "-q", repoDir]);
  await writeFixture(`
    export function validate(input: string): boolean {
      return input.length > 0;
    }
  `);
  const { stdout: joinOut } = await execFileAsync(
    synapseBin,
    [
      "join",
      "--repo-id", "packed-repo",
      "--member", "alice",
      "--session", "alice",
      "--agent", "claude-code",
      "--port", String(daemonPort),
      "--server", `ws://localhost:${serverPort}`
    ],
    { cwd: repoDir, env: { ...process.env, INIT_CWD: repoDir } }
  );
  assert.match(joinOut, /\.synapse\/config\.json/u, "join reports the config it wrote");

  const config = JSON.parse(await readFile(join(repoDir, ".synapse/config.json"), "utf8"));
  assert.equal(config.repoId, "packed-repo");
  assert.equal(config.daemonPort, daemonPort);
  const settings = JSON.parse(await readFile(join(repoDir, ".claude/settings.json"), "utf8"));
  assert.ok(JSON.stringify(settings.hooks).includes("synapse"), "Claude Code hooks installed");

  // --- 6. The bundled server + installed daemon answer a real check. ---
  // npm installs bundleDependencies NESTED under the cli package.
  const serverEntry = join(
    projectDir,
    "node_modules/@synapse/cli/node_modules/@synapse/server/dist/index.js"
  );
  startProcess("server", [serverEntry], projectDir, {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  startProcess("daemon", [synapseBin, "daemon"], repoDir, { INIT_CWD: repoDir });
  await waitForHttp(`http://localhost:${daemonPort}/health`);

  const check = await postJson(`http://localhost:${daemonPort}/tools/synapse_check`, {
    repoId: "packed-repo",
    sessionId: "alice",
    files: [filePath]
  });
  assert.equal(check.verdict, "none", "a clean check answers none from the installed package");
  assert.equal(check.degraded, false, "daemon is connected to the bundled server");

  console.log("npm-pack verification passed:");
  console.log(JSON.stringify({ tarball: tarball.split("/").pop(), verdict: check.verdict }, null, 2));
} finally {
  await stopChildren();
  await rm(packDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
}

async function registryReachable() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch("https://registry.npmjs.org/-/ping", {
      signal: controller.signal
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function writeFixture(source) {
  await writeFile(join(repoDir, filePath), `${source.trim()}\n`);
}

function startProcess(label, args, cwd, env) {
  const child = spawn(args[0].endsWith(".js") ? process.execPath : args[0], args[0].endsWith(".js") ? args : args.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
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

async function waitForHttp(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
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
            resolve(undefined);
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
