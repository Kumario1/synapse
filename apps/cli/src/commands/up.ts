import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandCwd, configFromArgs, numberDefault, ownPackageName, parseFlags, writeTeamConfig } from "../config.js";
import { startDaemon } from "../daemon.js";
import { isHealthy, waitForHealth } from "../http.js";
import { startTunnel } from "../tunnel.js";
import { performJoin } from "./join.js";
import { printDoctor, runDoctor } from "./doctor.js";

/**
 * One-command setup for a machine joining a Synapse team. Resolves a git-derived
 * identity, joins (config + hooks + venv), runs a `doctor` preflight, then starts
 * the daemon in-process. With `--serve` it also spawns the coordination server as
 * a child; with `--tunnel` it exposes that server over a public `wss://` URL,
 * records it in the committed `.synapse/team.json`, and prints the teammate
 * onboarding command. SIGINT/SIGTERM tears down every spawned child.
 */
export async function runUp(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const serve = flags.serve === "true";
  const tunnel = flags.tunnel === "true";
  if (tunnel && !serve) {
    throw new Error("--tunnel requires --serve (the tunnel exposes the server this host runs).");
  }

  const children: ChildProcess[] = [];
  const cleanup = (): void => {
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort — we are shutting down anyway
      }
    }
  };
  // Register before startDaemon so a Ctrl-C kills the server/tunnel children too
  // (startDaemon installs its own handler that closes the daemon and exits).
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  let config = configFromArgs(rawArgs);
  if (config.repoId === "local") {
    console.warn(
      'synapse: repoId is "local" — machines on different clones will NOT coordinate. ' +
        "Add a git remote, pass --repo-id, or set repoId in .synapse/team.json."
    );
  }

  // In public (tunnel) mode the server is internet-reachable, so a token is
  // mandatory; generate one if the operator did not supply it.
  let authToken = config.authToken;
  if (tunnel && !authToken) {
    authToken = randomBytes(24).toString("base64url");
    console.log("synapse: generated a shared auth token for this session.");
  }

  let serverUrl = config.serverUrl;

  if (serve) {
    const serverPort = numberDefault(flags["server-port"], process.env.SYNAPSE_SERVER_PORT, 4010);
    const healthUrl = `http://localhost:${serverPort}/health`;
    if (await isHealthy(healthUrl)) {
      console.log(`synapse: reusing the server already listening on :${serverPort}`);
    } else {
      children.push(startServerChild(serverPort, authToken, config.worktreeRoot));
      await waitForHealth(healthUrl, 10_000);
      console.log(`synapse: server listening on :${serverPort}`);
    }
    // The host's own daemon talks to the server over localhost — no NAT round
    // trip. Only teammates use the tunnel URL.
    serverUrl = `ws://localhost:${serverPort}`;

    if (tunnel) {
      const publicUrl = await startTunnel(serverPort, children);
      if (publicUrl) {
        await writeTeamConfig({
          serverUrl: publicUrl,
          repoId: config.repoId === "local" ? undefined : config.repoId
        });
        printTeammateInstructions(publicUrl, authToken);
      }
    }
  }

  config = { ...config, serverUrl, authToken };

  // Surface a server child dying (the daemon is useless without it).
  const serverChild = children[0];
  serverChild?.once("exit", (code, signal) => {
    if (signal !== "SIGTERM") {
      console.error(`synapse: server exited (${code ?? signal}); shutting down.`);
      cleanup();
      process.exit(1);
    }
  });

  await performJoin(config);

  const preflight = await runDoctor([], { mode: "preflight", config });
  printDoctor(preflight.checks);
  if (!preflight.ok) {
    cleanup();
    throw new Error("synapse doctor preflight failed (see above). Fix the FAILs and re-run `synapse up`.");
  }

  await startDaemon(config);
}

/** Resolve the built @synapse/server entrypoint, or throw a clear build hint. */
export function resolveServerEntry(): string {
  try {
    const pkg = createRequire(import.meta.url).resolve("@synapse/server/package.json");
    const entry = join(dirname(pkg), "dist/index.js");
    if (existsSync(entry)) {
      return entry;
    }
  } catch {
    // not resolvable as a dependency — fall back to the monorepo layout
    // (this module compiles to dist/commands/, so apps/server is three hops up)
  }

  const fallback = resolve(dirname(fileURLToPath(import.meta.url)), "../../../server/dist/index.js");
  if (existsSync(fallback)) {
    return fallback;
  }

  throw new Error(
    "Could not find the @synapse/server build. Run `npm run build` (or install @synapse/server) and retry."
  );
}

function startServerChild(serverPort: number, authToken: string, worktreeRoot: string): ChildProcess {
  const entry = resolveServerEntry();
  const child = spawn(process.execPath, [entry], {
    cwd: commandCwd(),
    env: {
      ...process.env,
      SYNAPSE_SERVER_PORT: String(serverPort),
      // Durable by default in serve mode so a restart resumes live team state.
      SYNAPSE_DB_PATH: join(worktreeRoot, ".synapse-server", "state.db"),
      ...(authToken ? { SYNAPSE_AUTH_TOKEN: authToken } : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  return child;
}

function printTeammateInstructions(publicUrl: string, authToken: string): void {
  console.log("\n── Share with teammates ──────────────────────────────");
  console.log(`server URL (in .synapse/team.json): ${publicUrl}`);
  console.log("1. Commit the updated .synapse/team.json.");
  console.log("2. Each teammate pulls, then runs `synapse up` in their clone of the repo:");
  const tokenPart = authToken ? `SYNAPSE_AUTH_TOKEN=${authToken} ` : "";
  console.log(`     ${tokenPart}synapse up`);
  const packageName = ownPackageName();
  if (packageName === "@synapse/cli") {
    console.log("   If synapse isn't on your PATH, run it from your source checkout instead:");
    console.log(`     ${tokenPart}node <path-to-synapse-checkout>/apps/cli/dist/index.js up`);
  } else {
    console.log("   If synapse isn't on your PATH, npx works without an install:");
    console.log(`     ${tokenPart}npx ${packageName} up`);
  }
  if (authToken) {
    console.log("   The token is secret — share it over Slack/1Password, never commit it.");
  }
  console.log("──────────────────────────────────────────────────────\n");
}

