import { commandDefaults, filesFromFlags, parseFlags } from "../config.js";
import { postJson } from "../http.js";

export async function runPush(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const files = filesFromFlags(flags);
  if (files.length === 0) {
    throw new Error("--file or --files is required");
  }

  const symbols = flags.symbols
    ? flags.symbols.split(",").map((raw) => ({ raw: raw.trim() })).filter((symbol) => symbol.raw)
    : flags.symbol
      ? [{ raw: flags.symbol }]
      : undefined;

  const response = await postJson(`http://localhost:${defaults.daemonPort}/tools/synapse_push`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    sha: flags.sha ?? "local",
    summary: flags.summary ?? `Pushed ${files.join(", ")}`,
    files,
    symbols
  });
  console.log(JSON.stringify(response, null, 2));
}

