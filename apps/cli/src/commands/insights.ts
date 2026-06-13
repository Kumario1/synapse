import type { SynapseInsightsRequest } from "@synapse/protocol";
import { commandDefaults, parseFlags } from "../config.js";
import { postJson } from "../http.js";

export async function runInsights(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const limit = flags.limit ? Number(flags.limit) : undefined;
  const request: SynapseInsightsRequest = {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    limit: Number.isFinite(limit) ? limit : undefined
  };

  const response = await postJson(
    `http://localhost:${defaults.daemonPort}/tools/synapse_insights`,
    request
  );
  console.log(JSON.stringify(response, null, 2));
}
