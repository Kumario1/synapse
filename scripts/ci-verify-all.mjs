#!/usr/bin/env node
// The one CI gate: build + typecheck + unit tests, then every verify script and
// the conflict eval, run sequentially against the single build. Local devs run
// the exact same command CI does:
//
//   node scripts/ci-verify-all.mjs
//
// Build happens once up front — each `npm run verify:*` entry rebuilds first,
// which is right for one-off runs but would rebuild ~30 times here, so this
// runner invokes the underlying `scripts/*.mjs` directly.
//
// Environment-dependent scripts stay green everywhere: verify-docker self-skips
// without docker, verify-up-tunnel stubs the tunnel binary. To skip scripts
// explicitly (e.g. latency gates on a noisy machine):
//
//   SYNAPSE_VERIFY_SKIP=hot-path-latency,large-repo-latency node scripts/ci-verify-all.mjs
//
// Or run just a few while iterating locally:
//
//   node scripts/ci-verify-all.mjs --only why,doctor
//
// Hermetic by convention: the LLM path is disabled for every child so results
// never depend on a key in the local environment.
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptTimeoutMs = Number(process.env.SYNAPSE_VERIFY_TIMEOUT_MS ?? 900_000);
const skip = new Set(
  (process.env.SYNAPSE_VERIFY_SKIP ?? "")
    .split(",")
    .map((name) => name.trim().replace(/^verify-/, "").replace(/\.mjs$/, ""))
    .filter(Boolean)
);
const onlyArg = process.argv.indexOf("--only");
const only =
  onlyArg !== -1 && process.argv[onlyArg + 1]
    ? new Set(
        process.argv[onlyArg + 1]
          .split(",")
          .map((name) => name.trim().replace(/^verify-/, "").replace(/\.mjs$/, ""))
          .filter(Boolean)
      )
    : null;
const childEnv = {
  ...process.env,
  // Force the deterministic path: no LLM calls regardless of local keys.
  OPENROUTER_API_KEY: "",
  SYNAPSE_LLM_EXPLAIN: "0"
};

// Stages are prerequisites — a broken build makes every verify fail for the
// same reason, so stages fail fast while verify scripts run to completion and
// aggregate.
const stages = [
  ["npm", ["run", "build"]],
  ["npm", ["run", "typecheck"]],
  ["npm", ["test"]],
  ["npm", ["run", "setup:analyzer-py"]]
];

for (const [command, args] of stages) {
  const label = [command, ...args].join(" ");
  console.log(`\n=== stage: ${label} ===`);
  const code = await run(command, args);
  if (code !== 0) {
    console.error(`\nstage failed (${label}); aborting before the verify matrix.`);
    process.exit(code || 1);
  }
}

const entries = (await readdir(join(rootDir, "scripts")))
  .filter((name) => /^verify-.+\.mjs$/.test(name))
  .sort();
entries.push("eval-conflicts.mjs");

const results = [];
for (const entry of entries) {
  const short = entry.replace(/^verify-/, "").replace(/\.mjs$/, "").replace(/^eval-/, "");
  if (only && !only.has(short)) {
    continue;
  }
  if (skip.has(short)) {
    console.log(`\n=== ${entry} === SKIP (SYNAPSE_VERIFY_SKIP)`);
    results.push({ entry, status: "skip" });
    continue;
  }

  console.log(`\n=== ${entry} ===`);
  const startedAt = Date.now();
  const code = await run("node", [join("scripts", entry)]);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const status = code === 0 ? "pass" : "fail";
  console.log(`=== ${entry}: ${status.toUpperCase()} in ${seconds}s ===`);
  results.push({ entry, status, seconds });
}

const failed = results.filter((result) => result.status === "fail");
console.log("\n========== verify summary ==========");
for (const { entry, status, seconds } of results) {
  console.log(`${status.toUpperCase().padEnd(5)} ${entry}${seconds ? ` (${seconds}s)` : ""}`);
}
console.log(`${results.length - failed.length}/${results.length} green`);
process.exit(failed.length === 0 ? 0 : 1);

/**
 * Run one command with inherited output, returning its exit code. The child is
 * its own process group so a timeout can reap the daemons/servers a verify
 * script spawned, not just the script itself.
 */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: childEnv,
      stdio: "inherit",
      detached: process.platform !== "win32",
      shell: process.platform === "win32"
    });

    const timer = setTimeout(() => {
      console.error(`timed out after ${scriptTimeoutMs}ms; killing process group`);
      terminate(child, "SIGTERM");
      setTimeout(() => terminate(child, "SIGKILL"), 5_000).unref();
    }, scriptTimeoutMs);

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(signal ? 1 : (code ?? 1));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      console.error(error.message);
      resolve(1);
    });
  });
}

function terminate(child, signal) {
  if (child.exitCode !== null || child.signalCode) {
    return;
  }
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // Already gone.
  }
}
