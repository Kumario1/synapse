// Proves the publishable npm artifact works exactly as a user would consume it:
// pack the release tarball, `npm install` it into a clean temp project, then run
// the installed CLI (not the monorepo build) through the real two-machine flow —
// alice hosts with `synapse up --serve`, bob joins with `synapse up`, and each
// sees the other. Also asserts the bundled @synapse/* packages resolve, analyzer
// sidecar assets ship, and the TypeScript analyzer works from the installed copy.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseConfig = JSON.parse(readFileSync(join(rootDir, "release.config.json"), "utf8"));
const children = [];
const token = "package-token";
const loopback = "127.0.0.1";

// 1. Build + pack the release tarball.
await execFileAsync("node", [join(rootDir, "scripts/build-package.mjs")], {
  cwd: rootDir,
  maxBuffer: 64 * 1024 * 1024
});
const tarballs = (await readdir(join(rootDir, "dist-release"))).filter((f) => f.endsWith(".tgz"));
assert.equal(tarballs.length, 1, `expected one tarball in dist-release, found: ${tarballs.join(", ")}`);
const tarball = join(rootDir, "dist-release", tarballs[0]);
const { stdout: listing } = await execFileAsync("tar", ["-tzf", tarball], { maxBuffer: 16 * 1024 * 1024 });
assertTarballContents(listing);

const installRoot = await mkdtemp(join(tmpdir(), "synapse-pkg-"));
const demoRoot = await mkdtemp(join(tmpdir(), "synapse-pkg-demo-"));

try {
  // 2. Install the tarball into a clean project, like a user would.
  await writeFile(join(installRoot, "package.json"), JSON.stringify({ name: "consumer", private: true }));
  await execFileAsync("npm", ["install", "--no-audit", "--no-fund", tarball], {
    cwd: installRoot,
    maxBuffer: 64 * 1024 * 1024
  });

  const packageRoot = join(installRoot, "node_modules", releaseConfig.name);
  const cli = join(packageRoot, "dist", "index.js");
  assert.ok(existsSync(cli), "installed CLI entrypoint exists");
  assert.ok(existsSync(join(installRoot, "node_modules", ".bin", "synapse")), "synapse bin link exists");

  // 3. Bundled workspace packages import (ESM) and the two createRequire
  // subpath lookups the CLI performs at runtime both resolve.
  const probePath = join(packageRoot, "dist", "verify-probe.mjs");
  await writeFile(
    probePath,
    `import { createRequire } from "node:module";
// @synapse/server is resolved only — importing it would start its listener.
const imported = ["@synapse/protocol", "@synapse/conflict-engine", "@synapse/analyzer-ts", "@synapse/analyzer-py", "@synapse/analyzer-go"];
for (const n of imported) await import(n);
const require = createRequire(import.meta.url);
require.resolve("@synapse/analyzer-py/package.json");
require.resolve("@synapse/server/package.json");
console.log("resolved:" + (imported.length + 1));
`
  );
  const { stdout: resolved } = await execFileAsync(process.execPath, [probePath]);
  assert.match(resolved, /resolved:6/, "all six bundled packages resolve");
  await rm(probePath, { force: true });

  const analyzerPyRoot = join(dirname(cli), "..", "node_modules", "@synapse", "analyzer-py");
  for (const piece of ["python", "requirements.txt", join("scripts", "setup-venv.mjs")]) {
    assert.ok(existsSync(join(analyzerPyRoot, piece)), `analyzer-py ships ${piece}`);
  }

  // 4. The installed analyzer extracts contracts.
  const samplePath = join(installRoot, "sample.ts");
  await writeFile(samplePath, "export function greet(name: string): string { return `hi ${name}`; }\n");
  const { stdout: analyzed } = await runCli(cli, ["analyze", "--file", samplePath], installRoot);
  assert.match(analyzed, /greet/, "analyze output mentions the exported symbol");

  // 5. Real flow: alice hosts (`up --serve`), bob joins, they see each other.
  const aliceRoot = join(demoRoot, "alice");
  const bobRoot = join(demoRoot, "bob");
  await initClone(aliceRoot);
  await initClone(bobRoot);

  const serverPort = await freePort();
  const alicePort = await freePort();
  const bobPort = await freePort();

  startUp(cli, "alice", aliceRoot, alicePort, serverPort, ["--serve", "--server-port", String(serverPort)]);
  await waitForHttp(`http://${loopback}:${serverPort}/health`);
  await waitForHttp(`http://${loopback}:${alicePort}/health`);
  await assertJoined(aliceRoot, alicePort, "alice");

  startUp(cli, "bob", bobRoot, bobPort, serverPort);
  await waitForHttp(`http://${loopback}:${bobPort}/health`);
  await assertJoined(bobRoot, bobPort, "bob");

  await waitForDaemonState(alicePort, (state) =>
    state.sessions.some((s) => (s.memberLogin ?? s.memberId) === "bob")
  );
  await waitForDaemonState(bobPort, (state) =>
    state.sessions.some((s) => (s.memberLogin ?? s.memberId) === "alice")
  );
  const check = await postJson(`http://${loopback}:${bobPort}/tools/synapse_check`, {
    repoId: "github.com/acme/widgets",
    sessionId: "bob",
    files: ["src/auth/token.ts"]
  });
  assert.equal(check.verdict, "none", "a clean check answers none from the installed package");
  assert.equal(check.degraded, false, "daemon is connected to the bundled server");

  console.log("Package verification passed:");
  console.log(
    JSON.stringify(
      {
        tarball: tarballs[0],
        bundledPackages: 6,
        binLink: "ok",
        analyze: "ok",
        join: "config and hooks written",
        check: check.verdict,
        twoMachineUp: "mutual visibility via installed CLI"
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
  await rm(installRoot, { recursive: true, force: true });
  await rm(demoRoot, { recursive: true, force: true });
}

async function initClone(dir) {
  await execFileAsync("git", ["init", "-q", dir]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "dev@example.com"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "Dev"]);
  await execFileAsync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:acme/widgets.git"]);
  await mkdir(join(dir, "src", "auth"), { recursive: true });
  await writeFile(
    join(dir, "src", "auth", "token.ts"),
    "export function validate(input: string): boolean { return input.length > 0; }\n"
  );
}

function startUp(cli, member, worktreeRoot, port, serverPort, extraArgs = []) {
  const child = spawn(
    process.execPath,
    [
      cli,
      "up",
      "--member",
      member,
      "--port",
      String(port),
      "--server",
      `ws://${loopback}:${serverPort}`,
      "--token",
      token,
      ...extraArgs
    ],
    {
      cwd: worktreeRoot,
      env: {
        ...process.env,
        INIT_CWD: worktreeRoot,
        OPENROUTER_API_KEY: "",
        SYNAPSE_LLM_EXPLAIN: "0",
        SYNAPSE_LLM_RESOLVE: "0",
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--dns-result-order=ipv4first"].filter(Boolean).join(" ")
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  children.push(child);
  child.stdout.on("data", (chunk) => process.stdout.write(`[${member}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${member}] ${chunk}`));
  return child;
}

async function runCli(cli, args, cwd) {
  return execFileAsync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, INIT_CWD: cwd },
    maxBuffer: 16 * 1024 * 1024
  });
}

async function waitForDaemonState(port, predicate, timeoutMs = 15000) {
  await waitFor(async () => {
    const response = await fetch(`http://${loopback}:${port}/state`).catch(() => null);
    if (!response?.ok) {
      return false;
    }
    return predicate(await response.json());
  }, timeoutMs);
}

async function waitForHttp(url, timeoutMs = 20000) {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => null);
    return response?.ok === true;
  }, timeoutMs);
}

async function assertJoined(worktreeRoot, daemonPort, member) {
  const config = JSON.parse(await readFile(join(worktreeRoot, ".synapse", "config.json"), "utf8"));
  assert.equal(config.repoId, "github.com/acme/widgets", `${member} config uses git-derived repoId`);
  assert.equal(config.daemonPort, daemonPort, `${member} config records daemon port`);
  const settings = JSON.parse(await readFile(join(worktreeRoot, ".claude", "settings.json"), "utf8"));
  assert.ok(JSON.stringify(settings.hooks).includes("synapse"), `${member} Claude Code hooks installed`);
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

function assertTarballContents(listing) {
  const files = listing.split("\n");
  const mustShip = [
    "package/dist/index.js",
    "package/node_modules/@synapse/server/dist/index.js",
    "package/node_modules/@synapse/protocol/dist/index.js",
    "package/node_modules/@synapse/conflict-engine/dist/index.js",
    "package/node_modules/@synapse/analyzer-ts/dist/index.js",
    "package/node_modules/@synapse/analyzer-py/dist/index.js",
    "package/node_modules/@synapse/analyzer-py/requirements.txt",
    "package/node_modules/@synapse/analyzer-py/scripts/setup-venv.mjs",
    "package/node_modules/@synapse/analyzer-go/dist/index.js",
    "package/node_modules/@synapse/analyzer-go/scripts/setup-go.mjs"
  ];
  for (const file of mustShip) {
    assert.ok(files.includes(file), `tarball ships ${file}`);
  }
  assert.ok(
    files.some((file) => file.startsWith("package/node_modules/@synapse/analyzer-py/python/")),
    "tarball ships the python sidecar sources"
  );
  assert.ok(
    files.some((file) => file.startsWith("package/node_modules/@synapse/analyzer-go/go/")),
    "tarball ships the Go sidecar sources"
  );
  assert.ok(!files.some((file) => file.includes("/__pycache__/")), "no Python __pycache__ rides along");
  assert.ok(!files.some((file) => file.endsWith(".pyc")), "no Python bytecode rides along");
  assert.ok(!files.some((file) => file.includes(".venv")), "no machine-specific venv rides along");
  assert.ok(!files.some((file) => file.includes("/src/")), "no TypeScript sources ride along");
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
          }, 1500).unref();
        })
    )
  );
}
