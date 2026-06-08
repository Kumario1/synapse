import type { ClientMessage } from "@synapse/protocol";

interface GitHubPushPayload {
  after?: unknown;
  repository?: { full_name?: unknown };
  pusher?: { name?: unknown };
  sender?: { login?: unknown };
  commits?: {
    added?: unknown;
    modified?: unknown;
    removed?: unknown;
    message?: unknown;
  }[];
  head_commit?: { message?: unknown };
}

export interface GitHubPushNotify {
  repoId: string;
  payload: Extract<ClientMessage, { type: "push.notify" }>["payload"];
}

/**
 * Convert a GitHub `push` webhook payload into Synapse's existing push.notify
 * message. This keeps the webhook path on the same state mutation used by the
 * local daemon's `synapse_push` command.
 */
export function gitHubPushToNotify(
  payload: unknown,
  repoIdOverride?: string | null
): GitHubPushNotify {
  if (!isRecord(payload)) {
    throw new Error("GitHub push payload must be an object.");
  }

  const push = payload as GitHubPushPayload;
  const repoId = repoIdOverride || stringAt(push.repository, "full_name") || "local";
  const sha = typeof push.after === "string" && push.after ? push.after : "unknown";
  const files = unique(filesFromCommits(push.commits));

  if (files.length === 0) {
    throw new Error("GitHub push payload did not include changed files.");
  }

  const memberId =
    stringAt(push.sender, "login") ||
    stringAt(push.pusher, "name") ||
    "github";
  const summary = summaryFor(push, files.length);

  return {
    repoId,
    payload: {
      repoId,
      memberId,
      sha,
      summary,
      files
    }
  };
}

function filesFromCommits(commits: GitHubPushPayload["commits"]): string[] {
  if (!Array.isArray(commits)) {
    return [];
  }

  return commits.flatMap((commit) => [
    ...strings(commit.added),
    ...strings(commit.modified),
    ...strings(commit.removed)
  ]);
}

function summaryFor(payload: GitHubPushPayload, fileCount: number): string {
  const message = stringAt(payload.head_commit, "message") ?? firstCommitMessage(payload.commits);
  if (message) {
    return `GitHub push: ${firstLine(message)}`;
  }

  return `GitHub push touched ${fileCount} file${fileCount === 1 ? "" : "s"}`;
}

function firstCommitMessage(commits: GitHubPushPayload["commits"]): string | null {
  if (!Array.isArray(commits)) {
    return null;
  }

  for (const commit of commits) {
    const message = typeof commit.message === "string" ? commit.message : null;
    if (message) {
      return message;
    }
  }

  return null;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u)[0] || value;
}

function stringAt(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const result = value[key];
  return typeof result === "string" && result ? result : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
