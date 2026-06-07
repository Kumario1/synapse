import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  createEmptyTeamState,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ContractDelta,
  type EditLock,
  type RecentPush,
  type ServerMessage,
  type Session,
  type TeamState,
  type WireEnvelope
} from "@synapse/protocol";
import { WebSocket, WebSocketServer } from "ws";

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
    applyMessage(repoId, message);
    send(socket, envelope("ack", { forId: message.id, ok: true }));
    broadcast(repoId, envelope("state.snapshot", { teamState: getState(repoId) }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown_error";
    send(socket, envelope("ack", { forId: message.id, ok: false, error: reason }));
  }
}

function applyMessage(repoId: string, message: ClientMessage): void {
  const state = getState(repoId);
  const now = new Date().toISOString();

  switch (message.type) {
    case "session.start":
      upsertSession(state, {
        ...message.payload.session,
        repoId,
        lastSeen: now,
        status: "active"
      });
      break;
    case "session.heartbeat":
      touchSession(state, message.payload.sessionId, now);
      break;
    case "session.end":
      endSession(state, message.payload.sessionId, now);
      break;
    case "edit.intent":
      upsertEditLock(state, {
        sessionId: message.payload.sessionId,
        symbolId: message.payload.symbolId,
        filePath: message.payload.filePath,
        acquiredAt: now,
        ttlSec: 90
      });
      markSessionEditing(state, message.payload.sessionId, message.payload.filePath, now);
      break;
    case "contract.delta":
      upsertDelta(state, message.payload.delta);
      markSessionEditing(
        state,
        message.payload.delta.sessionId,
        message.payload.delta.filePath,
        now
      );
      break;
    case "push.notify":
      addRecentPush(state, {
        id: randomUUID(),
        repoId,
        memberId: message.payload.memberId,
        summary: message.payload.summary,
        filesAffected: message.payload.files,
        symbols: message.payload.symbols,
        sha: message.payload.sha,
        pushedAt: now
      });
      clearPushedLiveState(state, message.payload.files, message.payload.symbols);
      break;
    case "query.briefing":
      break;
    default:
      assertNever(message);
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

function repoIdFor(message: ClientMessage): string | null {
  switch (message.type) {
    case "session.start":
      return message.payload.session.repoId;
    case "session.heartbeat":
    case "session.end":
    case "edit.intent":
    case "query.briefing":
      return message.payload.repoId;
    case "contract.delta":
      return message.payload.delta.repoId;
    case "push.notify":
      return message.payload.repoId;
    default:
      assertNever(message);
  }
}

function upsertSession(state: TeamState, session: Session): void {
  const index = state.sessions.findIndex((candidate) => candidate.id === session.id);
  if (index === -1) {
    state.sessions.push(session);
    return;
  }

  state.sessions[index] = {
    ...state.sessions[index],
    ...session,
    filesOpen: unique([...state.sessions[index].filesOpen, ...session.filesOpen]),
    filesEditing: unique([...state.sessions[index].filesEditing, ...session.filesEditing])
  };
}

function touchSession(state: TeamState, sessionId: string, now: string): void {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (session) {
    session.lastSeen = now;
    if (session.status !== "ended") {
      session.status = "active";
    }
  }
}

function endSession(state: TeamState, sessionId: string, now: string): void {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (session) {
    session.lastSeen = now;
    session.status = "ended";
    session.filesEditing = [];
  }

  state.editLocks = state.editLocks.filter((lock) => lock.sessionId !== sessionId);
}

function upsertEditLock(state: TeamState, lock: EditLock): void {
  const index = state.editLocks.findIndex(
    (candidate) =>
      candidate.sessionId === lock.sessionId && candidate.symbolId.raw === lock.symbolId.raw
  );

  if (index === -1) {
    state.editLocks.push(lock);
    return;
  }

  state.editLocks[index] = lock;
}

function markSessionEditing(
  state: TeamState,
  sessionId: string,
  filePath: string,
  now: string
): void {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) {
    return;
  }

  session.filesEditing = unique([...session.filesEditing, filePath]);
  session.lastSeen = now;
}

function upsertDelta(state: TeamState, delta: ContractDelta): void {
  const index = state.unpushedDeltas.findIndex((candidate) => candidate.id === delta.id);
  if (index === -1) {
    state.unpushedDeltas.push(delta);
    return;
  }

  state.unpushedDeltas[index] = delta;
}

function addRecentPush(state: TeamState, push: RecentPush): void {
  state.recentPushes.unshift(push);
  state.recentPushes = state.recentPushes.slice(0, 50);
}

function clearPushedLiveState(
  state: TeamState,
  files: string[],
  symbols: ContractDelta["symbolId"][] = []
): void {
  const fileSet = new Set(files);
  const symbolSet = new Set(symbols.map((symbol) => symbol.raw));

  state.unpushedDeltas = state.unpushedDeltas.filter(
    (delta) => !fileSet.has(delta.filePath) && !symbolSet.has(delta.symbolId.raw)
  );
  state.editLocks = state.editLocks.filter(
    (lock) => !fileSet.has(lock.filePath) && !symbolSet.has(lock.symbolId.raw)
  );

  for (const session of state.sessions) {
    session.filesEditing = session.filesEditing.filter((filePath) => !fileSet.has(filePath));
  }
}

function pruneExpiredLocks(state: TeamState): void {
  const now = Date.now();
  state.editLocks = state.editLocks.filter((lock) => {
    const acquiredAt = Date.parse(lock.acquiredAt);
    return Number.isNaN(acquiredAt) || now - acquiredAt <= lock.ttlSec * 1000;
  });
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function assertNever(value: never): never {
  throw new Error(`Unhandled message: ${JSON.stringify(value)}`);
}
