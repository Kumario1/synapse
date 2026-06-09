import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
  SynapseCheckRequest,
  SynapseFeedbackRequest,
  SynapsePushRequest,
  SynapseReportRequest,
  SynapseSessionRequest,
  SynapseWhatsupRequest,
  SynapseWhyRequest
} from "@synapse/protocol";
import { z } from "zod/v4";
import { SYNAPSE_AGENT_GUIDANCE } from "./connect.js";

const serverInfo = {
  name: "synapse",
  version: "0.0.0"
};

const commonShape = {
  port: z.number().int().positive().optional(),
  repoId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional()
};

const symbol = z.object({ raw: z.string().min(1) });
const symbolsInput = z.union([z.array(z.string().min(1)), z.array(symbol)]).optional();

export async function runMcp(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  // Resolve the coordination room the same way the Claude Code hooks do: explicit
  // flag, then env, then `.synapse/config.json` (written by `synapse join`/`up`),
  // then a local fallback. This is what lets an MCP-launched agent land in the
  // exact room the daemon joined with zero per-agent configuration.
  const localConfig = readLocalConfig();
  const defaultPort = Number(
    flags.port ?? process.env.SYNAPSE_DAEMON_PORT ?? localConfig.daemonPort ?? 4011
  );
  const defaultRepoId =
    flags["repo-id"] ?? process.env.SYNAPSE_REPO_ID ?? localConfig.repoId ?? "local";
  const defaultSessionId =
    flags.session ?? process.env.SYNAPSE_SESSION_ID ?? localConfig.sessionId ?? "local";
  // The `instructions` field is the MCP-native equivalent of the Claude Code
  // hooks: compliant clients surface it to the model, so any connecting agent is
  // told to check before edits and report after — no rules file required.
  const server = new McpServer(serverInfo, { instructions: SYNAPSE_AGENT_GUIDANCE });

  server.registerTool(
    "synapse_check",
    {
      title: "Check Synapse Conflicts",
      description:
        "Check the local Synapse daemon before editing files. Returns deterministic conflict verdicts, analysis, and resolutions.",
      inputSchema: {
        ...commonShape,
        file: z.string().min(1).optional(),
        files: z.array(z.string().min(1)).optional(),
        symbol: z.string().min(1).optional(),
        symbols: symbolsInput,
        task: z.string().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false
      }
    },
    async (args) => {
      const files = filesFromInput(args.file, args.files);
      if (files.length === 0) {
        return toolError("synapse_check requires `file` or `files`.");
      }

      const request: SynapseCheckRequest = {
        repoId: args.repoId ?? defaultRepoId,
        sessionId: args.sessionId ?? defaultSessionId,
        files,
        symbols: symbolsFromInput(args.symbol, args.symbols),
        task: args.task
      };

      return jsonResult(await daemonPost(args.port ?? defaultPort, "synapse_check", request));
    }
  );

  server.registerTool(
    "synapse_report",
    {
      title: "Report Synapse Contract Changes",
      description:
        "Ask the local Synapse daemon to extract contract changes from a file and broadcast any deltas.",
      inputSchema: {
        ...commonShape,
        file: z.string().min(1).optional(),
        filePath: z.string().min(1).optional(),
        symbol: z.string().min(1).optional(),
        symbolId: symbol.optional(),
        changeKind: z
          .enum(["added", "removed", "renamed", "moved", "signature_changed", "visibility_changed"])
          .optional(),
        summary: z.string().optional(),
        baseSha: z.string().optional(),
        dependents: symbolsInput
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false
      }
    },
    async (args) => {
      const filePath = args.filePath ?? args.file;
      if (!filePath) {
        return toolError("synapse_report requires `filePath` or `file`.");
      }

      const request: SynapseReportRequest = {
        repoId: args.repoId ?? defaultRepoId,
        sessionId: args.sessionId ?? defaultSessionId,
        filePath,
        symbolId: args.symbolId ?? (args.symbol ? { raw: args.symbol } : undefined),
        changeKind: args.changeKind,
        summary: args.summary,
        baseSha: args.baseSha,
        dependents: symbolsFromInput(undefined, args.dependents)
      };

      return jsonResult(await daemonPost(args.port ?? defaultPort, "synapse_report", request));
    }
  );

  server.registerTool(
    "synapse_feedback",
    {
      title: "Record Synapse Conflict Feedback",
      description:
        "Record explicit acted/dismissed feedback for a surfaced Synapse conflict warning. This is telemetry only and does not change verdicts.",
      inputSchema: {
        ...commonShape,
        conflictId: z.string().min(1),
        outcome: z.enum(["acted", "dismissed"]),
        note: z.string().optional(),
        rule: z
          .enum([
            "same_symbol_active",
            "same_symbol_unpushed",
            "contract_divergent",
            "dependency_changed",
            "transitive_dependency",
            "stale_base",
            "same_file_no_overlap"
          ])
          .optional(),
        targetSymbol: symbol.optional(),
        symbol: z.string().min(1).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false
      }
    },
    async (args) => {
      const request: SynapseFeedbackRequest = {
        repoId: args.repoId ?? defaultRepoId,
        sessionId: args.sessionId ?? defaultSessionId,
        conflictId: args.conflictId,
        outcome: args.outcome,
        note: args.note,
        rule: args.rule,
        targetSymbol: args.targetSymbol ?? (args.symbol ? { raw: args.symbol } : undefined)
      };

      return jsonResult(await daemonPost(args.port ?? defaultPort, "synapse_feedback", request));
    }
  );

  server.registerTool(
    "synapse_push",
    {
      title: "Notify Synapse Push",
      description:
        "Tell the local Synapse daemon that files were pushed so shared live state can clear stale deltas and locks.",
      inputSchema: {
        ...commonShape,
        file: z.string().min(1).optional(),
        files: z.array(z.string().min(1)).optional(),
        sha: z.string().min(1).optional(),
        summary: z.string().optional(),
        symbol: z.string().min(1).optional(),
        symbols: symbolsInput
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false
      }
    },
    async (args) => {
      const files = filesFromInput(args.file, args.files);
      if (files.length === 0) {
        return toolError("synapse_push requires `file` or `files`.");
      }

      const request: SynapsePushRequest = {
        repoId: args.repoId ?? defaultRepoId,
        sessionId: args.sessionId ?? defaultSessionId,
        sha: args.sha ?? "local",
        summary: args.summary ?? `Pushed ${files.join(", ")}`,
        files,
        symbols: symbolsFromInput(args.symbol, args.symbols)
      };

      return jsonResult(await daemonPost(args.port ?? defaultPort, "synapse_push", request));
    }
  );

  server.registerTool(
    "synapse_session",
    {
      title: "Update Synapse Session",
      description: "Start, heartbeat, or end the current local Synapse daemon session.",
      inputSchema: {
        ...commonShape,
        action: z.enum(["start", "heartbeat", "end"]).optional(),
        task: z.string().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false
      }
    },
    async (args) => {
      const request: SynapseSessionRequest = {
        repoId: args.repoId ?? defaultRepoId,
        sessionId: args.sessionId ?? defaultSessionId,
        action: args.action ?? "heartbeat",
        task: args.task
      };

      return jsonResult(await daemonPost(args.port ?? defaultPort, "synapse_session", request));
    }
  );

  server.registerTool(
    "synapse_whatsup",
    {
      title: "Show Synapse Team Briefing",
      description:
        "Return the local Synapse daemon's current team-state briefing: active sessions, unpushed deltas, edit locks, recent pushes, and shared resolutions.",
      inputSchema: {
        ...commonShape,
        limit: z.number().int().positive().max(50).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) => {
      const request: SynapseWhatsupRequest = {
        repoId: args.repoId ?? defaultRepoId,
        sessionId: args.sessionId ?? defaultSessionId,
        limit: args.limit
      };

      return jsonResult(await daemonPost(args.port ?? defaultPort, "synapse_whatsup", request));
    }
  );

  server.registerTool(
    "synapse_why",
    {
      title: "Search Synapse Memory",
      description:
        "Answer a why/what changed question from the local Synapse daemon's stored team context and return cited sources.",
      inputSchema: {
        ...commonShape,
        question: z.string().min(1),
        limit: z.number().int().positive().max(20).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) => {
      const request: SynapseWhyRequest = {
        repoId: args.repoId ?? defaultRepoId,
        sessionId: args.sessionId ?? defaultSessionId,
        question: args.question,
        limit: args.limit
      };

      return jsonResult(await daemonPost(args.port ?? defaultPort, "synapse_why", request));
    }
  );

  await server.connect(new StdioServerTransport());
}

function filesFromInput(file: string | undefined, files: string[] | undefined): string[] {
  return [...(file ? [file] : []), ...(files ?? [])];
}

function symbolsFromInput(
  symbolValue: string | undefined,
  symbols: string[] | { raw: string }[] | undefined
): { raw: string }[] | undefined {
  const normalized = [
    ...(symbolValue ? [{ raw: symbolValue }] : []),
    ...((symbols ?? []).map((entry) => (typeof entry === "string" ? { raw: entry } : entry)))
  ].filter((entry) => entry.raw);

  return normalized.length ? normalized : undefined;
}

async function daemonPost(port: number, tool: string, body: unknown): Promise<unknown> {
  const response = await fetch(`http://localhost:${port}/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string" ? payload.error : `Synapse daemon returned ${response.status}`
    );
  }

  return payload;
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }]
  };
}

/**
 * Best-effort read of `.synapse/config.json` for room defaults (repoId, session,
 * daemon port). The agent launches this MCP server with the project root as cwd,
 * so the config written by `synapse join`/`up` is found relative to it. Any
 * problem (missing/malformed file) degrades silently to the built-in defaults.
 */
function readLocalConfig(): { repoId?: string; sessionId?: string; daemonPort?: number } {
  const cwd = process.env.INIT_CWD ?? process.cwd();
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, ".synapse", "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return {
      repoId: typeof parsed.repoId === "string" ? parsed.repoId : undefined,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      daemonPort: typeof parsed.daemonPort === "number" ? parsed.daemonPort : undefined
    };
  } catch {
    return {};
  }
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
