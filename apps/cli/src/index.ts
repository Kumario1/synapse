#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, relative, resolve } from "node:path";
import {
  diffTypeScriptContracts,
  extractTypeScriptContracts,
  extractTypeScriptDependencyGraph
} from "@synapse/analyzer-ts";
import {
  contractChangeFor,
  emptyDependencyGraph,
  enrichConflicts,
  evaluateConflicts,
  symbolForFile,
  type DependencyGraph,
  type DependencyHop,
  verdictFor
} from "@synapse/conflict-engine";
import { createOpenRouterAnalysisProvider } from "./explain-openrouter.js";
import {
  createEmptyTeamState,
  PROTOCOL_VERSION,
  type AgentType,
  type CodeSymbol,
  type ClientMessage,
  type ContractChange,
  type ContractDelta,
  type ContractDeltaSummary,
  type ServerMessage,
  type Session,
  type Signature,
  type SynapseCheckRequest,
  type TeamState,
  type SynapsePushRequest,
  type SynapseReportRequest,
  type SynapseSessionRequest
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

        const graph = await buildDependencyGraph(config);
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

        writeJson(response, 200, {
          verdict: verdictFor(conflicts),
          conflicts: explained,
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
}

async function runCheck(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const port = Number(flags.port ?? process.env.SYNAPSE_DAEMON_PORT ?? 4011);
  const file = requiredFlag(flags, "file");
  const symbol = flags.symbol ? { raw: flags.symbol } : undefined;
  const response = await postJson(`http://localhost:${port}/tools/synapse_check`, {
    repoId: flags["repo-id"] ?? process.env.SYNAPSE_REPO_ID ?? "local",
    sessionId: flags.session ?? process.env.SYNAPSE_SESSION_ID ?? "local",
    files: [file],
    symbols: symbol ? [symbol] : undefined,
    task: flags.task
  });
  console.log(JSON.stringify(response, null, 2));
}

async function runReport(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const port = Number(flags.port ?? process.env.SYNAPSE_DAEMON_PORT ?? 4011);
  const file = requiredFlag(flags, "file");
  const symbol = flags.symbol ? { raw: flags.symbol } : undefined;
  const response = await postJson(`http://localhost:${port}/tools/synapse_report`, {
    repoId: flags["repo-id"] ?? process.env.SYNAPSE_REPO_ID ?? "local",
    sessionId: flags.session ?? process.env.SYNAPSE_SESSION_ID ?? "local",
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
  const port = Number(flags.port ?? process.env.SYNAPSE_DAEMON_PORT ?? 4011);
  const files = filesFromFlags(flags);
  if (files.length === 0) {
    throw new Error("--file or --files is required");
  }

  const symbols = flags.symbols
    ? flags.symbols.split(",").map((raw) => ({ raw: raw.trim() })).filter((symbol) => symbol.raw)
    : flags.symbol
      ? [{ raw: flags.symbol }]
      : undefined;

  const response = await postJson(`http://localhost:${port}/tools/synapse_push`, {
    repoId: flags["repo-id"] ?? process.env.SYNAPSE_REPO_ID ?? "local",
    sessionId: flags.session ?? process.env.SYNAPSE_SESSION_ID ?? "local",
    sha: flags.sha ?? "local",
    summary: flags.summary ?? `Pushed ${files.join(", ")}`,
    files,
    symbols
  });
  console.log(JSON.stringify(response, null, 2));
}

async function runSession(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const port = Number(flags.port ?? process.env.SYNAPSE_DAEMON_PORT ?? 4011);
  const action = (rawArgs.find((arg) => !arg.startsWith("--")) ?? "heartbeat") as
    | "start"
    | "end"
    | "heartbeat";
  const response = await postJson(`http://localhost:${port}/tools/synapse_session`, {
    repoId: flags["repo-id"] ?? process.env.SYNAPSE_REPO_ID ?? "local",
    sessionId: flags.session ?? process.env.SYNAPSE_SESSION_ID ?? "local",
    action,
    task: flags.task
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
        agentType: config.agentType,
        worktreeRoot: config.worktreeRoot,
        createdAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );

  console.log(`wrote ${join(dir, "config.json")}`);
  console.log(
    `start the daemon with: npm run dev --workspace @synapse/cli -- daemon --member ${config.member} --session ${config.sessionId} --port ${config.daemonPort}`
  );
}

async function runAnalyze(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const filePath = requiredFlag(flags, "file");
  const source = await readFile(resolve(commandCwd(), filePath), "utf8");
  const result = extractTypeScriptContracts({ filePath, source });
  console.log(JSON.stringify(result, null, 2));
}

function configFromArgs(rawArgs: string[]): RuntimeConfig {
  const flags = parseFlags(rawArgs);
  const member = flags.member ?? process.env.USER ?? "local";
  return {
    repoId: flags["repo-id"] ?? process.env.SYNAPSE_REPO_ID ?? "local",
    member,
    sessionId: flags.session ?? process.env.SYNAPSE_SESSION_ID ?? `${member}-${randomUUID()}`,
    agentType: agentType(flags.agent ?? process.env.SYNAPSE_AGENT ?? "other"),
    daemonPort: Number(flags.port ?? process.env.SYNAPSE_DAEMON_PORT ?? 4011),
    serverUrl: flags.server ?? process.env.SYNAPSE_SERVER_URL ?? "ws://localhost:4010",
    worktreeRoot: resolve(
      flags["worktree-root"] ?? process.env.SYNAPSE_WORKTREE_ROOT ?? commandCwd()
    )
  };
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

    if (!isTypeScriptLike(filePath)) {
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

async function buildDependencyGraph(config: RuntimeConfig): Promise<DependencyGraph> {
  const files = await readTypeScriptFiles(config.worktreeRoot);
  if (files.length === 0) {
    return emptyDependencyGraph;
  }

  const graph = extractTypeScriptDependencyGraph({ files });
  const adjacency = new Map<string, ContractDelta["symbolId"][]>();

  for (const edge of graph.edges) {
    const dependencies = adjacency.get(edge.from.raw) ?? [];
    dependencies.push(edge.to);
    adjacency.set(edge.from.raw, dependencies);
  }

  return {
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

  if (body.symbolId || !isTypeScriptLike(filePath)) {
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

  return diffTypeScriptContracts(previous, current).map((change) =>
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

async function extractSymbolsForFile(config: RuntimeConfig, filePath: string): Promise<CodeSymbol[]> {
  const source = await readFile(resolve(config.worktreeRoot, filePath), "utf8");
  return extractTypeScriptContracts({
    filePath,
    source
  }).symbols;
}

async function readTypeScriptFiles(
  root: string,
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

      files.push(...(await readTypeScriptFiles(root, fullPath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const filePath = normalizePath(relative(root, fullPath));
    if (!isTypeScriptLike(filePath)) {
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
  return new Set([".git", ".turbo", ".synapse", "dist", "node_modules", "coverage"]).has(name);
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
  join     Write a local .synapse/config.json
  analyze  Extract TypeScript contract symbols from a file

Examples:
  synapse daemon --member alice --session alice --port 4011
  synapse report --port 4011 --file src/auth/token.ts --symbol ts:src/auth/token.ts#TokenValidator.validate
  synapse push --port 4011 --file src/auth/token.ts --sha abc123 --summary "Pushed auth token changes"
  synapse check --port 4012 --file src/auth/token.ts --symbol ts:src/auth/token.ts#TokenValidator.validate
  synapse analyze --file packages/analyzer-ts/src/index.ts
`);
}
