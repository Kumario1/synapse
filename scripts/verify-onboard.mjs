import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// `synapse onboard` (plan C4 slice): a first-session deep briefing — the full
// team digest plus the room's cited decision history. Proven here in three
// legs: (1) floor — a populated room renders sections + numbered decisions
// with no RAG involved; (2) empty/degraded — a daemon that cannot reach its
// server still answers with the pinned no-history line, never a throw;
// (3) RAG (gated on SYNAPSE_VERIFY_PG_URL + pgvector, SKIPs otherwise) — a
// vector-only memory with no lexical overlap in the digest lands in the
// decisions section via the fixed recall query, rag: true.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
const repoId = `onboardverify/${Date.now()}`;
const worktree = await mkdtemp(join(tmpdir(), "synapse-onboard-"));

try {
  // --- Leg 1: floor on a populated room. ---
  const serverPort = await freePort();
  startServer("server", serverPort, {});
  await waitForHttp(`http://localhost:${serverPort}/health`);

  const alicePort = await freePort();
  startDaemon("alice", alicePort, serverPort);
  await waitForHttp(`http://localhost:${alicePort}/health`);

  // Seed durable memory over the wire (summary) and activity via the tools.
  const ws = await openSocket(`ws://localhost:${serverPort}?repoId=${encodeURIComponent(repoId)}&v=1`);
  ws.send(JSON.stringify(envelope("session.summary", {
    repoId,
    summary: {
      sessionId: "bob-session",
      repoId,
      memberLogin: "bob",
      task: "auth groundwork",
      summary: "architecture decisions: token validation gotchas recorded for newcomers",
      symbols: [{ raw: "ts:src/auth/token.ts#validate" }],
      deltaCount: 1,
      source: "deterministic",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString()
    }
  })));
  await postJson(`http://localhost:${alicePort}/tools/synapse_push`, {
    repoId,
    summary: "Tighten token validation",
    files: ["src/auth/token.ts"]
  });
  await waitFor(async () => {
    const state = await fetchJson(`http://localhost:${alicePort}/state`);
    return state.recentPushes.length >= 1 && state.sessionSummaries.length >= 1;
  }, 10_000, "seeded state reaches the daemon");

  const onboard = await postJson(`http://localhost:${alicePort}/tools/synapse_onboard`, {
    repoId,
    sessionId: "alice"
  });
  assert.equal(onboard.degraded, false, "live daemon is not degraded");
  assert.ok(
    onboard.briefing.startsWith(`🧭 Synapse onboarding briefing for ${repoId}:`),
    "briefing is addressed to the room"
  );
  assert.ok(onboard.briefing.includes("Recent pushes:"), "digest includes pushes");
  assert.ok(onboard.briefing.includes("Decisions & history:"), "decision history present");
  assert.ok(/ {2}1\. /.test(onboard.briefing), "decisions are numbered citations");
  assert.ok(onboard.sections.decisions.length >= 1, "structured decisions present");
  assert.ok(!onboard.rag, "no rag flag without recall");

  // --- Leg 2: empty room / unreachable server → pinned no-history answer. ---
  const deadServerPort = await freePort(); // nothing listens here
  const lonelyPort = await freePort();
  startDaemon("lonely", lonelyPort, deadServerPort, { SYNAPSE_RECONNECT_BASE_MS: "100000" });
  await waitForHttp(`http://localhost:${lonelyPort}/health`);
  const lonely = await postJson(`http://localhost:${lonelyPort}/tools/synapse_onboard`, {
    repoId,
    sessionId: "lonely"
  });
  assert.equal(lonely.degraded, true, "unreachable server → degraded");
  assert.ok(
    lonely.briefing.includes("No recorded team history yet"),
    "empty room answers with the pinned no-history line"
  );
  assert.deepEqual(lonely.sections.decisions, []);

  // --- Leg 3 (PG-gated): vector-only memory reaches the decisions. ---
  const pgUrl = process.env.SYNAPSE_VERIFY_PG_URL ?? process.env.SYNAPSE_DATABASE_URL;
  let ragResult = "SKIP (no SYNAPSE_VERIFY_PG_URL)";
  if (pgUrl && (await pgvectorAvailable(pgUrl))) {
    const DIM = 64;
    const embedServer = createHttpServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const { input } = JSON.parse(body);
        const texts = Array.isArray(input) ? input : [input];
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: texts.map((text) => ({ embedding: embed(text, DIM) })) }));
      });
    });
    embedServer.listen(0, "127.0.0.1");
    await once(embedServer, "listening");
    const embedPort = embedServer.address().port;

    try {
      const ragServerPort = await freePort();
      startServer("rag", ragServerPort, {
        SYNAPSE_DATABASE_URL: pgUrl,
        SYNAPSE_EMBED_BASE_URL: `http://localhost:${embedPort}`,
        SYNAPSE_EMBED_DIM: String(DIM)
      });
      await waitForHttp(`http://localhost:${ragServerPort}/health`);

      // A vector-ONLY memory: seed the decision summary first, then flood 52
      // noise summaries so the state's SESSION_SUMMARY_CAP (50) evicts it —
      // pgvector keeps everything, so onboarding can only cite it through
      // recall. The memory shares words with the daemon's fixed recall query
      // ("key decisions, architecture choices, and gotchas in this
      // repository"); the noise is orthogonal.
      const ragWs = await openSocket(
        `ws://localhost:${ragServerPort}?repoId=${encodeURIComponent(repoId)}&v=1`
      );
      const summaryFor = (sessionId, text) => envelope("session.summary", {
        repoId,
        summary: {
          sessionId,
          repoId,
          memberLogin: sessionId,
          task: null,
          summary: text,
          symbols: [],
          deltaCount: 0,
          source: "deterministic",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString()
        }
      });
      ragWs.send(JSON.stringify(summaryFor(
        "carol-session",
        "architecture decisions and gotchas: webhook retries are capped on purpose"
      )));
      for (let i = 0; i < 52; i += 1) {
        ragWs.send(JSON.stringify(summaryFor(`noise-${i}`, `routine refactor touchup number ${i}`)));
      }
      await waitFor(async () => {
        const state = await fetchJson(`http://localhost:${ragServerPort}/state?repoId=${encodeURIComponent(repoId)}`);
        const evicted = !state.sessionSummaries.some((s) => s.summary.includes("webhook retries"));
        if (!evicted || state.sessionSummaries.length < 50) {
          return false;
        }
        const recall = await postJson(`http://localhost:${ragServerPort}/recall`, {
          repoId,
          query: "key decisions, architecture choices, and gotchas in this repository"
        });
        return (
          recall.degraded === false &&
          recall.matches.some((m) => m.summary.includes("webhook retries"))
        );
      }, 20_000, "decision memory evicted from state but recallable from pgvector");

      const ragDaemonPort = await freePort();
      startDaemon("ragalice", ragDaemonPort, ragServerPort);
      await waitForHttp(`http://localhost:${ragDaemonPort}/health`);

      const ragOnboard = await postJson(`http://localhost:${ragDaemonPort}/tools/synapse_onboard`, {
        repoId,
        sessionId: "ragalice"
      });
      assert.equal(ragOnboard.rag, true, "vector recall contributed (rag: true)");
      assert.ok(
        ragOnboard.sections.decisions.some((d) => d.summary.includes("webhook retries")),
        "the vector-only memory landed in the decisions"
      );
      assert.ok(ragOnboard.briefing.includes("Decisions & history:"));
      ragResult = "PASS";
      ragWs.close();
    } finally {
      embedServer.close();
    }
  } else if (pgUrl) {
    ragResult = "SKIP (pgvector extension unavailable)";
  }
  console.log(`RAG leg: ${ragResult}`);

  console.log("Onboard verification passed:");
  console.log(
    JSON.stringify(
      {
        floorSections: onboard.briefing.split("\n\n").length,
        floorDecisions: onboard.sections.decisions.length,
        emptyRoom: lonely.briefing.includes("No recorded team history yet"),
        rag: ragResult
      },
      null,
      2
    )
  );
  ws.close();
} finally {
  await stopChildren();
  await rm(worktree, { recursive: true, force: true });
}

function embed(text, dim) {
  const vector = new Array(dim).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean)) {
    let hash = 0;
    for (const char of word) {
      hash = (hash * 31 + char.charCodeAt(0)) | 0;
    }
    vector[Math.abs(hash) % dim] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

async function pgvectorAvailable(pgUrl) {
  const require = createRequire(join(rootDir, "apps/server/package.json"));
  const { default: pg } = await import(require.resolve("pg"));
  const client = new pg.Client({ connectionString: pgUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

function envelope(type, payload) {
  return { v: 1, type, id: randomUUID(), ts: new Date().toISOString(), payload };
}

function startServer(label, port, env) {
  startProcess(label, ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(port),
    ...env
  });
}

function startDaemon(member, port, serverPort, env = {}) {
  startProcess(member, [
    "apps/cli/dist/index.js",
    "daemon",
    "--member", member,
    "--session", member,
    "--repo-id", repoId,
    "--port", String(port),
    "--server", `ws://localhost:${serverPort}`,
    "--worktree-root", worktree
  ], { SYNAPSE_FILE_WATCHER: "0", ...env });
}

function openSocket(url) {
  const require = createRequire(join(rootDir, "apps/server/package.json"));
  return import(require.resolve("ws")).then((wsModule) => {
    const WebSocket = wsModule.WebSocket ?? wsModule.default;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.on("open", () => resolve(socket));
      socket.on("error", reject);
      setTimeout(() => reject(new Error(`timed out opening ${url}`)), 5000).unref();
    });
  });
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

async function fetchJson(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${url} not ok`);
  return response.json();
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
