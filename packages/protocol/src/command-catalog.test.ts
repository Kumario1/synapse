import assert from "node:assert/strict";
import { test } from "node:test";
import { renderCommandCatalogMarkdown, SYNAPSE_COMMAND_CATALOG } from "./command-catalog.js";

test("markdown command catalog includes every tool", () => {
  const out = renderCommandCatalogMarkdown();

  for (const entry of SYNAPSE_COMMAND_CATALOG) {
    assert.ok(out.includes(entry.tool), `missing tool ${entry.tool}`);
  }
});

test("markdown command catalog includes every usage string", () => {
  const out = renderCommandCatalogMarkdown();

  for (const entry of SYNAPSE_COMMAND_CATALOG) {
    assert.ok(out.includes(entry.usage), `missing usage ${entry.usage}`);
  }
});

test("markdown command catalog formats no-args and required-args entries", () => {
  const out = renderCommandCatalogMarkdown();
  const lines = out.split("\n");
  const whatsup = SYNAPSE_COMMAND_CATALOG.find((entry) => entry.tool === "synapse_whatsup");
  const why = SYNAPSE_COMMAND_CATALOG.find((entry) => entry.tool === "synapse_why");

  assert.ok(whatsup);
  assert.ok(why);
  const whyArg = why.args[0];
  assert.ok(whyArg);

  const whatsupLine = lines.find((line) => line.includes(`\`${whatsup.tool}\``));
  const whyLine = lines.find((line) => line.includes(`\`${why.tool}\``));

  assert.ok(whatsupLine);
  assert.ok(whyLine);
  assert.doesNotMatch(whatsupLine, /Args:/);
  assert.ok(whyLine.includes(whyArg.name));
  assert.ok(whyLine.includes(whyArg.hint));
});
