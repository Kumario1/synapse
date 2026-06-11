import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// RAG memory (plan C1/C2): session summaries / resolutions / repo events are
// embedded into pgvector behind the optional provider seam, and `synapse_why`
// answers HYBRID — the deterministic lexical floor always stands, vector
// recall only adds sources on top, every answer line still cites a source.
// Proven here with a deterministic stub embedding endpoint (synonym groups →
// shared vector buckets, zero network): a question with NO lexical overlap
// with the memory still finds it through vectors; with RAG disabled the same
// question finds nothing; a server without an embedding provider answers
// /recall degraded:true and the floor stands alone.
// Needs Postgres with the pgvector extension (CI: pgvector/pgvector image);
// SKIPs without SYNAPSE_VERIFY_PG_URL or when the extension is unavailable.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pgUrl = process.env.SYNAPSE_VERIFY_PG_URL ?? process.env.SYNAPSE_DATABASE_URL;

if (!pgUrl) {
  console.log("RAG verification skipped: set SYNAPSE_VERIFY_PG_URL to run it.");
  process.exit(0);
}

// Preflight: reachable AND pgvector available; missing extension → SKIP (the
// runtime is absent, like a missing Go toolchain), unreachable → fail.
{
  const require = createRequire(join(rootDir, "apps/server/package.json"));
  const { default: pg } = await import(require.resolve("pg"));
  const client = new pg.Client({ connectionString: pgUrl, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  } catch {
    console.log("RAG verification skipped: the pgvector extension is not available on this Postgres.");
    await client.end();
    process.exit(0);
  }
  await client.end();
}

const children = [];
const repoId = `ragverify/${Date.now()}`;
const DIM = 64;

// Deterministic "semantic" embeddings: words in the same synonym group land in
// the same bucket, so paraphrases are close in cosine space and unrelated
// text is orthogonal — no model, no network, same vectors every run.
const SYNONYM_GROUPS = [
  ["token", "credential", "credentials"],
  ["validate", "validation", "checking", "check"],
  ["change", "changed", "shift", "shifted", "reshaped"],
  ["contract", "signature", "agreement"]
];

function embed(text) {
  const vector = new Array(DIM).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean)) {
    const group = SYNONYM_GROUPS.findIndex((candidates) => candidates.includes(word));
    let bucket;
    if (group !== -1) {
      bucket = group;
    } else {
      let hash = 0;
      for (const char of word) {
        hash = (hash * 31 + char.charCodeAt(0)) | 0;
      }
      bucket = SYNONYM_GROUPS.length + (Math.abs(hash) % (DIM - SYNONYM_GROUPS.length));
    }
    vector[bucket] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

const embedServer = createHttpServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const { input } = JSON.parse(body);
    const texts = Array.isArray(input) ? input : [input];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: texts.map((text) => ({ embedding: embed(text) })) }));
  });
});
embedServer.listen(0, "127.0.0.1");
await once(embedServer, "listening");
const embedPort = embedServer.address().port;

try {
  // --- Server A: Postgres + stub embeddings → RAG active. ---
  const ragPort = await freePort();
  startServer("rag", ragPort, {
    SYNAPSE_DATABASE_URL: pgUrl,
    SYNAPSE_EMBED_BASE_URL: `http://localhost:${embedPort}`,
    SYNAPSE_EMBED_DIM: String(DIM),
    SYNAPSE_LOG_LEVEL: "debug"
  });
  await waitForHttp(`http://localhost:${ragPort}/health`);

  // Seed two memories over the wire: the target summary and a decoy event.
  const ws = await openSocket(`ws://localhost:${ragPort}?repoId=${encodeURIComponent(repoId)}&v=1`);
  ws.send(JSON.stringify(envelope("session.summary", {
    repoId,
    summary: {
      sessionId: "alice-session",
      repoId,
      memberLogin: "alice",
      task: "auth work",
      summary: "alice changed the token validate contract to return Result",
      symbols: [{ raw: "ts:src/auth/token.ts#validate" }],
      deltaCount: 1,
      source: "deterministic",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString()
    }
  })));
  ws.send(JSON.stringify(envelope("repo.event", {
    repoId,
    kind: "pull_request",
    action: "opened",
    actor: "bob",
    title: "Dashboard color palette tweaks",
    summary: "bob tweaked the dashboard color palette",
    number: 7
  })));

  // Wait until both memories are indexed (recall sees them directly).
  await waitFor(async () => {
    const recall = await postJson(`http://localhost:${ragPort}/recall`, {
      repoId,
      query: "token validate contract"
    });
    return recall.degraded === false && recall.matches.length === 2;
  }, 10_000, "both memories indexed into pgvector");

  // --- Daemon against the RAG server. ---
  const daemonPort = await freePort();
  startDaemon("alice", daemonPort, ragPort);
  await waitForHttp(`http://localhost:${daemonPort}/health`);

  // The question shares NO lexical term (or substring) with the memory text —
  // the deterministic floor alone finds nothing…
  const question = "why did the credential checking agreement shift?";
  const floor = await postJson(`http://localhost:${daemonPort}/tools/synapse_why`, {
    repoId,
    sessionId: "alice",
    question,
    // RAG disabled for this call's baseline via a second daemon below; here
    // we first prove the hybrid path:
  });
  assert.equal(floor.rag, true, "vector recall contributed (rag: true)");
  assert.ok(floor.sources.length >= 1, "hybrid why has sources");
  assert.equal(
    floor.sources[0].summary.includes("token validate contract"),
    true,
    "the semantically-matching memory is cited"
  );
  assert.ok(
    floor.answer.includes("1. "),
    "the answer keeps the numbered-citation contract"
  );
  assert.ok(
    !floor.sources.some((s) => s.summary.includes("color palette")) ||
      floor.sources[0].summary.includes("token validate contract"),
    "the decoy never outranks the semantic match"
  );

  // --- Same question with RAG disabled: the floor finds nothing. ---
  const noRagPort = await freePort();
  startDaemon("norag", noRagPort, ragPort, { SYNAPSE_RAG: "0" });
  await waitForHttp(`http://localhost:${noRagPort}/health`);
  const lexicalOnly = await postJson(`http://localhost:${noRagPort}/tools/synapse_why`, {
    repoId,
    sessionId: "norag",
    question
  });
  assert.ok(!lexicalOnly.rag, "no rag flag without recall");
  assert.equal(lexicalOnly.sources.length, 0, "the lexical floor alone finds nothing");
  assert.ok(lexicalOnly.answer.includes("No matching Synapse memory"), "floor answer preserved");

  // --- Server B: no embedding provider → /recall degraded, floor stands. ---
  const plainPort = await freePort();
  startServer("plain", plainPort, { SYNAPSE_DATABASE_URL: pgUrl });
  await waitForHttp(`http://localhost:${plainPort}/health`);
  const degraded = await postJson(`http://localhost:${plainPort}/recall`, {
    repoId,
    query: question
  });
  assert.equal(degraded.degraded, true, "no provider → degraded:true");
  assert.deepEqual(degraded.matches, []);

  console.log("RAG verification passed:");
  console.log(
    JSON.stringify(
      {
        hybridRag: floor.rag,
        citedMemory: floor.sources[0].title,
        lexicalFloorAlone: lexicalOnly.sources.length,
        degradedWithoutProvider: degraded.degraded
      },
      null,
      2
    )
  );
  ws.close();
} finally {
  embedServer.close();
  await stopChildren();
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
    "--worktree-root", rootDir
  ], env);
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
  }, timeoutMs, `reach ${url}`);
}

async function waitFor(predicate, timeoutMs, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
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
