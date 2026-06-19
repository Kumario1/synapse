import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProcessTracker,
  freePort,
  postJson,
  waitForHttp,
  waitForState
} from "./lib/verify-harness.mjs";

// Hermetic: pin the coordination room so git-remote derivation does not pick up the host repo.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const { startProcess, stopChildren } = createProcessTracker(rootDir);

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const worktreeRoot = await mkdtemp(join(tmpdir(), "synapse-daemon-ts-report-"));
const filePath = "src/auth/token.ts";
const symbol = "ts:src/auth/token.ts#validate";

try {
  await mkdir(join(worktreeRoot, "src/auth"), { recursive: true });
  await writeFixture(`
    export interface Token {
      value: string;
    }

    export function validate(input: string): boolean {
      return input.length > 0;
    }
  `);

  const server = startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });

  await waitForHttp(`http://localhost:${serverPort}/health`);

  const alice = startProcess(
    "alice",
    [
      "apps/cli/dist/index.js",
      "daemon",
      "--member",
      "alice",
      "--session",
      "alice",
      "--port",
      String(alicePort),
      "--server",
      `ws://localhost:${serverPort}`,
      "--worktree-root",
      worktreeRoot
    ],
    {}
  );

  const bob = startProcess(
    "bob",
    [
      "apps/cli/dist/index.js",
      "daemon",
      "--member",
      "bob",
      "--session",
      "bob",
      "--port",
      String(bobPort),
      "--server",
      `ws://localhost:${serverPort}`,
      "--worktree-root",
      worktreeRoot
    ],
    {}
  );

  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`)
  ]);

  await waitForState(serverPort, (state) => state.sessions.length === 2);

  const baseline = await report(alicePort);
  assert.deepEqual(baseline.deltas, []);
  await waitForState(serverPort, (state) => state.unpushedDeltas.length === 0);

  await writeFixture(`
    export interface Token {
      value: string;
    }

    export function validate(input: string): boolean {
      return input.trim().length > 0;
    }
  `);

  const implementationOnly = await report(alicePort);
  assert.deepEqual(implementationOnly.deltas, []);
  await waitForState(serverPort, (state) => state.unpushedDeltas.length === 0);

  await writeFixture(`
    export interface Token {
      value: string;
    }

    export function validate(input: string): Token | null {
      return input ? { value: input } : null;
    }
  `);

  const signatureChange = await report(alicePort);
  await waitForState(serverPort, (state) =>
    state.unpushedDeltas.some((delta) => delta.symbolId.raw === symbol)
  );
  const stateAfterSignature = await readState(serverPort);
  const signatureDelta =
    signatureChange.deltas.find((delta) => delta.symbolId.raw === symbol) ??
    stateAfterSignature.unpushedDeltas.find((delta) => delta.symbolId.raw === symbol);
  assert.ok(signatureDelta);
  assert.equal(signatureDelta.changeKind, "signature_changed");
  assert.equal(signatureDelta.symbolId.raw, symbol);

  const check = await postJson(`http://localhost:${bobPort}/tools/synapse_check`, {
    repoId: "local",
    sessionId: "bob",
    files: [filePath],
    symbols: [{ raw: symbol }]
  });

  assert.equal(check.verdict, "warn");
  assert.equal(check.degraded, false);
  assert.deepEqual(
    check.conflicts.map((conflict) => conflict.rule),
    ["same_symbol_unpushed"]
  );

  console.log("Daemon TypeScript report verification passed:");
  console.log(JSON.stringify({ signatureChange, check }, null, 2));

  server.kill();
  alice.kill();
  bob.kill();
} finally {
  await stopChildren();
  await rm(worktreeRoot, { recursive: true, force: true });
}

async function writeFixture(source) {
  await writeFile(join(worktreeRoot, filePath), `${source.trim()}\n`);
}

async function report(port) {
  return postJson(`http://localhost:${port}/tools/synapse_report`, {
    repoId: "local",
    sessionId: "alice",
    filePath
  });
}

async function readState(port) {
  const response = await fetch(`http://localhost:${port}/state?repoId=local`);
  assert.equal(response.ok, true);
  return response.json();
}
