import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic: pin the coordination room so git-remote derivation does not pick up the host repo.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(rootDir, "apps/cli/dist/index.js");
const children = [];

const serverPort = await freePort();
const bobPort = await freePort();
const bobRoot = await mkdtemp(join(tmpdir(), "synapse-gh-brief-bob-"));
const webhookSecret = "synapse-github-briefing-secret";

try {
  await writeLocalConfig(bobRoot, bobPort, "bob");

  startProcess("server", ["apps/server/dist/index.js"], rootDir, {
    SYNAPSE_SERVER_PORT: String(serverPort),
    SYNAPSE_GITHUB_WEBHOOK_SECRET: webhookSecret
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  startProcess(
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
      bobRoot
    ],
    rootDir,
    {}
  );
  await waitForHttp(`http://localhost:${bobPort}/health`);
  await waitForState(serverPort, (state) => state.sessions.length === 1);

  const pr = await postGitHub("pull_request", {
    action: "opened",
    repository: { full_name: "acme/widgets" },
    sender: { login: "alice" },
    pull_request: {
      number: 42,
      title: "Add billing ledger",
      html_url: "https://github.com/acme/widgets/pull/42",
      merged: false
    }
  });
  assert.deepEqual(pr, {
    ok: true,
    repoId: "local",
    event: "pull_request",
    kind: "pull_request",
    action: "opened"
  });

  const review = await postGitHub("pull_request_review", {
    action: "submitted",
    repository: { full_name: "acme/widgets" },
    sender: { login: "carol" },
    pull_request: {
      number: 42,
      title: "Add billing ledger",
      html_url: "https://github.com/acme/widgets/pull/42"
    },
    review: {
      state: "approved",
      html_url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1"
    }
  });
  assert.equal(review.kind, "pull_request_review");
  assert.equal(review.action, "approved");

  const comment = await postGitHub("issue_comment", {
    action: "created",
    repository: { full_name: "acme/widgets" },
    sender: { login: "dana" },
    issue: {
      number: 42,
      title: "Add billing ledger",
      html_url: "https://github.com/acme/widgets/pull/42",
      pull_request: {}
    },
    comment: {
      html_url: "https://github.com/acme/widgets/pull/42#issuecomment-1"
    }
  });
  assert.equal(comment.kind, "issue_comment");
  assert.equal(comment.action, "created");

  const ignored = await postGitHub("ping", { repository: { full_name: "acme/widgets" } });
  assert.deepEqual(ignored, { ok: true, ignored: true, event: "ping" });

  const state = await waitForState(serverPort, (candidate) => candidate.recentRepoEvents.length === 3);
  assertSummaries(state.recentRepoEvents);

  await waitForDaemonState(bobPort, (candidate) => candidate.recentRepoEvents.length === 3);

  const briefing = await postJson(`http://localhost:${bobPort}/tools/synapse_whatsup`, {
    repoId: "local",
    sessionId: "bob"
  });
  assert.equal(briefing.recentRepoEvents.length, 3);
  assert.ok(briefing.summary.some((line) => line.includes("3 GitHub repo events")));
  assertSummaries(briefing.recentRepoEvents);

  const out = await runSessionStartHook(bobRoot);
  assert.ok(out, "session-start hook emitted a briefing");
  const context = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(context.includes("Recent GitHub activity"));
  assert.ok(context.includes("GitHub PR #42 opened: Add billing ledger"));
  assert.ok(context.includes("GitHub review approved on PR #42: Add billing ledger"));
  assert.ok(context.includes("GitHub comment created on PR #42: Add billing ledger"));

  console.log("GitHub briefing verification passed:");
  console.log(JSON.stringify({ state: state.recentRepoEvents, briefing, sessionStart: context }, null, 2));
} finally {
  await stopChildren();
  await rm(bobRoot, { recursive: true, force: true });
}

function assertSummaries(events) {
  const summaries = events.map((event) => event.summary);
  assert.ok(summaries.includes("GitHub PR #42 opened: Add billing ledger"));
  assert.ok(summaries.includes("GitHub review approved on PR #42: Add billing ledger"));
  assert.ok(summaries.includes("GitHub comment created on PR #42: Add billing ledger"));
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

function runSessionStartHook(worktreeRoot) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, "hook", "session-start"], {
      cwd: worktreeRoot,
      env: { ...process.env, INIT_CWD: worktreeRoot },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`hook session-start exited ${code}: ${stderr}`));
        return;
      }

      const trimmed = stdout.trim();
      resolvePromise(trimmed ? JSON.parse(trimmed) : null);
    });
    child.stdin.end(
      JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: worktreeRoot })
    );
  });
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
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
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
