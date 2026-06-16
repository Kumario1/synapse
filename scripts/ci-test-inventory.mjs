#!/usr/bin/env node
import { access, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const rootDir = join(import.meta.dirname, "..");
const requiredMinimums = new Map([
  ["@synapse/protocol", 2],
  ["@synapse/conflict-engine", 6],
  ["@synapse/analyzer-ts", 1],
  ["@synapse/analyzer-py", 1],
  ["@synapse/analyzer-go", 1],
  ["@synapse/server", 4],
  ["@synapse/cli", 2]
]);
const focusedMarkers = [".only(", "test.only", "describe.only", "it.only"];

const rootPackage = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const workspaceDirs = await resolveWorkspaceDirs(rootPackage.workspaces ?? []);
const summaries = [];
const failures = [];

for (const packageDir of workspaceDirs) {
  const packageJsonPath = join(packageDir, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const packageName = packageJson.name ?? relative(rootDir, packageDir);
  const runsTypeScriptSourceTests = await testScriptRunsTypeScriptSource(packageJson.scripts?.test, packageDir);
  const sourceTests = (await findTests(join(packageDir, "src"))).sort();
  const matchedDistTests = [];

  for (const sourceTest of sourceTests) {
    const sourceText = await readFile(sourceTest, "utf8");
    const marker = focusedMarkers.find((candidate) => sourceText.includes(candidate));
    if (marker) {
      failures.push(`${packageName}: focused test marker ${marker} in ${relative(rootDir, sourceTest)}`);
    }

    const distTest = join(
      packageDir,
      "dist",
      relative(join(packageDir, "src"), sourceTest).replace(/\.ts$/, ".js")
    );
    if (await exists(distTest)) {
      matchedDistTests.push(distTest);
    } else if (!runsTypeScriptSourceTests) {
      failures.push(`${packageName}: missing compiled test ${relative(rootDir, distTest)}`);
    }
  }

  if (packageJson.scripts?.test && sourceTests.length === 0) {
    failures.push(`${packageName}: package has a test script but no src/**/*.test.ts files`);
  }

  const minimum = requiredMinimums.get(packageName);
  if (minimum !== undefined && sourceTests.length < minimum) {
    failures.push(`${packageName}: expected at least ${minimum} source test files, found ${sourceTests.length}`);
  }

  summaries.push({
    package: packageName,
    sourceTestCount: sourceTests.length,
    matchedDistTestCount: matchedDistTests.length,
    status: runsTypeScriptSourceTests || matchedDistTests.length === sourceTests.length ? "pass" : "fail"
  });
}

console.log(JSON.stringify(summaries, null, 2));

if (failures.length > 0) {
  console.error("\nTest inventory check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

async function resolveWorkspaceDirs(patterns) {
  const dirs = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      throw new Error(`Unsupported workspace pattern: ${pattern}`);
    }

    const baseDir = join(rootDir, pattern.slice(0, -2));
    const entries = await readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(join(baseDir, entry.name));
      }
    }
  }
  return dirs.sort();
}

async function findTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const tests = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      tests.push(...(await findTests(path)));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      tests.push(path);
    }
  }

  return tests;
}

async function exists(path) {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

async function testScriptRunsTypeScriptSource(script, packageDir) {
  if (!script) {
    return false;
  }
  if (runsTsxNodeTests(script)) {
    return true;
  }

  const runnerPath = script.match(/^node\s+([^\s;&|]+\.mjs)(?:\s|$)/)?.[1];
  if (!runnerPath) {
    return false;
  }

  const runner = await readFile(join(packageDir, runnerPath), "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  return runsTsxNodeTests(runner);
}

function runsTsxNodeTests(source) {
  return source.includes("--import") && source.includes("tsx") && source.includes("--test") && source.includes(".test.ts");
}
