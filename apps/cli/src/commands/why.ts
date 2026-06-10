import { commandDefaults, parseFlags } from "../config.js";
import { postJson } from "../http.js";

export async function runWhy(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const question = flags.question ?? flags.q ?? rawArgs.filter((arg) => !arg.startsWith("--")).join(" ");
  if (!question) {
    throw new Error("--question is required");
  }

  const limit = flags.limit ? Number(flags.limit) : undefined;
  const response = await postJson(`http://localhost:${defaults.daemonPort}/tools/synapse_why`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    question,
    limit: Number.isFinite(limit) ? limit : undefined
  });
  console.log(JSON.stringify(response, null, 2));
}

