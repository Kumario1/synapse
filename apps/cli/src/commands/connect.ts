import { connectAgents, integrationIds, type ConnectResult } from "../connect.js";
import { cliEntrypoint, commandCwd, parseFlags } from "../config.js";

/**
 * Wire non-Claude-Code agents (Cursor, VS Code/Copilot, Gemini CLI, Windsurf, and
 * any MCP client) up to the local Synapse MCP server in one shot: register the
 * stdio server in each client's config and drop rules files carrying the same
 * before/after-edit guidance the Claude Code hooks encode. `--agent a,b` limits
 * the set; default writes them all. Idempotent — safe to re-run.
 */
export async function runConnect(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const only = (flags.agent ?? flags.agents)
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (only?.length) {
    const known = new Set(integrationIds());
    const unknown = only.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new Error(
        `unknown agent(s): ${unknown.join(", ")}. Known agents: ${integrationIds().join(", ")}`
      );
    }
  }

  const results = await connectAgents({
    repoDir: commandCwd(),
    cliEntrypoint: cliEntrypoint(),
    only
  });
  reportConnectResults(results);
}

/**
 * Shared by `connect`, `join`, and `up`: wire every agent up and print a summary.
 * Never throws — wiring up other agents must not break a join.
 */
export async function connectAllAgents(repoDir: string): Promise<void> {
  try {
    const results = await connectAgents({ repoDir, cliEntrypoint: cliEntrypoint() });
    reportConnectResults(results);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`synapse: could not wire up other agents (${message}); continuing.`);
  }
}

function reportConnectResults(results: ConnectResult[]): void {
  for (const result of results) {
    const verb = result.status === "unchanged" ? "up to date" : result.status;
    console.log(`  ${result.path} — ${result.label} (${verb})`);
  }
  console.log(
    "connected other agents to the Synapse MCP server (check before edits, report after)."
  );
}

