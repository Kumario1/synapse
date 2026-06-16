import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";

export interface ConnectionRecord {
  id: string;
  userId: string;
  label: string;
  serverUrl: string;
  repoId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionInput {
  label: string;
  serverUrl: string;
  repoId: string;
}

export interface ConnectionStore {
  list(userId: string): Promise<ConnectionRecord[]>;
  get(userId: string, id: string): Promise<ConnectionRecord | null>;
  create(userId: string, input: ConnectionInput): Promise<ConnectionRecord>;
  update(userId: string, id: string, input: ConnectionInput): Promise<ConnectionRecord | null>;
  delete(userId: string, id: string): Promise<boolean>;
}

export class InMemoryConnectionStore implements ConnectionStore {
  private readonly rows = new Map<string, ConnectionRecord>();

  async list(userId: string): Promise<ConnectionRecord[]> {
    return Array.from(this.rows.values())
      .filter((row) => row.userId === userId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  async get(userId: string, id: string): Promise<ConnectionRecord | null> {
    const row = this.rows.get(id);
    return row?.userId === userId ? row : null;
  }

  async create(userId: string, input: ConnectionInput): Promise<ConnectionRecord> {
    const now = new Date().toISOString();
    const row: ConnectionRecord = {
      id: randomUUID(),
      userId,
      label: input.label,
      serverUrl: input.serverUrl,
      repoId: input.repoId,
      createdAt: now,
      updatedAt: now
    };
    this.rows.set(row.id, row);
    return row;
  }

  async update(userId: string, id: string, input: ConnectionInput): Promise<ConnectionRecord | null> {
    const current = await this.get(userId, id);
    if (!current) {
      return null;
    }
    const row: ConnectionRecord = {
      ...current,
      label: input.label,
      serverUrl: input.serverUrl,
      repoId: input.repoId,
      updatedAt: new Date().toISOString()
    };
    this.rows.set(id, row);
    return row;
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const current = await this.get(userId, id);
    if (!current) {
      return false;
    }
    return this.rows.delete(id);
  }
}

interface NeonRow {
  id: string;
  user_id: string;
  label: string;
  server_url: string;
  repo_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

type NeonSql = ReturnType<typeof neon>;

export class NeonConnectionStore implements ConnectionStore {
  private readonly sql: NeonSql;
  private initPromise: Promise<void> | null = null;

  constructor(databaseUrl: string, sql?: NeonSql) {
    this.sql = sql ?? createNeonSql(databaseUrl);
  }

  async list(userId: string): Promise<ConnectionRecord[]> {
    await this.init();
    const rows = (await this.sql`
      SELECT id, user_id, label, server_url, repo_id, created_at, updated_at
      FROM connections
      WHERE user_id = ${userId}
      ORDER BY updated_at DESC
    `) as NeonRow[];
    return rows.map(toConnectionRecord);
  }

  async get(userId: string, id: string): Promise<ConnectionRecord | null> {
    await this.init();
    const rows = (await this.sql`
      SELECT id, user_id, label, server_url, repo_id, created_at, updated_at
      FROM connections
      WHERE user_id = ${userId} AND id = ${id}
      LIMIT 1
    `) as NeonRow[];
    return rows[0] ? toConnectionRecord(rows[0]) : null;
  }

  async create(userId: string, input: ConnectionInput): Promise<ConnectionRecord> {
    await this.init();
    const rows = (await this.sql`
      INSERT INTO connections (id, user_id, label, server_url, repo_id)
      VALUES (${randomUUID()}, ${userId}, ${input.label}, ${input.serverUrl}, ${input.repoId})
      RETURNING id, user_id, label, server_url, repo_id, created_at, updated_at
    `) as NeonRow[];
    return toConnectionRecord(rows[0]);
  }

  async update(userId: string, id: string, input: ConnectionInput): Promise<ConnectionRecord | null> {
    await this.init();
    const rows = (await this.sql`
      UPDATE connections
      SET label = ${input.label},
          server_url = ${input.serverUrl},
          repo_id = ${input.repoId},
          updated_at = now()
      WHERE user_id = ${userId} AND id = ${id}
      RETURNING id, user_id, label, server_url, repo_id, created_at, updated_at
    `) as NeonRow[];
    return rows[0] ? toConnectionRecord(rows[0]) : null;
  }

  async delete(userId: string, id: string): Promise<boolean> {
    await this.init();
    const rows = (await this.sql`
      DELETE FROM connections
      WHERE user_id = ${userId} AND id = ${id}
      RETURNING id
    `) as { id: string }[];
    return rows.length > 0;
  }

  private init(): Promise<void> {
    this.initPromise ??= this.createSchema();
    return this.initPromise;
  }

  private async createSchema(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        label TEXT NOT NULL,
        server_url TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS connections_user_id_idx ON connections (user_id)`;
  }
}

let singleton: ConnectionStore | null = null;

export function getConnectionStore(): ConnectionStore {
  if (!singleton) {
    singleton = process.env.DATABASE_URL
      ? new NeonConnectionStore(process.env.DATABASE_URL)
      : new InMemoryConnectionStore();
  }
  return singleton;
}

function createNeonSql(databaseUrl: string): NeonSql {
  return neon(databaseUrl);
}

function toConnectionRecord(row: NeonRow): ConnectionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    serverUrl: row.server_url,
    repoId: row.repo_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
