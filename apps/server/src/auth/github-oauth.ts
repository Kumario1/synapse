/**
 * GitHub user-to-server OAuth, hand-rolled per docs/adr/0001 (no hosted auth
 * provider). Every network call takes an injectable `fetchFn` so the route
 * tests stay hermetic — they never hit GitHub.
 */

export interface OAuthCreds {
  clientId: string;
  clientSecret: string;
}

export interface GitHubUser {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

type FetchFn = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringAt(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/** Authorize URL the browser is redirected to (allow_signup so new users can join). */
export function buildAuthorizeUrl(creds: OAuthCreds, state: string, redirectUri: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}

/** Exchange the OAuth `code` for a user access token. */
export async function exchangeCodeForToken(
  creds: OAuthCreds,
  code: string,
  redirectUri: string,
  fetchFn: FetchFn = fetch
): Promise<string> {
  const response = await fetchFn("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: redirectUri
    })
  });
  if (!response.ok) {
    throw new Error(`github_token_exchange_status_${response.status}`);
  }
  const body: unknown = await response.json();
  const token = isRecord(body) ? stringAt(body, "access_token") : null;
  if (!token) {
    throw new Error("github_token_exchange_missing_access_token");
  }
  return token;
}

/** Fetch the authenticated user's GitHub profile. */
export async function fetchGitHubUser(
  accessToken: string,
  fetchFn: FetchFn = fetch
): Promise<GitHubUser> {
  const response = await fetchFn("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "synapse-server"
    }
  });
  if (!response.ok) {
    throw new Error(`github_user_status_${response.status}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || (typeof body.id !== "number" && typeof body.id !== "string")) {
    throw new Error("github_user_missing_id");
  }
  const login = stringAt(body, "login");
  if (!login) {
    throw new Error("github_user_missing_login");
  }
  return {
    id: String(body.id),
    login,
    name: stringAt(body, "name"),
    avatarUrl: stringAt(body, "avatar_url")
  };
}
