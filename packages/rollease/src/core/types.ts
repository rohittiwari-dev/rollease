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
  createdAt: Date;
  updatedAt: Date;
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
  | "override"
  | "assignment"
  | "rule_match"
  | "percentage"
  | "weighted_random"
  | "default";

export interface FlagResult<T = unknown> {
  key: string;
  value: T;
  variant: string | null;
  enabled: boolean;
  reason: EvalReason;
  ruleId: string | null;
  evaluatedAt: Date;
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
  scheduledAt?: string | null;
  deployedAt?: Date | null;
  deployedBy?: string;
  rolledBackAt?: Date | null;
  rolledBackBy?: string;
  rollbackReason?: string;
  createdAt: Date;
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
  | "rule.added"
  | "rule.updated"
  | "rule.removed"
  | "rule.reordered"
  | "rollout.set"
  | "variant.updated"
  | "release.deployed"
  | "release.rolled_back"
  | "segment.created"
  | "segment.updated"
  | "segment.deleted"
  | "tags.added"
  | "tags.removed";

export interface HistoryEntry {
  id: string;
  flagKey?: string;
  action: HistoryAction;
  by?: string;
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
}

export interface UpdateFlagInput {
  defaultValue?: unknown;
  description?: string;
  tags?: string[];
  locked?: boolean;
  lockedReason?: string;
  environments?: string[];
  scheduledAt?: string | null;
  expiresAt?: string | null;
}

export interface ListFlagsInput {
  namespace?: string;
  tags?: string[];
  status?: FlagStatus;
  environment?: string;
  search?: string;
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
}

export interface RuleOrdering {
  ruleId: string;
  priority: number;
}

export interface CreateSegmentInput {
  key: string;
  description?: string;
  rules: FlagConditionGroup;
}

export interface UpdateSegmentInput {
  description?: string;
  rules?: FlagConditionGroup;
}

export interface CreateReleaseInput {
  name: string;
  description?: string;
  environment?: string;
  changes: ReleaseChange[];
  scheduledAt?: string | null;
}

export interface KillFlagInput {
  reason?: string;
  killedBy?: string;
}

export interface RestoreFlagInput {
  restoredBy?: string;
  reason?: string;
}

export interface ArchiveFlagInput {
  reason?: string;
  archivedBy?: string;
}

export interface DeployReleaseInput {
  deployedBy?: string;
}

export interface RollbackReleaseInput {
  rolledBackBy?: string;
  reason?: string;
}

export interface CloneFlagInput {
  newKey: string;
  includeRules?: boolean;
  includeRollout?: boolean;
}
