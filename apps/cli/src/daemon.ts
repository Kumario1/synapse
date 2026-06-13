import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { closeGoAnalyzer, diffGoContracts } from "@synapse/analyzer-go";
import { closePythonAnalyzer, diffPythonContracts } from "@synapse/analyzer-py";
import { diffTypeScriptContracts, extractTypeScriptContracts } from "@synapse/analyzer-ts";
import {
  applyAdaptiveSeverity,
  applyBranchAwareness,
  enrichConflicts,
  evaluateConflicts,
  resolutionInputsHash,
  resolutionSidesForSymbol,
  symbolForFile,
  verdictFor,
  type Conflict,
  type ResolutionProvider,
  type ResolutionSide
} from "@synapse/conflict-engine";
import {
  createEmptyTeamState,
  createLogger,
  MetricsRegistry,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  parseServerMessage,
  type ClientMessage,
  type CodeSymbol,
  type ConflictFeedback,
  type ContractDelta,
  type ContractDeltaSummary,
  type ContractResolution,
  type ProposedResolution,
  type RecallMatch,
  type RecallResponse,
  type Session,
  type SessionSummary,
  type SynapseCheckRequest,
  type SynapseFeedbackRequest,
  type SynapseFeedbackResponse,
  type SynapseOnboardRequest,
  type SynapsePrBriefRequest,
  type SynapsePushRequest,
  type SynapseReportRequest,
  type SynapseSessionRequest,
  type SynapseWhatsupRequest,
  type SynapseWhyRequest,
  type TeamState
} from "@synapse/protocol";
import { WebSocket } from "ws";
import {
  buildDependencyGraph,
  extractSymbolsForFile,
  isAnalyzable,
  isGoLike,
  isPythonLike,
  markGraphDirty,
  resolveCheckTargets,
  selfChanges,
  selfSignatures,
  type AnalysisCache
} from "./analysis.js";
import {
  buildOnboardResponse,
  buildPrBriefResponse,
  buildWhatsupResponse,
  buildWhyResponse,
  mergeRecallIntoOnboard,
  mergeRecallIntoWhy
} from "./briefings.js";
import { currentGitBranch, type RuntimeConfig } from "./config.js";
import {
  createOpenRouterAnalysisProvider,
  createOpenRouterResolutionProvider,
  createOpenRouterSummaryProvider,
  type SessionSummaryDelta,
  type SummaryProvider
} from "./explain-openrouter.js";
import { JsonBodyError, readJson, writeJson } from "./http.js";
import { startFileWatcher } from "./watcher.js";

export async function startDaemon(config: RuntimeConfig): Promise<void> {
  let teamState = createEmptyTeamState(config.repoId);
  let socket: WebSocket | null = null;
  const log = createLogger("synapse-daemon");
  const metrics = new MetricsRegistry();
  const contractSnapshots = new Map<string, CodeSymbol[]>();
  const analysisCache: AnalysisCache = {
    symbolsByFile: new Map(),
    graph: null,
    // Dirty until the first build; only the watcher's ready signal makes
    // "clean" trustworthy (manual edits are otherwise invisible).
    graphDirty: true,
    graphTrusted: false,
    onGraphReuse: () => metrics.count("synapse_graph_cache_hits_total")
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

  // Offline outbox: a report emitted while the server is down/restarting is
  // queued (FIFO, capped, drop-oldest) and flushed on the next open — so a
  // contract delta produced during a blip reaches the team instead of being
  // silently dropped. Heartbeats are the exception: they are stale on arrival,
  // and the reconnect's `session.start` re-asserts liveness anyway.
  const outbox: ClientMessage[] = [];
  const OUTBOX_CAP = 500;
  const sendToServer = (type: ClientMessage["type"], payload: unknown): void => {
    const message = envelope(type, payload);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      if (type === "session.heartbeat") {
        return;
      }
      outbox.push(message);
      metrics.count("synapse_outbox_enqueued_total", { type });
      log.debug("outbox.enqueued", { type, queued: outbox.length });
      if (outbox.length > OUTBOX_CAP) {
        outbox.shift();
        metrics.count("synapse_outbox_dropped_total");
        log.warn("outbox.dropped_oldest", { cap: OUTBOX_CAP });
      }
      return;
    }

    socket.send(JSON.stringify(message));
  };

  const flushOutbox = (): void => {
    const queued = outbox.length;
    while (outbox.length > 0 && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(outbox.shift()));
    }
    if (queued > 0) {
      metrics.count("synapse_outbox_flushed_total", {}, queued);
      log.info("outbox.flushed", { flushed: queued });
    }
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

  // Reconnect with exponential backoff + full jitter so a restarting server is
  // not hammered by every daemon at once; the attempt counter resets on a
  // successful open. Env knobs exist so the reconnect verifier runs fast.
  const reconnectBaseMs = Number(process.env.SYNAPSE_RECONNECT_BASE_MS ?? 500);
  const reconnectMaxMs = Number(process.env.SYNAPSE_RECONNECT_MAX_MS ?? 30_000);
  let reconnectAttempt = 0;

  const connect = (): void => {
    // Credential travels in the Authorization header, not the query string,
    // so it never lands in proxy/access logs along the way.
    socket = new WebSocket(
      `${config.serverUrl}?repoId=${encodeURIComponent(config.repoId)}&sessionId=${encodeURIComponent(config.sessionId)}&v=${PROTOCOL_VERSION}`,
      config.authToken ? { headers: { authorization: `Bearer ${config.authToken}` } } : undefined
    );

    // Protocol negotiation (M15): the server advertises its dialect range on
    // the upgrade response; verify compatibility from this side too so a
    // too-new server is a loud, specific warning instead of mystery failures.
    socket.on("upgrade", (response) => {
      const serverMax = Number(response.headers["x-synapse-protocol"]);
      if (Number.isInteger(serverMax) && serverMax < MIN_SUPPORTED_PROTOCOL_VERSION) {
        warnConnection(
          `server speaks protocol v${serverMax}, older than this client's oldest supported v${MIN_SUPPORTED_PROTOCOL_VERSION} — upgrade the server`,
          { auth: true }
        );
      }
    });

    socket.on("open", () => {
      connectionWarned = false;
      reconnectAttempt = 0;
      sendToServer("session.start", { session: makeSession(config) });
      flushOutbox();
    });

    socket.on("message", (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        log.warn("ws.invalid_frame", { error: "invalid_json" });
        return;
      }

      const parsed = parseServerMessage(raw);
      if (!parsed.ok) {
        log.warn("ws.invalid_frame", { error: parsed.error });
        return;
      }

      const message = parsed.message;
      if (message.type === "state.snapshot" || message.type === "state.delta") {
        teamState = message.payload.teamState;
      }
    });

    socket.on("unexpected-response", (_request, response) => {
      const auth = response.statusCode === 401;
      if (response.statusCode === 426) {
        const max = response.headers["x-synapse-protocol"] ?? "?";
        const min = response.headers["x-synapse-protocol-min"] ?? "?";
        warnConnection(
          `protocol v${PROTOCOL_VERSION} refused — the server supports v${min}–v${max}; upgrade the older side`,
          { auth: true }
        );
        return;
      }
      warnConnection(
        auth
          ? "401 unauthorized — check your project key (SYNAPSE_PROJECT_KEY / --key) or SYNAPSE_AUTH_TOKEN"
          : `HTTP ${response.statusCode}`,
        { auth }
      );
    });

    socket.on("close", () => {
      const ceiling = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** reconnectAttempt);
      const delayMs = Math.max(50, Math.floor(Math.random() * ceiling));
      reconnectAttempt = Math.min(reconnectAttempt + 1, 16);
      metrics.count("synapse_reconnects_scheduled_total");
      log.debug("ws.reconnect_scheduled", { delayMs, attempt: reconnectAttempt });
      setTimeout(connect, delayMs);
    });

    socket.on("error", (error) => {
      const code = (error as { code?: string }).code;
      warnConnection(code ?? (error instanceof Error ? error.message : "connection error"));
      socket?.close();
    });
  };

  connect();

  // File watcher (M10): manual edits between agent turns flow through the
  // same report path as synapse_report, so the team still learns about them.
  // The first event for a file records its baseline; the next emits deltas.
  // SYNAPSE_FILE_WATCHER=0 disables.
  if (process.env.SYNAPSE_FILE_WATCHER !== "0") {
    startFileWatcher({
      worktreeRoot: config.worktreeRoot,
      debounceMs: Number(process.env.SYNAPSE_WATCH_DEBOUNCE_MS ?? 400),
      shouldReport: isAnalyzable,
      onChange: async (filePath) => {
        const deltas = await reportContractChanges(
          config,
          contractSnapshots,
          { filePath },
          analysisCache
        );
        metrics.count("synapse_watch_reports_total");
        log.debug("watch.reported", { filePath, deltas: deltas.length });
        for (const delta of deltas) {
          metrics.count("synapse_deltas_emitted_total", { changeKind: delta.changeKind });
          sendToServer("contract.delta", { delta });
        }
      },
      onError: (error) => {
        log.warn("watch.error", {
          error: error instanceof Error ? error.message : String(error)
        });
      },
      onReady: () => {
        // Observable via /metrics: a change is only guaranteed to be seen
        // after the initial scan completes (files created during it can be
        // swallowed by ignoreInitial). Only from this point is a "clean"
        // graph cache trustworthy for the warm-check fast path.
        analysisCache.graphTrusted = true;
        metrics.count("synapse_watch_ready");
        log.info("watch.ready", {});
      }
    });
    log.info("watch.started", { worktreeRoot: config.worktreeRoot });
  }

  setInterval(() => {
    sendToServer("session.heartbeat", {
      repoId: config.repoId,
      sessionId: config.sessionId,
      // Refresh the branch every beat so branch-aware severity tracks a
      // mid-session checkout; undefined (detached HEAD) keeps the field out.
      branch: currentGitBranch(config.worktreeRoot)
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

      if (request.method === "POST" && url.pathname === "/tools/synapse_pr_brief") {
        const body = (await readJson(request)) as Partial<SynapsePrBriefRequest>;
        writeJson(
          response,
          200,
          buildPrBriefResponse(teamState, {
            degraded: socket?.readyState !== WebSocket.OPEN,
            base: body.base,
            head: body.head ?? currentGitBranch(config.worktreeRoot),
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

        const floor = buildWhyResponse(teamState, body.question, {
          degraded: socket?.readyState !== WebSocket.OPEN,
          limit: body.limit
        });
        // Hybrid recall (C1/C2): the deterministic floor always answers; the
        // server's vector memory can only add sources on top. Any failure or
        // a degraded recall leaves the floor untouched. SYNAPSE_RAG=0 disables.
        const merged =
          process.env.SYNAPSE_RAG === "0"
            ? floor
            : mergeRecallIntoWhy(
                floor,
                await fetchRecall(config, body.question, body.limit),
                body.limit
              );
        if (merged.rag) {
          metrics.count("synapse_why_rag_total");
        }
        writeJson(response, 200, merged);
        return;
      }

      if (request.method === "POST" && url.pathname === "/tools/synapse_onboard") {
        const body = (await readJson(request)) as Partial<SynapseOnboardRequest>;
        const floor = buildOnboardResponse(teamState, {
          degraded: socket?.readyState !== WebSocket.OPEN,
          limit: body.limit
        });
        // Same hybrid contract as synapse_why: the deterministic digest always
        // answers; vector recall (over a fixed, room-agnostic query) can only
        // add cited decisions on top. SYNAPSE_RAG=0 disables.
        const merged =
          process.env.SYNAPSE_RAG === "0"
            ? floor
            : mergeRecallIntoOnboard(
                floor,
                await fetchRecall(
                  config,
                  "key decisions, architecture choices, and gotchas in this repository",
                  body.limit
                ),
                body.limit
              );
        metrics.count("synapse_onboard_total");
        if (merged.rag) {
          metrics.count("synapse_onboard_rag_total");
        }
        writeJson(response, 200, merged);
        return;
      }

      if (request.method === "GET" && url.pathname === "/metrics") {
        response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        response.end(metrics.renderPrometheus());
        return;
      }

      if (request.method === "POST" && url.pathname === "/tools/synapse_check") {
        const checkStartedAt = performance.now();
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
        const rawConflicts = evaluateConflicts({
          selfSessionId: config.sessionId,
          targets,
          state: teamState,
          graph
        });
        // Branch awareness (M6.5): cross-branch dependency_changed/stale_base
        // demote warn → info (they only bite at merge time); merge-blocking
        // rules are never demoted. Runs before the adaptive pass so the team's
        // explicit feedback has the final say. SYNAPSE_BRANCH_AWARE_SEVERITY=0
        // disables.
        const branchAware =
          process.env.SYNAPSE_BRANCH_AWARE_SEVERITY === "0"
            ? { conflicts: rawConflicts, demotedRules: [] }
            : applyBranchAwareness(rawConflicts, currentGitBranch(config.worktreeRoot));
        for (const rule of branchAware.demotedRules) {
          metrics.count("synapse_branch_severity_demotions_total", { rule });
          log.info("severity.branch_demoted", { rule });
        }
        // Adaptive severity (F1): demote warn rules this team chronically
        // dismisses, from the explicit feedback already in shared state.
        // Deterministic, never promotes; SYNAPSE_ADAPTIVE_SEVERITY=0 disables.
        const adaptive =
          process.env.SYNAPSE_ADAPTIVE_SEVERITY === "0"
            ? { conflicts: branchAware.conflicts, demotedRules: [] }
            : applyAdaptiveSeverity(branchAware.conflicts, teamState.conflictFeedback);
        const conflicts = adaptive.conflicts;
        for (const rule of adaptive.demotedRules) {
          metrics.count("synapse_severity_demotions_total", { rule });
          log.info("severity.demoted", { rule });
        }
        // Measure only the deterministic hot path (extract + graph + evaluate):
        // the optional LLM enrichment below is off the latency budget.
        metrics.observe("synapse_check_duration_ms", performance.now() - checkStartedAt);
        metrics.count("synapse_checks_total", { verdict: verdictFor(conflicts) });
        for (const conflict of conflicts) {
          metrics.count("synapse_conflicts_total", {
            rule: conflict.rule,
            severity: conflict.severity
          });
        }

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
        await seedContractSnapshotsForFiles(
          config,
          contractSnapshots,
          body,
          analysisCache
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
        metrics.count("synapse_reports_total");
        for (const delta of deltas) {
          metrics.count("synapse_deltas_emitted_total", { changeKind: delta.changeKind });
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
          symbols: body.symbols,
          branch: currentGitBranch(config.worktreeRoot)
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
            sessionId: config.sessionId,
            branch: currentGitBranch(config.worktreeRoot)
          });
        }

        writeJson(response, 200, { sessionId: config.sessionId });
        return;
      }

      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof JsonBodyError) {
        writeJson(response, error.code === "payload_too_large" ? 413 : 400, {
          error: error.code
        });
        return;
      }

      const reason = error instanceof Error ? error.message : "unknown_error";
      writeJson(response, 500, { error: reason });
    }
  });

  const daemonHost = process.env.SYNAPSE_DAEMON_HOST ?? "127.0.0.1";
  localServer.listen(config.daemonPort, daemonHost, () => {
    console.log(
      `synapse daemon ${config.sessionId} listening on http://${daemonHost}:${config.daemonPort}`
    );
  });

  // Tear the Python sidecar down with the daemon so it never lingers.
  const shutdown = (): void => {
    closePythonAnalyzer();
    closeGoAnalyzer();
    localServer.close();
    socket?.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

/**
 * Ask the server's vector memory for question-relevant memories. Best-effort:
 * any error, non-OK status, or degraded recall returns [] so the
 * deterministic why floor stands alone.
 */
async function fetchRecall(
  config: RuntimeConfig,
  query: string,
  limit?: number
): Promise<RecallMatch[]> {
  try {
    const base = config.serverUrl.replace(/^ws/u, "http");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${base}/recall`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.authToken ? { authorization: `Bearer ${config.authToken}` } : {})
      },
      body: JSON.stringify({ repoId: config.repoId, query, limit }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as RecallResponse;
    return payload.degraded ? [] : payload.matches;
  } catch {
    return [];
  }
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
    status: "active",
    branch: currentGitBranch(config.worktreeRoot)
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

function envelope(type: ClientMessage["type"], payload: unknown): ClientMessage {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: randomUUID(),
    ts: new Date().toISOString(),
    payload
  } as ClientMessage;
}

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

async function seedContractSnapshotsForFiles(
  config: RuntimeConfig,
  contractSnapshots: Map<string, CodeSymbol[]>,
  body: Partial<SynapseCheckRequest>,
  cache?: AnalysisCache
): Promise<void> {
  const seen = new Set<string>();

  for (const [index, filePath] of (body.files ?? []).entries()) {
    if (seen.has(filePath) || !isAnalyzable(filePath)) {
      continue;
    }
    seen.add(filePath);

    try {
      contractSnapshots.set(filePath, await extractSymbolsForFile(config, filePath, cache));
    } catch (error) {
      if (body.symbols?.[index]) {
        continue;
      }
      throw error;
    }
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
  // Every reported edit (tool call or watcher event) can change dependency
  // edges — the warm-check graph cache must not outlive it.
  if (isAnalyzable(filePath)) {
    markGraphDirty(cache);
  }

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

  const changes = isPythonLike(filePath)
    ? diffPythonContracts(previous, current)
    : isGoLike(filePath)
      ? diffGoContracts(previous, current)
      : diffTypeScriptContracts(previous, current, {
          detectRenames: process.env.SYNAPSE_RENAME_TRACKING !== "0"
        });
  return changes.map((change) =>
    createContractDelta(config, {
      symbolId: change.symbolId,
      filePath,
      changeKind: change.changeKind,
      before: change.before?.signature ?? null,
      after: change.after?.signature ?? null,
      summary:
        body.summary ??
        (change.changeKind === "renamed" && change.after
          ? `Renamed ${change.symbolId.raw} to ${change.after.id.raw}`
          : summarizeSymbolChange(change.changeKind, change.symbolId.raw)),
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
