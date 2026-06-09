import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  createEmptyTeamState,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type TeamState,
  type WireEnvelope
} from "@synapse/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { gitHubPushToNotify } from "./github.js";
import { applyMessage, pruneExpiredLocks, repoIdFor } from "./state.js";
import { createStateStore } from "./store.js";

const port = Number(process.env.SYNAPSE_SERVER_PORT ?? 4010);
// Optional shared-token auth for the daemon<->server channel. When
// SYNAPSE_AUTH_TOKEN is set, every WSS connection and GET /state must present a
// matching token; unset means open (local/dev and hermetic tests). GitHub OAuth
// is the intended upgrade — see the README.
const authToken = process.env.SYNAPSE_AUTH_TOKEN ?? "";
// Durable per-repo state. In-memory cache is the hot-path working copy; the
// store persists every mutation so a restart resumes live state. With no
// SYNAPSE_DB_PATH the store is in-memory and behavior is identical to before.
const store = createStateStore();
const states = new Map<string, TeamState>();
const roomClients = new Map<string, Set<WebSocket>>();

const httpServer = createServer((request, response) => {
  void handleHttp(request, response);
});

async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { ok: true, service: "synapse-server" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/state") {
    if (!authorized(request, url)) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    writeJson(response, 200, getState(url.searchParams.get("repoId") ?? "local"));
    return;
  }

  if (request.method === "POST" && url.pathname === "/webhooks/github") {
    await handleGitHubWebhook(request, response, url);
    return;
  }

  writeJson(response, 404, { error: "not_found" });
}

const wsServer = new WebSocketServer({
  server: httpServer,
  // Reject the handshake itself when the token is missing/wrong, so an
  // unauthenticated client never enters a repo room.
  verifyClient: (info, done) => {
    const url = new URL(info.req.url ?? "/", "ws://localhost");
    if (authorized(info.req, url)) {
      done(true);
    } else {
      done(false, 401, "Unauthorized");
    }
  }
});

wsServer.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/", "ws://localhost");
  const repoId = url.searchParams.get("repoId") ?? "local";
  joinRoom(repoId, socket);
  send(socket, envelope("state.snapshot", { teamState: getState(repoId) }));

  socket.on("message", (data) => {
    void handleMessage(socket, repoId, data.toString());
  });

  socket.on("close", () => {
    leaveRoom(repoId, socket);
  });
});

httpServer.listen(port, () => {
  console.log(`synapse server listening on http://localhost:${port}`);
});

// Flush every cached repo and close the store cleanly on shutdown so a restart
// resumes from a consistent snapshot.
const shutdown = (): void => {
  for (const repoId of states.keys()) {
    persist(repoId);
  }
  store.close();
  httpServer.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function handleMessage(socket: WebSocket, fallbackRepoId: string, raw: string): Promise<void> {
  let message: ClientMessage;

  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    send(socket, envelope("ack", { forId: "unknown", ok: false, error: "invalid_json" }));
    return;
  }

  try {
    const repoId = repoIdFor(message) ?? fallbackRepoId;
    applyMessage(getState(repoId), repoId, message);
    persist(repoId);
    send(socket, envelope("ack", { forId: message.id, ok: true }));
    broadcast(repoId, envelope("state.snapshot", { teamState: getState(repoId) }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown_error";
    send(socket, envelope("ack", { forId: message.id, ok: false, error: reason }));
  }
}

async function handleGitHubWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<void> {
  const raw = await readBody(request);
  const secret = process.env.SYNAPSE_GITHUB_WEBHOOK_SECRET;
  if (secret && !validGitHubSignature(raw, headerValue(request, "x-hub-signature-256"), secret)) {
    writeJson(response, 401, { ok: false, error: "invalid_signature" });
    return;
  }

  const event = headerValue(request, "x-github-event") ?? "unknown";
  if (event !== "push") {
    writeJson(response, 202, { ok: true, ignored: true, event });
    return;
  }

  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    writeJson(response, 400, { ok: false, error: "invalid_json" });
    return;
  }

  try {
    const push = gitHubPushToNotify(payload, url.searchParams.get("repoId"));
    applyMessage(
      getState(push.repoId),
      push.repoId,
      clientEnvelope("push.notify", push.payload)
    );
    persist(push.repoId);
    broadcast(push.repoId, envelope("state.snapshot", { teamState: getState(push.repoId) }));
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

function getState(repoId: string): TeamState {
  let state = states.get(repoId);
  if (!state) {
    // Cache miss: resume the persisted snapshot if one exists, else start fresh.
    state = store.load(repoId) ?? createEmptyTeamState(repoId);
    states.set(repoId, state);
  }

  pruneExpiredLocks(state);
  return state;
}

/** Persist a repo's state after a mutation so it survives a restart. */
function persist(repoId: string): void {
  const state = states.get(repoId);
  if (state) {
    store.save(repoId, state);
  }
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
  }

  return body;
}

/**
 * True when auth is disabled (no token configured) or the request presents the
 * matching token — via `?token=` or an `Authorization: Bearer` header. The
 * comparison is constant-time to avoid leaking the token through timing.
 */
function authorized(request: IncomingMessage, url: URL): boolean {
  if (!authToken) {
    return true;
  }

  const fromQuery = url.searchParams.get("token");
  const header = headerValue(request, "authorization");
  const fromHeader = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  const provided = fromQuery ?? fromHeader;
  if (!provided) {
    return false;
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(authToken);
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
