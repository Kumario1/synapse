#!/usr/bin/env node
// Build the publishable @synapse/cli tarball.
//
// `npm pack --workspace @synapse/cli` silently SKIPS bundleDependencies that
// are workspace symlinks (npm packs node_modules/<name> only when it is a real
// directory), which would ship a CLI whose imports all fail. So this script
// stages a real directory tree first:
//
//   staging/
//     package.json + dist/                  (the CLI itself)
//     node_modules/@synapse/<pkg>/          (real copies: package.json, dist,
//                                            + analyzer-py python assets)
//
// and runs `npm pack` there, so the declared bundleDependencies are embedded
// for real. Usage:  node apps/cli/scripts/pack.mjs [--dest <dir>]
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(cliRoot, "../..");
const destFlag = process.argv.indexOf("--dest");
const destDir = resolve(destFlag !== -1 && process.argv[destFlag + 1] ? process.argv[destFlag + 1] : repoRoot);

// What each bundled workspace package ships. analyzer-py carries its Python
// sidecar sources + the venv bootstrap; everything else is dist-only. `.venv`
// must never ride along (it is machine-specific and hundreds of MB).
const bundled = {
  "@synapse/protocol": ["package.json", "dist"],
  "@synapse/conflict-engine": ["package.json", "dist"],
  "@synapse/analyzer-ts": ["package.json", "dist"],
  "@synapse/analyzer-py": ["package.json", "dist", "python", "requirements.txt", "scripts"],
  "@synapse/analyzer-go": ["package.json", "dist", "go", "scripts"],
  "@synapse/server": ["package.json", "dist"]
};

const cliPackage = JSON.parse(await readFile(join(cliRoot, "package.json"), "utf8"));
const declared = cliPackage.bundleDependencies ?? [];
for (const name of Object.keys(bundled)) {
  if (!declared.includes(name)) {
    console.error(`package.json bundleDependencies is missing ${name}`);
    process.exit(1);
  }
}

const staging = await mkdtemp(join(tmpdir(), "synapse-cli-pack-"));
try {
  await cp(join(cliRoot, "package.json"), join(staging, "package.json"));
  await cp(join(cliRoot, "dist"), join(staging, "dist"), { recursive: true });

  for (const [name, entries] of Object.entries(bundled)) {
    const sourceRoot = join(repoRoot, name.startsWith("@synapse/server") ? "apps" : "packages", name.split("/")[1]);
    const targetRoot = join(staging, "node_modules", name);
    await mkdir(targetRoot, { recursive: true });
    for (const entry of entries) {
      const source = join(sourceRoot, entry);
      if (!existsSync(source)) {
        console.error(`missing ${source} — run \`npm run build\` first`);
        process.exit(1);
      }
      await cp(source, join(targetRoot, entry), { recursive: true });
    }
  }

  await mkdir(destDir, { recursive: true });
  const result = spawnSync("npm", ["pack", "--pack-destination", destDir], {
    cwd: staging,
    encoding: "utf8"
  });
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  const tarball = result.stdout.trim().split("\n").pop();
  console.log(join(destDir, tarball));
} finally {
  await rm(staging, { recursive: true, force: true });
}
