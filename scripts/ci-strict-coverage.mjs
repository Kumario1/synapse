#!/usr/bin/env node
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { groups } from "./ci-strict-runner.mjs";

const scriptsDir = import.meta.dirname;
const allowlist = new Map([
  ["verify-hot-path-latency.mjs", "latency/flaky on shared CI"],
  ["verify-large-repo-latency.mjs", "latency/flaky on shared CI"],
  ["verify-repo-latency.mjs", "latency/flaky on shared CI"],
  ["verify-up-tunnel.mjs", "external public tunnel"],
  ["verify-why-rag.mjs", "needs pgvector/offline skip"],
  ["verify-connect.mjs", "promotion candidate"],
  ["verify-doctor.mjs", "promotion candidate"],
  ["verify-insights.mjs", "promotion candidate"],
  ["verify-feedback.mjs", "promotion candidate"],
  ["verify-llm-actions.mjs", "promotion candidate"],
  ["verify-rename-tracking.mjs", "promotion candidate"],
  ["verify-push-state-reset.mjs", "promotion candidate"],
  ["verify-git-repo-id.mjs", "promotion candidate"],
  ["verify-join-config.mjs", "promotion candidate"],
  ["verify-up.mjs", "promotion candidate"],
  ["verify-milestone-0.mjs", "promotion candidate"]
]);

const scriptFiles = new Set(
  (await readdir(scriptsDir))
    .filter((name) => /^(verify|eval)-.*\.mjs$/.test(name))
    .sort()
);
const gated = new Set(
  Object.values(groups)
    .flat()
    .flatMap((entry) => entry.args ?? [])
    .filter((arg) => /^scripts\/(verify|eval)-.*\.mjs$/.test(arg))
    .map((arg) => arg.slice("scripts/".length))
);
const missing = [...scriptFiles].filter((name) => !gated.has(name) && !allowlist.has(name));

for (const name of allowlist.keys()) {
  if (!(await exists(join(scriptsDir, name)))) {
    console.warn(`WARN allowlisted script no longer exists: ${name}`);
  }
}

if (missing.length > 0) {
  console.error("Strict CI coverage check failed.");
  console.error("Gate these scripts in scripts/ci-strict-runner.mjs or allowlist them with a reason:");
  for (const name of missing) {
    console.error(`- ${name}`);
  }
  process.exit(1);
}

console.log("PASS strict CI covers every verify/eval script or has an allowlist reason");

async function exists(path) {
  return access(path)
    .then(() => true)
    .catch(() => false);
}
