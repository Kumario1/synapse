/**
 * GitHub App installation helpers for the repo-claim flow (issue #104). The
 * Owner installs the App on a repo they can push to; the setup callback uses
 * the user access token to list the installation's repositories, and only repos
 * the user can push to are claimable. Every network call takes an injectable
 * `fetchFn` so the route tests stay hermetic — they never hit GitHub.
 */

export interface ClaimedRepo {
  fullName: string;
  pushAccess: boolean;
}

type FetchFn = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringAt(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/**
 * The App install URL the Owner is redirected to. The signed `state` rides
 * through the install and is echoed back to the setup callback for CSRF.
 */
export function buildInstallUrl(appSlug: string, state: string): string {
  const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * List the repositories in `installationId` the authenticated user can access,
 * each carrying whether the user has push permission. Repos without a string
 * `full_name` are skipped; `pushAccess` defaults to false.
 */
export async function listInstallationReposForUser(
  installationId: string,
  userToken: string,
  fetchFn: FetchFn = fetch
): Promise<ClaimedRepo[]> {
  const response = await fetchFn(
    `https://api.github.com/user/installations/${installationId}/repositories`,
    {
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "synapse-server"
      }
    }
  );
  if (!response.ok) {
    throw new Error(`github_installation_repos_status_${response.status}`);
  }
  const body: unknown = await response.json();
  const repositories = isRecord(body) ? body.repositories : null;
  if (!Array.isArray(repositories)) {
    throw new Error("github_installation_repos_missing_repositories");
  }
  const claimed: ClaimedRepo[] = [];
  for (const entry of repositories) {
    if (!isRecord(entry)) {
      continue;
    }
    const fullName = stringAt(entry, "full_name");
    if (!fullName) {
      continue;
    }
    const permissions = entry.permissions;
    const pushAccess = isRecord(permissions) && permissions.push === true;
    claimed.push({ fullName, pushAccess });
  }
  return claimed;
}
