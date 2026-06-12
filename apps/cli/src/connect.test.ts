import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SYNAPSE_COMMAND_CATALOG } from "@synapse/protocol";
import { connectAgents, SYNAPSE_AGENT_GUIDANCE } from "./connect.js";

test("agent guidance includes every catalog tool and usage string", () => {
  // This is the drift lock: adding a catalog entry without keeping the
  // generated guidance composition wired up must fail CI.
  for (const entry of SYNAPSE_COMMAND_CATALOG) {
    assert.ok(SYNAPSE_AGENT_GUIDANCE.includes(entry.tool), `missing tool ${entry.tool}`);
    assert.ok(SYNAPSE_AGENT_GUIDANCE.includes(entry.usage), `missing usage ${entry.usage}`);
  }
});

test("agent guidance keeps workflow anchors intact", () => {
  for (const anchor of ["SESSION START", "BEFORE EDITING", "AFTER EDITING", "AFTER PUSHING", "WHEN YOU NEED CONTEXT"]) {
    assert.ok(SYNAPSE_AGENT_GUIDANCE.includes(anchor), `missing anchor ${anchor}`);
  }
});

test("connectAgents writes AGENTS.md once and then leaves it unchanged", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "synapse-connect-"));

  try {
    const first = await connectAgents({
      repoDir,
      cliEntrypoint: "/tmp/fake-cli.js",
      only: ["agents"]
    });
    const firstAgents = first.find((entry) => entry.id === "agents");

    assert.ok(firstAgents);
    assert.equal(firstAgents.status, "wrote");

    const second = await connectAgents({
      repoDir,
      cliEntrypoint: "/tmp/fake-cli.js",
      only: ["agents"]
    });
    const secondAgents = second.find((entry) => entry.id === "agents");
    const agents = await readFile(join(repoDir, "AGENTS.md"), "utf8");

    assert.ok(secondAgents);
    assert.equal(secondAgents.status, "unchanged");
    assert.ok(agents.includes("<!-- BEGIN SYNAPSE"));
    assert.ok(agents.includes("<!-- END SYNAPSE"));
    assert.ok(agents.includes("synapse_why"));
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});
