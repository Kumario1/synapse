import assert from "node:assert/strict";
import test from "node:test";
import { gitHubPushToNotify } from "./github.js";

test("converts GitHub push payloads into push.notify payloads", () => {
  const push = gitHubPushToNotify(
    {
      after: "abc123",
      repository: { full_name: "Kumario1/synapse" },
      sender: { login: "alice" },
      head_commit: { message: "Update token contract\n\nbody" },
      commits: [
        {
          added: ["src/auth/token.ts"],
          modified: ["src/auth/login.ts", "src/auth/token.ts"],
          removed: ["src/old.ts"]
        }
      ]
    },
    "local"
  );

  assert.equal(push.repoId, "local");
  assert.deepEqual(push.payload, {
    repoId: "local",
    memberId: "alice",
    sha: "abc123",
    summary: "GitHub push: Update token contract",
    files: ["src/auth/token.ts", "src/auth/login.ts", "src/old.ts"]
  });
});

test("uses repository full_name as repo id when no override is provided", () => {
  const push = gitHubPushToNotify({
    after: "def456",
    repository: { full_name: "Kumario1/synapse" },
    pusher: { name: "bob" },
    commits: [{ modified: ["README.md"] }]
  });

  assert.equal(push.repoId, "Kumario1/synapse");
  assert.equal(push.payload.memberId, "bob");
  assert.equal(push.payload.summary, "GitHub push touched 1 file");
});

test("rejects push payloads without changed files", () => {
  assert.throws(
    () => gitHubPushToNotify({ after: "abc123", commits: [] }),
    /changed files/
  );
});
