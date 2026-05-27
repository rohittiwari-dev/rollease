// ============================================================================
// Rollease SDK — Flag Manager
// The main rl.flags API surface.
// ============================================================================

import type { DbAdapter, CacheAdapter } from "../db/adapter";
import type {
  AuditActor,
  Flag,
  FlagContext,
  FlagResult,
  FlagMap,
  DetailedFlagMap,
  Variant,
  FlagRule,
  Segment,
  Release,
  ReleasePreview,
  HistoryEntry,
  HistoryAction,
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
  SegmentUsage,
  RolloutConfig,
  RolleaseHooks,
  ImpressionConfig,
  SetLockInput,
} from "../core/types";
import {
  FlagNotFoundError,
  FlagLockedError,
  ValidationError,
} from "../core/errors";
import { evaluateFlag, evaluateConditionGroup } from "./evaluator";
import { MemoryCacheAdapter } from "../db/memory";
import { loadLocalOverrides } from "../overrides";
import {
  assertSafeConditionGroup,
  assertSafeFlagKey,
} from "../core/security";
import {
  createLogger,
  noopLogger,
  type RolleaseLogger,
} from "../core/logger";

type ChangeListener = (event: {
  flagKey: string;
  action: string;
  value?: unknown;
}) => void;

const OVERRIDE_CACHE_TTL_MS = 5000;
const DEFAULT_PAGE_SIZE = 1000;

export class FlagManager {
  private db: DbAdapter;
  private l1Cache: MemoryCacheAdapter;
  private l2Cache?: CacheAdapter;
  private l1TtlMs: number;
  private l2TtlMs: number;
  private useLocalOverrides: boolean;
  private localOverridesFile: string;
  private listeners: ChangeListener[] = [];
  private hooks: RolleaseHooks;
  private impressions: Required<ImpressionConfig>;
  private logger: RolleaseLogger;
  private evaluateAllPageSize: number;
  private autoResolveSegments: boolean;
  private overrideCache: Record<string, unknown> | null = null;
  private overrideReadAt = 0;

  constructor(opts: {
    db: DbAdapter;
    l2Cache?: CacheAdapter;
    l1TtlMs?: number;
    l2TtlMs?: number;
    useLocalOverrides?: boolean;
    localOverridesFile?: string;
    hooks?: RolleaseHooks;
    impressions?: ImpressionConfig;
    logger?: RolleaseLogger;
    evaluateAllPageSize?: number;
    autoResolveSegments?: boolean;
  }) {
    this.db = opts.db;
    this.l1Cache = new MemoryCacheAdapter();
    this.l2Cache = opts.l2Cache;
    this.l1TtlMs = opts.l1TtlMs ?? 5000;
    this.l2TtlMs = opts.l2TtlMs ?? 60000;
    this.useLocalOverrides = opts.useLocalOverrides ?? false;
    this.localOverridesFile = opts.localOverridesFile ?? ".rolleaserc.json";
    this.hooks = opts.hooks ?? {};
    this.impressions = {
      enabled: opts.impressions?.enabled ?? true,
      sampleRate: opts.impressions?.sampleRate ?? 1,
    };
    this.logger = opts.logger ?? noopLogger;
    this.evaluateAllPageSize = opts.evaluateAllPageSize ?? DEFAULT_PAGE_SIZE;
    this.autoResolveSegments = opts.autoResolveSegments ?? false;
  }

  // ── Flag CRUD ────────────────────────────────────────────────────────

  async create(input: CreateFlagInput): Promise<Flag> {
    assertSafeFlagKey(input.key, "flag key");

    // FEAT-08: Validate default value type matches flag type
    if (input.type === "boolean" && typeof input.defaultValue !== "boolean") {
      throw new ValidationError(
        `Boolean flag "${input.key}" must have a boolean default value, got ${typeof input.defaultValue}`,
        { flagKey: input.key, type: input.type, defaultValue: input.defaultValue }
      );
    }
    if (input.type === "number" && typeof input.defaultValue !== "number") {
      throw new ValidationError(
        `Number flag "${input.key}" must have a numeric default value, got ${typeof input.defaultValue}`,
        { flagKey: input.key, type: input.type, defaultValue: input.defaultValue }
      );
    }
    if (input.type === "string" && typeof input.defaultValue !== "string") {
      throw new ValidationError(
        `String flag "${input.key}" must have a string default value, got ${typeof input.defaultValue}`,
        { flagKey: input.key, type: input.type, defaultValue: input.defaultValue }
      );
    }

    // FEAT-09: Validate variant weights sum to 100 for multivariate flags
    if (input.type === "multivariate" && input.variants && input.variants.length > 0) {
      const totalWeight = input.variants.reduce((sum, v) => sum + v.weight, 0);
      if (totalWeight !== 100) {
        throw new ValidationError(
          `Multivariate flag "${input.key}" variant weights must sum to 100, got ${totalWeight}`,
          { flagKey: input.key, totalWeight, variants: input.variants.map((v) => ({ key: v.key, weight: v.weight })) }
        );
      }
    }

    await this.runMutationHook("flag.created", input.key, input.actor);
    const flag = await this.db.createFlag(input);
    this.emit({ flagKey: input.key, action: "created" });
    return flag;
  }

  async get(key: string): Promise<Flag> {
    const flag = await this.db.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    return flag;
  }

  async list(filters?: ListFlagsInput): Promise<ListFlagsResult> {
    return this.db.listFlags(filters || {});
  }

  async update(key: string, patch: UpdateFlagInput): Promise<Flag> {
    const flag = await this.db.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    if (flag.locked) {
      // A locked flag can only be modified via setLock(). Trying to sneak
      // `{ locked: false }` through update() must fail loudly so RBAC and
      // audit trails always go through the explicit lock-management path.
      throw new FlagLockedError(key, flag.lockedReason);
    }
    // Strip lock-management fields — these belong to setLock().
    const { locked: _locked, lockedReason: _lockedReason, actor, ...safePatch } = patch;
    await this.runMutationHook("flag.updated", key, actor);
    const updated = await this.db.updateFlag(key, safePatch);
    await this.bustCache(key);
    this.emit({ flagKey: key, action: "updated" });
    return updated;
  }

  async setLock(key: string, input: SetLockInput): Promise<Flag> {
    const flag = await this.db.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    const action: HistoryAction = input.locked ? "flag.locked" : "flag.unlocked";
    await this.runMutationHook(action, key, input.actor);
    const updated = await this.db.updateFlag(key, {
      locked: input.locked,
      lockedReason: input.locked ? input.reason : undefined,
    });
    await this.db.addHistory({
      flagKey: key,
      action,
      by: input.actor,
      reason: input.reason,
      at: new Date(),
    });
    await this.bustCache(key);
    this.emit({ flagKey: key, action: input.locked ? "locked" : "unlocked" });
    return updated;
  }

  async archive(key: string, opts?: ArchiveFlagInput): Promise<void> {
    const flag = await this.db.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    await this.runMutationHook("flag.archived", key, opts?.actor);
    await this.db.setFlagStatus(key, "archived");
    await this.db.addHistory({
      flagKey: key,
      action: "flag.archived",
      by: opts?.actor ?? opts?.archivedBy,
      reason: opts?.reason,
      at: new Date(),
    });
    await this.bustCache(key);
    this.emit({ flagKey: key, action: "archived" });
  }

  async restore(key: string, opts?: RestoreFlagInput): Promise<void> {
    const flag = await this.db.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    await this.runMutationHook("flag.restored", key, opts?.actor);
    await this.db.setFlagStatus(key, "active");
    await this.db.addHistory({
      flagKey: key,
      action: "flag.restored",
      by: opts?.actor ?? opts?.restoredBy,
      reason: opts?.reason,
      at: new Date(),
    });
    await this.bustCache(key);
    this.emit({ flagKey: key, action: "restored" });
  }

  async delete(
    key: string,
    opts?: { confirm: boolean; actor?: AuditActor }
  ): Promise<void> {
    if (opts?.confirm !== true) {
      throw new ValidationError(
        "You must pass { confirm: true } to delete a flag",
        { flagKey: key }
      );
    }
    await this.runMutationHook("flag.deleted", key, opts.actor);
    await this.db.deleteFlag(key);
    await this.bustCache(key);
    this.emit({ flagKey: key, action: "deleted" });
  }

  async clone(key: string, opts: CloneFlagInput): Promise<Flag> {
    assertSafeFlagKey(opts.newKey, "flag key");
    await this.runMutationHook("flag.cloned", opts.newKey, opts.actor);
    return this.db.cloneFlag(
      key,
      opts.newKey,
      opts.includeRules ?? true,
      opts.includeRollout ?? false
    );
  }

  async getHistory(key: string, opts?: { limit?: number }): Promise<HistoryEntry[]> {
    return this.db.getHistory(key, opts);
  }

  // ── Evaluation ───────────────────────────────────────────────────────

  async isEnabled(key: string, context: FlagContext): Promise<boolean> {
    const result = await this.evaluate(key, context);
    return result.enabled;
  }

  async getVariant(key: string, context: FlagContext): Promise<Variant> {
    const result = await this.evaluate(key, context);
    return {
      key: result.variant || "default",
      value: result.value,
      reason: result.reason,
    };
  }

  async getValue<T = unknown>(key: string, context: FlagContext): Promise<T> {
    const result = await this.evaluate<T>(key, context);
    return result.value;
  }

  async evaluateAll(
    context: FlagContext,
    opts?: { keys?: string[]; namespace?: string; tags?: string[] }
  ): Promise<FlagMap> {
    const detailed = await this.evaluateAllDetailed(context, opts);
    const out: FlagMap = {};
    for (const [key, result] of Object.entries(detailed)) {
      out[key] = result.value;
    }
    return out;
  }

  async evaluateAllDetailed(
    context: FlagContext,
    opts?: { keys?: string[]; namespace?: string; tags?: string[] }
  ): Promise<DetailedFlagMap> {
    const result: DetailedFlagMap = {};
    const allFlags: Flag[] = [];

    // Stream pages of active flags so the DB query never returns the whole
    // table in one shot.
    let offset = 0;
    while (true) {
      const page = await this.db.getAllActiveFlags({
        keys: opts?.keys,
        namespace: opts?.namespace,
        tags: opts?.tags,
        limit: this.evaluateAllPageSize,
        offset,
      });
      if (page.length === 0) break;
      allFlags.push(...page);
      if (page.length < this.evaluateAllPageSize) break;
      offset += page.length;
    }

    // Batch assignment lookups so we don't issue N round-trips.
    let assignments: Record<string, string> = {};
    if (context.userId && allFlags.length > 0) {
      const flagKeys = allFlags.map((f) => f.key);
      if (typeof this.db.getUserAssignments === "function") {
        assignments = await this.db.getUserAssignments(flagKeys, context.userId);
      } else {
        for (const key of flagKeys) {
          const v = await this.db.getUserAssignment(key, context.userId);
          if (v) assignments[key] = v;
        }
      }
    }

    for (const flag of allFlags) {
      try {
        await this.runBeforeEvaluation(flag.key, context);
      } catch (err) {
        // Hook denied this flag — surface as disabled rather than crashing
        // the whole evaluateAll call. RBAC will use this path for tenant
        // isolation.
        this.logger.debug("onBeforeEvaluation denied flag", {
          flagKey: flag.key,
          err: errMessage(err),
        });
        continue;
      }
      const rules = await this.getRulesCached(flag.key);
      const evalResult = evaluateFlag(flag, context, {
        rules,
        userAssignment: assignments[flag.key] ?? undefined,
        localOverride: this.getLocalOverride(flag.key),
        onWarning: (msg, meta) => this.logger.warn(msg, meta),
      });
      result[flag.key] = evalResult;
      this.maybeTrackImpression(evalResult, context);
      this.fireOnEvaluate(evalResult, context);
    }

    return result;
  }

  // ── Kill Switch ──────────────────────────────────────────────────────

  async kill(key: string, opts?: KillFlagInput): Promise<void> {
    const flag = await this.db.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    await this.runMutationHook("flag.killed", key, opts?.actor);
    await this.db.setFlagStatus(key, "killed");
    await this.db.addHistory({
      flagKey: key,
      action: "flag.killed",
      by: opts?.actor ?? opts?.killedBy,
      reason: opts?.reason,
      at: new Date(),
    });
    await this.bustCache(key);
    this.emit({ flagKey: key, action: "killed" });
  }

  async killAll(opts: {
    environment?: string;
    reason?: string;
    killedBy?: string;
    actor?: AuditActor;
  }): Promise<void> {
    await this.runMutationHook("flag.killed", undefined, opts.actor);
    const flags = await this.db.getAllActiveFlags();
    for (const flag of flags) {
      await this.db.setFlagStatus(flag.key, "killed");
    }
    await this.bustAllCaches();
    this.emit({ flagKey: "*", action: "killed_all" });
  }

  async restoreAll(opts: {
    environment?: string;
    restoredBy?: string;
    actor?: AuditActor;
  }): Promise<void> {
    await this.runMutationHook("flag.restored", undefined, opts.actor);
    const allFlags = await this.db.listFlags({ status: "killed" });
    for (const flag of allFlags.data) {
      await this.db.setFlagStatus(flag.key, "active");
    }
    await this.bustAllCaches();
    this.emit({ flagKey: "*", action: "restored_all" });
  }

  // ── Rules ────────────────────────────────────────────────────────────

  async addRule(flagKey: string, rule: AddRuleInput): Promise<FlagRule> {
    await this.ensureNotLocked(flagKey);
    assertSafeConditionGroup(rule.conditions, "rule.conditions");
    await this.runMutationHook("rule.added", flagKey, rule.actor);
    const created = await this.db.addRule(flagKey, rule);
    await this.bustCache(flagKey);
    this.emit({ flagKey, action: "rule_added" });
    return created;
  }

  async updateRule(
    flagKey: string,
    ruleId: string,
    patch: UpdateRuleInput
  ): Promise<FlagRule> {
    await this.ensureNotLocked(flagKey);
    if (patch.conditions) {
      assertSafeConditionGroup(patch.conditions, "rule.conditions");
    }
    await this.runMutationHook("rule.updated", flagKey, patch.actor);
    const updated = await this.db.updateRule(flagKey, ruleId, patch);
    await this.bustCache(flagKey);
    this.emit({ flagKey, action: "rule_updated" });
    return updated;
  }

  async removeRule(
    flagKey: string,
    ruleId: string,
    opts?: { actor?: AuditActor }
  ): Promise<void> {
    await this.ensureNotLocked(flagKey);
    await this.runMutationHook("rule.removed", flagKey, opts?.actor);
    await this.db.removeRule(flagKey, ruleId);
    await this.bustCache(flagKey);
    this.emit({ flagKey, action: "rule_removed" });
  }

  async listRules(flagKey: string): Promise<FlagRule[]> {
    return this.db.listRules(flagKey);
  }

  async reorderRules(
    flagKey: string,
    ordering: RuleOrdering[],
    opts?: { actor?: AuditActor }
  ): Promise<void> {
    await this.ensureNotLocked(flagKey);
    await this.runMutationHook("rule.reordered", flagKey, opts?.actor);
    await this.db.reorderRules(flagKey, ordering);
    await this.bustCache(flagKey);
  }

  // ── Rollout ──────────────────────────────────────────────────────────

  async setRollout(
    key: string,
    config: Partial<RolloutConfig>,
    opts?: { actor?: AuditActor }
  ): Promise<void> {
    await this.ensureNotLocked(key);
    await this.runMutationHook("rollout.set", key, opts?.actor);
    await this.db.setRollout(key, config);
    await this.bustCache(key);
    this.emit({ flagKey: key, action: "rollout_set" });
  }

  // ── Segments ─────────────────────────────────────────────────────────

  async createSegment(input: CreateSegmentInput): Promise<Segment> {
    assertSafeFlagKey(input.key, "segment key");
    assertSafeConditionGroup(input.rules, "segment.rules");
    await this.runMutationHook("segment.created", undefined, input.actor);
    return this.db.createSegment(input);
  }

  async updateSegment(key: string, patch: UpdateSegmentInput): Promise<Segment> {
    if (patch.rules) {
      assertSafeConditionGroup(patch.rules, "segment.rules");
    }
    await this.runMutationHook("segment.updated", undefined, patch.actor);
    return this.db.updateSegment(key, patch);
  }

  async deleteSegment(key: string, opts?: { actor?: AuditActor }): Promise<void> {
    await this.runMutationHook("segment.deleted", undefined, opts?.actor);
    return this.db.deleteSegment(key);
  }

  async listSegments(): Promise<Segment[]> {
    return this.db.listSegments();
  }

  async getSegmentUsage(key: string): Promise<SegmentUsage[]> {
    return this.db.getSegmentUsage(key);
  }

  // ── Releases ─────────────────────────────────────────────────────────

  async createRelease(input: CreateReleaseInput): Promise<Release> {
    return this.db.createRelease(input);
  }

  async previewRelease(releaseId: string): Promise<ReleasePreview[]> {
    const release = await this.db.getRelease(releaseId);
    if (!release) throw new ValidationError("Release not found", { releaseId });

    const previews: ReleasePreview[] = [];
    for (const change of release.changes) {
      const flag = await this.db.getFlag(change.flagKey);
      if (!flag) continue;

      const before = { value: flag.defaultValue, status: flag.status };
      let afterValue = flag.defaultValue;
      let afterStatus = flag.status;

      switch (change.action) {
        case "enable":
          afterValue = change.value ?? true;
          afterStatus = "active";
          break;
        case "disable":
          afterValue = change.value ?? false;
          break;
        case "setValue":
          afterValue = change.value;
          break;
        case "kill":
          afterStatus = "killed";
          break;
        case "restore":
          afterStatus = "active";
          break;
      }

      previews.push({
        flagKey: change.flagKey,
        before,
        after: { value: afterValue, status: afterStatus },
      });
    }

    return previews;
  }

  async deployRelease(releaseId: string, opts?: DeployReleaseInput): Promise<void> {
    await this.runMutationHook("release.deployed", undefined, opts?.actor);
    await this.db.deployRelease(releaseId, opts?.deployedBy);
    await this.bustAllCaches();
    this.emit({ flagKey: "*", action: "release_deployed" });
  }

  async rollbackRelease(releaseId: string, opts?: RollbackReleaseInput): Promise<void> {
    await this.runMutationHook("release.rolled_back", undefined, opts?.actor);
    await this.db.rollbackRelease(releaseId, opts?.rolledBackBy, opts?.reason);
    await this.bustAllCaches();
    this.emit({ flagKey: "*", action: "release_rolled_back" });
  }

  async listReleases(filters?: {
    environment?: string;
    status?: string;
    limit?: number;
  }): Promise<Release[]> {
    return this.db.listReleases(filters);
  }

  // ── Tags ─────────────────────────────────────────────────────────────

  async addTags(
    key: string,
    tags: string[],
    opts?: { actor?: AuditActor }
  ): Promise<void> {
    await this.runMutationHook("tags.added", key, opts?.actor);
    await this.db.addTags(key, tags);
  }

  async removeTags(
    key: string,
    tags: string[],
    opts?: { actor?: AuditActor }
  ): Promise<void> {
    await this.runMutationHook("tags.removed", key, opts?.actor);
    await this.db.removeTags(key, tags);
  }

  // ── Cache ────────────────────────────────────────────────────────────

  async invalidateCache(key: string): Promise<void> {
    await this.bustCache(key);
  }

  async invalidateAllCaches(): Promise<void> {
    await this.bustAllCaches();
  }

  // ── Events ───────────────────────────────────────────────────────────

  onChange(listener: ChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  private async evaluate<T = unknown>(
    key: string,
    context: FlagContext
  ): Promise<FlagResult<T>> {
    try {
      await this.runBeforeEvaluation(key, context);
    } catch (err) {
      // Hook rejected this evaluation (e.g. RBAC). Surface as disabled +
      // default value with a recognizable reason.
      this.logger.debug("onBeforeEvaluation denied", {
        flagKey: key,
        err: errMessage(err),
      });
      return missingFlagResult<T>(key);
    }

    // Auto-resolve segments when enabled and caller hasn't pre-populated them
    if (this.autoResolveSegments && (!context.segments || context.segments.length === 0)) {
      context = { ...context, segments: await this.resolveSegments(context) };
    }

    const flag = await this.getFlagCached(key);
    if (!flag) {
      return missingFlagResult<T>(key);
    }

    const rules = await this.getRulesCached(key);
    let assignment: string | null = null;
    if (context.userId) {
      assignment = await this.db.getUserAssignment(key, context.userId);
    }

    const result = evaluateFlag<T>(flag, context, {
      rules,
      userAssignment: assignment || undefined,
      localOverride: this.getLocalOverride(key),
      onWarning: (msg, meta) => this.logger.warn(msg, meta),
    });

    this.maybeTrackImpression(result, context);
    this.fireOnEvaluate(result, context);

    return result;
  }

  /**
   * Resolve segments automatically by evaluating all segment definitions
   * against the provided context. Returns an array of matching segment keys.
   *
   * This is opt-in via `autoResolveSegments: true` in the config.
   * When segments are pre-populated in context, this step is skipped.
   */
  private async resolveSegments(context: FlagContext): Promise<string[]> {
    try {
      const segments = await this.db.listSegments();
      const matched: string[] = [];
      for (const segment of segments) {
        try {
          if (evaluateConditionGroup(segment.rules, context)) {
            matched.push(segment.key);
          }
        } catch (err) {
          this.logger.warn("segment evaluation failed", {
            segmentKey: segment.key,
            err: errMessage(err),
          });
        }
      }
      return matched;
    } catch (err) {
      this.logger.warn("segment auto-resolution failed", {
        err: errMessage(err),
      });
      return [];
    }
  }

  // ── Cache Helpers ────────────────────────────────────────────────────

  private flagCacheKey(key: string): string {
    return `rollease:flag:${key}`;
  }

  private rulesCacheKey(key: string): string {
    return `rollease:rules:${key}`;
  }

  private async getFlagCached(key: string): Promise<Flag | null> {
    const cacheKey = this.flagCacheKey(key);

    // L1
    const l1Hit = await this.l1Cache.get(cacheKey);
    if (l1Hit !== null) {
      return parseCachedFlag(l1Hit);
    }

    // L2
    if (this.l2Cache) {
      const l2Hit = await this.l2Cache.get(cacheKey);
      if (l2Hit !== null) {
        await this.l1Cache.set(cacheKey, l2Hit, this.l1TtlMs);
        return parseCachedFlag(l2Hit);
      }
    }

    // DB
    const flag = await this.db.getFlag(key);
    if (flag) {
      const serialized = JSON.stringify(flag);
      await this.l1Cache.set(cacheKey, serialized, this.l1TtlMs);
      if (this.l2Cache) {
        await this.l2Cache.set(cacheKey, serialized, this.l2TtlMs);
      }
    } else {
      // Negative-cache misses briefly to avoid hammering DB for nonexistent keys.
      await this.l1Cache.set(cacheKey, "null", this.l1TtlMs);
    }
    return flag;
  }

  private async getRulesCached(key: string): Promise<FlagRule[]> {
    const cacheKey = this.rulesCacheKey(key);

    const l1Hit = await this.l1Cache.get(cacheKey);
    if (l1Hit !== null) {
      const parsed = parseCachedRules(l1Hit);
      if (parsed) return parsed;
    }

    if (this.l2Cache) {
      const l2Hit = await this.l2Cache.get(cacheKey);
      if (l2Hit !== null) {
        await this.l1Cache.set(cacheKey, l2Hit, this.l1TtlMs);
        const parsed = parseCachedRules(l2Hit);
        if (parsed) return parsed;
      }
    }

    const rules = await this.db.listRules(key);
    const serialized = JSON.stringify(rules);
    await this.l1Cache.set(cacheKey, serialized, this.l1TtlMs);
    if (this.l2Cache) {
      await this.l2Cache.set(cacheKey, serialized, this.l2TtlMs);
    }
    return rules;
  }

  // ── Override Cache (instance-scoped, not module-scoped) ───────────────

  private getLocalOverride(key: string): unknown | undefined {
    if (!this.useLocalOverrides) return undefined;
    const now = Date.now();
    if (
      !this.overrideCache ||
      now - this.overrideReadAt > OVERRIDE_CACHE_TTL_MS
    ) {
      try {
        this.overrideCache = loadLocalOverrides(this.localOverridesFile);
      } catch {
        this.overrideCache = {};
      }
      this.overrideReadAt = now;
    }
    return this.overrideCache[key];
  }

  private async ensureNotLocked(key: string): Promise<void> {
    const flag = await this.db.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    if (flag.locked) throw new FlagLockedError(key, flag.lockedReason);
  }

  private async bustCache(key: string): Promise<void> {
    const flagKey = this.flagCacheKey(key);
    const rulesKey = this.rulesCacheKey(key);
    await this.l1Cache.del(flagKey);
    await this.l1Cache.del(rulesKey);
    await this.l1Cache.del("rollease:all");
    if (this.l2Cache) {
      await this.l2Cache.del(flagKey);
      await this.l2Cache.del(rulesKey);
      await this.l2Cache.del("rollease:all");
    }
  }

  private async bustAllCaches(): Promise<void> {
    await this.l1Cache.delPattern("rollease:*");
    if (this.l2Cache?.delPattern) {
      await this.l2Cache.delPattern("rollease:*");
    }
  }

  private emit(event: { flagKey: string; action: string; value?: unknown }): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.warn("change listener threw", {
          flagKey: event.flagKey,
          action: event.action,
          err: errMessage(err),
        });
      }
    }
  }

  // ── Hooks & Impressions ──────────────────────────────────────────────

  private async runMutationHook(
    action: HistoryAction,
    flagKey: string | undefined,
    actor: AuditActor | undefined
  ): Promise<void> {
    if (!this.hooks.onBeforeMutation) return;
    await this.hooks.onBeforeMutation({ action, flagKey, actor });
  }

  private async runBeforeEvaluation(
    flagKey: string,
    context: FlagContext
  ): Promise<void> {
    if (!this.hooks.onBeforeEvaluation) return;
    await this.hooks.onBeforeEvaluation({ flagKey, context });
  }

  private fireOnEvaluate(result: FlagResult, context: FlagContext): void {
    if (!this.hooks.onEvaluate) return;
    // Fire-and-forget — hook errors are logged, never thrown.
    Promise.resolve()
      .then(() => this.hooks.onEvaluate?.(result, context))
      .catch((err) => {
        this.logger.warn("onEvaluate hook threw", {
          flagKey: result.key,
          err: errMessage(err),
        });
      });
  }

  private maybeTrackImpression(result: FlagResult, context: FlagContext): void {
    if (!this.impressions.enabled) return;
    if (!context.userId) return;
    if (!this.db.trackImpression) return;
    if (NON_TRACKED_REASONS.has(result.reason)) return;
    if (
      this.impressions.sampleRate < 1 &&
      Math.random() >= this.impressions.sampleRate
    ) {
      return;
    }
    // Fire-and-forget — never block evaluation on impression IO.
    this.db
      .trackImpression({
        flagKey: result.key,
        userId: context.userId,
        value: result.value,
        variant: result.variant,
        reason: result.reason,
      })
      .catch((err) =>
        this.logger.warn("impression tracking failed", {
          flagKey: result.key,
          err: errMessage(err),
        })
      );
  }
}

// ── Module helpers ─────────────────────────────────────────────────────

const NON_TRACKED_REASONS = new Set([
  "kill_switch",
  "disabled",
  "not_scheduled",
  "expired",
]);



function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function missingFlagResult<T>(key: string): FlagResult<T> {
  return {
    key,
    value: undefined as T,
    variant: null,
    enabled: false,
    reason: "default",
    ruleId: null,
    evaluatedAt: new Date(),
  };
}

function parseCachedFlag(serialized: string): Flag | null {
  if (serialized === "null") return null;
  try {
    return JSON.parse(serialized) as Flag;
  } catch {
    return null;
  }
}

function parseCachedRules(serialized: string): FlagRule[] | null {
  try {
    const parsed = JSON.parse(serialized);
    return Array.isArray(parsed) ? (parsed as FlagRule[]) : null;
  } catch {
    return null;
  }
}
