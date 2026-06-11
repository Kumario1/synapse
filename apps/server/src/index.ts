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
import { gitHubPushToNotify, gitHubRepoEventToNotify } from "./github.js";
import { applyMessage, pruneExpiredLocks, repoIdFor } from "./state.js";
import { createStateStore } from "./store.js";

const port = Number(process.env.SYNAPSE_SERVER_PORT ?? 4010);
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

httpServer.listen(port, () => {
  console.log(`synapse server listening on http://localhost:${port}`);
});

// Drain the store's op queue and close it cleanly on shutdown so a restart
// resumes from consistent rows.
const shutdown = (): void => {
  httpServer.close();
  void Promise.allSettled([fanout?.close()])
    .then(() => store.close())
    .finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function handleMessage(socket: WebSocket, fallbackRepoId: string, raw: string): Promise<void> {
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
  let raw: string;
  try {
    raw = await readBody(request);
  } catch {
    metrics.count("synapse_message_failures_total", { reason: "payload_too_large" });
    writeJson(response, 413, { ok: false, error: "payload_too_large" });
    return;
  }
  const secret = process.env.SYNAPSE_GITHUB_WEBHOOK_SECRET;
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
