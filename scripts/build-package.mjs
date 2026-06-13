#!/usr/bin/env node
// Assembles the publishable CLI package in dist-release/package and packs it
// into dist-release/<name>-<version>.tgz.
//
// Strategy: ship ONE public package. The bundled @synapse/* workspace packages
// are copied into the staged package's node_modules and declared as
// bundleDependencies, so `npm pack` includes them in the tarball verbatim and
// `npm install` extracts them as-is — no extra names to claim on the registry,
// and every runtime resolution path (require.resolve("@synapse/server/..."),
// the analyzer-py python/ dir, setup-venv.mjs) keeps working unchanged.
//
// External deps (better-sqlite3, ts-morph, ws, zod, MCP SDK) stay regular
// registry dependencies, declared at the top level so install always brings
// them in even if a package manager skips dependencies of bundled packages.
//
// The public name/version/description live in release.config.json so renaming
// the product never touches this script.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseConfig = JSON.parse(readFileSync(join(rootDir, "release.config.json"), "utf8"));
const destFlag = process.argv.indexOf("--dest");
const releaseDir = resolve(destFlag !== -1 && process.argv[destFlag + 1] ? process.argv[destFlag + 1] : join(rootDir, "dist-release"));
if (releaseDir === rootDir) {
  throw new Error("--dest must not be the repository root");
}
const stageDir = join(releaseDir, "package");

const BUNDLED = [
  { name: "@synapse/protocol", dir: "packages/protocol", copy: ["dist"] },
  { name: "@synapse/conflict-engine", dir: "packages/conflict-engine", copy: ["dist"] },
  { name: "@synapse/analyzer-ts", dir: "packages/analyzer-ts", copy: ["dist"] },
  {
    name: "@synapse/analyzer-go",
    dir: "packages/analyzer-go",
    copy: ["dist", "go", "scripts/setup-go.mjs"]
  },
  {
    name: "@synapse/analyzer-py",
    dir: "packages/analyzer-py",
    copy: ["dist", "python", "requirements.txt", "scripts/setup-venv.mjs"]
  },
  { name: "@synapse/server", dir: "apps/server", copy: ["dist"] }
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function log(message) {
  process.stdout.write(`[build-package] ${message}\n`);
}

function copyBundledEntry(source, target) {
  cpSync(source, target, {
    recursive: true,
    filter: (path) => {
      const name = basename(path);
      return name !== "__pycache__" && !name.endsWith(".pyc");
    }
  });
}

// 1. Fresh build of every workspace so dist/ is current.
log("building workspaces (turbo run build)");
execFileSync("npm", ["run", "build"], { cwd: rootDir, stdio: "inherit" });

// 2. Stage the package.
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

cpSync(join(rootDir, "apps/cli/dist"), join(stageDir, "dist"), { recursive: true });
cpSync(join(rootDir, "LICENSE"), join(stageDir, "LICENSE"));
cpSync(join(rootDir, "README.md"), join(stageDir, "README.md"));

for (const pkg of BUNDLED) {
  const sourceRoot = join(rootDir, pkg.dir);
  const targetRoot = join(stageDir, "node_modules", pkg.name);
  mkdirSync(targetRoot, { recursive: true });

  // Rewrite the bundled manifest: real version, not private, workspace deps
  // pinned to the release version. Their external deps stay declared so npm
  // resolves them from the registry on install.
  const manifest = readJson(join(sourceRoot, "package.json"));
  manifest.version = releaseConfig.version;
  delete manifest.private;
  delete manifest.scripts;
  delete manifest.devDependencies;
  // We copy exactly what ships; a files allowlist could only drop pieces
  // (e.g. analyzer-py's setup-venv.mjs) if npm ever applied it to bundled deps.
  delete manifest.files;
  for (const depName of Object.keys(manifest.dependencies ?? {})) {
    if (depName.startsWith("@synapse/")) {
      manifest.dependencies[depName] = releaseConfig.version;
    }
  }
  writeFileSync(join(targetRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const entry of pkg.copy) {
    const target = join(targetRoot, entry);
    mkdirSync(dirname(target), { recursive: true });
    copyBundledEntry(join(sourceRoot, entry), target);
  }
}

// 3. Top-level manifest: external deps from the CLI plus everything the
// bundled packages need at runtime, with the @synapse/* set marked bundled.
const cliManifest = readJson(join(rootDir, "apps/cli/package.json"));
const externalDeps = {};
const collectExternal = (deps) => {
  for (const [depName, range] of Object.entries(deps ?? {})) {
    if (!depName.startsWith("@synapse/")) {
      externalDeps[depName] = range;
    }
  }
};
collectExternal(cliManifest.dependencies);
for (const pkg of BUNDLED) {
  collectExternal(readJson(join(rootDir, pkg.dir, "package.json")).dependencies);
}

const bundledDeps = Object.fromEntries(BUNDLED.map((pkg) => [pkg.name, releaseConfig.version]));

const manifest = {
  name: releaseConfig.name,
  version: releaseConfig.version,
  description: releaseConfig.description,
  license: releaseConfig.license,
  homepage: releaseConfig.homepage,
  repository: { type: "git", url: `git+${releaseConfig.homepage}.git` },
  type: "module",
  bin: { synapse: "dist/index.js" },
  main: "dist/index.js",
  engines: { node: ">=20.6" },
  keywords: ["coding-agents", "mcp", "claude-code", "cursor", "conflict-detection", "coordination"],
  dependencies: { ...externalDeps, ...bundledDeps },
  bundleDependencies: Object.keys(bundledDeps),
  files: ["dist"]
};
writeFileSync(join(stageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// 4. Pack. npm includes bundleDependencies from the staged node_modules.
log(`packing ${releaseConfig.name}@${releaseConfig.version}`);
const packOutput = execFileSync(
  "npm",
  ["pack", "--pack-destination", releaseDir],
  { cwd: stageDir, encoding: "utf8" }
);
const tarball = packOutput.trim().split("\n").pop();
const tarballPath = join(releaseDir, tarball);
log(`tarball: ${tarballPath}`);
log("publish with: npm publish --access public " + tarballPath);
console.log(tarballPath);
