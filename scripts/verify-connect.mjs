import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(rootDir, "apps/cli/dist/index.js");
const tempRoot = await mkdtemp(join(tmpdir(), "synapse-connect-"));

let client = null;

try {
  // 1) A fresh `connect` writes every integration file.
  const first = runCli(["connect"], tempRoot);
  assert.match(first.stdout, /connected other agents to the Synapse MCP server/u);

  const expectedFiles = [
    ".cursor/mcp.json",
    ".cursor/rules/synapse.mdc",
    ".vscode/mcp.json",
    ".mcp.json",
    ".gemini/settings.json",
    ".windsurf/rules/synapse.md",
    "AGENTS.md"
  ];
  for (const file of expectedFiles) {
    assert.match(first.stdout, new RegExp(`${escapeRegExp(file)} —.*\\(wrote\\)`, "u"), `wrote ${file}`);
  }

  // 2) MCP server configs point `node <cli> mcp` under the right wrapper key.
  const mcpJson = JSON.parse(await readFile(join(tempRoot, ".mcp.json"), "utf8"));
  assert.equal(mcpJson.mcpServers.synapse.command, "node");
  assert.ok(mcpJson.mcpServers.synapse.args.includes("mcp"), "args include mcp");

  const cursorJson = JSON.parse(await readFile(join(tempRoot, ".cursor/mcp.json"), "utf8"));
  assert.equal(cursorJson.mcpServers.synapse.command, "node");

  const vscodeJson = JSON.parse(await readFile(join(tempRoot, ".vscode/mcp.json"), "utf8"));
  assert.equal(vscodeJson.servers.synapse.type, "stdio", "VS Code entry is stdio under `servers`");
  assert.equal(vscodeJson.servers.synapse.command, "node");

  const geminiJson = JSON.parse(await readFile(join(tempRoot, ".gemini/settings.json"), "utf8"));
  assert.equal(geminiJson.mcpServers.synapse.command, "node");

  // 3) Rules files carry the hook-equivalent guidance.
  const agentsMd = await readFile(join(tempRoot, "AGENTS.md"), "utf8");
  assert.match(agentsMd, /BEGIN SYNAPSE \(managed by/u);
  assert.match(agentsMd, /BEFORE EDITING — before you create, edit, or refactor/u);
  assert.match(agentsMd, /synapse_report/u);

  const cursorRule = await readFile(join(tempRoot, ".cursor/rules/synapse.mdc"), "utf8");
  assert.match(cursorRule, /alwaysApply: true/u);
  assert.match(cursorRule, /synapse_check/u);

  // 4) Re-running is idempotent: nothing changes, everything reports up to date.
  const agentsBefore = agentsMd;
  const mcpBefore = await readFile(join(tempRoot, ".mcp.json"), "utf8");
  const second = runCli(["connect"], tempRoot);
  for (const file of expectedFiles) {
    assert.match(
      second.stdout,
      new RegExp(`${escapeRegExp(file)} —.*\\(up to date\\)`, "u"),
      `${file} up to date on re-run`
    );
  }
  assert.equal(await readFile(join(tempRoot, "AGENTS.md"), "utf8"), agentsBefore, "AGENTS.md stable");
  assert.equal(await readFile(join(tempRoot, ".mcp.json"), "utf8"), mcpBefore, ".mcp.json stable");

  // 5) Existing user content is preserved when merging/upserting.
  const mergeRoot = await mkdtemp(join(tmpdir(), "synapse-connect-merge-"));
  await writeFile(
    join(mergeRoot, "AGENTS.md"),
    "# My project rules\n\nAlways write tests.\n"
  );
  await mkdir(join(mergeRoot, ".cursor"), { recursive: true });
  await writeFile(
    join(mergeRoot, ".cursor/mcp.json"),
    JSON.stringify({ mcpServers: { other: { command: "other-tool" } } }, null, 2)
  );
  runCli(["connect"], mergeRoot);

  const mergedAgents = await readFile(join(mergeRoot, "AGENTS.md"), "utf8");
  assert.match(mergedAgents, /My project rules/u, "preserves user heading");
  assert.match(mergedAgents, /Always write tests\./u, "preserves user content");
  assert.match(mergedAgents, /BEGIN SYNAPSE/u, "adds managed block");

  const mergedCursor = JSON.parse(await readFile(join(mergeRoot, ".cursor/mcp.json"), "utf8"));
  assert.equal(mergedCursor.mcpServers.other.command, "other-tool", "preserves other MCP server");
  assert.equal(mergedCursor.mcpServers.synapse.command, "node", "adds the synapse server");
  await rm(mergeRoot, { recursive: true, force: true });

  // 6) `--agent` limits the set to the requested clients only.
  const filterRoot = await mkdtemp(join(tmpdir(), "synapse-connect-filter-"));
  const filtered = runCli(["connect", "--agent", "cursor,vscode"], filterRoot);
  assert.match(filtered.stdout, /\.cursor\/mcp\.json/u);
  assert.match(filtered.stdout, /\.vscode\/mcp\.json/u);
  assert.doesNotMatch(filtered.stdout, /\.mcp\.json/u, "generic mcp excluded by filter");
  assert.doesNotMatch(filtered.stdout, /AGENTS\.md/u, "AGENTS.md excluded by filter");
  await rm(filterRoot, { recursive: true, force: true });

  // 7) An unknown agent is rejected loudly.
  const bad = spawnSync(process.execPath, [cliPath, "connect", "--agent", "nope"], {
    cwd: tempRoot,
    env: { ...process.env, INIT_CWD: tempRoot },
    encoding: "utf8"
  });
  assert.notEqual(bad.status, 0, "unknown agent fails");
  assert.match(bad.stderr, /unknown agent/u);

  // 8) The MCP server advertises the hook-equivalent guidance as `instructions`
  //    and resolves its room from `.synapse/config.json` written by join.
  await mkdir(join(tempRoot, ".synapse"), { recursive: true });
  await writeFile(
    join(tempRoot, ".synapse/config.json"),
    JSON.stringify({ repoId: "connect-repo", sessionId: "connect-session", daemonPort: 4321 }, null, 2)
  );

  client = new Client({ name: "synapse-connect-verifier", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp"],
    cwd: tempRoot,
    env: { ...process.env, INIT_CWD: tempRoot },
    stderr: "pipe"
  });
  transport.stderr?.on("data", (chunk) => process.stderr.write(`[mcp] ${chunk}`));
  await client.connect(transport);

  const instructions = client.getInstructions();
  assert.ok(instructions, "MCP server exposes instructions");
  assert.match(instructions, /BEFORE EDITING/u);
  assert.match(instructions, /synapse_check/u);
  assert.match(instructions, /synapse_report/u);

  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(tools, [
    "synapse_check",
    "synapse_feedback",
    "synapse_insights",
    "synapse_onboard",
    "synapse_pr_brief",
    "synapse_push",
    "synapse_report",
    "synapse_session",
    "synapse_whatsup",
    "synapse_why"
  ]);

  console.log("Connect verification passed:");
  console.log(
    JSON.stringify(
      { files: expectedFiles, instructionsLength: instructions.length, tools },
      null,
      2
    )
  );

  await client.close();
  client = null;
} finally {
  if (client) {
    await client.close().catch(() => {});
  }
  await rm(tempRoot, { recursive: true, force: true });
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, INIT_CWD: cwd },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
