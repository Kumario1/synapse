import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  affectedSitesForSymbols,
  buildDependencyGraph,
  filePathForSymbolRaw
} from "./analysis.js";
import type { RuntimeConfig } from "./config.js";

void test("filePathForSymbolRaw extracts analyzer paths", () => {
  assert.equal(filePathForSymbolRaw("ts:src/api.ts#loadUser"), "src/api.ts");
  assert.equal(filePathForSymbolRaw("py:auth.py#validate"), "auth.py");
  assert.equal(filePathForSymbolRaw("go:auth/token.go#Validate"), "auth/token.go");
  assert.equal(filePathForSymbolRaw("file:README.md"), null);
});

void test("affectedSitesForSymbols dedupes symbols and skips file-level ids", () => {
  assert.deepEqual(
    affectedSitesForSymbols([
      { raw: "ts:src/caller.ts#render" },
      { raw: "ts:src/caller.ts#render" },
      { raw: "file:README.md" }
    ]),
    [{ symbolId: { raw: "ts:src/caller.ts#render" }, filePath: "src/caller.ts" }]
  );
});

void test("dependentsOf returns direct downstream symbols with file paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "synapse-analysis-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/dep.ts"),
      "export function changed(input: string): string { return input; }\n"
    );
    await writeFile(
      join(root, "src/caller.ts"),
      [
        "import { changed } from './dep';",
        "export function render(value: string): string {",
        "  return changed(value);",
        "}",
        ""
      ].join("\n")
    );

    const graph = await buildDependencyGraph(testConfig(root));

    assert.deepEqual(graph.dependentsOf("ts:src/dep.ts#changed"), [
      { symbolId: { raw: "ts:src/caller.ts#render" }, filePath: "src/caller.ts" }
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

function testConfig(worktreeRoot: string): RuntimeConfig {
  return {
    repoId: "repo",
    member: "tester",
    sessionId: "session",
    agentType: "other",
    daemonPort: 0,
    serverUrl: "ws://localhost:0",
    worktreeRoot,
    authToken: ""
  };
}
