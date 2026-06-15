#!/usr/bin/env node
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(import.meta.dirname, "..");
const npmCacheDir = join(tmpdir(), "synapse-npm-cache");
const goCacheDir = join(tmpdir(), "synapse-go-cache");
const pipCacheDir = join(tmpdir(), "synapse-pip-cache");
const commandTimeoutMs = Number(process.env.SYNAPSE_STRICT_TIMEOUT_MS ?? 900_000);
const groupNames = ["static", "unit", "detection", "agent-loop", "polyglot", "services", "package"];
const isCliEntry = process.argv[1] === fileURLToPath(import.meta.url);
const workspacePackages = [
  "@synapse/protocol",
  "@synapse/conflict-engine",
  "@synapse/analyzer-ts",
  "@synapse/analyzer-py",
  "@synapse/analyzer-go",
  "@synapse/server",
  "@synapse/cli"
];

export const groups = {
  static: [
    command("npm", "run", "build"),
    command("npm", "run", "typecheck"),
    command("node", "scripts/ci-test-inventory.mjs"),
    command("node", "scripts/ci-strict-coverage.mjs")
  ],
  unit: [
    command("npm", "test"),
    ...workspacePackages.map((name) => command("npm", "test", "--workspace", name))
  ],
  detection: [
    command("node", "scripts/eval-conflicts.mjs"),
    command("node", "scripts/eval-detection.mjs", "--strict"),
    command("node", "scripts/verify-contract-compat.mjs"),
    command("node", "scripts/verify-resolution.mjs"),
    command("node", "scripts/verify-adaptive-severity.mjs"),
    command("node", "scripts/verify-branch-aware-severity.mjs")
  ],
  "agent-loop": [
    command("node", "scripts/verify-strict-agent-loop.mjs"),
    command("node", "scripts/verify-daemon-ts-report.mjs"),
    command("node", "scripts/verify-dependency-ts-check.mjs"),
    command("node", "scripts/verify-file-only-ts-check.mjs"),
    command("node", "scripts/verify-hooks.mjs"),
    command("node", "scripts/verify-mcp-adapter.mjs"),
    command("node", "scripts/verify-session-start.mjs"),
    command("node", "scripts/verify-session-summary.mjs"),
    command("node", "scripts/verify-whatsup.mjs"),
    command("node", "scripts/verify-why.mjs"),
    command("node", "scripts/verify-atomic-intent.mjs"),
    command("node", "scripts/verify-delta-broadcast.mjs"),
    command("node", "scripts/verify-protocol-compat.mjs"),
    command("node", "scripts/verify-pr-brief.mjs"),
    command("node", "scripts/verify-onboard.mjs")
  ],
  polyglot: [
    command("npm", "run", "setup:analyzer-py"),
    command("npm", "run", "setup:analyzer-go"),
    command("node", "scripts/verify-python-check.mjs"),
    command("node", "scripts/verify-go-check.mjs"),
    command("node", "scripts/verify-tsx-check.mjs"),
    command("node", "scripts/verify-fuzz.mjs")
  ],
  services: [
    command("node", "scripts/verify-security.mjs"),
    command("node", "scripts/verify-auth.mjs"),
    command("node", "scripts/verify-tenancy.mjs"),
    command("node", "scripts/verify-persistence.mjs"),
    command("node", "scripts/verify-persistence-pg.mjs"),
    command("node", "scripts/verify-multi-instance.mjs"),
    command("node", "scripts/verify-github-webhook.mjs"),
    command("node", "scripts/verify-github-briefing.mjs"),
    command("node", "scripts/verify-reconnect.mjs"),
    command("node", "scripts/verify-metrics.mjs"),
    commandWithEnv({ CHOKIDAR_USEPOLLING: "1" }, "node", "scripts/verify-file-watcher.mjs")
  ],
  package: [
    command("node", "scripts/verify-npm-pack.mjs"),
    command("node", "scripts/verify-package.mjs"),
    command("node", "scripts/verify-demo.mjs"),
    command("node", "scripts/verify-docker.mjs")
  ]
};

if (isCliEntry) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    usage();
    process.exit(1);
  }

  if (process.env.SYNAPSE_VERIFY_SKIP) {
    console.error("SYNAPSE_VERIFY_SKIP is not allowed in strict CI gates.");
    process.exit(1);
  }

  if (args[0] === "--list") {
    console.log(groupNames.join("\n"));
    process.exit(0);
  }

  const selected = args[0];
  if (!Object.hasOwn(groups, selected)) {
    usage();
    process.exit(1);
  }

  const results = [];
  for (const entry of groups[selected]) {
    console.log(`\n=== ${entry.label} ===`);
    const startedAt = Date.now();
    const code = await run(entry);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const status = code === 0 ? "pass" : "fail";
    console.log(`=== ${entry.label}: ${status.toUpperCase()} in ${seconds}s ===`);
    results.push({ label: entry.label, status, seconds });
  }

  const failed = results.filter((result) => result.status === "fail");
  console.log(`\n========== strict ${selected} summary ==========`);
  for (const { label, status, seconds } of results) {
    console.log(`${status.toUpperCase().padEnd(5)} ${label} (${seconds}s)`);
  }
  console.log(`${results.length - failed.length}/${results.length} green`);

  process.exit(failed.length === 0 ? 0 : 1);
}

function command(bin, ...args) {
  return {
    bin,
    args,
    label: [bin, ...args].join(" ")
  };
}

function commandWithEnv(env, bin, ...args) {
  return {
    ...command(bin, ...args),
    env
  };
}

function run(entry) {
  return new Promise((resolve) => {
    const child = spawn(entry.bin, entry.args, {
      cwd: rootDir,
      env: {
        ...process.env,
        ...(entry.env ?? {}),
        GOCACHE: process.env.GOCACHE ?? goCacheDir,
        NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE ?? npmCacheDir,
        npm_config_cache: process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE ?? npmCacheDir,
        PIP_CACHE_DIR: process.env.PIP_CACHE_DIR ?? pipCacheDir,
        OPENROUTER_API_KEY: "",
        SYNAPSE_LLM_EXPLAIN: "0",
        SYNAPSE_LLM_RESOLVE: "0"
      },
      stdio: "inherit",
      detached: process.platform !== "win32",
      shell: process.platform === "win32"
    });

    let settled = false;
    const timer = setTimeout(() => {
      console.error(`${entry.label} timed out after ${commandTimeoutMs}ms; killing process group`);
      terminate(child, "SIGTERM");
      setTimeout(() => terminate(child, "SIGKILL"), 5_000).unref();
    }, commandTimeoutMs);

    child.once("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(signal ? 1 : (code ?? 1));
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
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

function usage() {
  console.error(`Usage: node scripts/ci-strict-runner.mjs <${groupNames.join("|")}|--list>`);
}
