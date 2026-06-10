import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@synapse/protocol";
import type { TeamState } from "@synapse/protocol";
import { configFromArgs, numberValue, type RuntimeConfig } from "../config.js";

interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

interface DoctorResult {
  checks: DoctorCheck[];
  ok: boolean;
}

/**
 * Preflight diagnostics: turn the silent failures that block cross-machine
 * coordination into loud, specific messages. In `cli` mode it prints and sets a
 * non-zero exit on any FAIL; in `preflight` mode it returns the result for `up`.
 */
export async function runDoctor(
  rawArgs: string[],
  opts: { mode: "cli" | "preflight"; config?: RuntimeConfig } = { mode: "cli" }
): Promise<DoctorResult> {
  const config = opts.config ?? configFromArgs(rawArgs);
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "identity",
    status: "pass",
    detail: `repoId=${config.repoId} member=${config.member} server=${config.serverUrl} token=${config.authToken ? "set" : "unset"}`
  });

  if (config.repoId === "local") {
    checks.push({
      name: "repoId",
      status: "warn",
      detail:
        'repoId is "local" — machines on different clones will NOT coordinate. Add a git remote, pass --repo-id, or set repoId in .synapse/team.json.'
    });
  } else {
    checks.push({ name: "repoId", status: "pass", detail: `coordinating on ${config.repoId}` });
  }

  const localHost = /^wss?:\/\/(localhost|127\.0\.0\.1)(?::|\/|$)/u.test(config.serverUrl);
  if (config.serverUrl.startsWith("ws://") && !localHost) {
    checks.push({
      name: "transport",
      status: "warn",
      detail: "serverUrl is ws:// to a remote host — the token travels in cleartext. Prefer wss:// (a tunnel terminates TLS)."
    });
  } else {
    checks.push({
      name: "transport",
      status: "pass",
      detail: config.serverUrl.startsWith("wss://") ? "wss (encrypted)" : "local"
    });
  }

  const health = await probeHealth(`${httpFromWs(config.serverUrl)}/health`);
  checks.push(health.check);

  if (health.body) {
    const serverProtocol = numberValue((health.body as Record<string, unknown>).protocolVersion);
    if (serverProtocol === undefined) {
      checks.push({ name: "protocol", status: "warn", detail: "server /health did not report protocolVersion (older server?)" });
    } else if (serverProtocol !== PROTOCOL_VERSION) {
      checks.push({
        name: "protocol",
        status: "warn",
        detail: `server protocol v${serverProtocol}, client v${PROTOCOL_VERSION} — upgrade the older side.`
      });
    } else {
      checks.push({ name: "protocol", status: "pass", detail: `protocol v${PROTOCOL_VERSION}` });
    }
  }

  checks.push(await probeWsHandshake(config));
  checks.push(await probePeers(config));

  const ok = checks.every((check) => check.status !== "fail");

  if (opts.mode === "cli") {
    printDoctor(checks);
    if (!ok) {
      process.exitCode = 1;
    }
  }

  return { checks, ok };
}

export function printDoctor(checks: DoctorCheck[]): void {
  const icon = { pass: "✓", warn: "⚠", fail: "✗" } as const;
  console.log("synapse doctor:");
  for (const check of checks) {
    console.log(`  ${icon[check.status]} ${check.name}: ${check.detail}`);
  }
}

/** ws://host → http://host, wss://host → https://host (for /health and /state). */
function httpFromWs(serverUrl: string): string {
  return serverUrl.replace(/^ws/u, "http");
}

async function probeHealth(url: string): Promise<{ check: DoctorCheck; body: unknown | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { check: { name: "server", status: "fail", detail: `GET ${url} → HTTP ${response.status}` }, body: null };
    }
    const body = await response.json().catch(() => null);
    return { check: { name: "server", status: "pass", detail: `reachable at ${url}` }, body };
  } catch (error) {
    return { check: { name: "server", status: "fail", detail: describeFetchError(url, error) }, body: null };
  } finally {
    clearTimeout(timer);
  }
}

function probeWsHandshake(config: RuntimeConfig): Promise<DoctorCheck> {
  const url = `${config.serverUrl}?repoId=${encodeURIComponent(config.repoId)}&sessionId=synapse-doctor`;
  return new Promise((resolvePromise) => {
    const ws = new WebSocket(
      url,
      config.authToken ? { headers: { authorization: `Bearer ${config.authToken}` } } : undefined
    );
    let settled = false;
    const settle = (check: DoctorCheck): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolvePromise(check);
    };
    const timer = setTimeout(
      () => settle({ name: "websocket", status: "fail", detail: "WS handshake timed out — server unreachable (NAT/tunnel down?)." }),
      5000
    );
    ws.on("open", () => settle({ name: "websocket", status: "pass", detail: "WS handshake authenticated" }));
    ws.on("unexpected-response", (_request, response) =>
      settle({
        name: "websocket",
        status: "fail",
        detail:
          response.statusCode === 401
            ? "WS handshake rejected 401 — project key/token missing or wrong for this repo."
            : `WS handshake rejected — HTTP ${response.statusCode}.`
      })
    );
    ws.on("error", (error) => settle({ name: "websocket", status: "fail", detail: describeWsError(error) }));
  });
}

async function probePeers(config: RuntimeConfig): Promise<DoctorCheck> {
  const url = `${httpFromWs(config.serverUrl)}/state?repoId=${encodeURIComponent(config.repoId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: config.authToken ? { authorization: `Bearer ${config.authToken}` } : undefined
    });
    if (!response.ok) {
      return {
        name: "peers",
        status: response.status === 401 ? "fail" : "warn",
        detail: `GET /state → HTTP ${response.status}`
      };
    }
    const state = (await response.json()) as TeamState;
    const others = state.sessions.filter(
      (session) => session.id !== config.sessionId && session.status !== "ended"
    );
    if (others.length === 0) {
      return { name: "peers", status: "pass", detail: "connected, no other peers yet" };
    }
    const names = others.map((session) => session.memberLogin ?? session.memberId ?? session.id);
    return { name: "peers", status: "pass", detail: `connected, ${others.length} peer(s): ${names.join(", ")}` };
  } catch (error) {
    return { name: "peers", status: "warn", detail: describeFetchError(url, error) };
  } finally {
    clearTimeout(timer);
  }
}

function describeFetchError(url: string, error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return `${url} timed out — server unreachable (NAT/tunnel down?).`;
  }
  const code = fetchErrorCode(error);
  if (code === "ECONNREFUSED") {
    return `${url} refused the connection — is the server running / the tunnel up?`;
  }
  if (code === "ENOTFOUND") {
    return `${url} host not found — check the serverUrl / DNS.`;
  }
  return `${url} failed: ${error instanceof Error ? error.message : String(error)}`;
}

function fetchErrorCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (cause instanceof Error && "code" in cause) {
    return (cause as { code?: string }).code;
  }
  if (error instanceof Error && "code" in error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function describeWsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b401\b/u.test(message)) {
    return "WS handshake rejected 401 — auth token missing or wrong.";
  }
  const code = error instanceof Error && "code" in error ? (error as { code?: string }).code : undefined;
  if (code === "ECONNREFUSED") {
    return "WS connection refused — is the server running / the tunnel up?";
  }
  if (code === "ENOTFOUND") {
    return "WS host not found — check the serverUrl.";
  }
  return `WS handshake failed: ${message}`;
}

