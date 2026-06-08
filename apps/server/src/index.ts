import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
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
import { applyMessage, pruneExpiredLocks, repoIdFor } from "./state.js";

const port = Number(process.env.SYNAPSE_SERVER_PORT ?? 4010);
const states = new Map<string, TeamState>();
const roomClients = new Map<string, Set<WebSocket>>();

const httpServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { ok: true, service: "synapse-server" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/state") {
    writeJson(response, 200, getState(url.searchParams.get("repoId") ?? "local"));
    return;
  }

  writeJson(response, 404, { error: "not_found" });
});

const wsServer = new WebSocketServer({ server: httpServer });

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
    send(socket, envelope("ack", { forId: message.id, ok: true }));
    broadcast(repoId, envelope("state.snapshot", { teamState: getState(repoId) }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown_error";
    send(socket, envelope("ack", { forId: message.id, ok: false, error: reason }));
  }
}

function getState(repoId: string): TeamState {
  let state = states.get(repoId);
  if (!state) {
    state = createEmptyTeamState(repoId);
    states.set(repoId, state);
  }

  pruneExpiredLocks(state);
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

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body, null, 2));
}
