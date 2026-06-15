import type { SynapsePrBriefResponse } from "@synapse/protocol";
import { commandDefaults, parseFlags } from "../config.js";
import { finiteNumber, postToolWith } from "./tool.js";

export async function runPrBrief(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const response = (await postToolWith(defaults, "synapse_pr_brief", {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    base: flags.base,
    head: flags.head,
    limit: finiteNumber(flags.limit)
  })) as SynapsePrBriefResponse;

  if (flags.json === "true") {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  console.log(response.briefing);
}
