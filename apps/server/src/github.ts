import type { ClientMessage } from "@synapse/protocol";

type RepoEventPayload = Extract<ClientMessage, { type: "repo.event" }>["payload"];

interface GitHubPushPayload {
  after?: unknown;
  ref?: unknown;
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

interface GitHubPullRequestPayload {
  action?: unknown;
  repository?: { full_name?: unknown };
  sender?: { login?: unknown };
  pull_request?: {
    number?: unknown;
    title?: unknown;
    html_url?: unknown;
    merged?: unknown;
    body?: unknown;
  };
}

interface GitHubPullRequestReviewPayload {
  action?: unknown;
  repository?: { full_name?: unknown };
  sender?: { login?: unknown };
  pull_request?: {
    number?: unknown;
    title?: unknown;
    html_url?: unknown;
  };
  review?: {
    state?: unknown;
    html_url?: unknown;
    body?: unknown;
  };
}

interface GitHubIssueCommentPayload {
  action?: unknown;
  repository?: { full_name?: unknown };
  sender?: { login?: unknown };
  issue?: {
    number?: unknown;
    title?: unknown;
    html_url?: unknown;
    pull_request?: unknown;
  };
  comment?: {
    html_url?: unknown;
    body?: unknown;
  };
}

export interface GitHubPushNotify {
  repoId: string;
  payload: Extract<ClientMessage, { type: "push.notify" }>["payload"];
}

export interface GitHubRepoEventNotify {
  repoId: string;
  payload: RepoEventPayload;
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
  const branch = branchFromRef(push.ref);

  return {
    repoId,
    payload: {
      repoId,
      memberId,
      sha,
      summary,
      files,
      ...(branch ? { branch } : {})
    }
  };
}

/** `refs/heads/main` → `main`; tags and anything else stay unknown. */
function branchFromRef(ref: unknown): string | undefined {
  if (typeof ref !== "string") {
    return undefined;
  }

  const match = /^refs\/heads\/(.+)$/u.exec(ref);
  return match ? match[1] : undefined;
}

export function gitHubRepoEventToNotify(
  event: string,
  payload: unknown,
  repoIdOverride?: string | null
): GitHubRepoEventNotify {
  switch (event) {
    case "pull_request":
      return pullRequestToNotify(payload, repoIdOverride);
    case "pull_request_review":
      return pullRequestReviewToNotify(payload, repoIdOverride);
    case "issue_comment":
      return issueCommentToNotify(payload, repoIdOverride);
    default:
      throw new Error(`Unsupported GitHub repo event: ${event}.`);
  }
}

/**
 * Distill body prose for storage and embedding (plan C3 slice): strip code
 * (the privacy boundary — code never leaves as prose), strip markdown
 * link/image URLs, collapse whitespace, cap at a word boundary, and drop
 * content-free noise ("+1", "LGTM"). Returns undefined when nothing of
 * substance remains, so absent bodies stay absent (never "").
 */
export function distillProse(body: unknown, maxChars = 500): string | undefined {
  if (typeof body !== "string" || body.trim() === "") {
    return undefined;
  }

  let text = body;
  text = text.replace(/```[\s\S]*?```/gu, " [code omitted] ");
  text = text.replace(/~~~[\s\S]*?~~~/gu, " [code omitted] ");
  text = text.replace(/`[^`\n]*`/gu, " [code omitted] ");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1");
  text = text.replace(/https?:\/\/\S+/gu, "");
  text = text.replace(/\s+/gu, " ").trim();

  const meaningful = text.replace(/\[code omitted\]/gu, "").trim();
  if (meaningful.length < 12) {
    return undefined;
  }

  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(" ");
    text = `${cut.slice(0, lastSpace > 0 ? lastSpace : maxChars).trimEnd()}\u2026`;
  }

  return text;
}

/** Spread helper: include `detail` only when there is distilled prose (absent, never undefined). */
function detailField(detail: string | undefined): { detail?: string } {
  return detail !== undefined ? { detail } : {};
}

function pullRequestToNotify(
  payload: unknown,
  repoIdOverride?: string | null
): GitHubRepoEventNotify {
  if (!isRecord(payload)) {
    throw new Error("GitHub pull_request payload must be an object.");
  }

  const pr = payload as GitHubPullRequestPayload;
  const repoId = repoIdOverride || stringAt(pr.repository, "full_name") || "local";
  const action = stringValue(pr.action) ?? "unknown";
  const actor = stringAt(pr.sender, "login") ?? "github";
  const number = numberAt(pr.pull_request, "number");
  const title = stringAt(pr.pull_request, "title") ?? "untitled pull request";
  const url = stringAt(pr.pull_request, "html_url") ?? undefined;
  const normalizedAction =
    action === "closed" && booleanAt(pr.pull_request, "merged") === true ? "merged" : action;

  return {
    repoId,
    payload: {
      repoId,
      kind: "pull_request",
      action: normalizedAction,
      actor,
      title,
      number,
      url,
      summary: `GitHub PR #${number ?? "?"} ${normalizedAction}: ${title}`,
      ...detailField(
        normalizedAction === "opened" || normalizedAction === "merged"
          ? distillProse(pr.pull_request?.body)
          : undefined
      )
    }
  };
}

function pullRequestReviewToNotify(
  payload: unknown,
  repoIdOverride?: string | null
): GitHubRepoEventNotify {
  if (!isRecord(payload)) {
    throw new Error("GitHub pull_request_review payload must be an object.");
  }

  const review = payload as GitHubPullRequestReviewPayload;
  const repoId = repoIdOverride || stringAt(review.repository, "full_name") || "local";
  const action = stringValue(review.action) ?? "unknown";
  const actor = stringAt(review.sender, "login") ?? "github";
  const number = numberAt(review.pull_request, "number");
  const title = stringAt(review.pull_request, "title") ?? "untitled pull request";
  const state = stringAt(review.review, "state") ?? action;
  const url =
    stringAt(review.review, "html_url") ?? stringAt(review.pull_request, "html_url") ?? undefined;

  return {
    repoId,
    payload: {
      repoId,
      kind: "pull_request_review",
      action: state,
      actor,
      title,
      number,
      url,
      summary: `GitHub review ${state} on PR #${number ?? "?"}: ${title}`,
      ...detailField(distillProse(review.review?.body))
    }
  };
}

function issueCommentToNotify(
  payload: unknown,
  repoIdOverride?: string | null
): GitHubRepoEventNotify {
  if (!isRecord(payload)) {
    throw new Error("GitHub issue_comment payload must be an object.");
  }

  const comment = payload as GitHubIssueCommentPayload;
  const repoId = repoIdOverride || stringAt(comment.repository, "full_name") || "local";
  const action = stringValue(comment.action) ?? "unknown";
  const actor = stringAt(comment.sender, "login") ?? "github";
  const number = numberAt(comment.issue, "number");
  const title = stringAt(comment.issue, "title") ?? "untitled thread";
  const isPr = isRecord(comment.issue) && isRecord(comment.issue.pull_request);
  const subject = isPr ? "PR" : "issue";
  const url = stringAt(comment.comment, "html_url") ?? stringAt(comment.issue, "html_url") ?? undefined;

  return {
    repoId,
    payload: {
      repoId,
      kind: "issue_comment",
      action,
      actor,
      title,
      number,
      url,
      summary: `GitHub comment ${action} on ${subject} #${number ?? "?"}: ${title}`,
      ...detailField(distillProse(comment.comment?.body))
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberAt(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const result = value[key];
  return typeof result === "number" && Number.isFinite(result) ? result : undefined;
}

function booleanAt(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const result = value[key];
  return typeof result === "boolean" ? result : undefined;
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
