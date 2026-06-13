import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { URL } from "node:url";
import {
  createEmptyTeamState,
  createLogger,
  deriveProjectKey,
  MetricsRegistry,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  parseClientMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type TeamState,
  type WireEnvelope
} from "@synapse/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { createEmbeddingProvider } from "./embeddings.js";
import { gitHubPushToNotify, gitHubRepoEventToNotify } from "./github.js";
import { applyMessage, pruneExpiredLocks, repoIdFor } from "./state.js";
import { createStateStore } from "./store.js";

const port = Number(process.env.SYNAPSE_SERVER_PORT ?? 4010);
const host = process.env.SYNAPSE_SERVER_HOST ?? "127.0.0.1";
// Reported on /health so `synapse doctor` can compare client/server versions.
const SERVER_VERSION =
  (createRequire(import.meta.url)("../package.json") as { version?: string }).version ?? "0.0.0";
// Auth mode for the daemon<->server channel, resolved once at startup:
//   - SYNAPSE_MASTER_SECRET set → "project-key": each request is validated
//     against deriveProjectKey(secret, repoId), so a key grants access to its
//     own project only (real tenancy). The presented credential still arrives
//     via the existing `?token=` / `Authorization: Bearer` path.
//   - else SYNAPSE_AUTH_TOKEN set → "shared-token": today's all-or-nothing
//     behavior — any valid token reads/writes any repo.
//   - else → "open": no auth (local/dev and hermetic tests).
// GitHub OAuth / DB-backed keys are the intended multi-tenant upgrade — see the README.
const masterSecret = process.env.SYNAPSE_MASTER_SECRET ?? "";
const authToken = process.env.SYNAPSE_AUTH_TOKEN ?? "";
const authMode: "project-key" | "shared-token" | "open" = masterSecret
  ? "project-key"
  : authToken
    ? "shared-token"
    : "open";
// Durable per-repo state. In-memory cache is the hot-path working copy; every
// mutation in state.ts emits the matching per-entity store op (plan M8), so a
// restart resumes live state row-by-row. SYNAPSE_DATABASE_URL selects
// Postgres; SYNAPSE_DB_PATH a SQLite file; neither means in-memory SQLite.
const store = await createStateStore();
const states = new Map<string, TeamState>();
const roomClients = new Map<string, Set<WebSocket>>();
const log = createLogger("synapse-server");
const metrics = new MetricsRegistry();
// Multi-instance fan-out (plan M9): with SYNAPSE_REDIS_URL set, a mutation on
// any instance PUBLISHes the repo channel; the others re-read the repo from
// the shared store and re-broadcast to their local rooms. Unset → null, and
// everything below behaves exactly as the single-instance path always has.
// RAG memory (plan C1/C2): vector index over summaries/resolutions/events on
// the shared Postgres via pgvector. Requires both SYNAPSE_DATABASE_URL and an
// embedding provider (SYNAPSE_EMBED_BASE_URL); otherwise null and /recall
// answers degraded — the daemon's deterministic why floor stands alone.
const embeddingProvider = createEmbeddingProvider();
const memory =
  embeddingProvider && process.env.SYNAPSE_DATABASE_URL
    ? await (async () => {
        const { VectorMemory } = await import("./memory.js");
        const vectorMemory = new VectorMemory(process.env.SYNAPSE_DATABASE_URL!, embeddingProvider);
        await vectorMemory.init();
        return vectorMemory;
      })()
    : null;

const instanceId = randomUUID();
const fanout = process.env.SYNAPSE_REDIS_URL
  ? await (await import("./fanout.js")).createRedisFanout({
      redisUrl: process.env.SYNAPSE_REDIS_URL,
      instanceId,
      store,
      onRemoteChange: async (repoId) => {
        // Mark-dirty + reload under the repo lock: the reload is serialized
        // with local message applies, so it can never roll the cache back to
        // a pre-mutation read (lost update).
        const fresh = await withRepo(repoId, () => {
          dirtyRepos.add(repoId);
          return getState(repoId);
        });
        metrics.count("synapse_fanout_refreshes_total");
        log.debug("fanout.refreshed", { repoId, sessions: fresh.sessions.length });
        broadcast(repoId, envelope("state.snapshot", { teamState: fresh }));
      }
    })
  : null;
// Repos whose cache must be re-read from the shared store (a remote instance
// mutated them), and the one in-flight load per repo that everyone awaits.
const dirtyRepos = new Set<string>();
const loadsInFlight = new Map<string, Promise<TeamState>>();
// Per-repo async mutex: every path that reads-then-writes the repo's cache
// entry (message apply, webhook apply, snapshot reads, remote refresh) runs
// inside it. Without this, a load that started before a local mutation can
// complete after it and roll the cached state back (a lost update — observed
// as a session vanishing until the next heartbeat).
const repoLocks = new Map<string, Promise<unknown>>();

function withRepo<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(repoId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  repoLocks.set(
    repoId,
    next.catch(() => {})
  );
  return next;
}

const httpServer = createServer((request, response) => {
  void handleHttp(request, response);
});

async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    // Stays open (no auth) so doctor can reach it before proving the token.
    writeJson(response, 200, {
      ok: true,
      service: "synapse-server",
      version: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      minProtocolVersion: MIN_SUPPORTED_PROTOCOL_VERSION
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/metrics") {
    // Aggregate counters only (no repo content or identity) — open like /health.
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    response.end(metrics.renderPrometheus());
    return;
  }

  if (request.method === "GET" && url.pathname === "/state") {
    const repoId = url.searchParams.get("repoId") ?? "local";
    if (!authorized(request, url, repoId)) {
      metrics.count("synapse_auth_rejections_total", { surface: "state" });
      log.warn("auth.rejected", { surface: "state", repoId });
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    writeJson(response, 200, await withRepo(repoId, () => getState(repoId)));
    return;
  }

  if (request.method === "POST" && url.pathname === "/recall") {
    let body: { repoId?: string; query?: string; limit?: number };
    try {
      body = JSON.parse(await readBody(request)) as typeof body;
    } catch {
      writeJson(response, 400, { ok: false, error: "invalid_json" });
      return;
    }
    const repoId = body.repoId ?? "local";
    if (!authorized(request, url, repoId)) {
      metrics.count("synapse_auth_rejections_total", { surface: "recall" });
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (!body.query) {
      writeJson(response, 400, { ok: false, error: "query_required" });
      return;
    }
    if (!memory || memory.degraded()) {
      writeJson(response, 200, { degraded: true, matches: [] });
      return;
    }
    try {
      const matches = await memory.recall(repoId, body.query, Math.min(body.limit ?? 5, 20));
      metrics.count("synapse_recall_total");
      writeJson(response, 200, { degraded: false, matches });
    } catch (error) {
      log.warn("recall.failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      writeJson(response, 200, { degraded: true, matches: [] });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/webhooks/github") {
    await handleGitHubWebhook(request, response, url);
    return;
  }

  writeJson(response, 404, { error: "not_found" });
}

// Ingress hard cap: a single wire message or webhook body larger than this is
// rejected outright (nothing legitimate approaches it — deltas carry
// signatures, never file bodies).
const MAX_PAYLOAD_BYTES = Number(process.env.SYNAPSE_MAX_PAYLOAD_BYTES ?? 1_048_576);

const wsServer = new WebSocketServer({
  server: httpServer,
  maxPayload: MAX_PAYLOAD_BYTES,
  // Reject the handshake itself when the token is missing/wrong, so an
  // unauthenticated client never enters a repo room.
  verifyClient: (info, done) => {
    const url = new URL(info.req.url ?? "/", "ws://localhost");
    const repoId = url.searchParams.get("repoId") ?? "local";

    // Protocol negotiation (plan M15): refuse an incompatible dialect at the
    // handshake with an explicit reason, instead of failing opaquely on every
    // message. No `v` param = a pre-negotiation client = version 1.
    const announced = url.searchParams.get("v");
    const negotiated = negotiateProtocolVersion(
      announced === null ? undefined : Number(announced)
    );
    if (!negotiated.ok) {
      metrics.count("synapse_protocol_refusals_total");
      log.warn("protocol.refused", { announced, reason: negotiated.reason });
      done(false, 426, negotiated.reason, {
        "x-synapse-protocol": String(PROTOCOL_VERSION),
        "x-synapse-protocol-min": String(MIN_SUPPORTED_PROTOCOL_VERSION)
      });
      return;
    }

    if (authorized(info.req, url, repoId)) {
      done(true);
    } else {
      metrics.count("synapse_auth_rejections_total", { surface: "ws" });
      log.warn("auth.rejected", { surface: "ws", repoId });
      done(false, 401, "Unauthorized");
    }
  }
});

// Transport-level liveness: the daemon already sends an app-level heartbeat,
// but a half-open socket (machine sleep, dropped NAT mapping) still looks OPEN
// to both sides. The server pings every client; one missed pong window means
// the socket is dead — terminate it so the daemon's backoff reconnects cleanly.
const socketAlive = new WeakMap<WebSocket, boolean>();
// Agreed wire version per socket (plan M15) — the downgrade seam for D3.
const socketProtocol = new WeakMap<WebSocket, number>();

// Ingress rate limiting (G4): a sliding one-minute window per WS connection
// and a global one for the webhook endpoint. The defaults are far above any
// legitimate flow (a daemon heartbeats twice a minute and bursts a handful of
// messages per edit), so only a runaway or hostile client ever hits them; an
// over-limit message is acked as an error and dropped before any mutation.
// Set a limit to 0 to disable it.
const WS_RATE_LIMIT_PER_MIN = Number(process.env.SYNAPSE_RATE_LIMIT_PER_MIN ?? 600);
const WEBHOOK_RATE_LIMIT_PER_MIN = Number(process.env.SYNAPSE_WEBHOOK_RATE_LIMIT_PER_MIN ?? 120);

interface RateWindow {
  windowStartedAt: number;
  count: number;
}

const socketRates = new WeakMap<WebSocket, RateWindow>();
const webhookRate: RateWindow = { windowStartedAt: 0, count: 0 };

function overRateLimit(window: RateWindow, limitPerMinute: number, now: number): boolean {
  if (limitPerMinute <= 0) {
    return false;
  }
  if (now - window.windowStartedAt >= 60_000) {
    window.windowStartedAt = now;
    window.count = 0;
  }
  window.count += 1;
  return window.count > limitPerMinute;
}
const pingIntervalMs = Number(process.env.SYNAPSE_WS_PING_INTERVAL_MS ?? 20_000);

wsServer.on("headers", (headers) => {
  headers.push(
    `x-synapse-protocol: ${PROTOCOL_VERSION}`,
    `x-synapse-protocol-min: ${MIN_SUPPORTED_PROTOCOL_VERSION}`
  );
});

wsServer.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/", "ws://localhost");
  const repoId = url.searchParams.get("repoId") ?? "local";
  const announced = url.searchParams.get("v");
  const negotiated = negotiateProtocolVersion(announced === null ? undefined : Number(announced));
  // The seam for graceful downgrade: outbound messages to this socket should
  // use its agreed dialect. Today there is exactly one dialect (v1), so this
  // is recorded (and observable) but never branches.
  socketProtocol.set(socket, negotiated.ok ? negotiated.agreed : PROTOCOL_VERSION);
  log.debug("protocol.negotiated", {
    repoId,
    announced,
    agreed: negotiated.ok ? negotiated.agreed : PROTOCOL_VERSION
  });
  joinRoom(repoId, socket);
  socketAlive.set(socket, true);
  metrics.count("synapse_ws_connections_total");
  log.info("ws.open", { repoId });
  void withRepo(repoId, () => getState(repoId)).then((state) =>
    send(socket, envelope("state.snapshot", { teamState: state }))
  );

  socket.on("pong", () => {
    socketAlive.set(socket, true);
  });

  socket.on("message", (data) => {
    void handleMessage(socket, repoId, data.toString());
  });

  socket.on("close", () => {
    leaveRoom(repoId, socket);
    metrics.count("synapse_ws_closes_total");
    log.info("ws.close", { repoId });
  });
});

const pingTimer = setInterval(() => {
  for (const socket of wsServer.clients) {
    if (socketAlive.get(socket) === false) {
      metrics.count("synapse_ws_terminated_total");
      log.warn("ws.terminated_dead", {});
      socket.terminate();
      continue;
    }
    socketAlive.set(socket, false);
    socket.ping();
  }
}, pingIntervalMs);
pingTimer.unref();

httpServer.listen(port, host, () => {
  console.log(`synapse server listening on http://${host}:${port}`);
});

// Drain the store's op queue and close it cleanly on shutdown so a restart
// resumes from consistent rows.
const shutdown = (): void => {
  httpServer.close();
  void Promise.allSettled([fanout?.close(), memory?.close()])
    .then(() => store.close())
    .finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function handleMessage(socket: WebSocket, fallbackRepoId: string, raw: string): Promise<void> {
  let rate = socketRates.get(socket);
  if (!rate) {
    rate = { windowStartedAt: 0, count: 0 };
    socketRates.set(socket, rate);
  }
  if (overRateLimit(rate, WS_RATE_LIMIT_PER_MIN, Date.now())) {
    metrics.count("synapse_rate_limited_total", { surface: "ws" });
    if (rate.count === WS_RATE_LIMIT_PER_MIN + 1) {
      log.warn("rate.limited", { surface: "ws", repoId: fallbackRepoId, limit: WS_RATE_LIMIT_PER_MIN });
    }
    send(socket, envelope("ack", { forId: "unknown", ok: false, error: "rate_limited" }));
    return;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    metrics.count("synapse_message_failures_total", { reason: "invalid_json" });
    send(socket, envelope("ack", { forId: "unknown", ok: false, error: "invalid_json" }));
    return;
  }

  // Validate the shape before any mutation runs: a malformed payload gets an
  // ack error instead of poisoning the persisted TeamState.
  const validated = parseClientMessage(parsed);
  if (!validated.ok) {
    const forId =
      parsed && typeof parsed === "object" && typeof (parsed as { id?: unknown }).id === "string"
        ? (parsed as { id: string }).id
        : "unknown";
    metrics.count("synapse_message_failures_total", { reason: "invalid_message" });
    log.warn("message.invalid", { error: validated.error });
    send(socket, envelope("ack", { forId, ok: false, error: validated.error }));
    return;
  }
  const message: ClientMessage = validated.message;

  try {
    const messageRepoId = repoIdFor(message);
    // In project-key mode the connection is authorized for exactly one repo
    // (fallbackRepoId, bound at the handshake). Reject any message whose payload
    // targets a different repo, so a client authorized for A cannot drive writes
    // into B through the message body.
    if (
      authMode === "project-key" &&
      messageRepoId !== null &&
      messageRepoId !== fallbackRepoId
    ) {
      metrics.count("synapse_message_failures_total", { reason: "forbidden_repo" });
      log.warn("message.forbidden_repo", { type: message.type, repoId: messageRepoId });
      send(socket, envelope("ack", { forId: message.id, ok: false, error: "forbidden_repo" }));
      return;
    }

    const repoId = messageRepoId ?? fallbackRepoId;
    const startedAt = performance.now();
    const state = await withRepo(repoId, async () => {
      const current = await getState(repoId);
      applyMessage(current, repoId, message, store);
      return current;
    });
    metrics.count("synapse_messages_total", { type: message.type });
    metrics.observe("synapse_message_apply_ms", performance.now() - startedAt);
    indexMemory(repoId, message);
    log.debug("message.applied", { type: message.type, repoId, sessions: state.sessions.length });
    send(socket, envelope("ack", { forId: message.id, ok: true }));
    broadcast(repoId, envelope("state.snapshot", { teamState: state }));
    fanout?.publish(repoId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown_error";
    metrics.count("synapse_message_failures_total", { reason: "apply_error" });
    log.error("message.failed", { type: message.type, reason });
    send(socket, envelope("ack", { forId: message.id, ok: false, error: reason }));
  }
}

async function handleGitHubWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<void> {
  if (overRateLimit(webhookRate, WEBHOOK_RATE_LIMIT_PER_MIN, Date.now())) {
    metrics.count("synapse_rate_limited_total", { surface: "webhook" });
    log.warn("rate.limited", { surface: "webhook", limit: WEBHOOK_RATE_LIMIT_PER_MIN });
    writeJson(response, 429, { ok: false, error: "rate_limited" });
    return;
  }

  const secret = process.env.SYNAPSE_GITHUB_WEBHOOK_SECRET;
  // G4: a server running with auth (shared token or project keys) is a
  // production posture — an unsigned, internet-reachable webhook that mutates
  // team state is not acceptable there. Open mode (local/dev) stays unchanged.
  if (authMode !== "open" && !secret) {
    metrics.count("synapse_webhook_rejections_total", { reason: "secret_required" });
    log.warn("webhook.secret_required", { authMode });
    writeJson(response, 403, {
      ok: false,
      error: "webhook_secret_required",
      detail:
        "This server runs with auth enabled; set SYNAPSE_GITHUB_WEBHOOK_SECRET (and configure the same secret on the GitHub webhook) to accept webhooks."
    });
    return;
  }

  let raw: string;
  try {
    raw = await readBody(request);
  } catch {
    metrics.count("synapse_message_failures_total", { reason: "payload_too_large" });
    writeJson(response, 413, { ok: false, error: "payload_too_large" });
    return;
  }
  if (secret && !validGitHubSignature(raw, headerValue(request, "x-hub-signature-256"), secret)) {
    writeJson(response, 401, { ok: false, error: "invalid_signature" });
    return;
  }

  const event = headerValue(request, "x-github-event") ?? "unknown";
  metrics.count("synapse_webhooks_total", { event });
  log.info("webhook.received", { event });
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    writeJson(response, 400, { ok: false, error: "invalid_json" });
    return;
  }

  try {
    if (event !== "push" && !repoEventSupported(event)) {
      writeJson(response, 202, { ok: true, ignored: true, event });
      return;
    }

    if (event !== "push") {
      const repoEvent = gitHubRepoEventToNotify(event, payload, url.searchParams.get("repoId"));
      const state = await withRepo(repoEvent.repoId, async () => {
        const current = await getState(repoEvent.repoId);
        applyMessage(current, repoEvent.repoId, clientEnvelope("repo.event", repoEvent.payload), store);
        return current;
      });
      broadcast(repoEvent.repoId, envelope("state.snapshot", { teamState: state }));
      fanout?.publish(repoEvent.repoId);
      writeJson(response, 202, {
        ok: true,
        repoId: repoEvent.repoId,
        event,
        kind: repoEvent.payload.kind,
        action: repoEvent.payload.action
      });
      return;
    }

    const push = gitHubPushToNotify(payload, url.searchParams.get("repoId"));
    const state = await withRepo(push.repoId, async () => {
      const current = await getState(push.repoId);
      applyMessage(current, push.repoId, clientEnvelope("push.notify", push.payload), store);
      return current;
    });
    broadcast(push.repoId, envelope("state.snapshot", { teamState: state }));
    fanout?.publish(push.repoId);
    writeJson(response, 202, {
      ok: true,
      repoId: push.repoId,
      sha: push.payload.sha,
      files: push.payload.files
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown_error";
    writeJson(response, 400, { ok: false, error: reason });
  }
}

/**
 * Feed the narrative artifacts into the vector memory as they arrive. Only
 * prose (titles, summaries, rationales) is embedded — never raw code.
 */
function indexMemory(repoId: string, message: ClientMessage): void {
  if (!memory) {
    return;
  }
  if (message.type === "session.summary") {
    const summary = message.payload.summary;
    memory.index(repoId, {
      id: `summary:${summary.sessionId}`,
      kind: "session_summary",
      title: `${summary.memberLogin}'s session summary`,
      summary: summary.summary,
      reference: summary.sessionId,
      createdAt: summary.endedAt
    });
  } else if (message.type === "resolution.propose") {
    const resolution = message.payload.resolution;
    memory.index(repoId, {
      id: `resolution:${resolution.symbol.raw}:${resolution.inputsHash}`,
      kind: "resolution",
      title: `Resolution for ${resolution.symbol.raw}`,
      summary: `${resolution.rationale} ${resolution.instruction}`,
      reference: resolution.symbol.raw,
      createdAt: resolution.createdAt
    });
  } else if (message.type === "repo.event") {
    memory.index(repoId, {
      id: `event:${message.id}`,
      kind: "repo_event",
      title: message.payload.title,
      // The distilled body prose (PR description / review / comment) is what
      // makes the memory citable as a decision — still prose only, the
      // distiller strips code before it ever reaches the wire.
      summary: message.payload.detail
        ? `${message.payload.summary} — ${message.payload.detail}`
        : message.payload.summary,
      reference: message.payload.url,
      createdAt: new Date().toISOString()
    });
  }
}

function repoEventSupported(event: string): boolean {
  return event === "pull_request" || event === "pull_request_review" || event === "issue_comment";
}

async function getState(repoId: string): Promise<TeamState> {
  let state = states.get(repoId);
  // Cache miss or remote change: rebuild from persisted rows. One load per
  // repo is in flight at a time and every caller awaits the same promise, so
  // a slow load can never overwrite a cache entry that a faster path (or a
  // local mutation) refreshed in the meantime. Loop: a dirty mark set while a
  // load was already in flight needs one more pass to be observed.
  while (!state || dirtyRepos.has(repoId)) {
    let inFlight = loadsInFlight.get(repoId);
    if (!inFlight) {
      inFlight = (async () => {
        dirtyRepos.delete(repoId);
        const fresh = (await store.load(repoId)) ?? createEmptyTeamState(repoId);
        states.set(repoId, fresh);
        loadsInFlight.delete(repoId);
        log.debug("state.loaded", { repoId, sessions: fresh.sessions.length });
        return fresh;
      })();
      loadsInFlight.set(repoId, inFlight);
    }
    state = await inFlight;
  }

  pruneExpiredLocks(state, store);
  return state;
}

function joinRoom(repoId: string, socket: WebSocket): void {
  let clients = roomClients.get(repoId);
  if (!clients) {
    clients = new Set();
    roomClients.set(repoId, clients);
  }

  clients.add(socket);
}

function leaveRoom(repoId: string, socket: WebSocket): void {
  roomClients.get(repoId)?.delete(socket);
}

function broadcast<TType extends ServerMessage["type"]>(
  repoId: string,
  message: Extract<ServerMessage, WireEnvelope<TType>>
): void {
  for (const client of roomClients.get(repoId) ?? []) {
    send(client, message);
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function envelope<TType extends ServerMessage["type"]>(
  type: TType,
  payload: Extract<ServerMessage, WireEnvelope<TType>>["payload"]
): Extract<ServerMessage, WireEnvelope<TType>> {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: randomUUID(),
    ts: new Date().toISOString(),
    payload
  } as Extract<ServerMessage, WireEnvelope<TType>>;
}

function clientEnvelope<TType extends ClientMessage["type"]>(
  type: TType,
  payload: Extract<ClientMessage, WireEnvelope<TType>>["payload"]
): Extract<ClientMessage, WireEnvelope<TType>> {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: randomUUID(),
    ts: new Date().toISOString(),
    payload
  } as Extract<ClientMessage, WireEnvelope<TType>>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_PAYLOAD_BYTES) {
      request.destroy();
      throw new Error("payload_too_large");
    }
  }

  return body;
}

/**
 * True when the request is authorized for `repoId`:
 *   - open mode: always (no auth configured).
 *   - shared-token mode: the presented credential matches SYNAPSE_AUTH_TOKEN
 *     (grants any repo).
 *   - project-key mode: the presented credential matches
 *     deriveProjectKey(masterSecret, repoId) — so a key validates against its
 *     own project only.
 * The credential arrives via `?token=` or an `Authorization: Bearer` header; the
 * comparison is constant-time to avoid leaking it through timing.
 */
function authorized(request: IncomingMessage, url: URL, repoId: string): boolean {
  if (authMode === "open") {
    return true;
  }

  const fromQuery = url.searchParams.get("token");
  const header = headerValue(request, "authorization");
  const fromHeader = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  const provided = fromQuery ?? fromHeader;
  if (!provided) {
    return false;
  }

  const expected =
    authMode === "project-key" ? deriveProjectKey(masterSecret, repoId) : authToken;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validGitHubSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature?.startsWith("sha256=")) {
    return false;
  }

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body, null, 2));
}
