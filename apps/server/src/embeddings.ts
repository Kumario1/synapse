import { createLogger } from "@synapse/protocol";

const log = createLogger("synapse-embeddings");

/**
 * Optional embedding provider for RAG memory (plan C1/C2), mirroring the
 * resolver's optional-provider seam: configuration only, fully absent unless
 * enabled, and any failure degrades recall instead of breaking the server.
 *
 * Any OpenAI-compatible `/embeddings` endpoint works:
 *   SYNAPSE_EMBED_BASE_URL   required; e.g. https://api.openai.com/v1 or a
 *                            local server — nothing is sent anywhere unless
 *                            this is explicitly set
 *   SYNAPSE_EMBED_API_KEY    bearer key if the endpoint needs one
 *   SYNAPSE_EMBED_MODEL      model name (default text-embedding-3-small)
 *   SYNAPSE_EMBED_DIM        vector width (default 1536; must match the model)
 *   SYNAPSE_RAG=0            force-disable even when configured
 *
 * Privacy note: what leaves the server is what gets embedded — session
 * summaries, resolution rationales, and repo-event titles. Never raw code.
 */
export interface EmbeddingProvider {
  dim: number;
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export function createEmbeddingProvider(): EmbeddingProvider | null {
  const baseUrl = process.env.SYNAPSE_EMBED_BASE_URL;
  if (!baseUrl || process.env.SYNAPSE_RAG === "0") {
    return null;
  }

  const apiKey = process.env.SYNAPSE_EMBED_API_KEY ?? "";
  const model = process.env.SYNAPSE_EMBED_MODEL ?? "text-embedding-3-small";
  const dim = Number(process.env.SYNAPSE_EMBED_DIM ?? 1536);
  const timeoutMs = Number(process.env.SYNAPSE_EMBED_TIMEOUT_MS ?? 8000);

  return {
    dim,
    model,
    async embed(texts: string[]): Promise<number[][]> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${baseUrl.replace(/\/$/u, "")}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
          },
          body: JSON.stringify({ model, input: texts }),
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(`embeddings endpoint answered ${response.status}`);
        }
        const payload = (await response.json()) as { data?: { embedding?: number[] }[] };
        const vectors = (payload.data ?? []).map((entry) => entry.embedding ?? []);
        if (vectors.length !== texts.length || vectors.some((v) => v.length !== dim)) {
          throw new Error(
            `embeddings endpoint returned ${vectors.length} vectors (expected ${texts.length}) of width ${vectors[0]?.length ?? 0} (expected ${dim})`
          );
        }
        return vectors;
      } catch (error) {
        log.warn("embed.failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
