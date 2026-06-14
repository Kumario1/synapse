import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { resolveWorktreePath, UnsafeWorktreePathError } from "./path-safety.js";

test("resolveWorktreePath accepts relative in-worktree paths", async () => {
  await withFixture(async ({ root }) => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/index.ts"), "export const ok = true;\n");

    assert.equal(
      await resolveWorktreePath(root, "src/index.ts"),
      join(root, "src/index.ts")
    );
  });
});

test("resolveWorktreePath rejects absolute paths", async () => {
  await withFixture(async ({ root }) => {
    await assert.rejects(
      resolveWorktreePath(root, join(root, "src/index.ts")),
      UnsafeWorktreePathError
    );
  });
});

test("resolveWorktreePath rejects parent traversal", async () => {
  await withFixture(async ({ root }) => {
    await assert.rejects(
      resolveWorktreePath(root, "../outside.ts"),
      UnsafeWorktreePathError
    );
  });
});

test("resolveWorktreePath rejects sibling-prefix escapes", async () => {
  await withFixture(async ({ root, temp }) => {
    const sibling = `${root}-other`;
    await mkdir(sibling);
    await writeFile(join(sibling, "secret.ts"), "export const secret = true;\n");

    const escapePath = `${basename(root)}-other/secret.ts`;
    await assert.rejects(
      resolveWorktreePath(root, `../${escapePath}`),
      UnsafeWorktreePathError
    );

    await rm(sibling, { force: true, recursive: true });
  });
});

test("resolveWorktreePath rejects symlink escapes when the file exists", async () => {
  await withFixture(async ({ root, temp }) => {
    const outside = join(temp, "outside.ts");
    await writeFile(outside, "export const secret = true;\n");
    await symlink(outside, join(root, "link.ts"));

    await assert.rejects(
      resolveWorktreePath(root, "link.ts"),
      UnsafeWorktreePathError
    );
  });
});

test("resolveWorktreePath allows missing relative in-worktree paths", async () => {
  await withFixture(async ({ root }) => {
    assert.equal(
      await resolveWorktreePath(root, "src/missing.ts"),
      join(root, "src/missing.ts")
    );
  });
});

async function withFixture(
  run: (fixture: { temp: string; root: string }) => Promise<void>
): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "synapse-path-safety-"));
  const root = join(temp, "repo");
  await mkdir(root);
  try {
    await run({ temp, root });
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
}
