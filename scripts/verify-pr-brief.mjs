import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.SYNAPSE_REPO_ID ??= "local";
process.env.SYNAPSE_FILE_WATCHER ??= "0";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(rootDir, "apps/cli/dist/index.js");
const children = [];

const serverPort = await freePort();
const alicePort = await freePort();
const bobPort = await freePort();
const aliceRoot = await mkdtemp(join(tmpdir(), "synapse-pr-brief-alice-"));
const bobRoot = await mkdtemp(join(tmpdir(), "synapse-pr-brief-bob-"));
const webhookSecret = "synapse-pr-brief-secret";
const branch = "feature/pr-brief";
const filePath = "src/billing/ledger.ts";
const symbol = "ts:src/billing/ledger.ts#LedgerWriter.commit";

try {
  initGitBranch(aliceRoot, branch);
  initGitBranch(bobRoot, branch);
  await writeLocalConfig(bobRoot, bobPort, "bob", bobRoot);

  startProcess("server", ["apps/server/dist/index.js"], rootDir, {
    SYNAPSE_SERVER_PORT: String(serverPort),
    SYNAPSE_GITHUB_WEBHOOK_SECRET: webhookSecret
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  startDaemon("alice", alicePort, aliceRoot);
  startDaemon("bob", bobPort, bobRoot);
  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`)
  ]);
  await waitForState(serverPort, (state) => state.sessions.length === 2);

  await postJson(`http://localhost:${alicePort}/tools/synapse_report`, {
    repoId: "local",
    sessionId: "alice",
    filePath,
    symbolId: { raw: symbol },
    changeKind: "signature_changed",
    summary: "LedgerWriter.commit now returns a durable receipt id",
    baseSha: "base-pr-brief"
  });
  await waitForState(serverPort, (state) => state.unpushedDeltas.length === 1);

  await postJson(`http://localhost:${alicePort}/tools/synapse_push`, {
    repoId: "local",
    sessionId: "alice",
    sha: "push-pr-brief",
    summary: "Pushed docs for billing ledger rollout",
    files: ["docs/billing-ledger.md"],
    symbols: [{ raw: "ts:src/billing/docs.ts#BillingDocs" }]
  });

  await postGitHub("pull_request", {
    action: "opened",
    repository: { full_name: "local" },
    sender: { login: "alice" },
    pull_request: {
      number: 42,
      title: "Add billing ledger",
      html_url: "https://github.com/acme/widgets/pull/42",
      merged: false
    }
  });
  await postGitHub("pull_request_review", {
    action: "submitted",
    repository: { full_name: "local" },
    sender: { login: "carol" },
    pull_request: {
      number: 42,
      title: "Add billing ledger",
      html_url: "https://github.com/acme/widgets/pull/42"
    },
    review: {
      state: "changes_requested",
      body: "Please keep ledger receipts stable for retry handling.",
      html_url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1"
    }
  });
  await postGitHub("issue_comment", {
    action: "created",
    repository: { full_name: "local" },
    sender: { login: "dana" },
    issue: {
      number: 42,
      title: "Add billing ledger",
      html_url: "https://github.com/acme/widgets/pull/42",
      pull_request: {}
    },
    comment: {
      body: "Coordinate rollout with billing migrations.",
      html_url: "https://github.com/acme/widgets/pull/42#issuecomment-1"
    }
  });

  await waitForDaemonState(
    bobPort,
    (state) =>
      state.unpushedDeltas.length === 1 &&
      state.recentPushes.length === 1 &&
      state.recentRepoEvents.length === 3
  );

  const markdown = runCli([
    "pr-brief",
    "--port",
    String(bobPort),
    "--base",
    "main",
    "--head",
    branch
  ]);
  assert.ok(markdown.includes("# Synapse PR brief"));
  assert.ok(markdown.includes(`Head: ${branch}`));
  assert.ok(markdown.includes("LedgerWriter.commit now returns a durable receipt id"));
  assert.ok(markdown.includes("GitHub PR #42 opened: Add billing ledger"));
  assert.ok(markdown.includes("GitHub review changes_requested on PR #42: Add billing ledger"));
  assert.ok(markdown.includes("GitHub comment created on PR #42: Add billing ledger"));
  assert.ok(markdown.includes("Pushed docs for billing ledger rollout"));
  assert.ok(markdown.includes("## Cited context"));
  assert.ok(markdown.includes("[#42]") || markdown.includes(symbol));

  const json = JSON.parse(runCli(["pr-brief", "--port", String(bobPort), "--head", branch, "--json"]));
  assert.equal(json.base, "main");
  assert.equal(json.head, branch);
  assert.equal(json.sections.unpushedDeltas[0].symbolId.raw, symbol);
  assert.equal(json.sections.recentRepoEvents.length, 3);

  console.log("PR brief verification passed:");
  console.log(markdown);
} finally {
  await stopChildren();
  await rm(aliceRoot, { recursive: true, force: true });
  await rm(bobRoot, { recursive: true, force: true });
}

function initGitBranch(worktreeRoot, branchName) {
  runGit(["init"], worktreeRoot);
  runGit(["checkout", "-b", branchName], worktreeRoot);
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function writeLocalConfig(worktreeRoot, port, sessionId) {
  await mkdir(join(worktreeRoot, ".synapse"), { recursive: true });
  await writeFile(
    join(worktreeRoot, ".synapse/config.json"),
    JSON.stringify(
      { repoId: "local", daemonPort: port, sessionId, member: sessionId, worktreeRoot },
      null,
      2
    )
  );
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
    rootDir,
    {}
  );
}

async function postGitHub(event, body) {
  return postJson(`http://localhost:${serverPort}/webhooks/github?repoId=local`, body, {
    "x-github-event": event,
    ...signedGitHubHeaders(body)
  });
}

function signedGitHubHeaders(body) {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", webhookSecret).update(raw).digest("hex");
  return { "x-hub-signature-256": `sha256=${signature}` };
}

function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: bobRoot,
    env: { ...process.env, INIT_CWD: bobRoot },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function startProcess(label, args, cwd, env) {
  const child = spawn(process.execPath, args, {
    cwd,
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

async function postJson(url, body, extraHeaders = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
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

async function waitForState(port, predicate, timeoutMs = 8000) {
  let lastState = null;

  await waitFor(async () => {
    const response = await fetch(`http://localhost:${port}/state?repoId=local`).catch(() => null);
    if (!response?.ok) {
      return false;
    }

    lastState = await response.json();
    return predicate(lastState);
  }, timeoutMs);

  return lastState;
}

async function waitForDaemonState(port, predicate, timeoutMs = 8000) {
  await waitFor(async () => {
    const response = await fetch(`http://localhost:${port}/state`).catch(() => null);
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
        })
    )
  );
}
