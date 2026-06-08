#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
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
  createOpenRouterResolutionProvider
} from "./explain-openrouter.js";
import { runMcp } from "./mcp.js";
import {
  createEmptyTeamState,
  PROTOCOL_VERSION,
  type AgentType,
  type CodeSymbol,
  type ClientMessage,
  type ContractChange,
  type ContractDelta,
  type ContractDeltaSummary,
  type ContractResolution,
  type ProposedResolution,
  type ServerMessage,
  type Session,
  type Signature,
  type SynapseCheckRequest,
  type TeamState,
  type SynapsePushRequest,
  type SynapseReportRequest,
  type SynapseSessionRequest,
  type SynapseWhatsupRequest,
  type SynapseWhatsupResponse
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
  case "session":
    await runSession(args.slice(1));
    break;
  case "whatsup":
    await runWhatsup(args.slice(1));
    break;
  case "mcp":
    await runMcp(args.slice(1));
    break;
  case "join":
    await runJoin(args.slice(1));
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
  // Optional LLM analysis layer (Rung 5). Null unless OPENROUTER_API_KEY is
  // set; detection stays deterministic either way.
  const analysisProvider = createOpenRouterAnalysisProvider();
  // Optional LLM resolver: synthesizes one merged contract for the narrow
  // `contract_divergent` case. Null without a key → deterministic escalate.
  const resolutionProvider = createOpenRouterResolutionProvider();

  const sendToServer = (type: ClientMessage["type"], payload: unknown): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify(envelope(type, payload)));
  };

  const connect = (): void => {
    socket = new WebSocket(
      `${config.serverUrl}?repoId=${encodeURIComponent(config.repoId)}&sessionId=${encodeURIComponent(config.sessionId)}`
    );

    socket.on("open", () => {
      sendToServer("session.start", { session: makeSession(config) });
    });

    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (message.type === "state.snapshot" || message.type === "state.delta") {
        teamState = message.payload.teamState;
      }
    });

    socket.on("close", () => {
      setTimeout(connect, 1000);
    });

    socket.on("error", () => {
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

      if (request.method === "POST" && url.pathname === "/tools/synapse_check") {
        const body = (await readJson(request)) as Partial<SynapseCheckRequest>;
        const targets = await resolveCheckTargets(config, body);

        for (const target of targets) {
          sendToServer("edit.intent", {
            repoId: config.repoId,
            sessionId: config.sessionId,
            symbolId: target.symbolId,
            filePath: target.filePath
          });
        }

        const { graph, neighborsOf } = await buildDependencyGraph(config);
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

        const deltas = await reportContractChanges(config, contractSnapshots, body);
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

      if (request.method === "POST" && url.pathname === "/tools/synapse_session") {
        const body = (await readJson(request)) as Partial<SynapseSessionRequest>;
        const action = body.action ?? "heartbeat";

        if (action === "end") {
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

async function runJoin(rawArgs: string[]): Promise<void> {
  const config = configFromArgs(rawArgs);
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

  // Best-effort: prepare the Python analyzer venv so `.py` files are analyzed on
  // first run. Never fails the join — missing Python just degrades to file-level.
  setupPythonAnalyzerVenv();

  console.log(`start the daemon with: npm run dev --workspace @synapse/cli -- daemon`);
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

function configFromArgs(rawArgs: string[]): RuntimeConfig {
  const flags = parseFlags(rawArgs);
  const localConfig = readLocalConfig();
  const member =
    flags.member ?? process.env.SYNAPSE_MEMBER ?? localConfig.member ?? process.env.USER ?? "local";

  return {
    repoId: flags["repo-id"] ?? process.env.SYNAPSE_REPO_ID ?? localConfig.repoId ?? "local",
    member,
    sessionId:
      flags.session ??
      process.env.SYNAPSE_SESSION_ID ??
      localConfig.sessionId ??
      `${member}-${randomUUID()}`,
    agentType: agentType(flags.agent ?? process.env.SYNAPSE_AGENT ?? localConfig.agentType ?? "other"),
    daemonPort: numberDefault(flags.port, process.env.SYNAPSE_DAEMON_PORT, localConfig.daemonPort, 4011),
    serverUrl:
      flags.server ?? process.env.SYNAPSE_SERVER_URL ?? localConfig.serverUrl ?? "ws://localhost:4010",
    worktreeRoot: resolve(
      flags["worktree-root"] ??
        process.env.SYNAPSE_WORKTREE_ROOT ??
        localConfig.worktreeRoot ??
        commandCwd()
    )
  };
}

function commandDefaults(flags: Record<string, string>): {
  repoId: string;
  sessionId: string;
  daemonPort: number;
} {
  const localConfig = readLocalConfig();

  return {
    repoId: flags["repo-id"] ?? process.env.SYNAPSE_REPO_ID ?? localConfig.repoId ?? "local",
    sessionId: flags.session ?? process.env.SYNAPSE_SESSION_ID ?? localConfig.sessionId ?? "local",
    daemonPort: numberDefault(flags.port, process.env.SYNAPSE_DAEMON_PORT, localConfig.daemonPort, 4011)
  };
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
  const resolutions = [...state.resolutions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    repoId: state.repoId,
    generatedAt: new Date().toISOString(),
    degraded: options.degraded,
    summary: [
      `${activeSessions.length} active session${activeSessions.length === 1 ? "" : "s"}`,
      `${unpushedDeltas.length} unpushed contract delta${unpushedDeltas.length === 1 ? "" : "s"}`,
      `${state.editLocks.length} active edit lock${state.editLocks.length === 1 ? "" : "s"}`,
      `${recentPushes.length} recent push${recentPushes.length === 1 ? "" : "es"}`,
      `${resolutions.length} shared resolution${resolutions.length === 1 ? "" : "s"}`
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
    resolutions: resolutions.slice(0, limit)
  };
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
  body: Partial<SynapseCheckRequest>
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

    const symbols = await extractSymbolsForFile(config, filePath);
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

async function buildDependencyGraph(config: RuntimeConfig): Promise<DaemonGraph> {
  // Build each language's graph locally, then merge. Symbol ids are
  // language-prefixed (`ts:` / `py:`), so the union never collides and the
  // conflict engine sees one graph spanning both.
  const tsFiles = await readSourceFiles(config.worktreeRoot, isTypeScriptLike);
  const pyFiles = await readSourceFiles(config.worktreeRoot, isPythonLike);

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
    return { graph: emptyDependencyGraph, neighborsOf: () => [] };
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

  return { graph: dependencyGraph, neighborsOf };
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
  body: Partial<SynapseReportRequest>
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

  const current = await extractSymbolsForFile(config, filePath);
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
async function extractSymbolsForFile(config: RuntimeConfig, filePath: string): Promise<CodeSymbol[]> {
  const source = await readFile(resolve(config.worktreeRoot, filePath), "utf8");

  if (isPythonLike(filePath)) {
    try {
      return (await extractPythonContracts({ filePath, source })).symbols;
    } catch (error) {
      warnAnalyzerDegraded("python", filePath, error);
      return [];
    }
  }

  return extractTypeScriptContracts({ filePath, source }).symbols;
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
): Promise<{ filePath: string; source: string }[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: { filePath: string; source: string }[] = [];

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

    files.push({
      filePath,
      source: await readFile(fullPath, "utf8")
    });
  }

  return files;
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
  session  Start, heartbeat, or end a local session
  whatsup  Show the daemon's current team-state briefing
  mcp      Run a stdio MCP server that forwards tools to the local daemon
  join     Write a local .synapse/config.json used as command defaults
  analyze  Extract TypeScript contract symbols from a file

Examples:
  synapse join --member alice --session alice --port 4011 --server ws://localhost:4010
  synapse daemon
  synapse mcp --port 4011
  synapse report --port 4011 --file src/auth/token.ts --symbol ts:src/auth/token.ts#TokenValidator.validate
  synapse push --port 4011 --file src/auth/token.ts --sha abc123 --summary "Pushed auth token changes"
  synapse check --port 4012 --file src/auth/token.ts --symbol ts:src/auth/token.ts#TokenValidator.validate
  synapse whatsup --port 4012
  synapse analyze --file packages/analyzer-ts/src/index.ts
`);
}
