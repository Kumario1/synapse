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
  isSupportedProtocolVersion,
  negotiateProtocolVersion,
  parseClientMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ProtocolVersion,
  type ServerMessage,
  type StateOp,
  type TeamState,
  type WireEnvelope
} from "@synapse/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { createEmbeddingProvider } from "./embeddings.js";
import { exchangeCodeForToken, fetchGitHubUser } from "./auth/github-oauth.js";
import { handleAuthRequest, type AuthContext } from "./auth/routes.js";
import { sessionKeyFromClientSecret } from "./auth/session.js";
import { createUserStore } from "./auth/user-store.js";
import { loadGitHubAppConfig } from "./github-app-config.js";
import { gitHubPushToNotify, gitHubRepoEventToNotify, webhookRepoFullName } from "./github.js";
import {
  applyMessage,
  dueForSweep,
  peerLocksForIntent,
  pruneExpiredLocks,
  pruneStaleSessions,
  repoIdFor
} from "./state.js";
import { getCachedState } from "./state-cache.js";
import { createStateStore, type StateStoreOps } from "./store.js";

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
const log = createLogger("synapse-server");
const githubApp = loadGitHubAppConfig();
const githubWebhookSecret = githubApp.webhookSecret;
if (githubApp.status === "incomplete") {
  log.warn("github_app.incomplete", { missing: githubApp.missing });
}
// Durable per-repo state. In-memory cache is the hot-path working copy; every
// mutation in state.ts emits the matching per-entity store op (plan M8), so a
// restart resumes live state row-by-row. SYNAPSE_DATABASE_URL selects
// Postgres; SYNAPSE_DB_PATH a SQLite file; neither means in-memory SQLite.
const store = await createStateStore();
// Human GitHub sign-in boundary (plan 051). Built ONLY when the GitHub App env
// is fully configured; otherwise null and the SPA shows signed-out. This cookie
// session is identity only — it never authorizes a daemon WS room or `/state`,
// which remain the separate machine-credential boundary (authorized()).
// SYNAPSE_PUBLIC_URL builds the OAuth redirect_uri; defaults to host:port.
const publicOrigin = process.env.SYNAPSE_PUBLIC_URL ?? `http://${host}:${port}`;
const authContext: AuthContext | null =
  githubApp.status === "configured"
    ? await (async () => {
        const userStore = await createUserStore();
        const creds = {
          clientId: githubApp.config.clientId,
          clientSecret: githubApp.config.clientSecret
        };
        const redirectUri = `${publicOrigin}/auth/github/callback`;
        return {
          creds,
          sessionKey: sessionKeyFromClientSecret(creds.clientSecret),
          userStore,
          redirectUri,
          exchangeCodeForToken: (code: string) => exchangeCodeForToken(creds, code, redirectUri),
          fetchGitHubUser: (token: string) => fetchGitHubUser(token),
          isSecure: publicOrigin.startsWith("https:")
        } satisfies AuthContext;
      })()
    : null;
const states = new Map<string, TeamState>();
const roomClients = new Map<string, Set<WebSocket>>();
const repoSeq = new Map<string, number>();
const metrics = new MetricsRegistry();
const deltaBroadcastEnabled = process.env.SYNAPSE_DELTA_BROADCAST !== "0";
// Prune-sweep throttle (plan 038): getState() is called on every inbound
// message; sweeping the lock/session arrays every time is wasted work. Sweep at
// most once per interval per repo. Expiry is still re-checked at use time, so
// the only effect is a briefly-stale broadcast snapshot. Set 0 to sweep always.
const SWEEP_INTERVAL_MS = Number(process.env.SYNAPSE_SWEEP_INTERVAL_MS ?? 1000);
const lastSweptAt = new Map<string, number>();
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
  ? await (
      await import("./fanout.js")
    ).createRedisFanout({
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
        const seq = bumpRepoSeq(repoId);
        broadcast(repoId, envelope("state.snapshot", { teamState: fresh, seq }));
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
      githubApp: githubApp.status,
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
    if (overRateLimit(httpReadRate, HTTP_READ_RATE_LIMIT_PER_MIN, Date.now())) {
      metrics.count("synapse_rate_limited_total", { surface: "state" });
      writeJson(response, 429, { ok: false, error: "rate_limited" });
      return;
    }
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
    if (overRateLimit(httpReadRate, HTTP_READ_RATE_LIMIT_PER_MIN, Date.now())) {
      metrics.count("synapse_rate_limited_total", { surface: "recall" });
      writeJson(response, 429, { ok: false, error: "rate_limited" });
      return;
    }
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

  // Human GitHub sign-in routes (plan 051), live only when the App is
  // configured. Strictly distinct from authorized() — never gates a WS room.
  if (authContext && url.pathname.startsWith("/auth/")) {
    if (await handleAuthRequest(request, response, url, authContext)) {
      return;
    }
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
    const negotiated = negotiateProtocolVersion(announced === null ? undefined : Number(announced));
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
const socketProtocol = new WeakMap<WebSocket, ProtocolVersion>();

// Ingress rate limiting (G4): a sliding one-minute window per WS connection
// and a global one for the webhook endpoint. The defaults are far above any
// legitimate flow (a daemon heartbeats twice a minute and bursts a handful of
// messages per edit), so only a runaway or hostile client ever hits them; an
// over-limit message is acked as an error and dropped before any mutation.
// Set a limit to 0 to disable it.
const WS_RATE_LIMIT_PER_MIN = Number(process.env.SYNAPSE_RATE_LIMIT_PER_MIN ?? 600);
const WEBHOOK_RATE_LIMIT_PER_MIN = Number(process.env.SYNAPSE_WEBHOOK_RATE_LIMIT_PER_MIN ?? 120);
// /state and /recall share one global read budget; set 0 to disable.
const HTTP_READ_RATE_LIMIT_PER_MIN = Number(process.env.SYNAPSE_HTTP_RATE_LIMIT_PER_MIN ?? 120);

interface RateWindow {
  windowStartedAt: number;
  count: number;
}

const socketRates = new WeakMap<WebSocket, RateWindow>();
const webhookRate: RateWindow = { windowStartedAt: 0, count: 0 };
const httpReadRate: RateWindow = { windowStartedAt: 0, count: 0 };

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
  // The seam for graceful downgrade: outbound messages to this socket use its
  // agreed dialect, so legacy clients keep seeing v1 envelopes.
  socketProtocol.set(
    socket,
    negotiated.ok && isSupportedProtocolVersion(negotiated.agreed)
      ? negotiated.agreed
      : PROTOCOL_VERSION
  );
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
    send(
      socket,
      envelope(
        "state.snapshot",
        { teamState: state, seq: currentRepoSeq(repoId) },
        socketVersion(socket)
      )
    )
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
  void Promise.allSettled([fanout?.close(), memory?.close(), authContext?.userStore.close()])
    .then(() => store.close())
    .finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function handleMessage(
  socket: WebSocket,
  fallbackRepoId: string,
  raw: string
): Promise<void> {
  let rate = socketRates.get(socket);
  if (!rate) {
    rate = { windowStartedAt: 0, count: 0 };
    socketRates.set(socket, rate);
  }
  if (overRateLimit(rate, WS_RATE_LIMIT_PER_MIN, Date.now())) {
    metrics.count("synapse_rate_limited_total", { surface: "ws" });
    if (rate.count === WS_RATE_LIMIT_PER_MIN + 1) {
      log.warn("rate.limited", {
        surface: "ws",
        repoId: fallbackRepoId,
        limit: WS_RATE_LIMIT_PER_MIN
      });
    }
    sendAck(socket, { forId: "unknown", ok: false, error: "rate_limited" });
    return;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    metrics.count("synapse_message_failures_total", { reason: "invalid_json" });
    sendAck(socket, { forId: "unknown", ok: false, error: "invalid_json" });
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
    sendAck(socket, { forId, ok: false, error: validated.error });
    return;
  }
  const message: ClientMessage = validated.message;

  try {
    const messageRepoId = repoIdFor(message);
    // In project-key mode the connection is authorized for exactly one repo
    // (fallbackRepoId, bound at the handshake). Reject any message whose payload
    // targets a different repo, so a client authorized for A cannot drive writes
    // into B through the message body.
    if (authMode === "project-key" && messageRepoId !== null && messageRepoId !== fallbackRepoId) {
      metrics.count("synapse_message_failures_total", { reason: "forbidden_repo" });
      log.warn("message.forbidden_repo", { type: message.type, repoId: messageRepoId });
      sendAck(socket, { forId: message.id, ok: false, error: "forbidden_repo" });
      return;
    }

    const repoId = messageRepoId ?? fallbackRepoId;
    const startedAt = performance.now();
    const ops: StateOp[] = [];
    const state = await withRepo(repoId, async () => {
      const current = await getState(repoId);
      applyMessage(current, repoId, message, teeStateStoreOps(ops));
      return current;
    });
    metrics.count("synapse_messages_total", { type: message.type });
    metrics.observe("synapse_message_apply_ms", performance.now() - startedAt);
    indexMemory(repoId, message);
    log.debug("message.applied", { type: message.type, repoId, sessions: state.sessions.length });
    // For edit.intent, read the post-apply peer locks (state from withRepo already
    // includes this session's just-applied lock — the linearization point) and ship
    // them on the ack so the requester's check evaluates against authoritative state.
    const ackLocks =
      message.type === "edit.intent"
        ? peerLocksForIntent(
            state,
            message.payload.sessionId,
            message.payload.symbolId.raw,
            Date.now()
          )
        : undefined;
    sendAck(socket, { forId: message.id, ok: true, ...(ackLocks ? { locks: ackLocks } : {}) });
    if (ops.length > 0) {
      broadcastStateChange(repoId, state, ops);
      fanout?.publish(repoId);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown_error";
    metrics.count("synapse_message_failures_total", { reason: "apply_error" });
    log.error("message.failed", { type: message.type, reason });
    sendAck(socket, { forId: message.id, ok: false, error: reason });
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

  const secret = githubWebhookSecret;
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

  if (authMode === "project-key" && !webhookRepoFullName(payload)) {
    metrics.count("synapse_webhook_rejections_total", { reason: "repo_binding_required" });
    log.warn("webhook.repo_binding_required", { authMode });
    writeJson(response, 422, { ok: false, error: "repository_full_name_required" });
    return;
  }

  try {
    if (event !== "push" && !repoEventSupported(event)) {
      writeJson(response, 202, { ok: true, ignored: true, event });
      return;
    }

    if (event !== "push") {
      const repoEvent = gitHubRepoEventToNotify(event, payload, url.searchParams.get("repoId"));
      const ops: StateOp[] = [];
      const state = await withRepo(repoEvent.repoId, async () => {
        const current = await getState(repoEvent.repoId);
        applyMessage(
          current,
          repoEvent.repoId,
          clientEnvelope("repo.event", repoEvent.payload),
          teeStateStoreOps(ops)
        );
        return current;
      });
      broadcastStateChange(repoEvent.repoId, state, ops);
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
    const ops: StateOp[] = [];
    const state = await withRepo(push.repoId, async () => {
      const current = await getState(push.repoId);
      applyMessage(
        current,
        push.repoId,
        clientEnvelope("push.notify", push.payload),
        teeStateStoreOps(ops)
      );
      return current;
    });
    broadcastStateChange(push.repoId, state, ops);
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
  const state = await getCachedState(repoId, {
    states,
    dirtyRepos,
    loadsInFlight,
    load: (id) => store.load(id),
    createEmpty: createEmptyTeamState,
    onLoaded: (id, fresh) =>
      log.debug("state.loaded", { repoId: id, sessions: fresh.sessions.length })
  });

  const now = Date.now();
  if (dueForSweep(lastSweptAt.get(repoId) ?? 0, now, SWEEP_INTERVAL_MS)) {
    pruneExpiredLocks(state, store);
    pruneStaleSessions(state, store);
    lastSweptAt.set(repoId, now);
  }
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
    send(client, { ...message, v: socketVersion(client) });
  }
}

function broadcastStateChange(repoId: string, state: TeamState, ops: StateOp[]): void {
  const seq = bumpRepoSeq(repoId);
  for (const client of roomClients.get(repoId) ?? []) {
    const version = socketVersion(client);
    if (deltaBroadcastEnabled && version >= 2) {
      send(client, envelope("state.delta", { repoId, seq, ops }, version));
      metrics.count("synapse_state_deltas_sent_total");
    } else {
      send(client, envelope("state.snapshot", { teamState: state, seq }, version));
      metrics.count("synapse_state_snapshots_sent_total");
    }
  }
}

function sendAck(
  socket: WebSocket,
  payload: Extract<ServerMessage, WireEnvelope<"ack">>["payload"]
): void {
  send(socket, envelope("ack", payload, socketVersion(socket)));
}

function socketVersion(socket: WebSocket): ProtocolVersion {
  return socketProtocol.get(socket) ?? PROTOCOL_VERSION;
}

function currentRepoSeq(repoId: string): number {
  return repoSeq.get(repoId) ?? 0;
}

function bumpRepoSeq(repoId: string): number {
  const next = currentRepoSeq(repoId) + 1;
  repoSeq.set(repoId, next);
  return next;
}

function teeStateStoreOps(ops: StateOp[]): StateStoreOps {
  return {
    upsertSession: (repoId, session) => {
      store.upsertSession(repoId, session);
      ops.push({ op: "upsertSession", session: clone(session) });
    },
    upsertEditLock: (repoId, lock) => {
      store.upsertEditLock(repoId, lock);
      ops.push({ op: "upsertEditLock", lock: clone(lock) });
    },
    deleteEditLock: (repoId, sessionId, symbolRaw) => {
      store.deleteEditLock(repoId, sessionId, symbolRaw);
      ops.push({ op: "deleteEditLock", sessionId, symbolRaw });
    },
    deleteEditLocksForSession: (repoId, sessionId) => {
      store.deleteEditLocksForSession(repoId, sessionId);
      ops.push({ op: "deleteEditLocksForSession", sessionId });
    },
    upsertDelta: (repoId, delta) => {
      store.upsertDelta(repoId, delta);
      ops.push({ op: "upsertDelta", delta: clone(delta) });
    },
    deleteDelta: (repoId, deltaId) => {
      store.deleteDelta(repoId, deltaId);
      ops.push({ op: "deleteDelta", deltaId });
    },
    deleteSession: (repoId, sessionId) => {
      // Sessions are only ever deleted by pruneStaleSessions in getState, which
      // uses the raw store (like pruneExpiredLocks) — never this tee. Present
      // solely to satisfy StateStoreOps; there is no applyMessage-path op to
      // mirror into the delta stream.
      store.deleteSession(repoId, sessionId);
    },
    appendPush: (repoId, push, cap) => {
      store.appendPush(repoId, push, cap);
      ops.push({ op: "appendPush", push: clone(push), cap });
    },
    appendRepoEvent: (repoId, event, cap) => {
      store.appendRepoEvent(repoId, event, cap);
      ops.push({ op: "appendRepoEvent", event: clone(event), cap });
    },
    upsertResolution: (repoId, resolution) => {
      store.upsertResolution(repoId, resolution);
      ops.push({ op: "upsertResolution", resolution: clone(resolution) });
    },
    deleteResolution: (repoId, symbolRaw, inputsHash) => {
      store.deleteResolution(repoId, symbolRaw, inputsHash);
      ops.push({ op: "deleteResolution", symbolRaw, inputsHash });
    },
    appendSummary: (repoId, summary, cap) => {
      store.appendSummary(repoId, summary, cap);
      ops.push({ op: "appendSummary", summary: clone(summary), cap });
    },
    appendFeedback: (repoId, feedback, cap) => {
      store.appendFeedback(repoId, feedback, cap);
      ops.push({ op: "appendFeedback", feedback: clone(feedback), cap });
    }
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function envelope<TType extends ServerMessage["type"]>(
  type: TType,
  payload: Extract<ServerMessage, WireEnvelope<TType>>["payload"],
  version: ProtocolVersion = PROTOCOL_VERSION
): Extract<ServerMessage, WireEnvelope<TType>> {
  return {
    v: version,
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

  const expected = authMode === "project-key" ? deriveProjectKey(masterSecret, repoId) : authToken;
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
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
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
