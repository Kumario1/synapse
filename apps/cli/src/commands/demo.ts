import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cliEntrypoint, parseFlags } from "../config.js";
import { resolveServerEntry } from "./up.js";

/**
 * `synapse demo` — a one-command, fully sandboxed two-agent conflict demo.
 * Everything lives in a mkdtemp sandbox (worktrees + SQLite state via
 * SYNAPSE_DB_PATH), the room id is random (`demo/<hex>` — never derived from
 * the cwd's git remote), every port comes from the OS, and children are
 * killed + the sandbox removed on exit (kept with --keep). `--json` prints a
 * machine-readable result instead of narration.
 */

const SHAPE_FILE = "src/geo/shape.ts";
const DRAW_FILE = "src/app/draw.ts";

const BASELINE = `export function area(w: number, h: number): number {
  return w * h;
}
`;
const RENAMED_RETURN = `export function area(w: number, h: number): { value: number } {
  return { value: w * h };
}
`;
const DRAW = `import { area } from "../geo/shape";

export function draw(w: number, h: number): number {
  return area(w, h);
}
`;

interface DemoResult {
  ok: boolean;
  sandbox: string;
  ports: { server: number; alice: number; bob: number };
  steps: string[];
  conflict: { rule: string; severity: string } | null;
}

export async function runDemo(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const json = "json" in flags;
  const keep = "keep" in flags;
  const children: ChildProcess[] = [];
  const steps: string[] = [];
  const say = (line: string): void => {
    if (!json) {
      console.log(line);
    }
  };

  const sandbox = await mkdtemp(join(tmpdir(), "synapse-demo-"));
  const repoId = `demo/${randomBytes(3).toString("hex")}`;
  const result: DemoResult = {
    ok: false,
    sandbox,
    ports: { server: 0, alice: 0, bob: 0 },
    steps,
    conflict: null
  };

  const cleanup = async (): Promise<void> => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    }
    if (!keep) {
      await rm(sandbox, { recursive: true, force: true });
    }
  };
  const onSigint = (): void => {
    void cleanup().then(() => process.exit(130));
  };
  process.once("SIGINT", onSigint);

  try {
    say("🧪 Synapse demo — two agents, one sandbox, one conflict. No setup touched.");
    say(`   sandbox: ${sandbox}${keep ? " (kept)" : ""}`);

    // Act 1: a server and two agents.
    const serverPort = await freePort();
    const alicePort = await freePort();
    const bobPort = await freePort();
    result.ports = { server: serverPort, alice: alicePort, bob: bobPort };

    const aliceRoot = join(sandbox, "alice");
    const bobRoot = join(sandbox, "bob");
    for (const root of [aliceRoot, bobRoot]) {
      await writeFixture(root, SHAPE_FILE, BASELINE);
      await writeFixture(root, DRAW_FILE, DRAW);
    }

    spawnChild(children, "server", resolveServerEntry(), [], {
      SYNAPSE_SERVER_PORT: String(serverPort),
      SYNAPSE_DB_PATH: join(sandbox, "state.sqlite")
    });
    await waitForHttp(`http://localhost:${serverPort}/health`);
    steps.push("server-up");
    say("1. Server up — coordination room " + repoId);

    startDaemon(children, "alice", alicePort, serverPort, repoId, aliceRoot);
    startDaemon(children, "bob", bobPort, serverPort, repoId, bobRoot);
    await Promise.all([
      waitForHttp(`http://localhost:${alicePort}/health`),
      waitForHttp(`http://localhost:${bobPort}/health`)
    ]);
    steps.push("join");
    say("2. Alice and Bob joined the room (two daemons, two worktrees).");

    // Act 2: a clean check.
    const clean = await postJson<{ verdict: string }>(
      `http://localhost:${bobPort}/tools/synapse_check`,
      { repoId, sessionId: "bob", files: [DRAW_FILE] }
    );
    if (clean.verdict !== "none") {
      throw new Error(`expected a clean first check, got ${clean.verdict}`);
    }
    steps.push("clean-check");
    say(`3. Bob checks before editing ${DRAW_FILE} → verdict "none". All clear.`);

    // Act 3: alice changes the contract draw() depends on.
    await postJson(`http://localhost:${alicePort}/tools/synapse_report`, {
      repoId,
      sessionId: "alice",
      filePath: SHAPE_FILE
    });
    steps.push("baseline");
    await writeFixture(aliceRoot, SHAPE_FILE, RENAMED_RETURN);
    await postJson(`http://localhost:${alicePort}/tools/synapse_report`, {
      repoId,
      sessionId: "alice",
      filePath: SHAPE_FILE
    });
    steps.push("delta");
    say("4. Alice changes area()'s return type and reports — the contract delta broadcasts.");

    await waitFor(async () => {
      const state = await fetchJson<{ unpushedDeltas: unknown[] }>(
        `http://localhost:${bobPort}/state`
      );
      return state.unpushedDeltas.length > 0;
    }, 10_000);

    // Act 4: bob's next check catches it.
    const conflicted = await postJson<{
      verdict: string;
      conflicts: { rule: string; severity: string; detail: string }[];
    }>(`http://localhost:${bobPort}/tools/synapse_check`, {
      repoId,
      sessionId: "bob",
      files: [DRAW_FILE]
    });
    const conflict = conflicted.conflicts.find((c) => c.rule === "dependency_changed");
    if (!conflict) {
      throw new Error(
        `expected a dependency_changed conflict, got: ${JSON.stringify(conflicted.conflicts)}`
      );
    }
    result.conflict = { rule: conflict.rule, severity: conflict.severity };
    steps.push("conflict");
    say(`5. Bob checks ${DRAW_FILE} again → ⚠ [${conflict.rule}] (${conflict.severity})`);
    say(`   ${conflict.detail}`);
    say("");
    say("That's the loop: check before editing, report after — no collision shipped.");
    say("Next: `synapse join` in a real repo, or the README's two-machine walkthrough.");

    result.ok = true;
  } finally {
    process.removeListener("SIGINT", onSigint);
    await cleanup();
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function startDaemon(
  children: ChildProcess[],
  member: string,
  port: number,
  serverPort: number,
  repoId: string,
  worktreeRoot: string
): void {
  spawnChild(
    children,
    member,
    cliEntrypoint(),
    [
      "daemon",
      "--member", member,
      "--session", member,
      "--repo-id", repoId,
      "--port", String(port),
      "--server", `ws://localhost:${serverPort}`,
      "--worktree-root", worktreeRoot
    ],
    { SYNAPSE_FILE_WATCHER: "0" }
  );
}

function spawnChild(
  children: ChildProcess[],
  label: string,
  entry: string,
  args: string[],
  env: Record<string, string>
): void {
  const child = spawn(process.execPath, [entry, ...args], {
    env: { ...process.env, ...env, OPENROUTER_API_KEY: "" },
    stdio: ["ignore", "ignore", "ignore"]
  });
  child.on("error", () => {
    /* surfaced via health-check timeouts */
  });
  children.push(child);
}

async function writeFixture(root: string, filePath: string, source: string): Promise<void> {
  const fullPath = join(root, filePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, source);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as T;
  if (!response.ok) {
    throw new Error(`${url} failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} not ok`);
  }
  return (await response.json()) as T;
}

async function waitForHttp(url: string, timeoutMs = 10_000): Promise<void> {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => null);
    return response?.ok === true;
  }, timeoutMs);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 150));
  }
  throw new Error(`demo timed out waiting on ${timeoutMs}ms condition`);
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      if (!address || typeof address !== "object") {
        reject(new Error("no port"));
        return;
      }
      probe.close(() => resolvePort(address.port));
    });
  });
}
