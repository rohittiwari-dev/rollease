// ============================================================================
// Rollease SDK — Flag Manager
// The main rl.flags API surface.
// ============================================================================

import type { DbAdapter, CacheAdapter } from "../db/adapter";
import type {
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
} from "../core/types";
import {
  FlagNotFoundError,
  FlagLockedError,
  ValidationError,
} from "../core/errors";
import { evaluateFlag } from "./evaluator";
import { MemoryCacheAdapter } from "../db/memory";
import { loadLocalOverrides } from "../overrides";
import { assertSafeConditionGroup } from "../core/security";

type ChangeListener = (event: {
  flagKey: string;
  action: string;
  value?: unknown;
}) => void;

export class FlagManager {
  private db: DbAdapter;
  private l1Cache: MemoryCacheAdapter;
  private l2Cache?: CacheAdapter;
  private l1TtlMs: number;
  private l2TtlMs: number;
  private useLocalOverrides: boolean;
  private localOverridesFile: string;
  private listeners: ChangeListener[] = [];

  constructor(opts: {
    db: DbAdapter;
    l2Cache?: CacheAdapter;
    l1TtlMs?: number;
    l2TtlMs?: number;
    useLocalOverrides?: boolean;
    localOverridesFile?: string;
  }) {
    this.db = opts.db;
    this.l1Cache = new MemoryCacheAdapter();
    this.l2Cache = opts.l2Cache;
    this.l1TtlMs = opts.l1TtlMs ?? 5000;
    this.l2TtlMs = opts.l2TtlMs ?? 60000;
    this.useLocalOverrides = opts.useLocalOverrides ?? false;
    this.localOverridesFile = opts.localOverridesFile ?? ".rolleaserc.json";
  }

  // ── Flag CRUD ────────────────────────────────────────────────────────

  async create(input: CreateFlagInput): Promise<Flag> {
    this.validateFlagKey(input.key);
    return this.db.createFlag(input);
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
    if (flag.locked) throw new FlagLockedError(key, flag.lockedReason);
    const updated = await this.db.updateFlag(key, patch);
    await this.bustCache(key);
    this.emit({ flagKey: key, action: "updated" });
    return updated;
  }

  async archive(key: string, opts?: ArchiveFlagInput): Promise<void> {
    const flag = await this.db.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    await this.db.setFlagStatus(key, "archived");
    await this.db.addHistory({
      flagKey: key,
      action: "flag.archived",
      by: opts?.archivedBy,
      reason: opts?.reason,
      at: new Date(),
    });
    await this.bustCache(key);
    this.emit({ flagKey: key, action: "archived" });
  }

  async restore(key: string, opts?: RestoreFlagInput): Promise<void> {
    const flag = await this.db.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    await this.db.setFlagStatus(key, "active");
    await this.db.addHistory({
      flagKey: key,
      action: "flag.restored",
      by: opts?.restoredBy,
      reason: opts?.reason,
      at: new Date(),
    });
    await this.bustCache(key);
    this.emit({ flagKey: key, action: "restored" });
  }

  async delete(key: string, opts?: { confirm: boolean }): Promise<void> {
    if (!opts?.confirm) {
      throw new ValidationError("You must pass { confirm: true } to delete a flag", { flagKey: key });
    }
    await this.db.deleteFlag(key);
    await this.bustCache(key);
    this.emit({ flagKey: key, action: "deleted" });
  }

  async clone(key: string, opts: CloneFlagInput): Promise<Flag> {
    this.validateFlagKey(opts.newKey);
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
    const flags = await this.db.getAllActiveFlags(opts);
    const result: FlagMap = {};

    for (const flag of flags) {
      const rules = await this.db.listRules(flag.key);
      const assignment = context.userId
        ? await this.db.getUserAssignment(flag.key, context.userId)
        : null;

      const evalResult = evaluateFlag(flag, context, {
        rules,
        userAssignment: assignment || undefined,
        localOverride: this.getLocalOverride(flag.key),
      });

      result[flag.key] = evalResult.value;
    }

    return result;
  }

  async evaluateAllDetailed(
    context: FlagContext,
    opts?: { keys?: string[]; namespace?: string; tags?: string[] }
  ): Promise<DetailedFlagMap> {
    const flags = await this.db.getAllActiveFlags(opts);
    const result: DetailedFlagMap = {};

    for (const flag of flags) {
      const rules = await this.db.listRules(flag.key);
      const assignment = context.userId
        ? await this.db.getUserAssignment(flag.key, context.userId)
        : null;

      result[flag.key] = evaluateFlag(flag, context, {
        rules,
        userAssignment: assignment || undefined,
        localOverride: this.getLocalOverride(flag.key),
      });
    }

    return result;
  }

  // ── Kill Switch ──────────────────────────────────────────────────────

  async kill(key: string, opts?: KillFlagInput): Promise<void> {
    const flag = await this.db.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    await this.db.setFlagStatus(key, "killed");
    await this.db.addHistory({
      flagKey: key,
      action: "flag.killed",
      by: opts?.killedBy,
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
  }): Promise<void> {
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
  }): Promise<void> {
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
    const updated = await this.db.updateRule(flagKey, ruleId, patch);
    await this.bustCache(flagKey);
    this.emit({ flagKey, action: "rule_updated" });
    return updated;
  }

  async removeRule(flagKey: string, ruleId: string): Promise<void> {
    await this.ensureNotLocked(flagKey);
    await this.db.removeRule(flagKey, ruleId);
    await this.bustCache(flagKey);
    this.emit({ flagKey, action: "rule_removed" });
  }

  async listRules(flagKey: string): Promise<FlagRule[]> {
    return this.db.listRules(flagKey);
  }

  async reorderRules(flagKey: string, ordering: RuleOrdering[]): Promise<void> {
    await this.ensureNotLocked(flagKey);
    await this.db.reorderRules(flagKey, ordering);
    await this.bustCache(flagKey);
  }

  // ── Rollout ──────────────────────────────────────────────────────────

  async setRollout(
    key: string,
    config: Partial<RolloutConfig>
  ): Promise<void> {
    await this.ensureNotLocked(key);
    await this.db.setRollout(key, config);
    await this.bustCache(key);
    this.emit({ flagKey: key, action: "rollout_set" });
  }

  // ── Segments ─────────────────────────────────────────────────────────

  async createSegment(input: CreateSegmentInput): Promise<Segment> {
    assertSafeConditionGroup(input.rules, "segment.rules");
    return this.db.createSegment(input);
  }

  async updateSegment(key: string, patch: UpdateSegmentInput): Promise<Segment> {
    if (patch.rules) {
      assertSafeConditionGroup(patch.rules, "segment.rules");
    }
    return this.db.updateSegment(key, patch);
  }

  async deleteSegment(key: string): Promise<void> {
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
    await this.db.deployRelease(releaseId, opts?.deployedBy);
    await this.bustAllCaches();
    this.emit({ flagKey: "*", action: "release_deployed" });
  }

  async rollbackRelease(releaseId: string, opts?: RollbackReleaseInput): Promise<void> {
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

  async addTags(key: string, tags: string[]): Promise<void> {
    await this.db.addTags(key, tags);
  }

  async removeTags(key: string, tags: string[]): Promise<void> {
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
    const flag = await this.db.getFlag(key);
    if (!flag) {
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

    const rules = await this.db.listRules(key);
    const assignment = context.userId
      ? await this.db.getUserAssignment(key, context.userId)
      : null;

    return evaluateFlag<T>(flag, context, {
      rules,
      userAssignment: assignment || undefined,
      localOverride: this.getLocalOverride(key),
    });
  }

  private getLocalOverride(key: string): unknown | undefined {
    if (!this.useLocalOverrides) return undefined;
    try {
      const overrides = loadLocalOverrides(this.localOverridesFile);
      return overrides[key];
    } catch {
      return undefined;
    }
  }

  private async ensureNotLocked(key: string): Promise<void> {
    const flag = await this.db.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    if (flag.locked) throw new FlagLockedError(key, flag.lockedReason);
  }

  private validateFlagKey(key: string): void {
    if (!key || typeof key !== "string") {
      throw new ValidationError("Flag key is required");
    }
    if (!/^[a-z0-9._-]+$/.test(key)) {
      throw new ValidationError(
        `Invalid flag key "${key}". Keys must be lowercase and can only contain letters, numbers, dots, hyphens, and underscores.`,
        { key }
      );
    }
  }

  private async bustCache(key: string): Promise<void> {
    const cacheKey = `rollease:flag:${key}`;
    await this.l1Cache.del(cacheKey);
    if (this.l2Cache) {
      await this.l2Cache.del(cacheKey);
    }
    // Also bust bulk cache
    await this.l1Cache.del("rollease:all");
    if (this.l2Cache) {
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
      } catch {
        // Don't let listener errors break the SDK
      }
    }
  }
}
