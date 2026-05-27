// ============================================================================
// Rollease SDK - Drizzle Database Adapter
// ============================================================================

import { ValidationError } from "../core/errors";
import {
  RepositoryDbAdapter,
  ROLLEASE_OPTIONAL_REPOSITORY_NAMES,
  ROLLEASE_REPOSITORY_NAMES,
  ROLLEASE_REPOSITORY_REQUIRED_COLUMNS,
  type AnyRepositoryName,
  type RepositoryFindManyOptions,
  type RepositoryName,
  type RepositorySet,
  type RowRepository,
} from "./repository";

export type DrizzleAdapterModelName = AnyRepositoryName;
export type DrizzleTableLike = Record<string | symbol, unknown>;
export type DrizzleTableMap = Partial<Record<DrizzleAdapterModelName, DrizzleTableLike>>;

export interface DrizzleHelpers {
  eq(column: unknown, value: unknown): unknown;
  and(...conditions: unknown[]): unknown;
  asc(column: unknown): unknown;
  desc(column: unknown): unknown;
}

export interface DrizzleDbLike {
  select(): { from(table: unknown): DrizzleSelectQueryLike };
  insert(table: unknown): { values(values: Record<string, unknown>): DrizzleMutationLike };
  update(table: unknown): {
    set(values: Record<string, unknown>): DrizzleMutationLike;
  };
  delete(table: unknown): DrizzleDeleteLike;
}

export interface DrizzleSelectQueryLike extends PromiseLike<unknown[]> {
  where?(condition: unknown): DrizzleSelectQueryLike;
  orderBy?(...orders: unknown[]): DrizzleSelectQueryLike;
  limit?(count: number): DrizzleSelectQueryLike;
}

export interface DrizzleMutationLike extends PromiseLike<unknown> {
  where?(condition: unknown): DrizzleMutationLike;
  returning?(): Promise<unknown[]>;
}

export interface DrizzleDeleteLike extends PromiseLike<unknown> {
  where?(condition: unknown): DrizzleDeleteLike;
  returning?(): Promise<unknown[]>;
}

export interface DrizzleAdapterOptions {
  /** Drizzle database instance. Required unless repositories are supplied. */
  db?: DrizzleDbLike;
  /** Rollease Drizzle table objects keyed by model name. */
  tables?: DrizzleTableMap;
  /** eq/and/asc/desc helpers from drizzle-orm. Loaded dynamically if omitted. */
  helpers?: Partial<DrizzleHelpers>;
  /** Validate table objects expose every Rollease column. Defaults to true. */
  validateTables?: boolean;
  /** Advanced escape hatch for custom Drizzle repositories or non-standard drivers. */
  repositories?: Partial<RepositorySet>;
  /** Optional close hook called by adapter.close(). */
  close?: () => Promise<void>;
}

export const ROLLEASE_DRIZZLE_REQUIRED_COLUMNS =
  ROLLEASE_REPOSITORY_REQUIRED_COLUMNS;

export class DrizzleDbAdapter extends RepositoryDbAdapter {
  constructor(options: DrizzleAdapterOptions) {
    if (options.repositories) {
      super(options.repositories as RepositorySet, { close: options.close });
      return;
    }

    if (!options.db || !options.tables) {
      throw new ValidationError(
        "Drizzle adapter requires either repositories or both db and tables",
        {}
      );
    }

    if (options.validateTables ?? true) {
      validateDrizzleTables(options.tables);
    }

    super(createDrizzleRepositories(options.db, options.tables, options.helpers), {
      close: options.close,
    });
  }
}

export function createDrizzleAdapter(options: DrizzleAdapterOptions): DrizzleDbAdapter {
  return new DrizzleDbAdapter(options);
}

export function validateDrizzleTables(tables: DrizzleTableMap): void {
  const validate = (name: DrizzleAdapterModelName, required: boolean): void => {
    const table = tables[name];
    if (!table) {
      if (required) {
        throw new ValidationError(`Missing Drizzle table for Rollease model "${name}"`, {
          model: name,
        });
      }
      return;
    }

    const columns = getDrizzleColumnNames(table);
    const missing = ROLLEASE_DRIZZLE_REQUIRED_COLUMNS[name].filter(
      (column) => !columns.has(column)
    );
    if (missing.length > 0) {
      throw new ValidationError(
        `Drizzle table for "${name}" is missing required Rollease columns`,
        { model: name, missingColumns: missing }
      );
    }
  };

  for (const name of ROLLEASE_REPOSITORY_NAMES) validate(name, true);
  for (const name of ROLLEASE_OPTIONAL_REPOSITORY_NAMES) validate(name, false);
}

function createDrizzleRepositories(
  db: DrizzleDbLike,
  tables: DrizzleTableMap,
  helpers?: Partial<DrizzleHelpers>
): RepositorySet {
  const loadHelpers = createDrizzleHelperLoader(helpers);
  const entries: Array<[DrizzleAdapterModelName, RowRepository]> = [];

  for (const name of ROLLEASE_REPOSITORY_NAMES) {
    const table = tables[name];
    if (!table) {
      throw new ValidationError(`Missing Drizzle table for Rollease model "${name}"`, {
        model: name,
      });
    }
    entries.push([name, createDrizzleRepository(name, db, table, loadHelpers)]);
  }

  for (const name of ROLLEASE_OPTIONAL_REPOSITORY_NAMES) {
    const table = tables[name];
    if (table) {
      entries.push([name, createDrizzleRepository(name, db, table, loadHelpers)]);
    }
  }

  return Object.fromEntries(entries) as RepositorySet;
}

function createDrizzleRepository(
  name: DrizzleAdapterModelName,
  db: DrizzleDbLike,
  table: DrizzleTableLike,
  loadHelpers: () => Promise<DrizzleHelpers>
): RowRepository {
  return {
    async create(values) {
      const query = db.insert(table).values(values);
      if (typeof query.returning === "function") {
        const rows = await query.returning();
        return rows[0] ?? values;
      }
      await query;
      return values;
    },

    async findOne(where) {
      const helpers = await loadHelpers();
      let query = db.select().from(table);
      const condition = buildDrizzleCondition(table, where, helpers);
      if (condition !== undefined) {
        query = applyWhere(name, query, condition) as DrizzleSelectQueryLike;
      }
      if (typeof query.limit === "function") {
        query = query.limit(1);
      }
      const rows = await query;
      return rows[0] ?? null;
    },

    async findMany(options?: RepositoryFindManyOptions) {
      const helpers = await loadHelpers();
      let query = db.select().from(table);
      const condition = buildDrizzleCondition(table, options?.where, helpers);
      if (condition !== undefined) {
        query = applyWhere(name, query, condition) as DrizzleSelectQueryLike;
      }
      const orderBy = buildDrizzleOrderBy(table, options?.orderBy, helpers);
      if (orderBy.length > 0) {
        if (typeof query.orderBy !== "function") {
          throw new ValidationError(`Drizzle query for "${name}" cannot order rows`, {
            model: name,
          });
        }
        query = query.orderBy(...orderBy);
      }
      return query;
    },

    async update(where, values) {
      const helpers = await loadHelpers();
      let query = db.update(table).set(values);
      const condition = buildDrizzleCondition(table, where, helpers);
      if (condition !== undefined) {
        query = applyWhere(name, query, condition) as DrizzleMutationLike;
      }
      if (typeof query.returning === "function") {
        const rows = await query.returning();
        return rows[0] ?? null;
      }
      await query;
      return null;
    },

    async delete(where) {
      await deleteRows(name, db, table, where, loadHelpers);
    },

    async deleteMany(where) {
      await deleteRows(name, db, table, where, loadHelpers);
    },
  };
}

async function deleteRows(
  name: DrizzleAdapterModelName,
  db: DrizzleDbLike,
  table: DrizzleTableLike,
  where: Record<string, unknown>,
  loadHelpers: () => Promise<DrizzleHelpers>
): Promise<void> {
  const helpers = await loadHelpers();
  let query = db.delete(table);
  const condition = buildDrizzleCondition(table, where, helpers);
  if (condition !== undefined) {
    query = applyWhere(name, query, condition) as DrizzleDeleteLike;
  }
  if (typeof query.returning === "function") {
    await query.returning();
    return;
  }
  await query;
}

function buildDrizzleCondition(
  table: DrizzleTableLike,
  where: Record<string, unknown> | undefined,
  helpers: DrizzleHelpers
): unknown {
  const entries = Object.entries(where ?? {});
  if (entries.length === 0) return undefined;

  const conditions = entries.map(([field, value]) => {
    const column = table[field];
    if (!column) {
      throw new ValidationError(`Drizzle table is missing column "${field}"`, {
        column: field,
      });
    }
    return helpers.eq(column, value);
  });

  return conditions.length === 1 ? conditions[0] : helpers.and(...conditions);
}

function buildDrizzleOrderBy(
  table: DrizzleTableLike,
  orderBy: RepositoryFindManyOptions["orderBy"],
  helpers: DrizzleHelpers
): unknown[] {
  return (orderBy ?? []).map(({ field, direction }) => {
    const column = table[field];
    if (!column) {
      throw new ValidationError(`Drizzle table is missing column "${field}"`, {
        column: field,
      });
    }
    return direction === "desc" ? helpers.desc(column) : helpers.asc(column);
  });
}

function applyWhere(
  name: DrizzleAdapterModelName,
  query: { where?: (condition: unknown) => unknown },
  condition: unknown
): unknown {
  if (typeof query.where !== "function") {
    throw new ValidationError(`Drizzle query for "${name}" cannot filter rows`, {
      model: name,
    });
  }
  return query.where(condition);
}

function getDrizzleColumnNames(table: DrizzleTableLike): Set<string> {
  const names = new Set<string>();
  for (const key of Object.keys(table)) {
    names.add(key);
  }

  const columns = table[Symbol.for("drizzle:Columns")];
  if (columns && typeof columns === "object") {
    for (const key of Object.keys(columns)) {
      names.add(key);
    }
  }

  return names;
}

function createDrizzleHelperLoader(
  provided: Partial<DrizzleHelpers> = {}
): () => Promise<DrizzleHelpers> {
  let cached: Promise<DrizzleHelpers> | undefined;

  return async () => {
    cached ??= resolveDrizzleHelpers(provided);
    return cached;
  };
}

async function resolveDrizzleHelpers(
  provided: Partial<DrizzleHelpers>
): Promise<DrizzleHelpers> {
  const missing = ["eq", "and", "asc", "desc"].filter(
    (name) => typeof provided[name as keyof DrizzleHelpers] !== "function"
  );
  if (missing.length === 0) {
    return provided as DrizzleHelpers;
  }

  try {
    const moduleName = "drizzle-orm";
    const drizzle = (await import(moduleName)) as Partial<DrizzleHelpers>;
    return {
      eq: provided.eq ?? drizzle.eq!,
      and: provided.and ?? drizzle.and!,
      asc: provided.asc ?? drizzle.asc!,
      desc: provided.desc ?? drizzle.desc!,
    };
  } catch {
    throw new ValidationError(
      "Install drizzle-orm or pass Drizzle helpers: { eq, and, asc, desc }",
      { missingHelpers: missing }
    );
  }
}
