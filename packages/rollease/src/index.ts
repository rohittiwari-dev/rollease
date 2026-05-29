// ============================================================================
// Rollease SDK — Main Entry Point
// ============================================================================

import { FlagManager } from "./engine/manager";
import { MemoryCacheAdapter } from "./db/memory";
import { RedisCacheAdapter } from "./db/redis";
import { ValidationError } from "./core/errors";
import { createLogger } from "./core/logger";
import { INTERNAL_SECRET } from "./core/internal";
import { createRolleaseHandler } from "./handler";
import type { RolleaseConfig, RolleaseHealthResult } from "./core/types";
import type { CacheAdapter } from "./db/adapter";
import type {
  RolleaseHandlerOptions,
  RolleaseHandler,
  RolleasePublicClientKeyConfig,
} from "./handler";

// ── Core Types ─────────────────────────────────────────────────────────────
export type {
  // Config
  RolleaseConfig,
  CacheConfig,
  AuditConfig,
  AuditSink,
  AuditActor,
  RolleaseHooks,
  LoggingConfig,
  LogLevel,
  ImpressionConfig,

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
  FlagPrerequisite,
  EvalReason,

  // Typed flag keys
  FlagDefinitions,
  TypedFlagKey,
  HasFlagDefinitions,
  FlagTypeToTS,
  FlagValueType,
  FlagDefaultValue,
  BooleanFlagKey,
  StringFlagKey,
  NumberFlagKey,
  JsonFlagKey,
  MultivariateFlagKey,

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
  ReleaseSnapshot,
  ReleaseStatus,
  ReleaseAction,

  // History
  HistoryEntry,
  HistoryAction,
  AuditEvent,

  // Inputs
  CreateFlagInput,
  UpdateFlagInput,
  SetLockInput,
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

  // Bulk operations
  BulkCreateResult,
  BulkUpdateResult,

  // Webhooks
  WebhookConfig,
  WebhookPayload,

  // Multi-Context
  MultiContext,

  // Exclusion Layers
  ExclusionLayer,
  ExclusionLayerAllocation,

  // GeoIP
  GeoContext,
  GeoIPAdapter,

  // Resilience, Privacy, Telemetry
  ResilienceConfig,
  PrivacyConfig,
  TelemetryAdapter,
  TelemetrySpan,
  RolleaseHealthResult,
  TrackEventInput,
  TrackingEvent,
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
export { evaluateFlag, evaluateConditionGroup } from "./engine/evaluator";
export { FlagManager } from "./engine/manager";

// ── Handler ─────────────────────────────────────────────────────────────────
export { createRolleaseHandler } from "./handler";
export type {
  RolleaseHandlerOptions,
  RolleaseHandler,
  RolleasePublicClientKeyConfig,
} from "./handler";

// ── Telemetry ─────────────────────────────────────────────────────────────
export { createOtelAdapter, createConsoleAdapter, noopSpan } from "./core/telemetry";

// ── Metrics ────────────────────────────────────────────────────────────────
export {
  PrometheusAdapter,
  createPrometheusAdapter,
  noopMetrics,
} from "./core/metrics";
export type { MetricsAdapter } from "./core/metrics";

// ── Exposure Dedup ─────────────────────────────────────────────────────────
export { createExposureTracker } from "./core/exposure";
export type {
  ExposureTracker,
  ExposureTrackerConfig,
  ExposureStats,
} from "./core/exposure";

// ── RBAC ───────────────────────────────────────────────────────────────────
export {
  createDefaultRBACPolicy,
  createRBACHook,
  createRBACAdminAuth,
} from "./core/rbac";
export type {
  RolleaseRole,
  RolleasePermission,
  RolleaseRBACPolicy,
} from "./core/rbac";

// ── Multi-Tenancy ──────────────────────────────────────────────────────────
export { createTenantAdapter } from "./core/tenant";
export type { TenantAdapterConfig } from "./core/tenant";

// ── Experiment Hooks ───────────────────────────────────────────────────────
export { createExperimentHooks, withExperimentHooks, EXPERIMENT_REASONS } from "./core/experiment";
export type { ExperimentBackend } from "./core/experiment";

// ── Utilities ──────────────────────────────────────────────────────────────
export { getBucket, murmurhash3_32 } from "./bucket";
export { loadLocalOverrides } from "./overrides";
export {
  isSafeRegexPattern,
  safeRegexTest,
  assertSafeConditionGroup,
  findUnsafeConditionIssue,
  isSafeFlagKey,
  assertSafeFlagKey,
  conditionReferencesSegment,
  walkConditions,
  validateOverridePath,
  FORBIDDEN_KEYS,
} from "./core/security";
export { createLogger, noopLogger } from "./core/logger";
export type { RolleaseLogger } from "./core/logger";
export { INTERNAL_SECRET } from "./core/internal";
export { WebhookDispatcher, verifyWebhookSignature } from "./core/webhook";

// ── Database Adapters ──────────────────────────────────────────────────────
export type {
  DbAdapter,
  CacheAdapter,
  InvalidationBus,
  InvalidationListener,
  InvalidationMessage,
} from "./db/adapter";
export {
  MemoryDbAdapter,
  MemoryCacheAdapter,
  MemoryInvalidationBus,
  createMemoryAdapter,
} from "./db/memory";
export {
  RedisCacheAdapter,
  RedisInvalidationBus,
  createRedisCache,
  createRedisInvalidationBus,
} from "./db/redis";
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

  /** Check SDK health — DB connectivity, cache status, and evaluation metrics. */
  health(): Promise<RolleaseHealthResult>;

  /**
   * Create a fetch-compatible HTTP handler that exposes Rollease evaluation
   * and management routes.  Mount it at a single catch-all route in your
   * framework of choice.
   *
   * **Next.js App Router** — `app/api/rollease/[...path]/route.ts`:
   * ```ts
   * import { rl } from '@/lib/rollease'
   *
   * const handler = rl.createHandler({
   *   contextFromRequest: async (req) => ({ userId: await getServerUserId(req) }),
   *   adminAuth: async (req) => req.headers.get('x-admin-token') === process.env.ADMIN_TOKEN,
   * })
   *
   * export const GET  = handler
   * export const POST = handler
   * export const PATCH  = handler
   * export const DELETE = handler
   * ```
   *
   * **Hono / Bun.serve**:
   * ```ts
   * const handler = rl.createHandler({ contextFromRequest: ... })
   * app.all('/api/rollease/*', (c) => handler(c.req.raw))
   * ```
   */
  createHandler(options?: RolleaseHandlerOptions): RolleaseHandler;

  /**
   * @deprecated Read via `client[Symbol.for('rollease.internal.secret')]()` if
   * absolutely necessary. This object remains present for one release to keep
   * v1 middleware working, but it WILL leak the secret if the client is
   * accidentally serialized.
   */
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
  const logger = createLogger(config.logging);

  const flags = new FlagManager({
    db: config.db,
    l2Cache,
    l1TtlMs,
    l2TtlMs,
    useLocalOverrides,
    localOverridesFile: config.localOverridesFile,
    hooks: config.hooks,
    impressions: config.impressions,
    logger,
    evaluateAllPageSize: config.evaluateAllPageSize,
    autoResolveSegments: config.autoResolveSegments,
    webhooks: config.webhooks,
    environment: config.environment,
    resilience: config.resilience,
    privacy: config.privacy,
    telemetry: config.telemetry,
    invalidationBus: config.invalidation,
    metrics: config.metrics,
    dbReader: config.dbReader,
    cacheNamespace: config.cacheNamespace,
    audit: config.audit,
  });

  // Capture the secret in a closure so it never appears on the public client
  // object (would leak via JSON.stringify, Object.keys, structured cloning).
  const secret = config.secret;

  const client: RolleaseClient = {
    flags,
    async health() {
      return flags.health();
    },
    createHandler(options?: RolleaseHandlerOptions): RolleaseHandler {
      return createRolleaseHandler(flags, options);
    },
    async close() {
      await flags.close();
      if (config.db.close) {
        await config.db.close();
      }
      if (l2Cache?.close) {
        await l2Cache.close();
      }
    },
  };

  // Build the signing key ring. The current key is used for signing new tokens;
  // all keys are accepted for verification to support gradual rotation.
  const signingKeyRing = config.signingKeys ?? [{ kid: "default", secret }];
  const currentKeyId = config.currentSigningKeyId ?? signingKeyRing[0].kid;
  const currentKeySecret = signingKeyRing.find((k) => k.kid === currentKeyId)?.secret ?? secret;

  // Symbol-keyed slot. Invisible to property enumeration; ignored by JSON.
  // Exposes { getSecret, getKeyRing } for use by the Next.js middleware only.
  Object.defineProperty(client, INTERNAL_SECRET, {
    value: () => ({
      secret: currentKeySecret,
      keyRing: signingKeyRing,
      currentKeyId,
    }),
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return client;
}
