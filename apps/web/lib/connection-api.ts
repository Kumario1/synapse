import { AuthenticationRequired, requireUser, type GuardSession } from "./auth-guard";
import type { ConnectionInput, ConnectionStore } from "./connection-store";

export interface ConnectionApiContext {
  session: GuardSession | null | undefined;
  store: ConnectionStore;
}

export async function listConnections(_request: Request, context: ConnectionApiContext): Promise<Response> {
  const user = authenticate(context.session);
  if (user instanceof Response) {
    return user;
  }
  return json(await context.store.list(user.userId));
}

export async function createConnection(request: Request, context: ConnectionApiContext): Promise<Response> {
  const user = authenticate(context.session);
  if (user instanceof Response) {
    return user;
  }
  const input = await readConnectionInput(request);
  if (input instanceof Response) {
    return input;
  }
  return json(await context.store.create(user.userId, input), 201);
}

export async function getConnection(
  _request: Request,
  context: ConnectionApiContext & { id: string }
): Promise<Response> {
  const user = authenticate(context.session);
  if (user instanceof Response) {
    return user;
  }
  const row = await context.store.get(user.userId, context.id);
  return row ? json(row) : json({ error: "not_found" }, 404);
}

export async function updateConnection(
  request: Request,
  context: ConnectionApiContext & { id: string }
): Promise<Response> {
  const user = authenticate(context.session);
  if (user instanceof Response) {
    return user;
  }
  const input = await readConnectionInput(request);
  if (input instanceof Response) {
    return input;
  }
  const row = await context.store.update(user.userId, context.id, input);
  return row ? json(row) : json({ error: "not_found" }, 404);
}

export async function deleteConnection(
  _request: Request,
  context: ConnectionApiContext & { id: string }
): Promise<Response> {
  const user = authenticate(context.session);
  if (user instanceof Response) {
    return user;
  }
  const deleted = await context.store.delete(user.userId, context.id);
  return deleted ? new Response(null, { status: 204 }) : json({ error: "not_found" }, 404);
}

function authenticate(session: GuardSession | null | undefined): { userId: string } | Response {
  try {
    return requireUser(session);
  } catch (error) {
    if (error instanceof AuthenticationRequired) {
      return json({ error: "unauthorized" }, 401);
    }
    throw error;
  }
}

async function readConnectionInput(request: Request): Promise<ConnectionInput | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (!isRecord(body)) {
    return json({ error: "invalid_body" }, 400);
  }

  const label = cleanString(body.label);
  const serverUrl = cleanString(body.serverUrl);
  const repoId = cleanString(body.repoId);

  if (!label || !serverUrl || !repoId || !isWebSocketUrl(serverUrl)) {
    return json({ error: "invalid_connection" }, 400);
  }

  return { label, serverUrl, repoId };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
}
