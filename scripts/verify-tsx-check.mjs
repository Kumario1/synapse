import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// JS/JSX/TSX audit (M11): the React-shaped repo works end-to-end. A
// default-exported .tsx component's props change must produce a symbol-level
// delta, and a teammate checking the .tsx file that imports it must get a
// dependency_changed warning through the cross-extension dependency graph
// (.tsx → .tsx default import, plus an .mjs helper edge).
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const worktreeRoot = await mkdtemp(join(tmpdir(), "synapse-tsx-check-"));
const panelFile = "src/ui/Panel.tsx";
const appFile = "src/ui/App.tsx";
const panelSymbol = "ts:src/ui/Panel.tsx#Panel";

try {
  await mkdir(join(worktreeRoot, "src/ui"), { recursive: true });
  await mkdir(join(worktreeRoot, "src/lib"), { recursive: true });
  await writePanel(`
    export default function Panel(props: { open: boolean }) {
      return <div>{props.open ? "open" : "closed"}</div>;
    }
  `);
  await write(appFile, `
    import Panel from "./Panel";
    import { format } from "../lib/format.mjs";

    export function App(): JSX.Element {
      return <main title={format("home")}><Panel open={true} /></main>;
    }
  `);
  await write("src/lib/format.mjs", `
    export function format(name) {
      return name.toUpperCase();
    }
  `);

  startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  startDaemon("alice", alicePort);
  startDaemon("bob", bobPort);
  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`)
  ]);
  await waitForState(serverPort, (state) => state.sessions.length === 2);

  // Baseline, then alice changes the component's props contract.
  const baseline = await report(alicePort, panelFile);
  assert.deepEqual(baseline.deltas, [], "first report records the .tsx baseline");

  await writePanel(`
    export default function Panel(props: { open: boolean; variant: "wide" | "narrow" }) {
      return <div data-variant={props.variant}>{props.open ? "open" : "closed"}</div>;
    }
  `);
  const changed = await report(alicePort, panelFile);
  assert.equal(changed.deltas.length, 1, "the props change is a symbol-level delta");
  assert.equal(changed.deltas[0].symbolId.raw, panelSymbol);
  assert.equal(changed.deltas[0].changeKind, "signature_changed");

  // Bob checks the importing .tsx — the default-import edge must surface the
  // dependency change.
  const check = await postJson(`http://localhost:${bobPort}/tools/synapse_check`, {
    repoId: "local",
    sessionId: "bob",
    files: [appFile]
  });
  assert.equal(check.verdict, "warn");
  const dependency = check.conflicts.find((conflict) => conflict.rule === "dependency_changed");
  assert.ok(dependency, "dependency_changed conflict for the imported component");
  assert.equal(dependency.targetSymbol.raw, "ts:src/ui/App.tsx#App");
  assert.equal(dependency.counterpart.sessionId, "alice");

  // The .mjs helper participates in the same graph: change it and the
  // importing component is warned too.
  const mjsBaseline = await report(alicePort, "src/lib/format.mjs");
  assert.deepEqual(mjsBaseline.deltas, []);
  await write("src/lib/format.mjs", `
    export function format(name, locale) {
      return name.toUpperCase() + ":" + locale;
    }
  `);
  const mjsChanged = await report(alicePort, "src/lib/format.mjs");
  assert.equal(mjsChanged.deltas.length, 1, ".mjs change is symbol-level");
  assert.equal(mjsChanged.deltas[0].symbolId.raw, "ts:src/lib/format.mjs#format");

  console.log("TSX check verification passed:");
  console.log(
    JSON.stringify(
      {
        tsxDelta: changed.deltas[0].symbolId.raw,
        verdict: check.verdict,
        dependencyRule: dependency.rule,
        mjsDelta: mjsChanged.deltas[0].symbolId.raw
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
  await rm(worktreeRoot, { recursive: true, force: true });
}

function startDaemon(member, port) {
  return startProcess(member, [
    "apps/cli/dist/index.js",
    "daemon",
    "--member", member,
    "--session", member,
    "--port", String(port),
    "--server", `ws://localhost:${serverPort}`,
    "--worktree-root", worktreeRoot
  ], {});
}

async function report(port, filePath) {
  return postJson(`http://localhost:${port}/tools/synapse_report`, {
    repoId: "local",
    sessionId: "alice",
    filePath
  });
}

async function writePanel(source) {
  await write(panelFile, source);
}

async function write(filePath, source) {
  await writeFile(join(worktreeRoot, filePath), `${source.trim()}\n`);
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

async function waitForHttp(url, timeoutMs = 8000) {
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

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
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
