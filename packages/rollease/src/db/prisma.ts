// ============================================================================
// Rollease SDK - Prisma Database Adapter
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

export type PrismaAdapterModelName = AnyRepositoryName;

export interface PrismaDelegateLike {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findFirst?(args: { where: Record<string, unknown> }): Promise<unknown | null>;
  findUnique?(args: { where: Record<string, unknown> }): Promise<unknown | null>;
  findMany(args?: {
    where?: Record<string, unknown>;
    orderBy?: Array<Record<string, "asc" | "desc">>;
  }): Promise<unknown[]>;
  update?(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<unknown>;
  updateMany?(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<unknown>;
  delete?(args: { where: Record<string, unknown> }): Promise<unknown>;
  deleteMany?(args: { where: Record<string, unknown> }): Promise<unknown>;
}

export type PrismaClientLike = {
  $disconnect?: () => Promise<unknown>;
  _runtimeDataModel?: {
    models?: Record<string, { fields?: Array<{ name: string }> | Record<string, unknown> }>;
  };
} & Record<string, unknown>;

export type PrismaAdapterDelegates = Partial<
  Record<PrismaAdapterModelName, string | PrismaDelegateLike>
>;

export interface PrismaAdapterOptions {
  /** Prisma client instance owned by the application. */
  prisma: PrismaClientLike;
  /** Map Rollease repositories to Prisma delegate names or delegate objects. */
  delegates?: PrismaAdapterDelegates;
  /** Map Rollease repositories to Prisma model names for optional field validation. */
  modelNames?: Partial<Record<PrismaAdapterModelName, string>>;
  /** Validate delegate presence and methods during construction. Defaults to true. */
  validateDelegates?: boolean;
  /** Validate Prisma model fields when runtime metadata is available. Defaults to false. */
  validateModelFields?: boolean;
  /** Call prisma.$disconnect() from adapter.close(). Defaults to false. */
  disconnectOnClose?: boolean;
}

export const ROLLEASE_PRISMA_DEFAULT_DELEGATES: Record<
  PrismaAdapterModelName,
  string
> = {
  Flag: "rolleaseFlag",
  Rule: "rolleaseRule",
  Segment: "rolleaseSegment",
  Release: "rolleaseRelease",
  Assignment: "rolleaseAssignment",
  History: "rolleaseHistory",
  Impression: "rolleaseImpression",
  ExclusionLayer: "rolleaseExclusionLayer",
};

export const ROLLEASE_PRISMA_DEFAULT_MODELS: Record<
  PrismaAdapterModelName,
  string
> = {
  Flag: "RolleaseFlag",
  Rule: "RolleaseRule",
  Segment: "RolleaseSegment",
  Release: "RolleaseRelease",
  Assignment: "RolleaseAssignment",
  History: "RolleaseHistory",
  Impression: "RolleaseImpression",
  ExclusionLayer: "RolleaseExclusionLayer",
};

export const ROLLEASE_PRISMA_REQUIRED_FIELDS = ROLLEASE_REPOSITORY_REQUIRED_COLUMNS;

export class PrismaDbAdapter extends RepositoryDbAdapter {
  constructor(options: PrismaAdapterOptions) {
    if (options.validateDelegates ?? true) {
      validatePrismaDelegates(options);
    }
    if (options.validateModelFields) {
      validatePrismaModelFields(options);
    }

    super(createPrismaRepositories(options), {
      close: options.disconnectOnClose
        ? async () => {
            await options.prisma.$disconnect?.();
          }
        : undefined,
    });
  }
}

export function createPrismaAdapter(options: PrismaAdapterOptions): PrismaDbAdapter {
  return new PrismaDbAdapter(options);
}

export function validatePrismaDelegates(options: PrismaAdapterOptions): void {
  const validate = (
    name: PrismaAdapterModelName,
    required: boolean
  ): void => {
    const delegate = resolvePrismaDelegate(options, name);
    if (!delegate) {
      if (required) {
        throw new ValidationError(`Missing Prisma delegate for Rollease model "${name}"`, {
          model: name,
          delegate: getPrismaDelegateName(options, name),
        });
      }
      return; // optional and absent — skip silently
    }

    const missing: string[] = [];
    if (typeof delegate.create !== "function") missing.push("create");
    if (typeof delegate.findMany !== "function") missing.push("findMany");
    if (
      typeof delegate.findFirst !== "function" &&
      typeof delegate.findUnique !== "function"
    ) {
      missing.push("findFirst or findUnique");
    }
    if (
      typeof delegate.updateMany !== "function" &&
      typeof delegate.update !== "function"
    ) {
      missing.push("updateMany or update");
    }
    if (
      typeof delegate.deleteMany !== "function" &&
      typeof delegate.delete !== "function"
    ) {
      missing.push("deleteMany or delete");
    }

    if (missing.length > 0) {
      throw new ValidationError(`Prisma delegate for "${name}" is incomplete`, {
        model: name,
        missingMethods: missing,
      });
    }
  };

  for (const name of ROLLEASE_REPOSITORY_NAMES) validate(name, true);
  for (const name of ROLLEASE_OPTIONAL_REPOSITORY_NAMES) validate(name, false);
}

export function validatePrismaModelFields(options: PrismaAdapterOptions): void {
  const models = options.prisma._runtimeDataModel?.models;
  if (!models) {
    throw new ValidationError(
      "Cannot validate Prisma model fields. Prisma runtime metadata was not found.",
      {}
    );
  }

  const validate = (name: PrismaAdapterModelName, required: boolean): void => {
    const modelName =
      options.modelNames?.[name] ?? ROLLEASE_PRISMA_DEFAULT_MODELS[name];
    const model = models[modelName];
    if (!model) {
      if (required) {
        throw new ValidationError(`Missing Prisma model metadata "${modelName}"`, {
          model: name,
          prismaModel: modelName,
        });
      }
      return;
    }

    const fieldNames = getPrismaFieldNames(model.fields);
    const missing = ROLLEASE_PRISMA_REQUIRED_FIELDS[name].filter(
      (field) => !fieldNames.has(field)
    );
    if (missing.length > 0) {
      throw new ValidationError(
        `Prisma model "${modelName}" is missing required Rollease fields`,
        { model: name, prismaModel: modelName, missingFields: missing }
      );
    }
  };

  for (const name of ROLLEASE_REPOSITORY_NAMES) validate(name, true);
  for (const name of ROLLEASE_OPTIONAL_REPOSITORY_NAMES) validate(name, false);
}

function createPrismaRepositories(options: PrismaAdapterOptions): RepositorySet {
  const entries: Array<[PrismaAdapterModelName, RowRepository]> = [];

  for (const name of ROLLEASE_REPOSITORY_NAMES) {
    const delegate = resolvePrismaDelegate(options, name);
    if (!delegate) {
      throw new ValidationError(`Missing Prisma delegate for Rollease model "${name}"`, {
        model: name,
        delegate: getPrismaDelegateName(options, name),
      });
    }
    entries.push([name, createPrismaRepository(name, delegate)]);
  }

  // Optional delegates — wire only when present so existing schemas keep
  // working unchanged.
  for (const name of ROLLEASE_OPTIONAL_REPOSITORY_NAMES) {
    const delegate = resolvePrismaDelegate(options, name);
    if (delegate) {
      entries.push([name, createPrismaRepository(name, delegate)]);
    }
  }

  return Object.fromEntries(entries) as RepositorySet;
}

function createPrismaRepository(
  name: PrismaAdapterModelName,
  delegate: PrismaDelegateLike
): RowRepository {
  return {
    async create(values) {
      return delegate.create({ data: values });
    },

    async findOne(where) {
      if (delegate.findFirst) {
        return delegate.findFirst({ where });
      }
      if (delegate.findUnique) {
        return delegate.findUnique({ where });
      }
      throw new ValidationError(`Prisma delegate for "${name}" cannot find one row`, {
        model: name,
      });
    },

    async findMany(options?: RepositoryFindManyOptions) {
      return delegate.findMany(stripUndefined({
        where: options?.where,
        orderBy: toPrismaOrderBy(options?.orderBy),
      }));
    },

    async update(where, values) {
      if (delegate.updateMany) {
        return delegate.updateMany({ where, data: values });
      }
      if (delegate.update) {
        return delegate.update({ where, data: values });
      }
      throw new ValidationError(`Prisma delegate for "${name}" cannot update rows`, {
        model: name,
      });
    },

    async delete(where) {
      if (delegate.deleteMany) {
        await delegate.deleteMany({ where });
        return;
      }
      if (delegate.delete) {
        await delegate.delete({ where });
        return;
      }
      throw new ValidationError(`Prisma delegate for "${name}" cannot delete rows`, {
        model: name,
      });
    },

    async deleteMany(where) {
      if (delegate.deleteMany) {
        await delegate.deleteMany({ where });
        return;
      }
      if (delegate.delete) {
        await delegate.delete({ where });
        return;
      }
      throw new ValidationError(`Prisma delegate for "${name}" cannot delete rows`, {
        model: name,
      });
    },
  };
}

function resolvePrismaDelegate(
  options: PrismaAdapterOptions,
  name: PrismaAdapterModelName
): PrismaDelegateLike | null {
  const configured = options.delegates?.[name];
  if (configured && typeof configured !== "string") {
    return configured;
  }

  const delegateName =
    typeof configured === "string"
      ? configured
      : ROLLEASE_PRISMA_DEFAULT_DELEGATES[name];
  const delegate = options.prisma[delegateName];
  return isPrismaDelegate(delegate) ? delegate : null;
}

function getPrismaDelegateName(
  options: PrismaAdapterOptions,
  name: PrismaAdapterModelName
): string {
  const configured = options.delegates?.[name];
  return typeof configured === "string"
    ? configured
    : ROLLEASE_PRISMA_DEFAULT_DELEGATES[name];
}

function isPrismaDelegate(value: unknown): value is PrismaDelegateLike {
  return Boolean(value && typeof value === "object");
}

function toPrismaOrderBy(
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>
): Array<Record<string, "asc" | "desc">> | undefined {
  return orderBy?.map((item) => ({ [item.field]: item.direction }));
}

function getPrismaFieldNames(
  fields?: Array<{ name: string }> | Record<string, unknown>
): Set<string> {
  if (Array.isArray(fields)) {
    return new Set(fields.map((field) => field.name));
  }
  return new Set(Object.keys(fields ?? {}));
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as T;
}
