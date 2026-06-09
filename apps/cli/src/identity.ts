/**
 * Pure, side-effect-free helpers for deriving a Synapse coordination identity
 * from a git remote. Kept out of `index.ts` (which is a CLI entrypoint with a
 * top-level command switch) so tests can import it without running the CLI.
 */

/**
 * Canonical, lowercased `host/owner/repo` slug for a git remote URL. Two clones
 * of the same repository normalize to the *same* slug regardless of transport
 * (ssh vs https), credentials, port, a trailing `.git`, or casing — so they
 * agree on one coordination room with no manual configuration.
 *
 * Returns `""` for inputs we cannot or should not coordinate on (bare local
 * paths, `file://`, or anything unparseable), letting callers fall back to the
 * `"local"` default.
 */
export function normalizeRemoteUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }

  const url = parseRemote(trimmed);
  if (!url) {
    return "";
  }

  // `hostname` is already lowercased by the URL parser and never carries a port
  // or embedded credentials (those live on `port`/`username`/`password`).
  const host = url.hostname;
  if (!host) {
    return "";
  }

  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 2) {
    return ""; // need at least owner + repo to identify a repository
  }

  // Drop a trailing `.git` on the repository name (the final path segment).
  const last = segments.length - 1;
  segments[last] = segments[last].replace(/\.git$/u, "");
  if (!segments[last]) {
    return "";
  }

  return `${host}/${segments.join("/")}`.toLowerCase();
}

/**
 * Parse a git remote into a {@link URL}. scp-style remotes (`git@host:owner/repo`)
 * are not valid URLs, so they are rewritten to an `ssh://` URL first. Anything
 * that still does not parse — including bare local filesystem paths, which we
 * deliberately do not coordinate on — yields `null`.
 */
function parseRemote(raw: string): URL | null {
  let candidate = raw;

  // scp-style only when there is no explicit scheme: `[user@]host:path`.
  if (!raw.includes("://")) {
    const scp = /^([A-Za-z0-9._~+-]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/u.exec(raw);
    if (scp) {
      const user = scp[1] ?? "";
      const host = scp[2];
      const path = scp[3].replace(/^\/+/u, "");
      candidate = `ssh://${user}${host}/${path}`;
    }
  }

  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}
