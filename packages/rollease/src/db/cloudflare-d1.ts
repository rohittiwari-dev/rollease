// ============================================================================
// Rollease SDK — Cloudflare D1 Adapter
// ----------------------------------------------------------------------------
// DbAdapter for Cloudflare D1 (SQLite at the edge). Builds a RepositorySet
// on top of a D1Database binding, so it inherits all flag/rule/segment/
// release logic from `RepositoryDbAdapter` and only owns the SQL transport.
//
// Usage (worker.ts):
//
//   import { createD1Adapter } from "rollease/db/cloudflare-d1"
//   import { createRollease } from "rollease"
//
//   export default {
//     async fetch(req: Request, env: Env) {
//       const rl = createRollease({
//         db: createD1Adapter(env.DB),
//         secret: env.ROLLEASE_SECRET,
//       })
//       return rl.createHandler()(req)
//     },
//   }
// ============================================================================

import {
  RepositoryDbAdapter,
  type RepositorySet,
  type RowRepository,
  type RepositoryFindManyOptions,
  type AnyRepositoryName,
} from "./repository";

// ── D1 Binding Surface ───────────────────────────────────────────────────────

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown>(): Promise<T[]>;
}

export interface D1Result<T = unknown> {
  results?: T[];
  success?: boolean;
  meta?: Record<string, unknown>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  exec?(query: string): Promise<unknown>;
  batch?(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

// ── Schema ───────────────────────────────────────────────────────────────────

/**
 * Idempotent DDL for every Rollease table. Run once before first use, e.g.
 * via `wrangler d1 execute <DB_NAME> --file=schema.sql` or by passing this
 * string to `db.exec()` at worker boot.
 *
 * JSON-valued columns store stringified JSON; dates store ISO-8601 strings.
 */
export const ROLLEASE_D1_SCHEMA = `
CREATE TABLE IF NOT EXISTS rl_flag (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  defaultValue TEXT,
  description TEXT,
  namespace TEXT,
  tags TEXT,
  locked INTEGER DEFAULT 0,
  lockedReason TEXT,
  environments TEXT,
  variants TEXT,
  rollout TEXT,
  scheduledAt TEXT,
  expiresAt TEXT,
  prerequisites TEXT,
  environmentDefaults TEXT,
  exclusionLayer TEXT,
  clientVisible INTEGER DEFAULT 0,
  lastEvaluatedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rl_flag_namespace ON rl_flag(namespace);
CREATE INDEX IF NOT EXISTS idx_rl_flag_status ON rl_flag(status);

CREATE TABLE IF NOT EXISTS rl_rule (
  id TEXT PRIMARY KEY,
  flagKey TEXT NOT NULL,
  name TEXT,
  priority INTEGER NOT NULL,
  value TEXT,
  conditions TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  rolloutPct REAL,
  isHoldout INTEGER DEFAULT 0,
  variantId TEXT,
  userIds TEXT,
  description TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_rl_rule_flagKey ON rl_rule(flagKey);

CREATE TABLE IF NOT EXISTS rl_segment (
  key TEXT PRIMARY KEY,
  description TEXT,
  rules TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rl_release (
  id TEXT PRIMARY KEY,
  name TEXT,
  description TEXT,
  environment TEXT,
  status TEXT,
  changes TEXT NOT NULL,
  snapshots TEXT,
  scheduledAt TEXT,
  deployedAt TEXT,
  deployedBy TEXT,
  rolledBackAt TEXT,
  rolledBackBy TEXT,
  rollbackReason TEXT,
  requiresApproval INTEGER DEFAULT 0,
  requiredApprovers TEXT,
  approvalStatus TEXT,
  approvals TEXT,
  rejectionReason TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rl_release_status ON rl_release(status);

CREATE TABLE IF NOT EXISTS rl_assignment (
  flagKey TEXT NOT NULL,
  userId TEXT NOT NULL,
  variantKey TEXT NOT NULL,
  PRIMARY KEY (flagKey, userId)
);
CREATE INDEX IF NOT EXISTS idx_rl_assignment_userId ON rl_assignment(userId);

CREATE TABLE IF NOT EXISTS rl_history (
  id TEXT PRIMARY KEY,
  flagKey TEXT NOT NULL,
  action TEXT NOT NULL,
  by TEXT,
  at TEXT NOT NULL,
  changes TEXT,
  reason TEXT,
  releaseId TEXT
);
CREATE INDEX IF NOT EXISTS idx_rl_history_flagKey ON rl_history(flagKey);
CREATE INDEX IF NOT EXISTS idx_rl_history_at ON rl_history(at);

CREATE TABLE IF NOT EXISTS rl_impression (
  id TEXT PRIMARY KEY,
  flagKey TEXT NOT NULL,
  userId TEXT NOT NULL,
  value TEXT,
  variant TEXT,
  reason TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rl_impression_userId ON rl_impression(userId);
CREATE INDEX IF NOT EXISTS idx_rl_impression_at ON rl_impression(at);

CREATE TABLE IF NOT EXISTS rl_exclusion_layer (
  key TEXT PRIMARY KEY,
  description TEXT,
  flagKeys TEXT NOT NULL,
  allocations TEXT NOT NULL
);
`;

// ── Table descriptors ────────────────────────────────────────────────────────

interface TableDescriptor {
  table: string;
  columns: string[];
  jsonColumns: Set<string>;
  boolColumns: Set<string>;
  dateColumns: Set<string>;
}

const TABLES: Record<AnyRepositoryName, TableDescriptor> = {
  Flag: {
    table: "rl_flag",
    columns: [
      "id", "key", "type", "status", "defaultValue", "description", "namespace",
      "tags", "locked", "lockedReason", "environments", "variants", "rollout",
      "scheduledAt", "expiresAt", "prerequisites", "environmentDefaults",
      "exclusionLayer", "clientVisible", "lastEvaluatedAt", "createdAt", "updatedAt",
    ],
    jsonColumns: new Set([
      "defaultValue", "tags", "environments", "variants", "rollout",
      "prerequisites", "environmentDefaults",
    ]),
    boolColumns: new Set(["locked", "clientVisible"]),
    dateColumns: new Set(["scheduledAt", "expiresAt", "lastEvaluatedAt", "createdAt", "updatedAt"]),
  },
  Rule: {
    table: "rl_rule",
    columns: [
      "id", "flagKey", "name", "priority", "value", "conditions", "enabled",
      "rolloutPct", "isHoldout", "variantId", "userIds", "description", "metadata",
    ],
    jsonColumns: new Set(["value", "conditions", "userIds", "metadata"]),
    boolColumns: new Set(["enabled", "isHoldout"]),
    dateColumns: new Set(),
  },
  Segment: {
    table: "rl_segment",
    columns: ["key", "description", "rules", "createdAt", "updatedAt"],
    jsonColumns: new Set(["rules"]),
    boolColumns: new Set(),
    dateColumns: new Set(["createdAt", "updatedAt"]),
  },
  Release: {
    table: "rl_release",
    columns: [
      "id", "name", "description", "environment", "status", "changes", "snapshots",
      "scheduledAt", "deployedAt", "deployedBy", "rolledBackAt", "rolledBackBy",
      "rollbackReason", "requiresApproval", "requiredApprovers", "approvalStatus",
      "approvals", "rejectionReason", "createdAt",
    ],
    jsonColumns: new Set([
      "changes", "snapshots", "requiredApprovers", "approvals",
    ]),
    boolColumns: new Set(["requiresApproval"]),
    dateColumns: new Set(["scheduledAt", "deployedAt", "rolledBackAt", "createdAt"]),
  },
  Assignment: {
    table: "rl_assignment",
    columns: ["flagKey", "userId", "variantKey"],
    jsonColumns: new Set(),
    boolColumns: new Set(),
    dateColumns: new Set(),
  },
  History: {
    table: "rl_history",
    columns: ["id", "flagKey", "action", "by", "at", "changes", "reason", "releaseId"],
    jsonColumns: new Set(["by", "changes"]),
    boolColumns: new Set(),
    dateColumns: new Set(["at"]),
  },
  Impression: {
    table: "rl_impression",
    columns: ["id", "flagKey", "userId", "value", "variant", "reason", "at"],
    jsonColumns: new Set(["value"]),
    boolColumns: new Set(),
    dateColumns: new Set(["at"]),
  },
  ExclusionLayer: {
    table: "rl_exclusion_layer",
    columns: ["key", "description", "flagKeys", "allocations"],
    jsonColumns: new Set(["flagKeys", "allocations"]),
    boolColumns: new Set(),
    dateColumns: new Set(),
  },
};

// ── Row marshaling ───────────────────────────────────────────────────────────

function serializeForDB(value: unknown, descriptor: TableDescriptor, column: string): unknown {
  if (value === undefined || value === null) return null;
  if (descriptor.boolColumns.has(column)) {
    return value ? 1 : 0;
  }
  if (descriptor.dateColumns.has(column)) {
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }
  if (descriptor.jsonColumns.has(column)) {
    return JSON.stringify(value);
  }
  // SQLite doesn't accept arbitrary objects — stringify defensively.
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function deserializeFromDB(
  row: Record<string, unknown>,
  descriptor: TableDescriptor
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of descriptor.columns) {
    let value = row[col];
    if (value === undefined) continue;
    if (value === null) {
      out[col] = null;
      continue;
    }
    if (descriptor.boolColumns.has(col)) {
      out[col] = value === 1 || value === true || value === "1";
      continue;
    }
    if (descriptor.dateColumns.has(col)) {
      out[col] = new Date(value as string);
      continue;
    }
    if (descriptor.jsonColumns.has(col)) {
      try {
        out[col] = typeof value === "string" ? JSON.parse(value) : value;
      } catch {
        out[col] = value;
      }
      continue;
    }
    out[col] = value;
  }
  return out;
}

// ── D1 RowRepository ─────────────────────────────────────────────────────────

class D1Repository implements RowRepository {
  constructor(private db: D1Database, private descriptor: TableDescriptor) {}

  private buildWhere(
    where: Record<string, unknown>,
    opts: { requireMatch?: boolean } = {}
  ): { sql: string; params: unknown[] } {
    const keys = Object.keys(where);
    if (keys.length === 0) return { sql: "", params: [] };
    const clauses: string[] = [];
    const params: unknown[] = [];
    const unknownCols: string[] = [];
    for (const k of keys) {
      if (!this.descriptor.columns.includes(k)) {
        unknownCols.push(k);
        continue;
      }
      const v = where[k];
      if (v === null) {
        clauses.push(`"${k}" IS NULL`);
      } else {
        clauses.push(`"${k}" = ?`);
        params.push(serializeForDB(v, this.descriptor, k));
      }
    }
    // Guard: when callers ask for a filtered operation but every where key
    // was unknown, refuse rather than silently turning UPDATE/DELETE into a
    // table-wide operation. Better to throw than to nuke a table.
    if (opts.requireMatch && clauses.length === 0) {
      throw new Error(
        `D1 ${this.descriptor.table}: refusing to run unfiltered write — none of [${unknownCols.join(", ")}] match table columns`
      );
    }
    return clauses.length ? { sql: ` WHERE ${clauses.join(" AND ")}`, params } : { sql: "", params };
  }

  async create(values: Record<string, unknown>): Promise<unknown> {
    const cols: string[] = [];
    const placeholders: string[] = [];
    const params: unknown[] = [];
    for (const col of this.descriptor.columns) {
      if (!(col in values)) continue;
      cols.push(`"${col}"`);
      placeholders.push("?");
      params.push(serializeForDB(values[col], this.descriptor, col));
    }
    const sql = `INSERT INTO "${this.descriptor.table}" (${cols.join(",")}) VALUES (${placeholders.join(",")})`;
    await this.db.prepare(sql).bind(...params).run();
    return values;
  }

  async findOne(where: Record<string, unknown>): Promise<unknown | null> {
    const { sql, params } = this.buildWhere(where);
    const query = `SELECT * FROM "${this.descriptor.table}"${sql} LIMIT 1`;
    const row = await this.db.prepare(query).bind(...params).first<Record<string, unknown>>();
    return row ? deserializeFromDB(row, this.descriptor) : null;
  }

  async findMany(options?: RepositoryFindManyOptions): Promise<unknown[]> {
    const { sql, params } = this.buildWhere(options?.where ?? {});
    let orderBy = "";
    if (options?.orderBy?.length) {
      orderBy =
        " ORDER BY " +
        options.orderBy
          .filter((o) => this.descriptor.columns.includes(o.field))
          .map((o) => `"${o.field}" ${o.direction === "desc" ? "DESC" : "ASC"}`)
          .join(",");
    }
    const query = `SELECT * FROM "${this.descriptor.table}"${sql}${orderBy}`;
    const res = await this.db.prepare(query).bind(...params).all<Record<string, unknown>>();
    const rows = res.results ?? [];
    return rows.map((r) => deserializeFromDB(r, this.descriptor));
  }

  async update(
    where: Record<string, unknown>,
    values: Record<string, unknown>
  ): Promise<unknown | null | void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const col of this.descriptor.columns) {
      if (!(col in values)) continue;
      sets.push(`"${col}" = ?`);
      params.push(serializeForDB(values[col], this.descriptor, col));
    }
    if (sets.length === 0) return null;
    const { sql, params: whereParams } = this.buildWhere(where, { requireMatch: true });
    const query = `UPDATE "${this.descriptor.table}" SET ${sets.join(",")}${sql}`;
    await this.db.prepare(query).bind(...params, ...whereParams).run();
    return null;
  }

  async delete(where: Record<string, unknown>): Promise<void> {
    await this.deleteMany(where);
  }

  async deleteMany(where: Record<string, unknown>): Promise<void> {
    const { sql, params } = this.buildWhere(where, { requireMatch: true });
    const query = `DELETE FROM "${this.descriptor.table}"${sql}`;
    await this.db.prepare(query).bind(...params).run();
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export interface D1AdapterOptions {
  /** When true, applies ROLLEASE_D1_SCHEMA at construction. Default: false. */
  applySchemaOnInit?: boolean;
}

export class CloudflareD1Adapter extends RepositoryDbAdapter {
  private d1: D1Database;

  constructor(db: D1Database, opts: D1AdapterOptions = {}) {
    const repos: RepositorySet = {
      Flag: new D1Repository(db, TABLES.Flag),
      Rule: new D1Repository(db, TABLES.Rule),
      Segment: new D1Repository(db, TABLES.Segment),
      Release: new D1Repository(db, TABLES.Release),
      Assignment: new D1Repository(db, TABLES.Assignment),
      History: new D1Repository(db, TABLES.History),
      Impression: new D1Repository(db, TABLES.Impression),
      ExclusionLayer: new D1Repository(db, TABLES.ExclusionLayer),
    };
    super(repos);
    this.d1 = db;
    if (opts.applySchemaOnInit) {
      // Fire and forget — caller should `await applySchema(db)` for guarantees.
      this.applySchema().catch(() => void 0);
    }
  }

  /** Apply ROLLEASE_D1_SCHEMA via a sequence of prepared statements. */
  async applySchema(): Promise<void> {
    if (this.d1.exec) {
      await this.d1.exec(ROLLEASE_D1_SCHEMA);
      return;
    }
    const statements = ROLLEASE_D1_SCHEMA
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await this.d1.prepare(stmt).run();
    }
  }

  /**
   * D1's batch API requires statements to be collected up-front, which
   * doesn't map cleanly onto the `fn(tx)` contract.  We expose `transaction`
   * for adapter-shape compatibility but fall through to sequential writes —
   * documented so consumers know D1 lacks rollback for cross-statement
   * failures performed via this code path.
   */
  async transaction<T>(
    fn: (tx: import("./adapter").DbAdapter) => Promise<T>
  ): Promise<T> {
    return fn(this);
  }
}

export function createD1Adapter(
  db: D1Database,
  opts: D1AdapterOptions = {}
): CloudflareD1Adapter {
  return new CloudflareD1Adapter(db, opts);
}
