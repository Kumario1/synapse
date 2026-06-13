/**
 * Deterministic catalog of Synapse's agent-facing tools (the MCP surface in
 * `apps/cli/src/mcp.ts`). This is the single source of truth for:
 *  - the LLM analysis/resolution prompts (`renderCommandCatalogForPrompt`),
 *    so suggested `actions[].command` values stay within a fixed allowlist
 *    (`isKnownSynapseCommand`);
 *  - the deterministic analysis floor's rule-appropriate command
 *    suggestions (no LLM key required);
 *  - the Claude Code hook output's "→ run: <cli>" rendering, via `usage`.
 *
 * Synapse only ever SUGGESTS these commands — nothing here executes them.
 * When a new MCP tool ships, add its entry here in the same PR.
 */
export interface SynapseCommandSpec {
  /** MCP tool name, e.g. "synapse_why". */
  tool: string;
  /** CLI equivalent, e.g. "synapse why". */
  cli: string;
  /** One sentence: when an agent should reach for this tool. */
  when: string;
  args: { name: string; type: "string" | "number"; required: boolean; hint: string }[];
  /**
   * CLI render template with <argName> placeholders, used verbatim by the
   * hook output so all executors format identically.
   * e.g. `synapse why "<question>"`, `synapse whatsup`.
   */
  usage: string;
}

export const SYNAPSE_COMMAND_CATALOG: SynapseCommandSpec[] = [
  {
    tool: "synapse_check",
    cli: "synapse check",
    when: "Before editing a file, to get deterministic conflict verdicts and analysis.",
    args: [{ name: "file", type: "string", required: true, hint: "path to the file you're about to edit" }],
    usage: "synapse check --file <file>"
  },
  {
    tool: "synapse_report",
    cli: "synapse report",
    when: "After editing a file, to broadcast contract changes so teammates are warned.",
    args: [{ name: "file", type: "string", required: true, hint: "path to the file you changed" }],
    usage: "synapse report --file <file>"
  },
  {
    tool: "synapse_push",
    cli: "synapse push",
    when: "After pushing commits, to clear stale deltas and edit locks for teammates.",
    args: [{ name: "file", type: "string", required: true, hint: "path of a pushed file" }],
    usage: "synapse push --file <file>"
  },
  {
    tool: "synapse_feedback",
    cli: "synapse feedback",
    when: "To record whether a surfaced conflict warning was acted on or dismissed.",
    args: [
      { name: "conflictId", type: "string", required: true, hint: "id of the conflict from a check response" },
      { name: "outcome", type: "string", required: true, hint: "'acted' or 'dismissed'" }
    ],
    usage: "synapse feedback --conflict-id <conflictId> --outcome <outcome>"
  },
  {
    tool: "synapse_session",
    cli: "synapse session",
    when: "To start, heartbeat, or end your local coordination session.",
    args: [{ name: "action", type: "string", required: false, hint: "'start' | 'heartbeat' | 'end'" }],
    usage: "synapse session --action <action>"
  },
  {
    tool: "synapse_whatsup",
    cli: "synapse whatsup",
    when: "To see what teammates are doing now: active sessions, unpushed deltas, edit locks.",
    args: [],
    usage: "synapse whatsup"
  },
  {
    tool: "synapse_onboard",
    cli: "synapse onboard",
    when: "Once at the start of your first session, to absorb team history and cited decisions.",
    args: [],
    usage: "synapse onboard"
  },
  {
    tool: "synapse_pr_brief",
    cli: "synapse pr-brief",
    when: "Before opening or reviewing a PR, to get a local handoff for a base/head branch pair.",
    args: [
      { name: "base", type: "string", required: false, hint: "target branch, usually main" },
      { name: "head", type: "string", required: false, hint: "source branch; defaults to current branch" }
    ],
    usage: "synapse pr-brief --base <base> --head <head>"
  },
  {
    tool: "synapse_why",
    cli: "synapse why",
    when: "To search team memory for why something changed, with cited sources.",
    args: [{ name: "question", type: "string", required: true, hint: "your why/what-changed question" }],
    usage: 'synapse why "<question>"'
  }
];

/** True if `tool` is a known entry in the catalog above. */
export function isKnownSynapseCommand(tool: string): boolean {
  return SYNAPSE_COMMAND_CATALOG.some((entry) => entry.tool === tool);
}

/** Compact prompt block: one line per tool — "name(args): when". */
export function renderCommandCatalogForPrompt(): string {
  return SYNAPSE_COMMAND_CATALOG.map((entry) => {
    const args = entry.args.map((arg) => arg.name).join(", ");
    return `${entry.tool}(${args}): ${entry.when}`;
  }).join("\n");
}
