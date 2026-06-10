import type { SynapseFeedbackRequest } from "@synapse/protocol";
import { commandDefaults, parseFlags } from "../config.js";
import { postJson } from "../http.js";

export async function runFeedback(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const conflictId = flags["conflict-id"] ?? flags.conflictId;
  const outcome = flags.outcome as SynapseFeedbackRequest["outcome"] | undefined;
  if (!conflictId) {
    throw new Error("--conflict-id is required");
  }
  if (outcome !== "acted" && outcome !== "dismissed") {
    throw new Error("--outcome must be acted or dismissed");
  }

  const response = await postJson(`http://localhost:${defaults.daemonPort}/tools/synapse_feedback`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    conflictId,
    outcome,
    note: flags.note,
    rule: flags.rule,
    targetSymbol: flags.symbol ? { raw: flags.symbol } : undefined
  });
  console.log(JSON.stringify(response, null, 2));
}

