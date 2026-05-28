// ============================================================================
// Rollease SDK — Core Type System (Feature Flags)
// ============================================================================

// ── Shared Primitives ──────────────────────────────────────────────────────

export type FlagKey = string;
export type UserId = string;

// ── Configuration ──────────────────────────────────────────────────────────

export interface RolleaseConfig {
  /** Database adapter — handles all rl_* table operations */
  db: import("../db/adapter").DbAdapter;
  /** Secret for signing internal tokens */
  secret: string;
  /** Cache configuration */
  cache?: CacheConfig;
  /** Audit logging configuration */
  audit?: AuditConfig;
  /** L1 (in-process) cache TTL in milliseconds (default: 5000) */
  l1TtlMs?: number;
  /** Enable local developer overrides via .rolleaserc.json (default: true in dev) */
  localOverrides?: boolean;
  /** Override file path (default: '.rolleaserc.json') */
  localOverridesFile?: string;
  /** Per-evaluation impression tracking */
  impressions?: ImpressionConfig;
  /** Lifecycle hooks for extension (RBAC/ABAC, custom audit, metrics) */
  hooks?: RolleaseHooks;
  /** Logging configuration (level + sink). When unset, falls back to console. */
  logging?: LoggingConfig;
  /** Page size used by evaluateAll/getAllActiveFlags (default 1000). */
  evaluateAllPageSize?: number;
  /**
   * When enabled, the SDK automatically evaluates segment definitions from
   * the database against the user context to populate `context.segments`.
   * Skipped when the caller pre-populates `context.segments`.
   * Default: false (opt-in for backward compatibility).
   */
  autoResolveSegments?: boolean;
  /** Webhook configurations for flag change notifications */
  webhooks?: WebhookConfig[];
  /** Environment name — filters all flag operations to this environment */
  environment?: string;
  /** Resilience: graceful degradation, retries, circuit breaker */
  resilience?: ResilienceConfig;
  /** Privacy: PII attribute scrubbing, data retention */
  privacy?: PrivacyConfig;
  /** OpenTelemetry / custom telemetry integration */
  telemetry?: TelemetryAdapter;
  /** Cross-process invalidation bus for multi-replica cache/SSE coherence. */
  invalidation?: import("../db/adapter").InvalidationBus;
}

export interface ResilienceConfig {
  /**
   * When true, DB errors during evaluate() return a fallback result
   * ({ value: null, reason: 'error_fallback' }) instead of throwing.
   * @default false
   */
  fallbackOnError?: boolean;
  /** Retry configuration for DB operations. */
  retry?: {
    /** Max retry attempts. @default 3 */
    attempts?: number;
    /** Base delay between retries in ms. @default 100 */
    backoffMs?: number;
    /** Add random jitter to retry delay. @default true */
    jitter?: boolean;
  };
  /**
   * Simple circuit breaker: after `threshold` consecutive failures
   * within `windowMs`, open the circuit and return fallback results
   * for `resetAfterMs` before retrying.
   */
  circuitBreaker?: {
    threshold?: number;
    windowMs?: number;
    resetAfterMs?: number;
  };
}

export interface PrivacyConfig {
  /**
   * Context attribute keys to scrub before passing to impression tracking,
   * audit history, and evaluation hooks. Values are replaced with '[REDACTED]'.
   */
  privateAttributes?: string[];
  /** Automatically delete impression records older than N days. */
  impressionRetentionDays?: number;
  /** Automatically delete audit history older than N days. */
  auditRetentionDays?: number;
}

/** Span object returned by TelemetryAdapter.startSpan(). */
export interface TelemetrySpan {
  setAttribute(key: string, value: string | number | boolean): void;
  end(status?: "ok" | "error", error?: Error): void;
}

/**
 * Plug-in telemetry adapter.  Use `createOtelAdapter(tracer)` from
 * `rollease/telemetry` to integrate with `@opentelemetry/api`.
 */
export interface TelemetryAdapter {
  startSpan(
    name: string,
    attrs?: Record<string, string | number | boolean>
  ): TelemetrySpan;
}

/** Returned by `rl.health()` and `GET /api/rollease/health`. */
export interface RolleaseHealthResult {
  status: "healthy" | "degraded" | "unhealthy";
  db: "ok" | "error";
  cache: "ok" | "error" | "disabled";
  circuit?: "closed" | "open" | "half_open" | "disabled";
  latencyMs: number;
  evalCount: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  uptimeMs: number;
  ts: number;
}

export interface ImpressionConfig {
  /** Disable impression tracking entirely (default: enabled when db.trackImpression exists) */
  enabled?: boolean;
  /** Sample rate 0..1 (default 1.0). 0 disables, 1 tracks every evaluation. */
  sampleRate?: number;
}

export interface TrackEventInput {
  userId?: string;
  anonymousId?: string;
  event: string;
  value?: number;
  metadata?: Record<string, unknown>;
  context?: FlagContext;
  ts?: number | string | Date;
}

export interface TrackingEvent {
  id: string;
  userId?: string;
  anonymousId?: string;
  event: string;
  value?: number;
  metadata?: Record<string, unknown>;
  context?: FlagContext;
  environment?: string;
  createdAt: Date;
}

export interface RolleaseHooks {
  /**
   * Called before any write operation. Throwing aborts the operation (use for RBAC denials).
   * `flagKey` is undefined for global operations like killAll.
   */
  onBeforeMutation?: (ctx: {
    action: HistoryAction;
    flagKey?: string;
    actor?: AuditActor;
  }) => Promise<void> | void;
  /**
   * Called before a single flag evaluation. Throwing aborts evaluation.
   * Use to enforce tenant-isolation or permission checks at read time.
   */
  onBeforeEvaluation?: (ctx: {
    flagKey: string;
    context: FlagContext;
  }) => Promise<void> | void;
  /**
   * Called after every evaluation (single or bulk). Fire-and-forget — errors are logged.
   */
  onEvaluate?: (
    result: FlagResult,
    context: FlagContext
  ) => Promise<void> | void;
}

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface LoggingConfig {
  /** Threshold below which messages are dropped. Default 'warn'. */
  level?: LogLevel;
  /** Custom sink. Default writes to console.<level>. */
  sink?: (
    level: Exclude<LogLevel, "silent">,
    message: string,
    meta?: Record<string, unknown>
  ) => void;
}

/**
 * Identifies the actor performing a write operation. Used in audit history
 * and surfaced to permission hooks.
 */
export interface AuditActor {
  id: string;
  type: "user" | "service" | "system";
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface CacheConfig {
  driver: "memory" | "redis";
  redis?: { url: string };
  /** L2 cache TTL in seconds (default: 60) */
  ttl?: number;
}

export interface AuditConfig {
  enabled: boolean;
  sink: "db" | "stdout" | AuditSink;
  /** Fields to scrub from audit events */
  scrubFields?: string[];
}

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
}

// ── Flag Context ───────────────────────────────────────────────────────────

/**
 * Context passed to flag evaluation.
 * All fields are optional — pass what's relevant.
 */
export interface FlagContext {
  /** User identifier — required for user targeting and percentage hash */
  userId?: string;
  /** Runtime environment: 'dev' | 'staging' | 'production' */
  environment?: string;
  /** App/API semver string for version-based targeting (e.g. '2.1.0') */
  version?: string;
  /** Geographic region code (e.g. 'eu', 'us', 'ca', 'apac') */
  region?: string;
  /** User cohort from your user model (e.g. 'beta', 'alpha', 'internal') */
  userType?: string;
  /** Pre-resolved segment keys (e.g. ['power_users', 'enterprise']) */
  segments?: string[];
  /** Arbitrary key-value attributes for custom targeting rules */
  attributes?: Record<string, unknown>;
  /** IP address for GeoIP resolution (optional) */
  ip?: string;
  /** Multi-tenant isolation key */
  tenantId?: string;
}

// ── Flag Types ─────────────────────────────────────────────────────────────

export type FlagType =
  | "boolean"
  | "multivariate"
  | "percentage"
  | "string"
  | "number"
  | "json";

export type FlagStatus = "active" | "killed" | "archived";

export interface Flag {
  id: string;
  key: FlagKey;
  type: FlagType;
  status: FlagStatus;
  defaultValue: unknown;
  description?: string;
  namespace?: string;
  tags?: string[];
  locked?: boolean;
  lockedReason?: string;
  /** Per-environment configurations */
  environments?: string[];
  /** Multivariate variant definitions */
  variants?: FlagVariantDef[];
  /** Rollout configuration */
  rollout?: RolloutConfig;
  /** Auto-activation date */
  scheduledAt?: Date | string | null;
  /** Auto-deactivation date */
  expiresAt?: Date | string | null;
  /**
   * Flag prerequisites — this flag only evaluates if ALL prerequisites
   * return their required variation. Prevents enabling features without
   * their dependencies.
   */
  prerequisites?: FlagPrerequisite[];
  /** Per-environment default value overrides (e.g. { production: false, staging: true }) */
  environmentDefaults?: Record<string, unknown>;
  /** Last time this flag was evaluated (set by touchFlagEvaluation) */
  lastEvaluatedAt?: Date | null;
  /** Exclusion layer key this flag belongs to */
  exclusionLayer?: string;
  /** Whether this flag may be exposed through public browser/client keys. */
  clientVisible?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A prerequisite relationship. The prerequisite flag must evaluate to the
 * specified variation before this flag's rules are considered.
 */
export interface FlagPrerequisite {
  /** Key of the prerequisite flag */
  flagKey: string;
  /** Required value — prerequisite must evaluate to this value */
  variation: unknown;
}

// ── Variants ───────────────────────────────────────────────────────────────

export interface FlagVariantDef {
  id: string;
  key: string;
  value: unknown;
  /** Weight for weighted random distribution (0-100, all weights should sum to 100) */
  weight: number;
  description?: string;
}

export interface Variant {
  key: string;
  value: unknown;
  reason: EvalReason;
}

// ── Rollout ────────────────────────────────────────────────────────────────

export interface RolloutConfig {
  /** Percentage of users who get the "on" value (0-100) */
  percentage: number;
  /** Whether the same user always gets the same bucket (default: true) */
  sticky: boolean;
  /** Which context field to hash on (default: 'userId') */
  hashKey: string;
  /** Auto-ramp schedule — percentage increases automatically at given dates */
  rampSchedule?: RampStep[];
}

export interface RampStep {
  /** ISO date string — when this percentage becomes active */
  at: string;
  /** Target percentage at this date */
  percentage: number;
}

// ── Targeting Rules ────────────────────────────────────────────────────────

export interface FlagRule {
  id: string;
  flagKey: FlagKey;
  name?: string;
  /** Lower priority number = evaluated first */
  priority: number;
  /** Value to return when this rule matches */
  value: unknown;
  /** Targeting conditions (AND/OR/NOT groups) */
  conditions: FlagConditionGroup;
  /** Whether this rule is active */
  enabled: boolean;
  /** Per-rule rollout percentage — only X% of matched users get the value */
  rolloutPct?: number;
  /** Holdout flag — matched users get defaultValue (control group) */
  isHoldout?: boolean;
  /** Specific variant ID to assign (for multivariate flags) */
  variantId?: string;
  /** Explicit user allow-list — if set, rule only matches these users */
  userIds?: string[];
  /** Human-readable description of what this rule does */
  description?: string;
  /** Arbitrary metadata (e.g. ticket ID, owner, created date) */
  metadata?: Record<string, unknown>;
}

export type FlagDimensionKey =
  | "environment"
  | "version"
  | "userType"
  | "region"
  | "userId"
  | "segment"
  | "attribute"
  | "device"
  | "channel"
  | string;

export type FlagOperator =
  | "eq"
  | "neq"
  | "in"
  | "nin"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "regex"
  | "semverGte"
  | "semverLte"
  | "exists"
  | "dateAfter"
  | "dateBefore";

export interface FlagConditionLeaf {
  dimension: FlagDimensionKey;
  op: FlagOperator;
  value: unknown;
}

export interface FlagConditionGroup {
  all?: (FlagConditionLeaf | FlagConditionGroup)[];
  any?: (FlagConditionLeaf | FlagConditionGroup)[];
  none?: (FlagConditionLeaf | FlagConditionGroup)[];
}

// ── Segments ───────────────────────────────────────────────────────────────

export interface Segment {
  key: string;
  description?: string;
  rules: FlagConditionGroup;
  createdAt: Date;
  updatedAt: Date;
}

export interface SegmentUsage {
  flagKey: string;
  ruleId: string;
}

// ── Evaluation Result ──────────────────────────────────────────────────────

export type EvalReason =
  | "kill_switch"
  | "disabled"
  | "expired"
  | "not_scheduled"
  | "prerequisite_not_met"
  | "exclusion_group_miss"
  | "exclusion_layer_not_found"
  | "override"
  | "assignment"
  | "rule_match"
  | "percentage"
  | "weighted_random"
  | "error_fallback"
  | "default";

export interface EvaluationTraceStep {
  step: number;
  name: string;
  matched: boolean;
  detail?: string;
}

export interface EvaluationTrace {
  steps: EvaluationTraceStep[];
  matchedRuleId?: string;
  matchedVariantId?: string;
}

export interface FlagResult<T = unknown> {
  key: string;
  value: T;
  variant: string | null;
  enabled: boolean;
  reason: EvalReason;
  ruleId: string | null;
  evaluatedAt: Date;
  /** Populated when evaluate() is called with { trace: true }. */
  trace?: EvaluationTrace;
}

export type FlagMap = Record<string, unknown>;
export type DetailedFlagMap = Record<string, FlagResult>;

// ── Releases ───────────────────────────────────────────────────────────────

export type ReleaseStatus = "pending" | "deployed" | "rolled_back" | "scheduled";

export interface Release {
  id: string;
  name: string;
  description?: string;
  environment?: string;
  status: ReleaseStatus;
  changes: ReleaseChange[];
  /**
   * Before-snapshots captured at deploy time so rollback can restore exact prior state.
   * Populated by deployRelease(); absent on releases created before snapshots were added.
   */
  snapshots?: ReleaseSnapshot[];
  scheduledAt?: string | null;
  deployedAt?: Date | null;
  deployedBy?: string;
  rolledBackAt?: Date | null;
  rolledBackBy?: string;
  rollbackReason?: string;
  requiresApproval?: boolean;
  requiredApprovers?: string[];
  approvalStatus?: "pending" | "approved" | "rejected";
  approvals?: string[];
  rejectionReason?: string;
  createdAt: Date;
}

/**
 * Per-flag state captured before a release change is applied.
 * Used by rollbackRelease() to restore the exact prior value/status/rollout.
 */
export interface ReleaseSnapshot {
  flagKey: string;
  beforeValue: unknown;
  beforeStatus: FlagStatus;
  beforeRollout?: RolloutConfig;
}

export type ReleaseAction =
  | "enable"
  | "disable"
  | "setValue"
  | "setRollout"
  | "kill"
  | "restore";

export interface ReleaseChange {
  flagKey: string;
  action: ReleaseAction;
  value?: unknown;
  rollout?: Partial<RolloutConfig>;
  reason?: string;
}

export interface ReleasePreview {
  flagKey: string;
  before: { value: unknown; status: FlagStatus };
  after: { value: unknown; status: FlagStatus };
}

// ── History / Audit ────────────────────────────────────────────────────────

export type HistoryAction =
  | "flag.created"
  | "flag.updated"
  | "flag.archived"
  | "flag.restored"
  | "flag.killed"
  | "flag.deleted"
  | "flag.locked"
  | "flag.unlocked"
  | "flag.cloned"
  | "rule.added"
  | "rule.updated"
  | "rule.removed"
  | "rule.reordered"
  | "rollout.set"
  | "variant.updated"
  | "release.deployed"
  | "release.rolled_back"
  | "release.approved"
  | "release.rejected"
  | "segment.created"
  | "segment.updated"
  | "segment.deleted"
  | "tags.added"
  | "tags.removed";

export interface HistoryEntry {
  id: string;
  flagKey?: string;
  action: HistoryAction;
  /**
   * Actor who performed the action. String form is preserved for backwards
   * compatibility (older audit logs); new code should pass an AuditActor.
   */
  by?: string | AuditActor;
  at: Date;
  changes?: Record<string, unknown>;
  reason?: string;
  releaseId?: string;
}

export interface AuditEvent {
  id?: string;
  eventType: string;
  userId?: string;
  actorId?: string;
  resource?: string;
  action?: string;
  outcome?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

// ── GeoIP (Optional) ──────────────────────────────────────────────────────

export interface GeoContext {
  ip: string;
  country: string;
  continent: string;
  region: string;
  city: string;
  timezone: string;
}

export interface GeoIPAdapter {
  resolve(ip: string): Promise<GeoContext | null>;
}

// ── Flag Management Input Types ────────────────────────────────────────────

export interface CreateFlagInput {
  key: string;
  type: FlagType;
  defaultValue: unknown;
  description?: string;
  namespace?: string;
  tags?: string[];
  environments?: string[];
  variants?: Omit<FlagVariantDef, "id">[];
  rollout?: RolloutConfig;
  scheduledAt?: string | null;
  expiresAt?: string | null;
  /** Flag prerequisites (Flag B only evaluates if Flag A returns variation X) */
  prerequisites?: FlagPrerequisite[];
  /** Per-environment default value overrides */
  environmentDefaults?: Record<string, unknown>;
  /** Exclusion layer key this flag belongs to */
  exclusionLayer?: string;
  /** Whether this flag may be exposed through public browser/client keys. */
  clientVisible?: boolean;
  actor?: AuditActor;
}

export interface UpdateFlagInput {
  defaultValue?: unknown;
  description?: string;
  tags?: string[];
  /**
   * @deprecated Use `setLock(key, { locked, reason, actor })` instead. Passing
   * `locked` on a currently-locked flag is rejected — see FlagLockedError.
   */
  locked?: boolean;
  /** @deprecated Use setLock(). */
  lockedReason?: string;
  environments?: string[];
  scheduledAt?: string | null;
  expiresAt?: string | null;
  /** Exclusion layer key this flag belongs to */
  exclusionLayer?: string;
  /** Whether this flag may be exposed through public browser/client keys. */
  clientVisible?: boolean;
  actor?: AuditActor;
}

export interface SetLockInput {
  locked: boolean;
  reason?: string;
  actor?: AuditActor;
}

export interface ListFlagsInput {
  namespace?: string;
  tags?: string[];
  status?: FlagStatus;
  environment?: string;
  search?: string;
  /** Only return flags not evaluated since this ISO date (stale flag detection) */
  staleAfter?: string;
  limit?: number;
  offset?: number;
}

export interface ListFlagsResult {
  data: Flag[];
  total: number;
  hasMore: boolean;
}

export interface AddRuleInput {
  name?: string;
  priority: number;
  value: unknown;
  conditions: FlagConditionGroup;
  enabled?: boolean;
  rolloutPct?: number;
  isHoldout?: boolean;
  variantId?: string;
  /** Explicit user allow-list — if set, rule only matches these users */
  userIds?: string[];
  /** Human-readable description of what this rule does */
  description?: string;
  /** Arbitrary metadata (e.g. ticket ID, owner) */
  metadata?: Record<string, unknown>;
  actor?: AuditActor;
}

export interface UpdateRuleInput {
  name?: string;
  priority?: number;
  value?: unknown;
  conditions?: FlagConditionGroup;
  enabled?: boolean;
  rolloutPct?: number;
  isHoldout?: boolean;
  variantId?: string;
  /** Explicit user allow-list — if set, rule only matches these users */
  userIds?: string[];
  /** Human-readable description of what this rule does */
  description?: string;
  /** Arbitrary metadata (e.g. ticket ID, owner) */
  metadata?: Record<string, unknown>;
  actor?: AuditActor;
}

export interface RuleOrdering {
  ruleId: string;
  priority: number;
}

export interface CreateSegmentInput {
  key: string;
  description?: string;
  rules: FlagConditionGroup;
  actor?: AuditActor;
}

export interface UpdateSegmentInput {
  description?: string;
  rules?: FlagConditionGroup;
  actor?: AuditActor;
}

export interface CreateReleaseInput {
  name: string;
  description?: string;
  environment?: string;
  changes: ReleaseChange[];
  scheduledAt?: string | null;
  requiresApproval?: boolean;
  requiredApprovers?: string[];
  actor?: AuditActor;
}

export interface KillFlagInput {
  reason?: string;
  killedBy?: string;
  actor?: AuditActor;
}

export interface RestoreFlagInput {
  restoredBy?: string;
  reason?: string;
  actor?: AuditActor;
}

export interface ArchiveFlagInput {
  reason?: string;
  archivedBy?: string;
  actor?: AuditActor;
}

export interface DeployReleaseInput {
  deployedBy?: string;
  actor?: AuditActor;
}

export interface RollbackReleaseInput {
  rolledBackBy?: string;
  reason?: string;
  actor?: AuditActor;
}

export interface CloneFlagInput {
  newKey: string;
  includeRules?: boolean;
  includeRollout?: boolean;
  actor?: AuditActor;
}

// ── Bulk Operations ────────────────────────────────────────────────────────

export interface BulkCreateResult {
  created: Flag[];
  errors: Array<{ key: string; error: string }>;
}

export interface BulkUpdateResult {
  updated: Flag[];
  errors: Array<{ key: string; error: string }>;
}

// ── Webhooks ───────────────────────────────────────────────────────────────

export interface WebhookConfig {
  url: string;
  secret?: string;
  events?: HistoryAction[];
  headers?: Record<string, string>;
  /** Retry configuration. @default { attempts: 3, backoffMs: 500, jitter: true } */
  retry?: {
    attempts?: number;
    backoffMs?: number;
    jitter?: boolean;
  };
  /**
   * Dead-letter queue sink: called with the payload and last error after all
   * retries are exhausted.  Use to persist failed events to a queue or log.
   */
  dlq?: (payload: WebhookPayload, error: Error) => Promise<void> | void;
}

export interface WebhookPayload {
  event: HistoryAction;
  flagKey?: string;
  timestamp: string;
  data: Record<string, unknown>;
}

// ── Multi-Context Evaluation ────────────────────────────────────────────────

export interface MultiContext {
  contexts: Record<string, FlagContext>;
  primaryKey?: string; // Default to first context key
}

// ── Exclusion Layers ────────────────────────────────────────────────────────

export interface ExclusionLayerAllocation {
  flagKey: string;
  startBucket: number; // 0..100
  endBucket: number;   // 0..100
}

export interface ExclusionLayer {
  key: string;
  description?: string;
  flagKeys: string[];
  allocations: ExclusionLayerAllocation[];
}
