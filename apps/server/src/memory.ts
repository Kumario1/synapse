import { createLogger, type RecallMatch, type SynapseWhySourceKind } from "@synapse/protocol";
import type { Pool } from "pg";
import type { EmbeddingProvider } from "./embeddings.js";

const log = createLogger("synapse-memory");

/**
 * RAG memory (plan C1/C2): durable vector index over the narrative artifacts —
 * session summaries, contract resolutions, repo events — on the M8 Postgres
 * via pgvector. Indexing is fire-and-forget on the same serialized-queue
 * pattern as the store: a failed embed or insert logs and never breaks the
 * mutation that triggered it. `recall` answers the daemon's hybrid `why`:
 * embed the question, cosine top-k over the repo's memories.
 *
 * Strictly additive to the deterministic `why` floor: without an embedding
 * provider, without Postgres, or without the pgvector extension, the instance
 * reports `degraded: true` and the floor answers alone.
 */
export interface MemoryEntry {
  id: string;
  kind: SynapseWhySourceKind;
  title: string;
  summary: string;
  reference?: string;
  createdAt: string;
}

export class VectorMemory {
  private pool!: Pool;
  private queue: Promise<void> = Promise.resolve();
  private available = false;

  constructor(
    private readonly databaseUrl: string,
    private readonly provider: EmbeddingProvider
  ) {}

  /** Connect and create the extension + table. Failure → degraded, not fatal. */
  async init(): Promise<void> {
    try {
      const { default: pg } = await import("pg");
      this.pool = new pg.Pool({ connectionString: this.databaseUrl });
      const client = await this.pool.connect();
      try {
        // Same advisory-lock discipline as the store: concurrent instance
        // boots must not race the DDL (M9 lesson).
        await client.query("SELECT pg_advisory_lock(727269784)"); // 'synapse'+1
        await client.query("CREATE EXTENSION IF NOT EXISTS vector");
        await client.query(
          `CREATE TABLE IF NOT EXISTS synapse_memory (
             repo_id TEXT NOT NULL,
             id TEXT NOT NULL,
             kind TEXT NOT NULL,
             title TEXT NOT NULL,
             summary TEXT NOT NULL,
             reference TEXT,
             created_at TEXT NOT NULL,
             embedding vector(${this.provider.dim}) NOT NULL,
             PRIMARY KEY (repo_id, id)
           )`
        );
        await client.query("SELECT pg_advisory_unlock(727269784)");
      } finally {
        client.release();
      }
      this.available = true;
      log.info("memory.ready", { dim: this.provider.dim, model: this.provider.model });
    } catch (error) {
      this.available = false;
      log.warn("memory.degraded", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  degraded(): boolean {
    return !this.available;
  }

  /** Embed and upsert one memory; fire-and-forget, ordered, never throws. */
  index(repoId: string, entry: MemoryEntry): void {
    if (!this.available) {
      return;
    }
    this.queue = this.queue.then(async () => {
      try {
        const [embedding] = await this.provider.embed([`${entry.title}\n${entry.summary}`]);
        await this.pool.query(
          `INSERT INTO synapse_memory (repo_id, id, kind, title, summary, reference, created_at, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (repo_id, id) DO UPDATE SET
             kind = excluded.kind, title = excluded.title, summary = excluded.summary,
             reference = excluded.reference, created_at = excluded.created_at,
             embedding = excluded.embedding`,
          [
            repoId,
            entry.id,
            entry.kind,
            entry.title,
            entry.summary,
            entry.reference ?? null,
            entry.createdAt,
            vectorLiteral(embedding)
          ]
        );
        log.debug("memory.indexed", { repoId, id: entry.id, kind: entry.kind });
      } catch (error) {
        log.warn("memory.index_failed", {
          repoId,
          id: entry.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }

  /** Resolves when every index() issued so far has been applied (tests). */
  flush(): Promise<void> {
    return this.queue;
  }

  async recall(repoId: string, query: string, limit: number): Promise<RecallMatch[]> {
    if (!this.available) {
      return [];
    }
    const [embedding] = await this.provider.embed([query]);
    const result = await this.pool.query(
      `SELECT kind, title, summary, reference, created_at,
              1 - (embedding <=> $2) AS score
       FROM synapse_memory
       WHERE repo_id = $1
       ORDER BY embedding <=> $2
       LIMIT $3`,
      [repoId, vectorLiteral(embedding), limit]
    );
    return result.rows.map(
      (row: {
        kind: SynapseWhySourceKind;
        title: string;
        summary: string;
        reference: string | null;
        created_at: string;
        score: number;
      }) => ({
        kind: row.kind,
        title: row.title,
        summary: row.summary,
        ...(row.reference ? { reference: row.reference } : {}),
        createdAt: row.created_at,
        score: Number(row.score)
      })
    );
  }

  async close(): Promise<void> {
    await this.flush();
    if (this.pool) {
      await this.pool.end();
    }
  }
}

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
