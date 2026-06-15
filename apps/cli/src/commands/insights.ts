import type { SynapseInsightsRequest } from "@synapse/protocol";
import { finiteNumber, printToolJson } from "./tool.js";

export async function runInsights(rawArgs: string[]): Promise<void> {
  await printToolJson(rawArgs, "synapse_insights", (flags, defaults): SynapseInsightsRequest => ({
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    limit: finiteNumber(flags.limit)
  }));
}
