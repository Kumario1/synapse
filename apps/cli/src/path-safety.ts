import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export class UnsafeWorktreePathError extends Error {
  constructor(filePath: string) {
    super(`file path must stay inside the worktree: ${filePath}`);
    this.name = "UnsafeWorktreePathError";
  }
}

export async function resolveWorktreePath(
  worktreeRoot: string,
  filePath: string
): Promise<string> {
  if (isAbsolute(filePath)) {
    throw new UnsafeWorktreePathError(filePath);
  }

  const root = resolve(worktreeRoot);
  const fullPath = resolve(root, filePath);
  assertInside(root, fullPath, filePath);

  const realRoot = await realpath(root);
  try {
    const realTarget = await realpath(fullPath);
    assertInside(realRoot, realTarget, filePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return fullPath;
    }
    throw error;
  }

  return fullPath;
}

function assertInside(root: string, target: string, originalPath: string): void {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return;
  }
  throw new UnsafeWorktreePathError(originalPath);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
