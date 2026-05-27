// ============================================================================
// Rollease SDK — Database Adapter Interface
// ============================================================================

import type {
  Flag,
  FlagRule,
  Segment,
  Release,
  HistoryEntry,
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
  ReleaseChange,
  FlagStatus,
  SegmentUsage,
} from "../core/types";

/**
 * Database adapter interface for all Rollease flag operations.
 * Implement this interface to connect Rollease to any database.
 * All `rl_*` tables are owned and managed by Rollease.
 */
export interface DbAdapter {
  // ── Flag CRUD ────────────────────────────────────────────────────────

  /** Create a new flag. Throws FlagConflictError if key exists. */
  createFlag(input: CreateFlagInput): Promise<Flag>;

  /** Get a flag by key. Returns null if not found. */
  getFlag(key: string): Promise<Flag | null>;

  /** List flags with filtering, search, and pagination. */
  listFlags(input: ListFlagsInput): Promise<ListFlagsResult>;

  /** Update a flag's metadata. Returns updated flag. */
  updateFlag(key: string, input: UpdateFlagInput): Promise<Flag>;

  /** Set flag status (active, killed, archived). */
  setFlagStatus(key: string, status: FlagStatus): Promise<void>;

  /** Permanently delete a flag and all associated data. */
  deleteFlag(key: string): Promise<void>;

  /** Clone a flag to a new key. */
  cloneFlag(
    sourceKey: string,
    newKey: string,
    includeRules: boolean,
    includeRollout: boolean
  ): Promise<Flag>;

  // ── Flag Rollout ─────────────────────────────────────────────────────

  /** Set/update rollout configuration for a flag. */
  setRollout(
    key: string,
    rollout: { percentage?: number; sticky?: boolean; hashKey?: string; rampSchedule?: { at: string; percentage: number }[] }
  ): Promise<void>;

  // ── Rules ────────────────────────────────────────────────────────────

  /** Add a targeting rule to a flag. Returns created rule. */
  addRule(flagKey: string, input: AddRuleInput): Promise<FlagRule>;

  /** Update an existing rule. Returns updated rule. */
  updateRule(flagKey: string, ruleId: string, input: UpdateRuleInput): Promise<FlagRule>;

  /** Remove a rule from a flag. */
  removeRule(flagKey: string, ruleId: string): Promise<void>;

  /** List all rules for a flag, sorted by priority. */
  listRules(flagKey: string): Promise<FlagRule[]>;

  /** Reorder rules by setting new priorities. */
  reorderRules(flagKey: string, ordering: RuleOrdering[]): Promise<void>;

  // ── Segments ─────────────────────────────────────────────────────────

  /** Create a new segment. Throws FlagConflictError if key exists. */
  createSegment(input: CreateSegmentInput): Promise<Segment>;

  /** Update a segment. */
  updateSegment(key: string, input: UpdateSegmentInput): Promise<Segment>;

  /** Delete a segment. */
  deleteSegment(key: string): Promise<void>;

  /** List all segments. */
  listSegments(): Promise<Segment[]>;

  /** Get a segment by key. */
  getSegment(key: string): Promise<Segment | null>;

  /** Find which flags reference a segment. */
  getSegmentUsage(key: string): Promise<SegmentUsage[]>;

  // ── Releases ─────────────────────────────────────────────────────────

  /** Create a new release (batch of flag changes). */
  createRelease(input: CreateReleaseInput): Promise<Release>;

  /** Get a release by ID. */
  getRelease(releaseId: string): Promise<Release | null>;

  /** List releases with filtering. */
  listReleases(filters?: {
    environment?: string;
    status?: string;
    limit?: number;
  }): Promise<Release[]>;

  /** Mark a release as deployed and apply all its changes atomically. */
  deployRelease(releaseId: string, deployedBy?: string): Promise<void>;

  /** Mark a release as rolled back and revert all its changes. */
  rollbackRelease(releaseId: string, rolledBackBy?: string, reason?: string): Promise<void>;

  // ── Sticky Assignments ───────────────────────────────────────────────

  /** Get a user's sticky variant assignment for a flag. */
  getUserAssignment(flagKey: string, userId: string): Promise<string | null>;

  /**
   * Batched variant: return assignments for many flags in one round-trip.
   * Optional — when omitted, FlagManager.evaluateAll falls back to N calls.
   * Implement in production adapters to avoid N+1 queries on bulk evaluate.
   */
  getUserAssignments?(
    flagKeys: string[],
    userId: string
  ): Promise<Record<string, string>>;

  /** Set a user's sticky variant assignment. */
  setUserAssignment(flagKey: string, userId: string, variantKey: string): Promise<void>;

  // ── History / Audit ──────────────────────────────────────────────────

  /** Record a history entry for a flag. */
  addHistory(entry: Omit<HistoryEntry, "id">): Promise<void>;

  /** Get history for a flag. */
  getHistory(flagKey: string, opts?: { limit?: number }): Promise<HistoryEntry[]>;

  // ── Impressions (Optional) ───────────────────────────────────────────

  /** Record an evaluation impression. */
  trackImpression?(params: {
    flagKey: string;
    userId: string;
    value: unknown;
    variant: string | null;
    reason: string;
  }): Promise<void>;

  // ── Bulk Operations ──────────────────────────────────────────────────

  /**
   * Get all active flags for bulk evaluation. Supports pagination so very
   * large flag tables don't have to be loaded into memory at once.
   */
  getAllActiveFlags(opts?: {
    namespace?: string;
    tags?: string[];
    keys?: string[];
    limit?: number;
    offset?: number;
  }): Promise<Flag[]>;

  // ── Tags ─────────────────────────────────────────────────────────────

  /** Add tags to a flag. */
  addTags(flagKey: string, tags: string[]): Promise<void>;

  /** Remove tags from a flag. */
  removeTags(flagKey: string, tags: string[]): Promise<void>;

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Close any active database connections. */
  close?(): Promise<void>;
}

/**
 * Cache adapter interface for L2 (shared) caching.
 */
export interface CacheAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
  delPattern?(pattern: string): Promise<void>;
  close?(): Promise<void>;
}
