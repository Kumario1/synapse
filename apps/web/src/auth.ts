/**
 * Same-origin client for the human GitHub sign-in boundary (plan 051). These
 * calls only resolve to a signed-in Owner when the SPA is served from the
 * Synapse server's origin (hosted production); in plain `vite dev` there is no
 * proxy, so `/auth/me` 404/!2xx and the topbar shows signed-out. Acceptable.
 */

export interface Owner {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/** A repo the signed-in Owner has claimed, with its per-repo daemon credential. */
export interface Project {
  repoId: string;
  projectKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function fetchMe(): Promise<Owner | null> {
  try {
    const response = await fetch("/auth/me", { credentials: "include" });
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || !isRecord(body.owner)) {
      return null;
    }
    const owner = body.owner;
    if (typeof owner.login !== "string") {
      return null;
    }
    return {
      login: owner.login,
      name: typeof owner.name === "string" ? owner.name : null,
      avatarUrl: typeof owner.avatarUrl === "string" ? owner.avatarUrl : null
    };
  } catch {
    return null;
  }
}

export async function fetchProjects(): Promise<Project[]> {
  try {
    const response = await fetch("/auth/projects", { credentials: "include" });
    if (!response.ok) {
      return [];
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.projects)) {
      return [];
    }
    const projects: Project[] = [];
    for (const entry of body.projects) {
      if (
        isRecord(entry) &&
        typeof entry.repoId === "string" &&
        typeof entry.projectKey === "string"
      ) {
        projects.push({ repoId: entry.repoId, projectKey: entry.projectKey });
      }
    }
    return projects;
  } catch {
    return [];
  }
}

export async function signOut(): Promise<void> {
  try {
    await fetch("/auth/logout", { method: "POST", credentials: "include" });
  } catch {
    // Best-effort: the caller reloads regardless; a stale cookie just re-shows
    // signed-in until it expires.
  }
}

export type AuthView = { kind: "anon" } | { kind: "owner"; label: string };

export function authView(owner: Owner | null): AuthView {
  return owner ? { kind: "owner", label: owner.login } : { kind: "anon" };
}
