import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupGoAnalyzerBinary, setupPythonAnalyzerVenv } from "../analysis.js";
import { commandCwd, configFromArgs, type RuntimeConfig } from "../config.js";
import { installClaudeCodeHooks } from "../hooks.js";
import { connectAllAgents } from "./connect.js";

export async function runJoin(rawArgs: string[]): Promise<void> {
  await performJoin(configFromArgs(rawArgs));
  console.log("start the daemon with: synapse daemon");
}

/**
 * Write `.synapse/config.json`, install the Claude Code hooks, and prepare the
 * Python analyzer venv. Idempotent — safe to re-run. Shared by `join` and `up`.
 */
export async function performJoin(config: RuntimeConfig): Promise<void> {
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

  // Do the same for every other agent: register the MCP server in their configs
  // and drop rules files so check-before-edit / report-after-edit is automatic
  // for Cursor, VS Code, Gemini, Windsurf, and any MCP client — not just Claude.
  await connectAllAgents(commandCwd());

  // Best-effort: prepare the Python analyzer venv and the Go analyzer binary so
  // `.py`/`.go` files are analyzed on first run. Never fails the join — a
  // missing toolchain just degrades that language to file-level.
  setupPythonAnalyzerVenv();
  setupGoAnalyzerBinary();
}

