import type { RecallMatch, RecallResponse } from "@synapse/protocol";
import type { RuntimeConfig } from "./config.js";

/**
 * Ask the server's vector memory for question-relevant memories. Best-effort:
 * any error, non-OK status, or degraded recall returns [] so the
 * deterministic why floor stands alone.
 */
export async function fetchRecall(
  config: RuntimeConfig,
  query: string,
  limit?: number
): Promise<RecallMatch[]> {
  try {
    const base = config.serverUrl.replace(/^ws/u, "http");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${base}/recall`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.authToken ? { authorization: `Bearer ${config.authToken}` } : {})
      },
      body: JSON.stringify({ repoId: config.repoId, query, limit }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as RecallResponse;
    return payload.degraded ? [] : payload.matches;
  } catch {
    return [];
  }
}
