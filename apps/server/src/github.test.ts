import assert from "node:assert/strict";
import test from "node:test";
import { gitHubPushToNotify, gitHubRepoEventToNotify } from "./github.js";

test("converts GitHub push payloads into push.notify payloads", () => {
  const push = gitHubPushToNotify(
    {
      after: "abc123",
      ref: "refs/heads/feature-x",
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
    files: ["src/auth/token.ts", "src/auth/login.ts", "src/old.ts"],
    branch: "feature-x"
  });
});

test("omits branch for non-branch refs and missing refs", () => {
  const tagPush = gitHubPushToNotify({
    after: "abc123",
    ref: "refs/tags/v1.0.0",
    commits: [{ modified: ["README.md"] }]
  });
  assert.equal("branch" in tagPush.payload, false);

  const noRefPush = gitHubPushToNotify({
    after: "abc123",
    commits: [{ modified: ["README.md"] }]
  });
  assert.equal("branch" in noRefPush.payload, false);
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

test("converts pull_request payloads into repo events", () => {
  const event = gitHubRepoEventToNotify(
    "pull_request",
    {
      action: "closed",
      repository: { full_name: "Kumario1/synapse" },
      sender: { login: "alice" },
      pull_request: {
        number: 12,
        title: "Add config loader",
        html_url: "https://github.com/Kumario1/synapse/pull/12",
        merged: true
      }
    },
    "local"
  );

  assert.equal(event.repoId, "local");
  assert.deepEqual(event.payload, {
    repoId: "local",
    kind: "pull_request",
    action: "merged",
    actor: "alice",
    title: "Add config loader",
    number: 12,
    url: "https://github.com/Kumario1/synapse/pull/12",
    summary: "GitHub PR #12 merged: Add config loader"
  });
});

test("converts pull_request_review payloads into repo events", () => {
  const event = gitHubRepoEventToNotify("pull_request_review", {
    action: "submitted",
    repository: { full_name: "Kumario1/synapse" },
    sender: { login: "bob" },
    pull_request: {
      number: 13,
      title: "Add auth",
      html_url: "https://github.com/Kumario1/synapse/pull/13"
    },
    review: {
      state: "approved",
      html_url: "https://github.com/Kumario1/synapse/pull/13#pullrequestreview-1"
    }
  });

  assert.equal(event.repoId, "Kumario1/synapse");
  assert.equal(event.payload.actor, "bob");
  assert.equal(event.payload.action, "approved");
  assert.equal(event.payload.summary, "GitHub review approved on PR #13: Add auth");
});

test("converts issue_comment payloads into repo events", () => {
  const event = gitHubRepoEventToNotify("issue_comment", {
    action: "created",
    repository: { full_name: "Kumario1/synapse" },
    sender: { login: "carol" },
    issue: {
      number: 14,
      title: "Clarify auth behavior",
      html_url: "https://github.com/Kumario1/synapse/issues/14",
      pull_request: {}
    },
    comment: {
      html_url: "https://github.com/Kumario1/synapse/issues/14#issuecomment-1"
    }
  });

  assert.equal(event.payload.kind, "issue_comment");
  assert.equal(event.payload.summary, "GitHub comment created on PR #14: Clarify auth behavior");
});
