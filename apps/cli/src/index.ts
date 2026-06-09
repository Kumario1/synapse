#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRemoteUrl } from "./identity.js";
import {
  diffTypeScriptContracts,
  extractTypeScriptContracts,
  extractTypeScriptDependencyGraph
} from "@synapse/analyzer-ts";
import {
  closePythonAnalyzer,
  diffPythonContracts,
  extractPythonContracts,
  extractPythonDependencyGraph
} from "@synapse/analyzer-py";
import {
  contractChangeFor,
  emptyDependencyGraph,
  enrichConflicts,
  evaluateConflicts,
  resolutionInputsHash,
  resolutionSidesForSymbol,
  symbolForFile,
  type Conflict,
  type DependencyGraph,
  type DependencyHop,
  type ResolutionProvider,
  type ResolutionSide,
  verdictFor
} from "@synapse/conflict-engine";
import {
  createOpenRouterAnalysisProvider,
  createOpenRouterResolutionProvider,
  createOpenRouterSummaryProvider,
  type SessionSummaryDelta,
  type SummaryProvider
} from "./explain-openrouter.js";
import { runMcp } from "./mcp.js";
import {
  createEmptyTeamState,
  deriveProjectKey,
  PROTOCOL_VERSION,
  type AgentType,
  type CodeSymbol,
  type ClientMessage,
  type ConflictFeedback,
  type ContractChange,
  type ContractDelta,
  type ContractDeltaSummary,
  type ContractResolution,
  type ProposedResolution,
  type ServerMessage,
  type Session,
  type SessionSummary,
  type Signature,
  type SynapseCheckRequest,
  type SynapseCheckResponse,
  type SynapseFeedbackRequest,
  type SynapseFeedbackResponse,
  type TeamState,
  type SynapsePushRequest,
  type SynapseReportRequest,
  type SynapseSessionRequest,
  type SynapseWhatsupRequest,
  type SynapseWhatsupResponse,
  type SynapseWhyRequest,
  type SynapseWhyResponse,
  type SynapseWhySource,
  type SynapseWhySourceKind
} from "@synapse/protocol";
import { WebSocket } from "ws";

interface RuntimeConfig {
  repoId: string;
  member: string;
  sessionId: string;
  agentType: AgentType;
  daemonPort: number;
  serverUrl: string;
  worktreeRoot: string;
  /** Shared auth token for the server, if the server requires one. */
  authToken: string;
}

interface LocalConfig {
  repoId?: string;
  member?: string;
  sessionId?: string;
  agentType?: AgentType;
  daemonPort?: number;
  serverUrl?: string;
  worktreeRoot?: string;
}

/** Committed, shared, non-secret team config (`.synapse/team.json`). */
interface TeamConfig {
  schemaVersion?: number;
  serverUrl?: string;
  repoId?: string;
}

interface AnalysisCache {
  symbolsByFile: Map<string, CachedSymbols>;
  graph: CachedGraph | null;
}

interface CachedSymbols {
  fingerprint: string;
  symbols: CodeSymbol[];
}

interface CachedGraph {
  fingerprint: string;
  value: DaemonGraph;
}

interface SourceFileFingerprint {
  filePath: string;
  mtimeMs: number;
  size: number;
}

interface SourceFileContent extends SourceFileFingerprint {
  source: string;
}

const args = process.argv.slice(2);
const command = args[0] ?? "help";

switch (command) {
  case "daemon":
    await startDaemon(configFromArgs(args.slice(1)));
    break;
  case "check":
    await runCheck(args.slice(1));
    break;
  case "report":
    await runReport(args.slice(1));
    break;
  case "push":
    await runPush(args.slice(1));
    break;
  case "feedback":
    await runFeedback(args.slice(1));
    break;
  case "session":
    await runSession(args.slice(1));
    break;
  case "whatsup":
    await runWhatsup(args.slice(1));
    break;
  case "why":
    await runWhy(args.slice(1));
    break;
  case "mcp":
    await runMcp(args.slice(1));
    break;
  case "join":
    await runJoin(args.slice(1));
    break;
  case "up":
    await runUp(args.slice(1));
    break;
  case "keygen":
    runKeygen(args.slice(1));
    break;
  case "doctor":
    await runDoctor(args.slice(1));
    break;
  case "hook":
    await runHook(args.slice(1));
    break;
  case "analyze":
    await runAnalyze(args.slice(1));
    break;
  case "help":
  default:
    printHelp();
    break;
}

async function startDaemon(config: RuntimeConfig): Promise<void> {
  let teamState = createEmptyTeamState(config.repoId);
  let socket: WebSocket | null = null;
  const contractSnapshots = new Map<string, CodeSymbol[]>();
  const analysisCache: AnalysisCache = {
    symbolsByFile: new Map(),
    graph: null
  };
  // Optional LLM analysis layer (Rung 5). Null unless OPENROUTER_API_KEY is
  // set; detection stays deterministic either way.
  const analysisProvider = createOpenRouterAnalysisProvider();
  // Optional LLM resolver: synthesizes one merged contract for the narrow
  // `contract_divergent` case. Null without a key → deterministic escalate.
  const resolutionProvider = createOpenRouterResolutionProvider();
  // Optional LLM session summarizer (Layer II). Null without a key → the
  // deterministic, structured summary. Never runs in the edit hot path.
  const summaryProvider = createOpenRouterSummaryProvider();

  const sendToServer = (type: ClientMessage["type"], payload: unknown): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify(envelope(type, payload)));
  };

  // A daemon that cannot reach the server reconnects forever; without a signal
  // a misconfig (wrong token, unreachable server, repoId mismatch) looks exactly
  // like "working." Surface the first failure once, and every auth rejection,
  // pointing at `synapse doctor` — but stay quiet on the 1s reconnect loop.
  let connectionWarned = false;
  const warnConnection = (detail: string, opts?: { auth?: boolean }): void => {
    if (connectionWarned && !opts?.auth) {
      return;
    }
    connectionWarned = true;
    console.warn(
      `synapse: daemon cannot reach ${config.serverUrl} (${detail}); retrying. Run \`synapse doctor\` to diagnose.`
    );
  };

  const connect = (): void => {
    const tokenParam = config.authToken
      ? `&token=${encodeURIComponent(config.authToken)}`
      : "";
    socket = new WebSocket(
      `${config.serverUrl}?repoId=${encodeURIComponent(config.repoId)}&sessionId=${encodeURIComponent(config.sessionId)}${tokenParam}`
    );

    socket.on("open", () => {
      connectionWarned = false;
      sendToServer("session.start", { session: makeSession(config) });
    });

    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (message.type === "state.snapshot" || message.type === "state.delta") {
        teamState = message.payload.teamState;
      }
    });

    socket.on("unexpected-response", (_request, response) => {
      const auth = response.statusCode === 401;
      warnConnection(
        auth
          ? "401 unauthorized — check your project key (SYNAPSE_PROJECT_KEY / --key) or SYNAPSE_AUTH_TOKEN"
          : `HTTP ${response.statusCode}`,
        { auth }
      );
    });

    socket.on("close", () => {
      setTimeout(connect, 1000);
    });

    socket.on("error", (error) => {
      const code = (error as { code?: string }).code;
      warnConnection(code ?? (error instanceof Error ? error.message : "connection error"));
      socket?.close();
    });
  };

  connect();

  setInterval(() => {
    sendToServer("session.heartbeat", {
      repoId: config.repoId,
      sessionId: config.sessionId
    });
  }, 30_000).unref();

  const localServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          ok: true,
          service: "synapse-daemon",
          repoId: config.repoId,
          sessionId: config.sessionId
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/state") {
        writeJson(response, 200, teamState);
        return;
      }

      if (request.method === "POST" && url.pathname === "/tools/synapse_whatsup") {
        const body = (await readJson(request)) as Partial<SynapseWhatsupRequest>;
        writeJson(
          response,
          200,
          buildWhatsupResponse(teamState, {
            degraded: socket?.readyState !== WebSocket.OPEN,
            limit: body.limit
          })
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/tools/synapse_why") {
        const body = (await readJson(request)) as Partial<SynapseWhyRequest>;
        if (!body.question) {
          writeJson(response, 400, { error: "question is required" });
          return;
        }

        writeJson(
          response,
          200,
          buildWhyResponse(teamState, body.question, {
            degraded: socket?.readyState !== WebSocket.OPEN,
            limit: body.limit
          })
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/tools/synapse_check") {
        const body = (await readJson(request)) as Partial<SynapseCheckRequest>;
        const targets = await resolveCheckTargets(config, body, analysisCache);

        for (const target of targets) {
          sendToServer("edit.intent", {
            repoId: config.repoId,
            sessionId: config.sessionId,
            symbolId: target.symbolId,
            filePath: target.filePath
          });
        }

        const { graph, neighborsOf } = await buildDependencyGraph(config, analysisCache);
        const conflicts = evaluateConflicts({
          selfSessionId: config.sessionId,
          targets,
          state: teamState,
          graph
        });

        // Verdict is already decided deterministically; the analysis layer only
        // enriches the actionable steps and falls back silently on any failure.
        const explained = analysisProvider
          ? await enrichConflicts(conflicts, analysisProvider, {
              task: body.task,
              selfSignatureBySymbol: selfSignatures(targets),
              selfChangeBySymbol: selfChanges(teamState, config.sessionId)
            })
          : conflicts;

        // Resolve `contract_divergent` conflicts to one shared merged contract:
        // read the canonical store first (convergence), otherwise generate via
        // the optional LLM resolver, publish, and attach. Falls back to the
        // engine's deterministic escalate when no provider/resolution exists.
        const resolved = await attachResolutions(
          config,
          explained,
          teamState,
          resolutionProvider,
          neighborsOf,
          sendToServer
        );

        writeJson(response, 200, {
          verdict: verdictFor(conflicts),
          conflicts: resolved,
          degraded: socket?.readyState !== WebSocket.OPEN
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/tools/synapse_report") {
        const body = (await readJson(request)) as Partial<SynapseReportRequest>;
        if (!body.filePath) {
          writeJson(response, 400, { error: "filePath is required" });
          return;
        }

        const deltas = await reportContractChanges(config, contractSnapshots, body, analysisCache);
        for (const delta of deltas) {
          sendToServer("contract.delta", { delta });
        }

        writeJson(response, 200, {
          ok: true,
          delta: deltas[0] ? summarizeDelta(deltas[0]) : undefined,
          deltas: deltas.map(summarizeDelta)
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/tools/synapse_push") {
        const body = (await readJson(request)) as Partial<SynapsePushRequest>;
        const files = body.files ?? [];
        if (files.length === 0) {
          writeJson(response, 400, { error: "files is required" });
          return;
        }

        const sha = body.sha ?? "local";
        sendToServer("push.notify", {
          repoId: config.repoId,
          memberId: config.member,
          sha,
          summary: body.summary ?? `Pushed ${files.join(", ")}`,
          files,
          symbols: body.symbols
        });

        writeJson(response, 200, {
          ok: true,
          sha,
          files
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/tools/synapse_feedback") {
        const body = (await readJson(request)) as Partial<SynapseFeedbackRequest>;
        if (!body.conflictId) {
          writeJson(response, 400, { error: "conflictId is required" });
          return;
        }
        if (body.outcome !== "acted" && body.outcome !== "dismissed") {
          writeJson(response, 400, { error: "outcome must be acted or dismissed" });
          return;
        }

        const feedback = createConflictFeedback(config, {
          conflictId: body.conflictId,
          outcome: body.outcome,
          note: body.note,
          rule: body.rule,
          targetSymbol: body.targetSymbol
        });
        sendToServer("conflict.feedback", { repoId: config.repoId, feedback });

        writeJson(response, 200, {
          ok: true,
          feedback
        } satisfies SynapseFeedbackResponse);
        return;
      }

      if (request.method === "POST" && url.pathname === "/tools/synapse_session") {
        const body = (await readJson(request)) as Partial<SynapseSessionRequest>;
        const action = body.action ?? "heartbeat";

        if (action === "end") {
          // Layer II: distill what this session changed into a durable summary
          // before tearing it down, so teammates can catch up later.
          const summary = await buildSessionSummary(config, teamState, summaryProvider, body.task);
          sendToServer("session.summary", { repoId: config.repoId, summary });
          sendToServer("session.end", {
            repoId: config.repoId,
            sessionId: config.sessionId
          });
        } else if (action === "start") {
          sendToServer("session.start", { session: makeSession(config, body.task) });
        } else {
          sendToServer("session.heartbeat", {
            repoId: config.repoId,
            sessionId: config.sessionId
          });
        }

        writeJson(response, 200, { sessionId: config.sessionId });
        return;
      }

      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown_error";
      writeJson(response, 500, { error: reason });
    }
  });

  localServer.listen(config.daemonPort, () => {
    console.log(
      `synapse daemon ${config.sessionId} listening on http://localhost:${config.daemonPort}`
    );
  });

  // Tear the Python sidecar down with the daemon so it never lingers.
  const shutdown = (): void => {
    closePythonAnalyzer();
    localServer.close();
    socket?.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runCheck(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const file = requiredFlag(flags, "file");
  const symbol = flags.symbol ? { raw: flags.symbol } : undefined;
  const response = await postJson(`http://localhost:${defaults.daemonPort}/tools/synapse_check`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    files: [file],
    symbols: symbol ? [symbol] : undefined,
    task: flags.task
  });
  console.log(JSON.stringify(response, null, 2));
}

async function runReport(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const file = requiredFlag(flags, "file");
  const symbol = flags.symbol ? { raw: flags.symbol } : undefined;
  const response = await postJson(`http://localhost:${defaults.daemonPort}/tools/synapse_report`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    filePath: file,
    symbolId: symbol,
    summary: flags.summary,
    baseSha: flags["base-sha"],
    changeKind: flags["change-kind"] as SynapseReportRequest["changeKind"] | undefined
  });
  console.log(JSON.stringify(response, null, 2));
}

async function runPush(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const files = filesFromFlags(flags);
  if (files.length === 0) {
    throw new Error("--file or --files is required");
  }

  const symbols = flags.symbols
    ? flags.symbols.split(",").map((raw) => ({ raw: raw.trim() })).filter((symbol) => symbol.raw)
    : flags.symbol
      ? [{ raw: flags.symbol }]
      : undefined;

  const response = await postJson(`http://localhost:${defaults.daemonPort}/tools/synapse_push`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    sha: flags.sha ?? "local",
    summary: flags.summary ?? `Pushed ${files.join(", ")}`,
    files,
    symbols
  });
  console.log(JSON.stringify(response, null, 2));
}

async function runFeedback(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const conflictId = flags["conflict-id"] ?? flags.conflictId;
  const outcome = flags.outcome as SynapseFeedbackRequest["outcome"] | undefined;
  if (!conflictId) {
    throw new Error("--conflict-id is required");
  }
  if (outcome !== "acted" && outcome !== "dismissed") {
    throw new Error("--outcome must be acted or dismissed");
  }

  const response = await postJson(`http://localhost:${defaults.daemonPort}/tools/synapse_feedback`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    conflictId,
    outcome,
    note: flags.note,
    rule: flags.rule,
    targetSymbol: flags.symbol ? { raw: flags.symbol } : undefined
  });
  console.log(JSON.stringify(response, null, 2));
}

async function runSession(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const action = (rawArgs.find((arg) => !arg.startsWith("--")) ?? "heartbeat") as
    | "start"
    | "end"
    | "heartbeat";
  const response = await postJson(`http://localhost:${defaults.daemonPort}/tools/synapse_session`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    action,
    task: flags.task
  });
  console.log(JSON.stringify(response, null, 2));
}

async function runWhatsup(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const limit = flags.limit ? Number(flags.limit) : undefined;
  const response = await postJson(`http://localhost:${defaults.daemonPort}/tools/synapse_whatsup`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    limit: Number.isFinite(limit) ? limit : undefined
  });
  console.log(JSON.stringify(response, null, 2));
}

async function runWhy(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const question = flags.question ?? flags.q ?? rawArgs.filter((arg) => !arg.startsWith("--")).join(" ");
  if (!question) {
    throw new Error("--question is required");
  }

  const limit = flags.limit ? Number(flags.limit) : undefined;
  const response = await postJson(`http://localhost:${defaults.daemonPort}/tools/synapse_why`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    question,
    limit: Number.isFinite(limit) ? limit : undefined
  });
  console.log(JSON.stringify(response, null, 2));
}

async function runJoin(rawArgs: string[]): Promise<void> {
  await performJoin(configFromArgs(rawArgs));
  console.log(`start the daemon with: npm run dev --workspace @synapse/cli -- daemon`);
}

/**
 * Write `.synapse/config.json`, install the Claude Code hooks, and prepare the
 * Python analyzer venv. Idempotent — safe to re-run. Shared by `join` and `up`.
 */
async function performJoin(config: RuntimeConfig): Promise<void> {
  const dir = join(commandCwd(), ".synapse");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "config.json"),
    `${JSON.stringify(
      {
        repoId: config.repoId,
        serverUrl: config.serverUrl,
        daemonPort: config.daemonPort,
        member: config.member,
        sessionId: config.sessionId,
        agentType: config.agentType,
        worktreeRoot: config.worktreeRoot,
        createdAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );

  console.log(`wrote ${join(dir, "config.json")}`);

  // Install the Claude Code hooks so synapse_check/synapse_report fire
  // automatically before/after every Edit, Write, and MultiEdit.
  await installClaudeCodeHooks(commandCwd());

  // Best-effort: prepare the Python analyzer venv so `.py` files are analyzed on
  // first run. Never fails the join — missing Python just degrades to file-level.
  setupPythonAnalyzerVenv();
}

/**
 * One-command setup for a machine joining a Synapse team. Resolves a git-derived
 * identity, joins (config + hooks + venv), runs a `doctor` preflight, then starts
 * the daemon in-process. With `--serve` it also spawns the coordination server as
 * a child; with `--tunnel` it exposes that server over a public `wss://` URL,
 * records it in the committed `.synapse/team.json`, and prints the teammate
 * onboarding command. SIGINT/SIGTERM tears down every spawned child.
 */
async function runUp(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const serve = flags.serve === "true";
  const tunnel = flags.tunnel === "true";
  if (tunnel && !serve) {
    throw new Error("--tunnel requires --serve (the tunnel exposes the server this host runs).");
  }

  const children: ChildProcess[] = [];
  const cleanup = (): void => {
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort — we are shutting down anyway
      }
    }
  };
  // Register before startDaemon so a Ctrl-C kills the server/tunnel children too
  // (startDaemon installs its own handler that closes the daemon and exits).
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  let config = configFromArgs(rawArgs);
  if (config.repoId === "local") {
    console.warn(
      'synapse: repoId is "local" — machines on different clones will NOT coordinate. ' +
        "Add a git remote, pass --repo-id, or set repoId in .synapse/team.json."
    );
  }

  // In public (tunnel) mode the server is internet-reachable, so a token is
  // mandatory; generate one if the operator did not supply it.
  let authToken = config.authToken;
  if (tunnel && !authToken) {
    authToken = randomBytes(24).toString("base64url");
    console.log("synapse: generated a shared auth token for this session.");
  }

  let serverUrl = config.serverUrl;

  if (serve) {
    const serverPort = numberDefault(flags["server-port"], process.env.SYNAPSE_SERVER_PORT, 4010);
    const healthUrl = `http://localhost:${serverPort}/health`;
    if (await isHealthy(healthUrl)) {
      console.log(`synapse: reusing the server already listening on :${serverPort}`);
    } else {
      children.push(startServerChild(serverPort, authToken, config.worktreeRoot));
      await waitForHealth(healthUrl, 10_000);
      console.log(`synapse: server listening on :${serverPort}`);
    }
    // The host's own daemon talks to the server over localhost — no NAT round
    // trip. Only teammates use the tunnel URL.
    serverUrl = `ws://localhost:${serverPort}`;

    if (tunnel) {
      const publicUrl = await startTunnel(serverPort, children);
      if (publicUrl) {
        await writeTeamConfig({
          serverUrl: publicUrl,
          repoId: config.repoId === "local" ? undefined : config.repoId
        });
        printTeammateInstructions(publicUrl, authToken);
      }
    }
  }

  config = { ...config, serverUrl, authToken };

  // Surface a server child dying (the daemon is useless without it).
  const serverChild = children[0];
  serverChild?.once("exit", (code, signal) => {
    if (signal !== "SIGTERM") {
      console.error(`synapse: server exited (${code ?? signal}); shutting down.`);
      cleanup();
      process.exit(1);
    }
  });

  await performJoin(config);

  const preflight = await runDoctor([], { mode: "preflight", config });
  printDoctor(preflight.checks);
  if (!preflight.ok) {
    cleanup();
    throw new Error("synapse doctor preflight failed (see above). Fix the FAILs and re-run `synapse up`.");
  }

  await startDaemon(config);
}

/**
 * Mint a project-scoped key for the server operator: HMAC(SYNAPSE_MASTER_SECRET,
 * repoId). The operator runs this once per project and shares the key
 * out-of-band; teammates pass it as SYNAPSE_PROJECT_KEY / --key. repoId resolves
 * via the same chain as `up`, so a checkout with a git remote needs no flags.
 */
function runKeygen(rawArgs: string[]): void {
  const secret = process.env.SYNAPSE_MASTER_SECRET ?? "";
  if (!secret) {
    throw new Error(
      "SYNAPSE_MASTER_SECRET is not set. Set the same master secret the server runs with, then re-run `synapse keygen`."
    );
  }

  const config = configFromArgs(rawArgs);
  if (config.repoId === "local") {
    console.warn(
      'synapse: repoId is "local" — this key only authorizes the "local" project. ' +
        "Add a git remote, pass --repo-id, or set repoId in .synapse/team.json to scope it to a real project."
    );
  }

  console.log(deriveProjectKey(secret, config.repoId));
}

/** Resolve the built @synapse/server entrypoint, or throw a clear build hint. */
function resolveServerEntry(): string {
  try {
    const pkg = createRequire(import.meta.url).resolve("@synapse/server/package.json");
    const entry = join(dirname(pkg), "dist/index.js");
    if (existsSync(entry)) {
      return entry;
    }
  } catch {
    // not resolvable as a dependency — fall back to the monorepo layout
  }

  const fallback = resolve(dirname(fileURLToPath(import.meta.url)), "../../server/dist/index.js");
  if (existsSync(fallback)) {
    return fallback;
  }

  throw new Error(
    "Could not find the @synapse/server build. Run `npm run build` (or install @synapse/server) and retry."
  );
}

function startServerChild(serverPort: number, authToken: string, worktreeRoot: string): ChildProcess {
  const entry = resolveServerEntry();
  const child = spawn(process.execPath, [entry], {
    cwd: commandCwd(),
    env: {
      ...process.env,
      SYNAPSE_SERVER_PORT: String(serverPort),
      // Durable by default in serve mode so a restart resumes live team state.
      SYNAPSE_DB_PATH: join(worktreeRoot, ".synapse-server", "state.db"),
      ...(authToken ? { SYNAPSE_AUTH_TOKEN: authToken } : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  return child;
}

/**
 * Spawn a quick tunnel (cloudflared, else ngrok) wrapping the local server and
 * return its public `wss://` URL. Overridable via SYNAPSE_TUNNEL_CMD for tests.
 * Falls back to a LAN URL hint (and returns null) when no tunnel binary exists.
 */
async function startTunnel(serverPort: number, children: ChildProcess[]): Promise<string | null> {
  const override = process.env.SYNAPSE_TUNNEL_CMD;
  const spec = override
    ? { cmd: "sh", args: ["-c", override] }
    : detectTunnel(serverPort);

  if (!spec) {
    console.warn("synapse: no tunnel binary found (install cloudflared: `brew install cloudflared`).");
    const lan = lanFallbackUrl(serverPort);
    if (lan) {
      console.warn(`synapse: teammates on the same network can use --server ${lan} (LAN only).`);
    }
    return null;
  }

  const child = spawn(spec.cmd, spec.args, {
    cwd: commandCwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  child.stdout?.on("data", (chunk) => process.stdout.write(`[tunnel] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[tunnel] ${chunk}`));

  const httpUrl = await captureTunnelUrl(child);
  if (!httpUrl) {
    console.warn("synapse: could not determine the tunnel URL within the timeout.");
    return null;
  }

  // The tunnel terminates TLS, so the daemon speaks wss to the public host.
  return httpUrl.replace(/^http/u, "ws");
}

function detectTunnel(serverPort: number): { cmd: string; args: string[] } | null {
  if (hasBinary("cloudflared")) {
    return { cmd: "cloudflared", args: ["tunnel", "--url", `http://localhost:${serverPort}`] };
  }
  if (hasBinary("ngrok")) {
    return { cmd: "ngrok", args: ["http", String(serverPort), "--log", "stdout"] };
  }
  return null;
}

function hasBinary(name: string): boolean {
  const lookup = process.platform === "win32" ? "where" : "which";
  try {
    return spawnSync(lookup, [name], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** Watch a tunnel child's output for its public https URL (timeout → null). */
function captureTunnelUrl(child: ChildProcess, timeoutMs = 20_000): Promise<string | null> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let buffer = "";
    const pattern =
      /https:\/\/[a-z0-9-]+\.(?:trycloudflare\.com|ngrok-free\.app|ngrok\.io|ngrok\.app)\b[^\s"']*/iu;

    const settle = (url: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      resolvePromise(url);
    };

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const match = pattern.exec(buffer);
      if (match) {
        settle(match[0]);
      }
    };

    const timer = setTimeout(() => settle(null), timeoutMs);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
  });
}

/** First non-internal IPv4 address as a ws URL, for the no-tunnel LAN fallback. */
function lanFallbackUrl(serverPort: number): string | null {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) {
        return `ws://${info.address}:${serverPort}`;
      }
    }
  }
  return null;
}

/** Merge updates into the committed `.synapse/team.json` (read-merge-write). */
async function writeTeamConfig(update: { serverUrl?: string; repoId?: string }): Promise<void> {
  const dir = join(commandCwd(), ".synapse");
  await mkdir(dir, { recursive: true });
  const existing = readTeamConfig();
  const merged: TeamConfig = {
    schemaVersion: 1,
    serverUrl: update.serverUrl ?? existing.serverUrl,
    repoId: update.repoId ?? existing.repoId
  };
  await writeFile(
    join(dir, "team.json"),
    `${JSON.stringify(omitUndefined(merged), null, 2)}\n`
  );
  console.log(`wrote ${join(dir, "team.json")} (commit this so teammates inherit the server URL)`);
}

function omitUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

function printTeammateInstructions(publicUrl: string, authToken: string): void {
  console.log("\n── Share with teammates ──────────────────────────────");
  console.log(`server URL (in .synapse/team.json): ${publicUrl}`);
  console.log("1. Commit the updated .synapse/team.json.");
  console.log("2. Each teammate pulls, then runs `synapse up` in their clone of the repo:");
  const tokenPart = authToken ? `SYNAPSE_AUTH_TOKEN=${authToken} ` : "";
  console.log(`     ${tokenPart}synapse up`);
  console.log("   If synapse isn't on your PATH, run it from your source checkout instead:");
  console.log(`     ${tokenPart}node <path-to-synapse-checkout>/apps/cli/dist/index.js up`);
  if (authToken) {
    console.log("   The token is secret — share it over Slack/1Password, never commit it.");
  }
  console.log("──────────────────────────────────────────────────────\n");
}

async function isHealthy(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isHealthy(url)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become healthy at ${url} within ${timeoutMs}ms`);
}

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
async function runDoctor(
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

function printDoctor(checks: DoctorCheck[]): void {
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
  const tokenParam = config.authToken ? `&token=${encodeURIComponent(config.authToken)}` : "";
  const url = `${config.serverUrl}?repoId=${encodeURIComponent(config.repoId)}&sessionId=synapse-doctor${tokenParam}`;
  return new Promise((resolvePromise) => {
    const ws = new WebSocket(url);
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
  const tokenParam = config.authToken ? `&token=${encodeURIComponent(config.authToken)}` : "";
  const url = `${httpFromWs(config.serverUrl)}/state?repoId=${encodeURIComponent(config.repoId)}${tokenParam}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
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

/** Absolute path to this CLI's entrypoint, for embedding in hook commands. */
function cliEntrypoint(): string {
  return fileURLToPath(import.meta.url);
}

/** The shell command Claude Code runs for a given hook stage. */
function hookCommand(stage: "pre" | "post" | "session-start"): string {
  return `node "${cliEntrypoint()}" hook ${stage}`;
}

/**
 * Merge Synapse's `PreToolUse`/`PostToolUse` hooks into the repo's
 * `.claude/settings.json` without disturbing existing hooks. Idempotent: a
 * re-join does not duplicate the entries.
 */
async function installClaudeCodeHooks(repoDir: string): Promise<void> {
  const settingsDir = join(repoDir, ".claude");
  const settingsPath = join(settingsDir, "settings.json");
  await mkdir(settingsDir, { recursive: true });

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      console.warn(`synapse: could not read ${settingsPath}; leaving Claude Code hooks uninstalled.`);
      return;
    }
  }

  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  const editMatcher = "Edit|Write|MultiEdit";
  const startMatcher = "startup|resume|clear";

  settings.hooks = {
    ...hooks,
    PreToolUse: withSynapseHook(hooks.PreToolUse, editMatcher, hookCommand("pre"), "pre"),
    PostToolUse: withSynapseHook(hooks.PostToolUse, editMatcher, hookCommand("post"), "post"),
    SessionStart: withSynapseHook(
      hooks.SessionStart,
      startMatcher,
      hookCommand("session-start"),
      "session-start"
    )
  };

  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`installed Claude Code hooks in ${settingsPath}`);
}

interface HookEntry {
  matcher?: string;
  hooks?: { type: string; command: string }[];
}

/**
 * Return the event's matcher groups with our `synapse hook` command ensured
 * present exactly once under `matcher`, preserving any other groups/commands.
 */
function withSynapseHook(
  existing: unknown,
  matcher: string,
  command: string,
  stage: "pre" | "post" | "session-start"
): HookEntry[] {
  const groups: HookEntry[] = Array.isArray(existing) ? (existing as HookEntry[]).map(cloneEntry) : [];

  // Identify our command for this stage regardless of the embedded absolute path.
  const isOurStage = (value: string): boolean => new RegExp(`\\bhook ${stage}\\b`, "u").test(value);

  let group = groups.find((entry) => entry.matcher === matcher);
  if (!group) {
    group = { matcher, hooks: [] };
    groups.push(group);
  }
  group.hooks ??= [];

  // Drop any prior Synapse command for this stage (handles a moved CLI path),
  // then add the current one. Non-Synapse hooks are untouched.
  group.hooks = group.hooks.filter((hook) => !isOurStage(hook.command));
  group.hooks.push({ type: "command", command });

  return groups;
}

function cloneEntry(entry: HookEntry): HookEntry {
  return { ...entry, hooks: entry.hooks ? entry.hooks.map((hook) => ({ ...hook })) : undefined };
}

/** Run the analyzer-py venv setup script, resolved from the installed package. */
function setupPythonAnalyzerVenv(): void {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve("@synapse/analyzer-py/package.json");
    const script = join(dirname(packageJson), "scripts", "setup-venv.mjs");
    const result = spawnSync(process.execPath, [script], { stdio: "inherit" });
    if (result.status !== 0) {
      console.warn("synapse: Python analyzer setup skipped; .py files will use file-level detection.");
    }
  } catch {
    console.warn("synapse: Python analyzer package not found; .py files will use file-level detection.");
  }
}

async function runAnalyze(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const filePath = requiredFlag(flags, "file");
  const source = await readFile(resolve(commandCwd(), filePath), "utf8");
  const result = isPythonLike(filePath)
    ? await extractPythonContracts({ filePath, source })
    : extractTypeScriptContracts({ filePath, source });
  if (isPythonLike(filePath)) {
    closePythonAnalyzer();
  }
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Claude Code hook entrypoint. Invoked by `.claude/settings.json` before
 * (`pre`) and after (`post`) Edit/Write/MultiEdit. Reads the hook JSON on
 * stdin, maps the target file to a repo-relative path, and talks to the local
 * daemon. It must NEVER break the agent: any error, a missing daemon, or an
 * out-of-tree file exits 0 with no decision.
 */
async function runHook(rawArgs: string[]): Promise<void> {
  const stage = hookStage(rawArgs[0]);
  try {
    const input = parseHookInput(await readStdin());
    const defaults = commandDefaults({});
    const baseUrl = `http://localhost:${defaults.daemonPort}`;

    if (stage === "session-start") {
      await runSessionStartHook(baseUrl, defaults);
      return;
    }

    const filePath = hookRelativePath(input);
    if (!filePath) {
      return; // Not a file edit we can map — stay silent.
    }

    if (stage === "post") {
      await postJson(`${baseUrl}/tools/synapse_report`, {
        repoId: defaults.repoId,
        sessionId: defaults.sessionId,
        filePath
      }).catch(() => undefined);
      return;
    }

    const result = (await postJson(`${baseUrl}/tools/synapse_check`, {
      repoId: defaults.repoId,
      sessionId: defaults.sessionId,
      files: [filePath]
    }).catch(() => null)) as SynapseCheckResponse | null;

    if (result && result.verdict !== "none" && result.conflicts.length > 0) {
      process.stdout.write(`${JSON.stringify(preToolUseDecision(filePath, result))}\n`);
    }
  } catch {
    // Swallow everything — a hook must not interrupt or fail the edit.
  }
}

function hookStage(value: string | undefined): "pre" | "post" | "session-start" {
  if (value === "post") {
    return "post";
  }
  if (value === "session-start") {
    return "session-start";
  }
  return "pre";
}

/**
 * SessionStart hook: greet a starting session with a catch-up on what changed
 * while it was away — recent pushes, teammates' unpushed contract changes, and
 * recent session summaries — injected as Claude Code context. Silent when there
 * is nothing new or the daemon is unreachable.
 */
async function runSessionStartHook(
  baseUrl: string,
  defaults: { repoId: string; sessionId: string }
): Promise<void> {
  const briefing = (await postJson(`${baseUrl}/tools/synapse_whatsup`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId
  }).catch(() => null)) as SynapseWhatsupResponse | null;
  if (!briefing) {
    return;
  }

  const context = sessionStartBriefing(briefing, defaults.sessionId);
  if (!context) {
    return; // All caught up — stay silent.
  }

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context }
    })}\n`
  );
}

/** Build the catch-up text from a whatsup briefing, excluding the reader's own work. */
function sessionStartBriefing(briefing: SynapseWhatsupResponse, selfSessionId: string): string | null {
  const sections: string[] = [];

  const pushes = briefing.recentPushes.slice(0, 5);
  if (pushes.length > 0) {
    sections.push(
      `Recent pushes:\n${pushes
        .map((push) => `  • ${push.memberId}: ${push.summary} (${push.filesAffected.length} file(s))`)
        .join("\n")}`
    );
  }

  const repoEvents = briefing.recentRepoEvents.slice(0, 5);
  if (repoEvents.length > 0) {
    sections.push(
      `Recent GitHub activity:\n${repoEvents
        .map((event) => `  • ${event.actor}: ${event.summary}`)
        .join("\n")}`
    );
  }

  const othersDeltas = briefing.unpushedDeltas.filter((delta) => delta.sessionId !== selfSessionId);
  if (othersDeltas.length > 0) {
    sections.push(
      `Teammates' unpushed contract changes:\n${othersDeltas
        .slice(0, 5)
        .map((delta) => `  • ${delta.memberLogin}: ${delta.symbolId.raw} (${delta.changeKind})`)
        .join("\n")}`
    );
  }

  const summaries = briefing.sessionSummaries.filter((summary) => summary.sessionId !== selfSessionId);
  if (summaries.length > 0) {
    sections.push(
      `Recent session summaries:\n${summaries
        .slice(0, 3)
        .map((summary) => `  • ${summary.summary}`)
        .join("\n")}`
    );
  }

  if (sections.length === 0) {
    return null;
  }

  return `📋 Synapse catch-up for ${briefing.repoId}:\n${sections.join("\n\n")}`;
}

/**
 * Build the Claude Code `PreToolUse` response that surfaces a conflict. Default
 * is `ask` so the developer decides (proceed/adjust/ping) — the "agents query,
 * humans decide" principle — never an auto-block. Set `SYNAPSE_HOOK_NONBLOCKING=1`
 * to instead inject the heads-up as context and proceed without a prompt.
 */
function preToolUseDecision(filePath: string, result: SynapseCheckResponse): unknown {
  const heading = `⚠ Synapse: ${result.conflicts.length} potential conflict(s) before editing ${filePath}`;
  const lines = result.conflicts.map((conflict) => {
    const who = conflict.counterpart.memberLogin;
    const detail = conflict.analysis?.assessment ?? conflict.detail;
    const next = conflict.suggestion ? ` → ${conflict.suggestion}` : "";
    return `• [${conflict.rule}] ${detail} (with ${who})${next}`;
  });
  const message = [heading, ...lines].join("\n");

  if (process.env.SYNAPSE_HOOK_NONBLOCKING === "1") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        additionalContext: message
      }
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: message
    }
  };
}

/** Map a hook payload's absolute `file_path` to a path relative to the worktree. */
function hookRelativePath(input: HookInput): string | null {
  const absolute = input.toolInput?.file_path;
  if (!absolute || typeof absolute !== "string") {
    return null;
  }

  const worktreeRoot = readLocalConfig().worktreeRoot ?? input.cwd ?? commandCwd();
  const relativePath = normalizePath(relative(worktreeRoot, absolute));
  // Outside the worktree (".." prefix) or empty → not ours to check.
  if (!relativePath || relativePath.startsWith("..")) {
    return null;
  }

  return relativePath;
}

interface HookInput {
  toolName?: string;
  cwd?: string;
  toolInput?: { file_path?: unknown };
}

function parseHookInput(raw: string): HookInput {
  if (!raw.trim()) {
    return {};
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const toolInput = isRecord(parsed.tool_input) ? parsed.tool_input : undefined;
  return {
    toolName: typeof parsed.tool_name === "string" ? parsed.tool_name : undefined,
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
    toolInput: toolInput as HookInput["toolInput"]
  };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configFromArgs(rawArgs: string[]): RuntimeConfig {
  const flags = parseFlags(rawArgs);
  const localConfig = readLocalConfig();
  const teamConfig = readTeamConfig();
  const member =
    flags.member ?? process.env.SYNAPSE_MEMBER ?? localConfig.member ?? gitMember();

  return {
    repoId:
      flags["repo-id"] ??
      process.env.SYNAPSE_REPO_ID ??
      localConfig.repoId ??
      teamConfig.repoId ??
      (gitRepoId() || "local"),
    member,
    sessionId:
      flags.session ??
      process.env.SYNAPSE_SESSION_ID ??
      localConfig.sessionId ??
      `${member}-${randomUUID()}`,
    agentType: agentType(flags.agent ?? process.env.SYNAPSE_AGENT ?? localConfig.agentType ?? "other"),
    daemonPort: numberDefault(flags.port, process.env.SYNAPSE_DAEMON_PORT, localConfig.daemonPort, 4011),
    serverUrl:
      flags.server ??
      process.env.SYNAPSE_SERVER_URL ??
      localConfig.serverUrl ??
      teamConfig.serverUrl ??
      "ws://localhost:4010",
    worktreeRoot: resolve(
      flags["worktree-root"] ??
        process.env.SYNAPSE_WORKTREE_ROOT ??
        localConfig.worktreeRoot ??
        gitWorktreeRoot()
    ),
    // Sourced from flag/env only — never persisted to .synapse/config.json so a
    // secret credential does not land on disk. A project key (--key /
    // SYNAPSE_PROJECT_KEY) and a shared token (--token / SYNAPSE_AUTH_TOKEN) both
    // ride this field; the server decides which it is by its own auth mode.
    authToken:
      flags.key ??
      process.env.SYNAPSE_PROJECT_KEY ??
      flags.token ??
      process.env.SYNAPSE_AUTH_TOKEN ??
      ""
  };
}

function commandDefaults(flags: Record<string, string>): {
  repoId: string;
  sessionId: string;
  daemonPort: number;
} {
  const localConfig = readLocalConfig();
  const teamConfig = readTeamConfig();

  return {
    // Same chain as configFromArgs so the hook-driven check/report resolve the
    // exact room the daemon joined. `.synapse/config.json` (written by join/up)
    // carries repoId, so the hot path never shells out to git in steady state.
    repoId:
      flags["repo-id"] ??
      process.env.SYNAPSE_REPO_ID ??
      localConfig.repoId ??
      teamConfig.repoId ??
      (gitRepoId() || "local"),
    sessionId: flags.session ?? process.env.SYNAPSE_SESSION_ID ?? localConfig.sessionId ?? "local",
    daemonPort: numberDefault(flags.port, process.env.SYNAPSE_DAEMON_PORT, localConfig.daemonPort, 4011)
  };
}

/** Run a read-only git command from the command cwd; "" on any failure. */
function git(gitArgs: string[]): string {
  try {
    const result = spawnSync("git", gitArgs, {
      cwd: commandCwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return result.status === 0 ? (result.stdout ?? "").trim() : "";
  } catch {
    return "";
  }
}

/**
 * Canonical `host/owner/repo` slug from the git origin remote (falling back to
 * the first remote), or "" when there is no usable remote. This is what lets two
 * clones of the same repo share a coordination room with zero configuration.
 */
function gitRepoId(): string {
  const origin = git(["config", "--get", "remote.origin.url"]);
  const url = origin || firstRemoteUrl();
  return url ? normalizeRemoteUrl(url) : "";
}

function firstRemoteUrl(): string {
  const remotes = git(["remote"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return remotes.length > 0 ? git(["config", "--get", `remote.${remotes[0]}.url`]) : "";
}

/** The git worktree root, or the command cwd when not inside a git tree. */
function gitWorktreeRoot(): string {
  return git(["rev-parse", "--show-toplevel"]) || commandCwd();
}

/** Best display name for this member: git identity, then $USER, then "local". */
function gitMember(): string {
  return (
    git(["config", "user.name"]) ||
    git(["config", "user.email"]) ||
    process.env.USER ||
    "local"
  );
}

function readLocalConfig(): LocalConfig {
  const path = join(commandCwd(), ".synapse", "config.json");
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }

  const rawAgentType = stringValue(parsed.agentType);

  return {
    repoId: stringValue(parsed.repoId),
    member: stringValue(parsed.member),
    sessionId: stringValue(parsed.sessionId),
    agentType: rawAgentType ? agentType(rawAgentType) : undefined,
    daemonPort: numberValue(parsed.daemonPort),
    serverUrl: stringValue(parsed.serverUrl),
    worktreeRoot: stringValue(parsed.worktreeRoot)
  };
}

/**
 * Read `.synapse/team.json` — the committed, shared, non-secret team config that
 * carries the coordination server URL (and optional repoId) so a teammate
 * inherits them on checkout. A missing file is fine (returns {}); a malformed
 * committed file is loud (rethrows) so the team notices a bad commit.
 */
function readTeamConfig(): TeamConfig {
  const path = join(commandCwd(), ".synapse", "team.json");
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }

  return {
    schemaVersion: numberValue(parsed.schemaVersion),
    serverUrl: stringValue(parsed.serverUrl),
    repoId: stringValue(parsed.repoId)
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function numberDefault(...values: Array<number | string | undefined>): number {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  throw new Error("missing numeric default");
}

function makeSession(config: RuntimeConfig, task: string | null = null): Session {
  const now = new Date().toISOString();
  return {
    id: config.sessionId,
    repoId: config.repoId,
    memberId: config.member,
    memberLogin: config.member,
    agentType: config.agentType,
    filesOpen: [],
    filesEditing: [],
    lastTask: task,
    startedAt: now,
    lastSeen: now,
    status: "active"
  };
}

/**
 * Distill the ending session's contract changes into a {@link SessionSummary}.
 * Deterministic by default (a structured list of the session's deltas); upgraded
 * to prose by the LLM summarizer when one is configured. Reads the session's own
 * unpushed deltas from the warm cache — never raw code.
 */
async function buildSessionSummary(
  config: RuntimeConfig,
  state: TeamState,
  provider: SummaryProvider | null,
  task: string | undefined
): Promise<SessionSummary> {
  const now = new Date().toISOString();
  const session = state.sessions.find((candidate) => candidate.id === config.sessionId);
  const resolvedTask = task ?? session?.lastTask ?? null;
  const myDeltas = state.unpushedDeltas.filter(
    (delta) => delta.sessionId === config.sessionId && delta.pushedAt === null
  );
  const symbols = [...new Map(myDeltas.map((delta) => [delta.symbolId.raw, delta.symbolId])).values()];

  let summary = deterministicSessionSummary(config.member, resolvedTask, myDeltas);
  let source = "deterministic";

  if (provider && myDeltas.length > 0) {
    const llm = await provider
      .summarizeSession({
        member: config.member,
        task: resolvedTask,
        deltas: myDeltas.map(summaryDeltaFor)
      })
      .catch(() => null);
    if (llm) {
      summary = llm;
      source = provider.model;
    }
  }

  return {
    sessionId: config.sessionId,
    repoId: config.repoId,
    memberLogin: config.member,
    task: resolvedTask,
    summary,
    symbols,
    deltaCount: myDeltas.length,
    source,
    startedAt: session?.startedAt ?? now,
    endedAt: now
  };
}

function summaryDeltaFor(delta: ContractDelta): SessionSummaryDelta {
  return {
    symbol: delta.symbolId.raw,
    changeKind: delta.changeKind,
    before: delta.before?.raw ?? null,
    after: delta.after?.raw ?? null,
    summary: delta.summary
  };
}

/** A structured, no-LLM summary of a session's contract changes. */
function deterministicSessionSummary(
  member: string,
  task: string | null,
  deltas: ContractDelta[]
): string {
  const taskSuffix = task ? ` Task: ${task}.` : "";
  if (deltas.length === 0) {
    return `${member}'s session ended with no contract changes.${taskSuffix}`;
  }

  const fileCount = new Set(deltas.map((delta) => delta.filePath)).size;
  const items = deltas.slice(0, 5).map((delta) => {
    const name = delta.symbolId.raw.split("#").pop() ?? delta.symbolId.raw;
    const shape =
      delta.before?.raw && delta.after?.raw ? `: ${delta.before.raw} -> ${delta.after.raw}` : "";
    return `${name} (${delta.changeKind}${shape})`;
  });
  const more = deltas.length > items.length ? `, +${deltas.length - items.length} more` : "";

  return (
    `${member}'s session changed ${deltas.length} contract${deltas.length === 1 ? "" : "s"} ` +
    `across ${fileCount} file${fileCount === 1 ? "" : "s"}: ${items.join(", ")}${more}.${taskSuffix}`
  );
}

function buildWhatsupResponse(
  state: TeamState,
  options: { degraded: boolean; limit?: number }
): SynapseWhatsupResponse {
  const limit = clampLimit(options.limit);
  const memberBySession = new Map(
    state.sessions.map((session) => [
      session.id,
      session.memberLogin ?? session.memberId ?? session.id
    ])
  );
  const activeSessions = state.sessions
    .filter((session) => session.status !== "ended")
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  const unpushedDeltas = [...state.unpushedDeltas]
    .filter((delta) => delta.pushedAt === null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recentPushes = [...state.recentPushes].sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
  const recentRepoEvents = [...state.recentRepoEvents].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
  const resolutions = [...state.resolutions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const sessionSummaries = [...state.sessionSummaries].sort((a, b) =>
    b.endedAt.localeCompare(a.endedAt)
  );
  const conflictFeedback = [...state.conflictFeedback].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );

  return {
    repoId: state.repoId,
    generatedAt: new Date().toISOString(),
    degraded: options.degraded,
    summary: [
      `${activeSessions.length} active session${activeSessions.length === 1 ? "" : "s"}`,
      `${unpushedDeltas.length} unpushed contract delta${unpushedDeltas.length === 1 ? "" : "s"}`,
      `${state.editLocks.length} active edit lock${state.editLocks.length === 1 ? "" : "s"}`,
      `${recentPushes.length} recent push${recentPushes.length === 1 ? "" : "es"}`,
      `${recentRepoEvents.length} GitHub repo event${recentRepoEvents.length === 1 ? "" : "s"}`,
      `${resolutions.length} shared resolution${resolutions.length === 1 ? "" : "s"}`,
      `${sessionSummaries.length} session summar${sessionSummaries.length === 1 ? "y" : "ies"}`,
      `${conflictFeedback.length} conflict feedback event${conflictFeedback.length === 1 ? "" : "s"}`
    ],
    sessions: activeSessions.slice(0, limit).map((session) => ({
      id: session.id,
      memberLogin: session.memberLogin ?? session.memberId,
      agentType: session.agentType,
      status: session.status,
      lastTask: session.lastTask,
      filesEditing: session.filesEditing,
      lastSeen: session.lastSeen
    })),
    unpushedDeltas: unpushedDeltas.slice(0, limit).map((delta) => ({
      id: delta.id,
      sessionId: delta.sessionId,
      memberLogin: memberBySession.get(delta.sessionId) ?? delta.sessionId,
      symbolId: delta.symbolId,
      changeKind: delta.changeKind,
      summary: delta.summary,
      filePath: delta.filePath,
      before: delta.before?.raw ?? null,
      after: delta.after?.raw ?? null,
      baseSha: delta.baseSha,
      createdAt: delta.createdAt
    })),
    editLocks: state.editLocks.slice(0, limit),
    recentPushes: recentPushes.slice(0, limit),
    recentRepoEvents: recentRepoEvents.slice(0, limit),
    resolutions: resolutions.slice(0, limit),
    sessionSummaries: sessionSummaries.slice(0, limit),
    conflictFeedback: conflictFeedback.slice(0, limit)
  };
}

function buildWhyResponse(
  state: TeamState,
  question: string,
  options: { degraded: boolean; limit?: number }
): SynapseWhyResponse {
  const limit = clampWhyLimit(options.limit);
  const terms = questionTerms(question);
  const sources = whySources(state)
    .map((source) => ({ ...source, score: scoreWhySource(source, terms) }))
    .filter((source) => source.score > 0)
    .sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);

  const answer =
    sources.length === 0
      ? `No matching Synapse memory found for "${question}". Try a symbol, file, PR title, teammate, or task keyword.`
      : [
          `Found ${sources.length} Synapse memor${sources.length === 1 ? "y" : "ies"} related to "${question}":`,
          ...sources.map((source, index) => `${index + 1}. ${source.title} — ${source.summary}`)
        ].join("\n");

  return {
    repoId: state.repoId,
    generatedAt: new Date().toISOString(),
    degraded: options.degraded,
    question,
    answer,
    sources
  };
}

function whySources(state: TeamState): SynapseWhySource[] {
  const memberBySession = new Map(
    state.sessions.map((session) => [
      session.id,
      session.memberLogin ?? session.memberId ?? session.id
    ])
  );

  return [
    ...state.sessionSummaries.map((summary) => ({
      kind: "session_summary" as SynapseWhySourceKind,
      title: `${summary.memberLogin}'s ended session`,
      summary: summary.summary,
      createdAt: summary.endedAt,
      score: 0,
      reference: summary.sessionId
    })),
    ...state.recentRepoEvents.map((event) => ({
      kind: "repo_event" as SynapseWhySourceKind,
      title: event.title,
      summary: `${event.actor}: ${event.summary}`,
      createdAt: event.createdAt,
      score: 0,
      url: event.url,
      reference: event.number ? `#${event.number}` : event.kind
    })),
    ...state.recentPushes.map((push) => ({
      kind: "recent_push" as SynapseWhySourceKind,
      title: `Push ${push.sha}`,
      summary: `${push.memberId}: ${push.summary} (${push.filesAffected.join(", ")})`,
      createdAt: push.pushedAt,
      score: 0,
      reference: push.sha
    })),
    ...state.resolutions.map((resolution) => ({
      kind: "resolution" as SynapseWhySourceKind,
      title: `Resolution for ${resolution.symbol.raw}`,
      summary: `${resolution.recommendation}: ${resolution.instruction} ${resolution.rationale}`,
      createdAt: resolution.createdAt,
      score: 0,
      reference: resolution.inputsHash
    })),
    ...state.conflictFeedback.map((feedback) => ({
      kind: "conflict_feedback" as SynapseWhySourceKind,
      title: `${memberBySession.get(feedback.sessionId) ?? feedback.memberId} ${feedback.outcome} on ${feedback.conflictId}`,
      summary: [
        feedback.rule ? `rule ${feedback.rule}` : "",
        feedback.targetSymbol?.raw ? `target ${feedback.targetSymbol.raw}` : "",
        feedback.note ?? ""
      ]
        .filter(Boolean)
        .join("; "),
      createdAt: feedback.createdAt,
      score: 0,
      reference: feedback.conflictId
    })),
    ...state.unpushedDeltas
      .filter((delta) => delta.pushedAt === null)
      .map((delta) => ({
        kind: "unpushed_delta" as SynapseWhySourceKind,
        title: `${memberBySession.get(delta.sessionId) ?? delta.sessionId} changed ${delta.symbolId.raw}`,
        summary: [
          delta.summary,
          delta.before?.raw && delta.after?.raw ? `${delta.before.raw} -> ${delta.after.raw}` : "",
          delta.filePath
        ]
          .filter(Boolean)
          .join(" "),
        createdAt: delta.createdAt,
        score: 0,
        reference: delta.symbolId.raw
      })),
    ...state.sessions.map((session) => ({
      kind: "session" as SynapseWhySourceKind,
      title: `${session.memberLogin ?? session.memberId}'s ${session.status} session`,
      summary: [
        session.lastTask ?? "No task recorded",
        session.filesEditing.length ? `editing ${session.filesEditing.join(", ")}` : ""
      ]
        .filter(Boolean)
        .join("; "),
      createdAt: session.lastSeen,
      score: 0,
      reference: session.id
    }))
  ];
}

function scoreWhySource(source: SynapseWhySource, terms: string[]): number {
  if (terms.length === 0) {
    return 1;
  }

  const text = `${source.kind} ${source.title} ${source.summary} ${source.reference ?? ""}`.toLowerCase();
  return terms.reduce((score, term) => score + (text.includes(term) ? term.length : 0), 0);
}

function questionTerms(question: string): string[] {
  const stopwords = new Set([
    "a",
    "an",
    "and",
    "are",
    "did",
    "do",
    "for",
    "how",
    "is",
    "it",
    "of",
    "on",
    "or",
    "the",
    "to",
    "was",
    "what",
    "when",
    "where",
    "who",
    "why"
  ]);

  return [...new Set(question.toLowerCase().match(/[a-z0-9_.#/-]+/gu) ?? [])].filter(
    (term) => term.length > 1 && !stopwords.has(term)
  );
}

function clampWhyLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 5;
  }

  return Math.max(1, Math.min(20, Math.trunc(value)));
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 10;
  }

  return Math.max(1, Math.min(50, Math.trunc(value)));
}

function envelope(type: ClientMessage["type"], payload: unknown): ClientMessage {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: randomUUID(),
    ts: new Date().toISOString(),
    payload
  } as ClientMessage;
}

interface CheckTarget {
  filePath: string;
  symbolId: ContractDelta["symbolId"];
  /** The checking agent's current local signature for the symbol, if known. */
  selfSignature?: Signature | null;
}

async function resolveCheckTargets(
  config: RuntimeConfig,
  body: Partial<SynapseCheckRequest>,
  cache?: AnalysisCache
): Promise<CheckTarget[]> {
  const files = body.files ?? [];
  const targets: CheckTarget[] = [];

  for (const [index, filePath] of files.entries()) {
    const explicitSymbol = body.symbols?.[index];
    if (explicitSymbol) {
      targets.push({ filePath, symbolId: explicitSymbol });
      continue;
    }

    if (!isAnalyzable(filePath)) {
      targets.push({ filePath, symbolId: symbolForFile(filePath) });
      continue;
    }

    const symbols = await extractSymbolsForFile(config, filePath, cache);
    if (symbols.length === 0) {
      targets.push({ filePath, symbolId: symbolForFile(filePath) });
      continue;
    }

    for (const symbol of symbols) {
      targets.push({ filePath, symbolId: symbol.id, selfSignature: symbol.signature });
    }
  }

  return targets;
}

/** The checking agent's local signature per symbol, for both-sides analysis. */
function selfSignatures(targets: CheckTarget[]): Map<string, Signature | null> {
  const signatures = new Map<string, Signature | null>();
  for (const target of targets) {
    signatures.set(target.symbolId.raw, target.selfSignature ?? null);
  }

  return signatures;
}

/** The checking agent's own unpushed change per symbol, for both-sides analysis. */
function selfChanges(state: TeamState, selfSessionId: string): Map<string, ContractChange | null> {
  const changes = new Map<string, ContractChange | null>();
  for (const delta of state.unpushedDeltas) {
    if (delta.sessionId === selfSessionId && delta.pushedAt === null) {
      changes.set(delta.symbolId.raw, contractChangeFor(delta));
    }
  }

  return changes;
}

interface DaemonGraph {
  graph: DependencyGraph;
  /** A symbol's dependency-graph neighbors (it imports / is imported by) and
   * their signatures, for caller-aware resolution context. */
  neighborsOf(symbolRaw: string): { symbol: string; signature: string }[];
}

async function buildDependencyGraph(
  config: RuntimeConfig,
  cache?: AnalysisCache
): Promise<DaemonGraph> {
  // Build each language's graph locally, then merge. Symbol ids are
  // language-prefixed (`ts:` / `py:`), so the union never collides and the
  // conflict engine sees one graph spanning both.
  const [tsFingerprints, pyFingerprints] = await Promise.all([
    readSourceFileFingerprints(config.worktreeRoot, isTypeScriptLike),
    readSourceFileFingerprints(config.worktreeRoot, isPythonLike)
  ]);
  const graphFingerprint = sourceSetFingerprint([...tsFingerprints, ...pyFingerprints]);
  if (cache?.graph?.fingerprint === graphFingerprint) {
    return cache.graph.value;
  }

  const [tsFiles, pyFiles] = await Promise.all([
    readSourceFiles(config.worktreeRoot, isTypeScriptLike),
    readSourceFiles(config.worktreeRoot, isPythonLike)
  ]);

  const symbols: CodeSymbol[] = [];
  const edges: { from: ContractDelta["symbolId"]; to: ContractDelta["symbolId"] }[] = [];

  if (tsFiles.length > 0) {
    const tsGraph = extractTypeScriptDependencyGraph({ files: tsFiles });
    symbols.push(...tsGraph.symbols);
    edges.push(...tsGraph.edges);
  }

  if (pyFiles.length > 0) {
    try {
      const pyGraph = await extractPythonDependencyGraph({ files: pyFiles });
      symbols.push(...pyGraph.symbols);
      edges.push(...pyGraph.edges);
    } catch (error) {
      warnAnalyzerDegraded("python", "dependency graph", error);
    }
  }

  if (symbols.length === 0 && edges.length === 0) {
    const empty = { graph: emptyDependencyGraph, neighborsOf: () => [] };
    if (cache) {
      cache.graph = { fingerprint: graphFingerprint, value: empty };
    }
    return empty;
  }

  const adjacency = new Map<string, ContractDelta["symbolId"][]>();
  const signatureBySymbol = new Map<string, string>();

  for (const symbol of symbols) {
    signatureBySymbol.set(symbol.id.raw, symbol.signature?.raw ?? symbol.name);
  }

  for (const edge of edges) {
    const dependencies = adjacency.get(edge.from.raw) ?? [];
    dependencies.push(edge.to);
    adjacency.set(edge.from.raw, dependencies);
  }

  const neighborsOf = (symbolRaw: string): { symbol: string; signature: string }[] => {
    const related = new Set<string>();
    for (const edge of edges) {
      if (edge.from.raw === symbolRaw) {
        related.add(edge.to.raw);
      } else if (edge.to.raw === symbolRaw) {
        related.add(edge.from.raw);
      }
    }

    return [...related].map((raw) => ({
      symbol: raw,
      signature: signatureBySymbol.get(raw) ?? raw
    }));
  };

  const dependencyGraph: DependencyGraph = {
    dependenciesOf(symbolId, maxHops): DependencyHop[] {
      const result: DependencyHop[] = [];
      const seen = new Set<string>([symbolId.raw]);
      const queue: { symbolId: ContractDelta["symbolId"]; hops: number }[] = [
        { symbolId, hops: 0 }
      ];

      while (queue.length > 0) {
        const current = queue.shift();
        if (!current || current.hops >= maxHops) {
          continue;
        }

        for (const dependency of adjacency.get(current.symbolId.raw) ?? []) {
          if (seen.has(dependency.raw)) {
            continue;
          }

          const hops = current.hops + 1;
          seen.add(dependency.raw);
          result.push({ symbolId: dependency, hops });
          queue.push({ symbolId: dependency, hops });
        }
      }

      return result;
    }
  };

  const value = { graph: dependencyGraph, neighborsOf };
  if (cache) {
    cache.graph = { fingerprint: graphFingerprint, value };
  }
  return value;
}

/**
 * Attach a converged merged-contract resolution to every `contract_divergent`
 * conflict. Order of preference: (1) the server-canonical resolution already
 * stored for this exact `(symbol, inputsHash)` — so both agents read the same
 * object; (2) a freshly generated one from the LLM resolver, validated and then
 * published so it becomes canonical; (3) the engine's deterministic escalate,
 * which is already on `conflict.analysis.resolution`.
 */
async function attachResolutions(
  config: RuntimeConfig,
  conflicts: Conflict[],
  teamState: TeamState,
  resolutionProvider: ResolutionProvider | null,
  neighborsOf: (symbolRaw: string) => { symbol: string; signature: string }[],
  sendToServer: (type: ClientMessage["type"], payload: unknown) => void
): Promise<Conflict[]> {
  return Promise.all(
    conflicts.map(async (conflict) => {
      if (conflict.rule !== "contract_divergent" || !conflict.analysis) {
        return conflict;
      }

      const symbol = conflict.targetSymbol.raw;
      const sides = labelSides(resolutionSidesForSymbol(teamState.unpushedDeltas, symbol), teamState);
      const inputsHash = resolutionInputsHash(symbol, sides);

      // (1) Convergence: a resolution for this exact pair already exists.
      const stored = teamState.resolutions.find(
        (resolution) => resolution.symbol.raw === symbol && resolution.inputsHash === inputsHash
      );
      if (stored) {
        return withResolution(conflict, toProposed(stored));
      }

      if (!resolutionProvider) {
        return conflict; // (3) keep the deterministic escalate.
      }

      // (2) Generate, validate, publish.
      const filePath = teamState.unpushedDeltas.find(
        (delta) => delta.symbolId.raw === symbol
      )?.filePath;
      const fileContext = filePath ? await readFileContext(config, filePath) : undefined;

      let proposed: ProposedResolution | null = null;
      try {
        proposed = await resolutionProvider.proposeResolution({
          symbol,
          inputsHash,
          sides,
          fileContext,
          neighbors: neighborsOf(symbol)
        });
      } catch {
        proposed = null;
      }

      if (!proposed) {
        return conflict; // resolver failed → deterministic escalate stands.
      }

      // A reconciled contract that does not parse cannot be trusted; fall back
      // to the deterministic escalate rather than handing agents broken code.
      if (proposed.reconciled && !contractParses(proposed.proposedContract)) {
        return conflict;
      }

      const record: ContractResolution = {
        ...proposed,
        repoId: config.repoId,
        symbol: conflict.targetSymbol,
        inputsHash,
        createdAt: new Date().toISOString()
      };
      sendToServer("resolution.propose", { repoId: config.repoId, resolution: record });

      return withResolution(conflict, proposed);
    })
  );
}

/** Replace `member` on each side with its session's display login, if known. */
function labelSides(sides: ResolutionSide[], state: TeamState): ResolutionSide[] {
  return sides.map((side) => {
    const session = state.sessions.find((candidate) => candidate.id === side.sessionId);
    return { ...side, member: session?.memberLogin ?? session?.memberId ?? side.member };
  });
}

function withResolution(conflict: Conflict, resolution: ProposedResolution): Conflict {
  return {
    ...conflict,
    analysis: conflict.analysis
      ? { ...conflict.analysis, resolution }
      : conflict.analysis
  };
}

function toProposed(resolution: ContractResolution): ProposedResolution {
  return {
    reconciled: resolution.reconciled,
    proposedContract: resolution.proposedContract,
    rationale: resolution.rationale,
    recommendation: resolution.recommendation,
    instruction: resolution.instruction,
    source: resolution.source
  };
}

async function readFileContext(config: RuntimeConfig, filePath: string): Promise<string | undefined> {
  try {
    return await readFile(resolve(config.worktreeRoot, filePath), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * A proposed merged contract is trusted only if the real analyzer can parse it.
 * We probe leniently: a full declaration is extracted directly; anything else
 * is wrapped as a type alias so a bare signature still has a chance to parse.
 */
function contractParses(proposedContract: string | null): boolean {
  if (!proposedContract) {
    return false;
  }

  const isDeclaration = /^\s*(export\s+)?(declare\s+)?(function|class|interface|type|enum|const)\b/u.test(
    proposedContract
  );
  const source = isDeclaration
    ? proposedContract.replace(/^\s*(export\s+)?/u, "export ")
    : `export type __Resolution = ${proposedContract};`;

  try {
    return extractTypeScriptContracts({ filePath: "__resolution.ts", source }).symbols.length > 0;
  } catch {
    return false;
  }
}

async function reportContractChanges(
  config: RuntimeConfig,
  contractSnapshots: Map<string, CodeSymbol[]>,
  body: Partial<SynapseReportRequest>,
  cache?: AnalysisCache
): Promise<ContractDelta[]> {
  if (!body.filePath) {
    return [];
  }

  const filePath = body.filePath;

  if (body.symbolId || !isAnalyzable(filePath)) {
    const symbolId = body.symbolId ?? symbolForFile(filePath);
    return [
      createContractDelta(config, {
        symbolId,
        filePath,
        changeKind: body.changeKind ?? "signature_changed",
        before: null,
        after: null,
        summary: body.summary ?? `Updated ${symbolId.raw}`,
        baseSha: body.baseSha,
        dependents: body.dependents
      })
    ];
  }

  const current = await extractSymbolsForFile(config, filePath, cache);
  const previous = contractSnapshots.get(filePath);
  contractSnapshots.set(filePath, current);

  if (!previous) {
    return [];
  }

  const diff = isPythonLike(filePath) ? diffPythonContracts : diffTypeScriptContracts;
  return diff(previous, current).map((change) =>
    createContractDelta(config, {
      symbolId: change.symbolId,
      filePath,
      changeKind: change.changeKind,
      before: change.before?.signature ?? null,
      after: change.after?.signature ?? null,
      summary: body.summary ?? summarizeSymbolChange(change.changeKind, change.symbolId.raw),
      baseSha: body.baseSha,
      dependents: body.dependents
    })
  );
}

function createContractDelta(
  config: RuntimeConfig,
  input: Pick<
    ContractDelta,
    "symbolId" | "changeKind" | "before" | "after" | "filePath"
  > & {
    summary: string;
    baseSha?: string;
    dependents?: ContractDelta["dependents"];
  }
): ContractDelta {
  return {
    id: randomUUID(),
    repoId: config.repoId,
    sessionId: config.sessionId,
    symbolId: input.symbolId,
    changeKind: input.changeKind,
    before: input.before,
    after: input.after,
    summary: input.summary,
    filePath: input.filePath,
    baseSha: input.baseSha ?? "local",
    dependents: input.dependents ?? [],
    createdAt: new Date().toISOString(),
    pushedAt: null
  };
}

function createConflictFeedback(
  config: RuntimeConfig,
  input: Pick<SynapseFeedbackRequest, "conflictId" | "outcome"> &
    Partial<Pick<SynapseFeedbackRequest, "note" | "rule" | "targetSymbol">>
): ConflictFeedback {
  return {
    id: randomUUID(),
    repoId: config.repoId,
    conflictId: input.conflictId,
    sessionId: config.sessionId,
    memberId: config.member,
    outcome: input.outcome,
    note: input.note,
    rule: input.rule,
    targetSymbol: input.targetSymbol,
    createdAt: new Date().toISOString()
  };
}

function summarizeDelta(delta: ContractDelta): ContractDeltaSummary {
  return {
    id: delta.id,
    symbolId: delta.symbolId,
    changeKind: delta.changeKind,
    summary: delta.summary,
    filePath: delta.filePath,
    createdAt: delta.createdAt
  };
}

function summarizeSymbolChange(changeKind: ContractDelta["changeKind"], rawSymbolId: string): string {
  switch (changeKind) {
    case "added":
      return `Added ${rawSymbolId}`;
    case "removed":
      return `Removed ${rawSymbolId}`;
    case "signature_changed":
      return `Changed signature for ${rawSymbolId}`;
    case "visibility_changed":
      return `Changed visibility for ${rawSymbolId}`;
    case "moved":
      return `Moved ${rawSymbolId}`;
    case "renamed":
      return `Renamed ${rawSymbolId}`;
  }
}

function isTypeScriptLike(filePath: string): boolean {
  return /\.(cts|mts|tsx?|jsx?)$/u.test(filePath);
}

function isPythonLike(filePath: string): boolean {
  return /\.pyi?$/u.test(filePath);
}

/** A file Synapse can extract a contract from (any supported analyzer). */
function isAnalyzable(filePath: string): boolean {
  return isTypeScriptLike(filePath) || isPythonLike(filePath);
}

/**
 * Extract a file's contract symbols with the right per-language analyzer.
 * Python runs in the sidecar (tree-sitter + jedi); if it is unavailable
 * (no venv/deps) the call returns `[]`, so callers degrade to file-level
 * detection exactly as they do for an unsupported language.
 */
async function extractSymbolsForFile(
  config: RuntimeConfig,
  filePath: string,
  cache?: AnalysisCache
): Promise<CodeSymbol[]> {
  const fullPath = resolve(config.worktreeRoot, filePath);
  const fingerprint = await fileFingerprint(fullPath);
  const cached = cache?.symbolsByFile.get(filePath);
  if (cached?.fingerprint === fingerprint) {
    return cached.symbols;
  }

  const source = await readFile(fullPath, "utf8");

  if (isPythonLike(filePath)) {
    try {
      const symbols = (await extractPythonContracts({ filePath, source })).symbols;
      cache?.symbolsByFile.set(filePath, { fingerprint, symbols });
      return symbols;
    } catch (error) {
      warnAnalyzerDegraded("python", filePath, error);
      return [];
    }
  }

  const symbols = extractTypeScriptContracts({ filePath, source }).symbols;
  cache?.symbolsByFile.set(filePath, { fingerprint, symbols });
  return symbols;
}

let pythonDegradedWarned = false;

/** Warn once that the Python analyzer is degraded — keeps logs quiet on repeat. */
function warnAnalyzerDegraded(lang: string, filePath: string, error: unknown): void {
  if (lang === "python" && pythonDegradedWarned) {
    return;
  }
  pythonDegradedWarned = lang === "python" || pythonDegradedWarned;
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(
    `synapse: ${lang} analyzer unavailable (${reason}); falling back to file-level detection for ${filePath}`
  );
}

async function readSourceFiles(
  root: string,
  matches: (filePath: string) => boolean,
  currentDir: string = root
): Promise<SourceFileContent[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: SourceFileContent[] = [];

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectory(entry.name)) {
        continue;
      }

      files.push(...(await readSourceFiles(root, matches, fullPath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const filePath = normalizePath(relative(root, fullPath));
    if (!matches(filePath)) {
      continue;
    }

    const stats = await stat(fullPath);
    files.push({
      filePath,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      source: await readFile(fullPath, "utf8")
    });
  }

  return files;
}

async function readSourceFileFingerprints(
  root: string,
  matches: (filePath: string) => boolean,
  currentDir: string = root
): Promise<SourceFileFingerprint[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: SourceFileFingerprint[] = [];

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectory(entry.name)) {
        continue;
      }

      files.push(...(await readSourceFileFingerprints(root, matches, fullPath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const filePath = normalizePath(relative(root, fullPath));
    if (!matches(filePath)) {
      continue;
    }

    const stats = await stat(fullPath);
    files.push({
      filePath,
      mtimeMs: stats.mtimeMs,
      size: stats.size
    });
  }

  return files;
}

async function fileFingerprint(fullPath: string): Promise<string> {
  const stats = await stat(fullPath);
  return `${stats.mtimeMs}:${stats.size}`;
}

function sourceSetFingerprint(files: SourceFileFingerprint[]): string {
  return files
    .map((file) => `${file.filePath}:${file.mtimeMs}:${file.size}`)
    .sort()
    .join("|");
}

function ignoredDirectory(name: string): boolean {
  return new Set([
    ".git",
    ".turbo",
    ".synapse",
    "dist",
    "node_modules",
    "coverage",
    // Python: never index virtualenvs, caches, or build output — a venv's
    // site-packages is tens of thousands of files and is not the user's code.
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".tox",
    "site-packages",
    "build"
  ]).has(name);
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body, null, 2));
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as unknown;

  if (!response.ok) {
    throw new Error(JSON.stringify(payload));
  }

  return payload;
}

function parseFlags(rawArgs: string[]): Record<string, string> {
  const flags: Record<string, string> = {};

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg?.startsWith("--")) {
      continue;
    }

    const name = arg.slice(2);
    const next = rawArgs[index + 1];
    if (!next || next.startsWith("--")) {
      flags[name] = "true";
      continue;
    }

    flags[name] = next;
    index += 1;
  }

  return flags;
}

function requiredFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) {
    throw new Error(`--${name} is required`);
  }

  return value;
}

function filesFromFlags(flags: Record<string, string>): string[] {
  const values = [flags.file, flags.files].filter((value): value is string => Boolean(value));
  return values.flatMap((value) =>
    value
      .split(",")
      .map((file) => file.trim())
      .filter(Boolean)
  );
}

function agentType(value: string): AgentType {
  const allowed = new Set<AgentType>(["claude-code", "cursor", "cline", "aider", "other"]);
  return allowed.has(value as AgentType) ? (value as AgentType) : "other";
}

function commandCwd(): string {
  return process.env.INIT_CWD ?? process.cwd();
}

function printHelp(): void {
  console.log(`Synapse CLI

Commands:
  daemon   Start the local daemon
  check    Call the local synapse_check endpoint
  report   Call the local synapse_report endpoint
  push     Notify Synapse that files were pushed
  feedback Record explicit acted/dismissed feedback for a conflict warning
  session  Start, heartbeat, or end a local session
  whatsup  Show the daemon's current team-state briefing
  why      Search Synapse memory with source citations
  mcp      Run a stdio MCP server that forwards tools to the local daemon
  join     Write .synapse/config.json and install Claude Code hooks
  up       One command: join + preflight + start daemon (--serve / --tunnel for the host)
  keygen   Mint a project-scoped key for this repo (needs SYNAPSE_MASTER_SECRET)
  doctor   Preflight a setup: identity, server reachability, auth, and live peers
  hook     Claude Code hook entrypoint (pre|post); reads hook JSON on stdin
  analyze  Extract TypeScript contract symbols from a file

Examples:
  synapse up                                   # teammate: inherits .synapse/team.json
  synapse up --serve --tunnel                  # host: run the server + expose it publicly
  SYNAPSE_MASTER_SECRET=… synapse keygen       # operator: mint this project's key
  SYNAPSE_PROJECT_KEY=… synapse up             # teammate: connect with the project key
  synapse doctor                               # diagnose why two machines aren't coordinating
  synapse join --member alice --session alice --port 4011 --server ws://localhost:4010
  synapse daemon
  synapse mcp --port 4011
  synapse report --port 4011 --file src/auth/token.ts --symbol ts:src/auth/token.ts#TokenValidator.validate
  synapse push --port 4011 --file src/auth/token.ts --sha abc123 --summary "Pushed auth token changes"
  synapse check --port 4012 --file src/auth/token.ts --symbol ts:src/auth/token.ts#TokenValidator.validate
  synapse feedback --port 4012 --conflict-id conflict:abc123 --outcome acted --note "Adjusted caller"
  synapse whatsup --port 4012
  synapse why --port 4012 --question "why did auth validation change?"
  synapse analyze --file packages/analyzer-ts/src/index.ts
`);
}
