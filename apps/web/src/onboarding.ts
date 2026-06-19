import type { Project } from "./auth";

export const INSTALL_COMMAND = "npm install -g @kumario/synapse";

export function serverWsUrl(origin: string = window.location.origin): string {
  return origin.replace(/^http/, "ws"); // https→wss, http→ws
}

export function daemonCommand(project: Project, wsUrl: string = serverWsUrl()): string {
  return `SYNAPSE_PROJECT_KEY=${project.projectKey} synapse up --server ${wsUrl} --repo-id ${project.repoId}`;
}

export function isRoomConnected(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    Array.isArray((state as { sessions?: unknown }).sessions) &&
    (state as { sessions: unknown[] }).sessions.length > 0
  );
}

export async function fetchRoomConnected(project: Project): Promise<boolean> {
  try {
    const url = `/state?repoId=${encodeURIComponent(project.repoId)}&token=${encodeURIComponent(project.projectKey)}`;
    const response = await fetch(url);
    if (!response.ok) return false;
    return isRoomConnected(await response.json());
  } catch {
    return false;
  }
}
