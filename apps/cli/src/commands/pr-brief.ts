import type { SynapsePrBriefResponse } from "@synapse/protocol";
import { commandDefaults, parseFlags } from "../config.js";
import { postJson } from "../http.js";

export async function runPrBrief(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const limit = flags.limit ? Number(flags.limit) : undefined;
  const response = (await postJson(
    `http://localhost:${defaults.daemonPort}/tools/synapse_pr_brief`,
    {
      repoId: defaults.repoId,
      sessionId: defaults.sessionId,
      base: flags.base,
      head: flags.head,
      limit: Number.isFinite(limit) ? limit : undefined
    }
  )) as SynapsePrBriefResponse;

  if (flags.json === "true") {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  console.log(response.briefing);
}
