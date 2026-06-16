import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const tests = collectTests(srcDir);

if (tests.length === 0) {
  console.error("No web tests found under src/**/*.test.ts");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...tests], {
  stdio: "inherit"
});

process.exit(result.status ?? 1);

function collectTests(dir) {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        return collectTests(path);
      }
      return entry.endsWith(".test.ts") ? [path] : [];
    })
    .sort();
}
