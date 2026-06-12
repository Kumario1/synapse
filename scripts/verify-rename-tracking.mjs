import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Rename tracking (plan F5 slice): an unambiguous same-file, same-shape
// removed+added pair is ONE `renamed` delta keyed by the OLD symbol id —
// so dependents' graphs (which still reference the old name) keep firing
// dependency_changed, and the summary names both identities. Opt-out
// (SYNAPSE_RENAME_TRACKING=0) restores the removed+added behavior.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
const roots = [];

const shapeFile = "src/geo/shape.ts";
const drawFile = "src/app/draw.ts";
const oldSymbol = "ts:src/geo/shape.ts#area";
const newSymbol = "ts:src/geo/shape.ts#computeArea";

const baselineSource = `
  export function area(w: number, h: number): number {
    return w * h;
  }
`;
const renamedSource = `
  export function computeArea(w: number, h: number): number {
    return w * h;
  }
`;
const drawSource = `
  import { area } from "../geo/shape";

  export function draw(w: number, h: number): number {
    return area(w, h);
  }
`;

try {
  // --- Leg 1: rename detection on. ---
  const onRepo = `renameverify-on/${Date.now()}`;
  const on = await bootPair(onRepo, {});
  await report(on.alicePort, onRepo); // baseline snapshot
  await writeFixture(on.aliceRoot, shapeFile, renamedSource);
  const renamedDeltas = (await report(on.alicePort, onRepo)).deltas;

  assert.equal(renamedDeltas.length, 1, "one delta for an unambiguous rename");
  assert.equal(renamedDeltas[0].changeKind, "renamed");
  assert.equal(renamedDeltas[0].symbolId.raw, oldSymbol, "delta keyed by the OLD id");
  assert.equal(
    renamedDeltas[0].summary,
    `Renamed ${oldSymbol} to ${newSymbol}`,
    "summary names both identities"
  );

  await waitForState(on.serverPort, onRepo, (state) =>
    state.unpushedDeltas.some((delta) => delta.changeKind === "renamed")
  );
  await waitForDaemonState(on.bobPort, (state) =>
    state.unpushedDeltas.some((delta) => delta.changeKind === "renamed")
  );

  const check = await postJson(`http://localhost:${on.bobPort}/tools/synapse_check`, {
    repoId: onRepo,
    sessionId: "bob",
    files: [drawFile]
  });
  const conflict = check.conflicts.find((item) => item.rule === "dependency_changed");
  assert.ok(conflict, "dependents of the old name still get dependency_changed");
  assert.ok(conflict.detail.includes(oldSymbol), "conflict cites the old id");
  assert.ok(conflict.detail.includes(newSymbol), "the rename summary surfaces the new id");

  // --- Leg 2: opt-out restores removed + added. ---
  const offRepo = `renameverify-off/${Date.now()}`;
  const off = await bootPair(offRepo, { SYNAPSE_RENAME_TRACKING: "0" });
  await report(off.alicePort, offRepo);
  await writeFixture(off.aliceRoot, shapeFile, renamedSource);
  const optOutDeltas = (await report(off.alicePort, offRepo)).deltas;
  assert.deepEqual(
    optOutDeltas.map((delta) => delta.changeKind).sort(),
    ["added", "removed"],
    "opt-out emits removed + added"
  );

  console.log("Rename tracking verification passed:");
  console.log(
    JSON.stringify(
      {
        renamedDelta: { symbolId: renamedDeltas[0].symbolId.raw, summary: renamedDeltas[0].summary },
        dependentConflict: conflict.rule,
        optOutKinds: optOutDeltas.map((delta) => delta.changeKind).sort()
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}

async function bootPair(repoId, aliceEnv) {
  const serverPort = await freePort();
  startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  const aliceRoot = await trackedMkdtemp("synapse-rename-alice-");
  const bobRoot = await trackedMkdtemp("synapse-rename-bob-");
  for (const root of [aliceRoot, bobRoot]) {
    await writeFixture(root, shapeFile, baselineSource);
    await writeFixture(root, drawFile, drawSource);
  }

  const alicePort = await freePort();
  const bobPort = await freePort();
  startDaemon("alice", alicePort, serverPort, repoId, aliceRoot, aliceEnv);
  startDaemon("bob", bobPort, serverPort, repoId, bobRoot, {});
  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`)
  ]);
  await waitForState(serverPort, repoId, (state) => state.sessions.length === 2);

  return { serverPort, alicePort, bobPort, aliceRoot, bobRoot };
}

async function report(port, repoId) {
  return postJson(`http://localhost:${port}/tools/synapse_report`, {
    repoId,
    sessionId: "alice",
    filePath: shapeFile
  });
}

async function trackedMkdtemp(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeFixture(root, filePath, source) {
  const fullPath = join(root, filePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${source.trim()}\n`);
}

function startDaemon(member, port, serverPort, repoId, worktreeRoot, env) {
  startProcess(member, [
    "apps/cli/dist/index.js",
    "daemon",
    "--member", member,
    "--session", member,
    "--repo-id", repoId,
    "--port", String(port),
    "--server", `ws://localhost:${serverPort}`,
    "--worktree-root", worktreeRoot
  ], { SYNAPSE_FILE_WATCHER: "0", ...env });
}

function startProcess(label, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    env: { ...process.env, ...env, OPENROUTER_API_KEY: "" },
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

async function waitForState(port, repoId, predicate, timeoutMs = 8000) {
  await waitFor(async () => {
    const response = await fetch(
      `http://localhost:${port}/state?repoId=${encodeURIComponent(repoId)}`
    ).catch(() => null);
    if (!response?.ok) {
      return false;
    }
    return predicate(await response.json());
  }, timeoutMs, "server state");
}

async function waitForDaemonState(port, predicate, timeoutMs = 8000) {
  await waitFor(async () => {
    const response = await fetch(`http://localhost:${port}/state`).catch(() => null);
    if (!response?.ok) {
      return false;
    }
    return predicate(await response.json());
  }, timeoutMs, "daemon state");
}

async function waitForHttp(url, timeoutMs = 8000) {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => null);
    return response?.ok === true;
  }, timeoutMs, `http ${url}`);
}

async function waitFor(predicate, timeoutMs, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 150));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function stopChildren() {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit").catch(() => {});
      }
    })
  );
}
