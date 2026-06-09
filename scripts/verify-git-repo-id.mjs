import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pure unit: every git remote shape (ssh/scp/https, embedded credentials, port,
// trailing .git, casing) must normalize to the SAME canonical host/owner/repo
// slug, and non-repo inputs (local paths, file://) must yield "" so callers fall
// back to "local". This is what lets two clones of one repo share a room.
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const { normalizeRemoteUrl } = await import(
  join(rootDir, "apps/cli/dist/identity.js")
);

const cases = [
  ["git@github.com:acme/widgets.git", "github.com/acme/widgets"],
  ["https://github.com/acme/widgets.git", "github.com/acme/widgets"],
  ["https://github.com/acme/widgets", "github.com/acme/widgets"],
  ["ssh://git@github.com:22/acme/widgets.git", "github.com/acme/widgets"],
  ["https://user:ghp_token@github.com/acme/widgets.git", "github.com/acme/widgets"],
  ["git@github.com:Acme/Widgets.git", "github.com/acme/widgets"],
  ["https://gitlab.com/group/subgroup/repo.git", "gitlab.com/group/subgroup/repo"],
  ["git@bitbucket.org:team/repo.git", "bitbucket.org/team/repo"],
  // Same repo, two transports → identical slug (the whole point).
  ["git@github.com:acme/widgets.git", "github.com/acme/widgets"],
  // Not coordinatable → "".
  ["/Users/me/code/widgets", ""],
  ["file:///Users/me/code/widgets", ""],
  ["", ""],
  ["   ", ""],
  ["not a url", ""]
];

for (const [input, expected] of cases) {
  const actual = normalizeRemoteUrl(input);
  assert.equal(actual, expected, `normalizeRemoteUrl(${JSON.stringify(input)}) → ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// The cross-transport invariant, stated directly.
assert.equal(
  normalizeRemoteUrl("git@github.com:acme/widgets.git"),
  normalizeRemoteUrl("https://github.com/acme/widgets"),
  "ssh and https remotes for the same repo must produce the same slug"
);

console.log(`git-repo-id verification passed: ${cases.length} cases.`);
