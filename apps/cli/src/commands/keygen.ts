import { deriveProjectKey } from "@synapse/protocol";
import { configFromArgs } from "../config.js";

/**
 * Mint a project-scoped key for the server operator: HMAC(SYNAPSE_MASTER_SECRET,
 * repoId). The operator runs this once per project and shares the key
 * out-of-band; teammates pass it as SYNAPSE_PROJECT_KEY / --key. repoId resolves
 * via the same chain as `up`, so a checkout with a git remote needs no flags.
 */
export function runKeygen(rawArgs: string[]): void {
  const secret = process.env.SYNAPSE_MASTER_SECRET ?? "";
  if (!secret) {
    throw new Error(
      "SYNAPSE_MASTER_SECRET is not set. Set the same master secret the server runs with, then re-run `synapse keygen`."
    );
  }

  const config = configFromArgs(rawArgs);
  if (config.repoId === "local") {
    console.warn(
      'synapse: repoId is "local" — this key only authorizes the "local" project. ' +
        "Add a git remote, pass --repo-id, or set repoId in .synapse/team.json to scope it to a real project."
    );
  }

  console.log(deriveProjectKey(secret, config.repoId));
}

