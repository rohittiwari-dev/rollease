// ============================================================================
// Rollease SDK — Main Entry Point
// ============================================================================

import { FlagManager } from "./engine/manager";
import { MemoryCacheAdapter } from "./db/memory";
import { RedisCacheAdapter } from "./db/redis";
import { ValidationError } from "./core/errors";
import type { RolleaseConfig } from "./core/types";
import type { CacheAdapter } from "./db/adapter";

// ── Core Types ─────────────────────────────────────────────────────────────
export type {
  // Config
  RolleaseConfig,
  CacheConfig,
  AuditConfig,
  AuditSink,

  // Flag types
  Flag,
  FlagType,
  FlagStatus,
  FlagKey,
  FlagContext,
  FlagResult,
  FlagMap,
  DetailedFlagMap,
  Variant,
  FlagVariantDef,
  EvalReason,

  // Rollout
  RolloutConfig,
  RampStep,

  // Rules
  FlagRule,
  FlagConditionGroup,
  FlagConditionLeaf,
  FlagDimensionKey,
  FlagOperator,

  // Segments
  Segment,
  SegmentUsage,

  // Releases
  Release,
  ReleaseChange,
  ReleasePreview,
  ReleaseStatus,
  ReleaseAction,

  // History
  HistoryEntry,
  HistoryAction,
  AuditEvent,

  // Inputs
  CreateFlagInput,
  UpdateFlagInput,
  ListFlagsInput,
  ListFlagsResult,
  AddRuleInput,
  UpdateRuleInput,
  RuleOrdering,
  CreateSegmentInput,
  UpdateSegmentInput,
  CreateReleaseInput,
  KillFlagInput,
  RestoreFlagInput,
  ArchiveFlagInput,
  DeployReleaseInput,
  RollbackReleaseInput,
  CloneFlagInput,

  // GeoIP
  GeoContext,
  GeoIPAdapter,
} from "./core/types";

// ── Errors ─────────────────────────────────────────────────────────────────
export {
  RolleaseError,
  FlagNotFoundError,
  FlagLockedError,
  FlagConflictError,
  ValidationError,
  ReleaseConflictError,
  RolleaseInternalError,
  RuleNotFoundError,
  SegmentNotFoundError,
  ReleaseNotFoundError,
} from "./core/errors";

// ── Engine ─────────────────────────────────────────────────────────────────
export { evaluateFlag } from "./engine/evaluator";
export { FlagManager } from "./engine/manager";

// ── Utilities ──────────────────────────────────────────────────────────────
export { getBucket, murmurhash3_32 } from "./bucket";
export { loadLocalOverrides } from "./overrides";
export {
  isSafeRegexPattern,
  safeRegexTest,
  assertSafeConditionGroup,
  findUnsafeConditionIssue,
} from "./core/security";

// ── Database Adapters ──────────────────────────────────────────────────────
export type { DbAdapter, CacheAdapter } from "./db/adapter";
export { MemoryDbAdapter, MemoryCacheAdapter, createMemoryAdapter } from "./db/memory";
export { RedisCacheAdapter, createRedisCache } from "./db/redis";
export {
  ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS,
  SequelizeDbAdapter,
  createSequelizeAdapter,
  validateSequelizeAdapterModels,
} from "./db/sequelize";
export {
  ROLLEASE_PRISMA_DEFAULT_DELEGATES,
  ROLLEASE_PRISMA_DEFAULT_MODELS,
  ROLLEASE_PRISMA_REQUIRED_FIELDS,
  PrismaDbAdapter,
  createPrismaAdapter,
  validatePrismaDelegates,
  validatePrismaModelFields,
} from "./db/prisma";
export {
  ROLLEASE_DRIZZLE_REQUIRED_COLUMNS,
  DrizzleDbAdapter,
  createDrizzleAdapter,
  validateDrizzleTables,
} from "./db/drizzle";
export type {
  PrismaAdapterDelegates,
  PrismaAdapterModelName,
  PrismaAdapterOptions,
  PrismaClientLike,
  PrismaDelegateLike,
} from "./db/prisma";
export type {
  DrizzleAdapterModelName,
  DrizzleAdapterOptions,
  DrizzleDbLike,
  DrizzleHelpers,
  DrizzleTableLike,
  DrizzleTableMap,
} from "./db/drizzle";
export type {
  RepositoryFindManyOptions,
  RepositoryName,
  RepositorySet,
  RowRepository,
} from "./db/repository";

// ── Client Interface ───────────────────────────────────────────────────────

export interface RolleaseClient {
  flags: FlagManager;
  readonly __rollease?: {
    secret: string;
  };
  close(): Promise<void>;
}

/**
 * Create a new Rollease client.
 *
 * ```typescript
 * const rl = createRollease({
 *   db:     createMemoryAdapter(),
 *   secret: process.env.ROLLEASE_SECRET!,
 *   cache:  { driver: 'memory', ttl: 60 },
 * })
 *
 * const enabled = await rl.flags.isEnabled('my_flag', { userId: 'u_alice' })
 * ```
 */
export function createRollease(config: RolleaseConfig): RolleaseClient {
  if (!config.secret || config.secret.length < 16) {
    throw new ValidationError("Rollease secret must be at least 16 characters long");
  }

  // Resolve cache adapter
  let l2Cache: CacheAdapter | undefined;
  if (config.cache) {
    if (config.cache.driver === "memory") {
      l2Cache = new MemoryCacheAdapter();
    }
    if (config.cache.driver === "redis") {
      l2Cache = new RedisCacheAdapter({
        url: config.cache.redis?.url,
      });
    }
  }

  const l2TtlMs = (config.cache?.ttl ?? 60) * 1000;
  const l1TtlMs = config.l1TtlMs ?? 5000;

  // Detect development environment for local overrides
  const isDev =
    typeof process !== "undefined" &&
    (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "dev");

  const useLocalOverrides = config.localOverrides ?? isDev;

  const flags = new FlagManager({
    db: config.db,
    l2Cache,
    l1TtlMs,
    l2TtlMs,
    useLocalOverrides,
    localOverridesFile: config.localOverridesFile,
  });

  return {
    flags,
    __rollease: {
      secret: config.secret,
    },
    async close() {
      if (config.db.close) {
        await config.db.close();
      }
      if (l2Cache?.close) {
        await l2Cache.close();
      }
    },
  };
}
