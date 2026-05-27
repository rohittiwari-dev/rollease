// ============================================================================
// Rollease SDK — In-Memory Database Adapter
// For development, testing, and prototyping.
// ============================================================================

import type { DbAdapter, CacheAdapter } from "./adapter";
import type {
  Flag,
  FlagRule,
  Segment,
  Release,
  ReleaseSnapshot,
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
  FlagStatus,
  SegmentUsage,
} from "../core/types";
import {
  FlagNotFoundError,
  FlagConflictError,
  RuleNotFoundError,
  SegmentNotFoundError,
  ReleaseNotFoundError,
} from "../core/errors";
import {
  assertSafeConditionGroup,
  conditionReferencesSegment,
} from "../core/security";

/**
 * In-memory database adapter. All data is stored in Maps and lost on process restart.
 * Use for development, testing, and prototyping.
 */
export class MemoryDbAdapter implements DbAdapter {
  private idCounter = 0;
  private flags = new Map<string, Flag>();
  private rules = new Map<string, FlagRule[]>(); // flagKey → rules
  private segments = new Map<string, Segment>();
  private releases = new Map<string, Release>();
  private assignments = new Map<string, string>(); // `${flagKey}:${userId}` → variantKey
  private history: HistoryEntry[] = [];
  private impressions: Array<Record<string, unknown>> = [];

  private genId(prefix: string = "id"): string {
    return `${prefix}_${++this.idCounter}_${Date.now().toString(36)}`;
  }

  // ── Flag CRUD ────────────────────────────────────────────────────────

  async createFlag(input: CreateFlagInput): Promise<Flag> {
    if (this.flags.has(input.key)) {
      throw new FlagConflictError(input.key, "flag");
    }

    const now = new Date();
    const flag: Flag = {
      id: this.genId("flag"),
      key: input.key,
      type: input.type,
      status: "active",
      defaultValue: input.defaultValue,
      description: input.description,
      namespace: input.namespace,
      tags: input.tags || [],
      locked: false,
      environments: input.environments,
      variants: input.variants?.map((v) => ({ ...v, id: this.genId("var") })),
      rollout: input.rollout,
      scheduledAt: input.scheduledAt || null,
      expiresAt: input.expiresAt || null,
      createdAt: now,
      updatedAt: now,
    };

    this.flags.set(input.key, flag);
    this.rules.set(input.key, []);

    await this.addHistory({
      flagKey: input.key,
      action: "flag.created",
      at: now,
      changes: { input },
    });

    return flag;
  }

  async getFlag(key: string): Promise<Flag | null> {
    return this.flags.get(key) || null;
  }

  async listFlags(input: ListFlagsInput): Promise<ListFlagsResult> {
    let flags = Array.from(this.flags.values());

    // Filter by status
    if (input.status) {
      flags = flags.filter((f) => f.status === input.status);
    }

    // Filter by namespace
    if (input.namespace) {
      flags = flags.filter(
        (f) => f.namespace === input.namespace || f.key.startsWith(`${input.namespace}.`)
      );
    }

    // Filter by tags
    if (input.tags && input.tags.length > 0) {
      flags = flags.filter(
        (f) => f.tags && input.tags!.some((t) => f.tags!.includes(t))
      );
    }

    // Filter by environment
    if (input.environment) {
      flags = flags.filter(
        (f) => !f.environments || f.environments.includes(input.environment!)
      );
    }

    // Search
    if (input.search) {
      const q = input.search.toLowerCase();
      flags = flags.filter(
        (f) =>
          f.key.toLowerCase().includes(q) ||
          (f.description && f.description.toLowerCase().includes(q))
      );
    }

    const total = flags.length;
    const offset = input.offset || 0;
    const limit = input.limit || 50;
    const data = flags.slice(offset, offset + limit);

    return { data, total, hasMore: offset + limit < total };
  }

  async updateFlag(key: string, input: UpdateFlagInput): Promise<Flag> {
    const flag = this.flags.get(key);
    if (!flag) throw new FlagNotFoundError(key);

    const updated: Flag = {
      ...flag,
      ...input,
      updatedAt: new Date(),
      // Preserve fields not in input
      id: flag.id,
      key: flag.key,
      type: flag.type,
      status: flag.status,
      createdAt: flag.createdAt,
      variants: (input as Record<string, unknown>).variants !== undefined
        ? (input as Record<string, unknown>).variants as Flag["variants"]
        : flag.variants,
      rollout: (input as Record<string, unknown>).rollout !== undefined
        ? (input as Record<string, unknown>).rollout as Flag["rollout"]
        : flag.rollout,
    };

    // Merge tags if provided
    if (input.tags !== undefined) {
      updated.tags = input.tags;
    }

    this.flags.set(key, updated);

    await this.addHistory({
      flagKey: key,
      action: "flag.updated",
      at: new Date(),
      changes: input as unknown as Record<string, unknown>,
    });

    return updated;
  }

  async setFlagStatus(key: string, status: FlagStatus): Promise<void> {
    const flag = this.flags.get(key);
    if (!flag) throw new FlagNotFoundError(key);

    flag.status = status;
    flag.updatedAt = new Date();
    this.flags.set(key, flag);
  }

  async deleteFlag(key: string): Promise<void> {
    if (!this.flags.has(key)) throw new FlagNotFoundError(key);

    this.flags.delete(key);
    this.rules.delete(key);

    // Clean up assignments
    for (const k of this.assignments.keys()) {
      if (k.startsWith(`${key}:`)) {
        this.assignments.delete(k);
      }
    }

    await this.addHistory({
      flagKey: key,
      action: "flag.deleted",
      at: new Date(),
    });
  }

  async cloneFlag(
    sourceKey: string,
    newKey: string,
    includeRules: boolean,
    includeRollout: boolean
  ): Promise<Flag> {
    const source = this.flags.get(sourceKey);
    if (!source) throw new FlagNotFoundError(sourceKey);

    if (this.flags.has(newKey)) {
      throw new FlagConflictError(newKey, "flag");
    }

    const now = new Date();
    const cloned: Flag = {
      ...source,
      id: this.genId("flag"),
      key: newKey,
      status: "active",
      locked: false,
      lockedReason: undefined,
      rollout: includeRollout ? source.rollout : undefined,
      variants: source.variants?.map((v) => ({ ...v, id: this.genId("var") })),
      createdAt: now,
      updatedAt: now,
    };

    this.flags.set(newKey, cloned);

    // Clone rules if requested
    if (includeRules) {
      const sourceRules = this.rules.get(sourceKey) || [];
      const clonedRules = sourceRules.map((r) => ({
        ...r,
        id: this.genId("rule"),
        flagKey: newKey,
      }));
      this.rules.set(newKey, clonedRules);
    } else {
      this.rules.set(newKey, []);
    }

    return cloned;
  }

  // ── Rollout ──────────────────────────────────────────────────────────

  async setRollout(
    key: string,
    rollout: {
      percentage?: number;
      sticky?: boolean;
      hashKey?: string;
      rampSchedule?: { at: string; percentage: number }[];
    }
  ): Promise<void> {
    const flag = this.flags.get(key);
    if (!flag) throw new FlagNotFoundError(key);

    const prevRollout = flag.rollout;
    flag.rollout = {
      percentage: rollout.percentage ?? flag.rollout?.percentage ?? 0,
      sticky: rollout.sticky ?? flag.rollout?.sticky ?? true,
      hashKey: rollout.hashKey ?? flag.rollout?.hashKey ?? "userId",
      rampSchedule: rollout.rampSchedule ?? flag.rollout?.rampSchedule,
    };
    flag.updatedAt = new Date();
    this.flags.set(key, flag);

    await this.addHistory({
      flagKey: key,
      action: "rollout.set",
      at: new Date(),
      changes: {
        before: prevRollout,
        after: flag.rollout,
      },
    });
  }

  // ── Rules ────────────────────────────────────────────────────────────

  async addRule(flagKey: string, input: AddRuleInput): Promise<FlagRule> {
    if (!this.flags.has(flagKey)) throw new FlagNotFoundError(flagKey);
    assertSafeConditionGroup(input.conditions, "rule.conditions");

    const rule: FlagRule = {
      id: this.genId("rule"),
      flagKey,
      name: input.name,
      priority: input.priority,
      value: input.value,
      conditions: input.conditions,
      enabled: input.enabled ?? true,
      rolloutPct: input.rolloutPct,
      isHoldout: input.isHoldout,
      variantId: input.variantId,
    };

    const rules = this.rules.get(flagKey) || [];
    rules.push(rule);
    // Keep sorted by priority
    rules.sort((a, b) => a.priority - b.priority);
    this.rules.set(flagKey, rules);

    await this.addHistory({
      flagKey,
      action: "rule.added",
      at: new Date(),
      changes: { rule },
    });

    return rule;
  }

  async updateRule(
    flagKey: string,
    ruleId: string,
    input: UpdateRuleInput
  ): Promise<FlagRule> {
    const rules = this.rules.get(flagKey);
    if (!rules) throw new FlagNotFoundError(flagKey);

    const idx = rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) throw new RuleNotFoundError(flagKey, ruleId);
    if (input.conditions) {
      assertSafeConditionGroup(input.conditions, "rule.conditions");
    }

    const updated: FlagRule = { ...rules[idx], ...input };
    rules[idx] = updated;
    rules.sort((a, b) => a.priority - b.priority);
    this.rules.set(flagKey, rules);

    await this.addHistory({
      flagKey,
      action: "rule.updated",
      at: new Date(),
      changes: { ruleId, input },
    });

    return updated;
  }

  async removeRule(flagKey: string, ruleId: string): Promise<void> {
    const rules = this.rules.get(flagKey);
    if (!rules) throw new FlagNotFoundError(flagKey);

    const idx = rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) throw new RuleNotFoundError(flagKey, ruleId);

    rules.splice(idx, 1);
    this.rules.set(flagKey, rules);

    await this.addHistory({
      flagKey,
      action: "rule.removed",
      at: new Date(),
      changes: { ruleId },
    });
  }

  async listRules(flagKey: string): Promise<FlagRule[]> {
    return [...(this.rules.get(flagKey) || [])];
  }

  async reorderRules(
    flagKey: string,
    ordering: RuleOrdering[]
  ): Promise<void> {
    const rules = this.rules.get(flagKey);
    if (!rules) throw new FlagNotFoundError(flagKey);

    for (const { ruleId, priority } of ordering) {
      const rule = rules.find((r) => r.id === ruleId);
      if (rule) rule.priority = priority;
    }
    rules.sort((a, b) => a.priority - b.priority);
    this.rules.set(flagKey, rules);

    await this.addHistory({
      flagKey,
      action: "rule.reordered",
      at: new Date(),
      changes: { ordering },
    });
  }

  // ── Segments ─────────────────────────────────────────────────────────

  async createSegment(input: CreateSegmentInput): Promise<Segment> {
    if (this.segments.has(input.key)) {
      throw new FlagConflictError(input.key, "segment");
    }
    assertSafeConditionGroup(input.rules, "segment.rules");

    const now = new Date();
    const segment: Segment = {
      key: input.key,
      description: input.description,
      rules: input.rules,
      createdAt: now,
      updatedAt: now,
    };

    this.segments.set(input.key, segment);
    return segment;
  }

  async updateSegment(key: string, input: UpdateSegmentInput): Promise<Segment> {
    const segment = this.segments.get(key);
    if (!segment) throw new SegmentNotFoundError(key);
    if (input.rules) {
      assertSafeConditionGroup(input.rules, "segment.rules");
    }

    const updated: Segment = {
      ...segment,
      ...input,
      updatedAt: new Date(),
    };
    this.segments.set(key, updated);
    return updated;
  }

  async deleteSegment(key: string): Promise<void> {
    if (!this.segments.has(key)) throw new SegmentNotFoundError(key);
    this.segments.delete(key);
  }

  async listSegments(): Promise<Segment[]> {
    return Array.from(this.segments.values());
  }

  async getSegment(key: string): Promise<Segment | null> {
    return this.segments.get(key) || null;
  }

  async getSegmentUsage(key: string): Promise<SegmentUsage[]> {
    const usage: SegmentUsage[] = [];

    for (const [flagKey, rules] of this.rules) {
      for (const rule of rules) {
        if (conditionReferencesSegment(rule.conditions, key)) {
          usage.push({ flagKey, ruleId: rule.id });
        }
      }
    }

    return usage;
  }

  // ── Releases ─────────────────────────────────────────────────────────

  async createRelease(input: CreateReleaseInput): Promise<Release> {
    const now = new Date();
    const release: Release = {
      id: this.genId("rel"),
      name: input.name,
      description: input.description,
      environment: input.environment,
      status: input.scheduledAt ? "scheduled" : "pending",
      changes: input.changes,
      scheduledAt: input.scheduledAt || null,
      deployedAt: null,
      deployedBy: undefined,
      rolledBackAt: null,
      rolledBackBy: undefined,
      rollbackReason: undefined,
      createdAt: now,
    };

    this.releases.set(release.id, release);
    return release;
  }

  async getRelease(releaseId: string): Promise<Release | null> {
    return this.releases.get(releaseId) || null;
  }

  async listReleases(filters?: {
    environment?: string;
    status?: string;
    limit?: number;
  }): Promise<Release[]> {
    let releases = Array.from(this.releases.values());

    if (filters?.environment) {
      releases = releases.filter((r) => r.environment === filters.environment);
    }
    if (filters?.status) {
      releases = releases.filter((r) => r.status === filters.status);
    }

    // Sort by createdAt descending
    releases.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (filters?.limit) {
      releases = releases.slice(0, filters.limit);
    }

    return releases;
  }

  async deployRelease(releaseId: string, deployedBy?: string): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) throw new ReleaseNotFoundError(releaseId);

    const snapshots: ReleaseSnapshot[] = [];
    const snapshotted = new Set<string>();

    for (const change of release.changes) {
      const flag = this.flags.get(change.flagKey);
      if (!flag) continue;

      // Capture before-state so rollback can restore exact prior value.
      // Only snapshot the first time we encounter this flag — subsequent
      // changes to the same flag within this release should not overwrite
      // the original pre-deployment state.
      if (!snapshotted.has(change.flagKey)) {
        snapshotted.add(change.flagKey);
        snapshots.push({
          flagKey: change.flagKey,
          beforeValue: flag.defaultValue,
          beforeStatus: flag.status,
          beforeRollout: flag.rollout
            ? { ...flag.rollout, rampSchedule: flag.rollout.rampSchedule?.slice() }
            : undefined,
        });
      }

      switch (change.action) {
        case "enable":
          flag.defaultValue = change.value ?? true;
          flag.status = "active";
          break;
        case "disable":
          flag.defaultValue = change.value ?? false;
          break;
        case "setValue":
          flag.defaultValue = change.value;
          break;
        case "setRollout":
          if (change.rollout) {
            flag.rollout = {
              percentage: change.rollout.percentage ?? flag.rollout?.percentage ?? 0,
              sticky: change.rollout.sticky ?? flag.rollout?.sticky ?? true,
              hashKey: change.rollout.hashKey ?? flag.rollout?.hashKey ?? "userId",
              rampSchedule: change.rollout.rampSchedule ?? flag.rollout?.rampSchedule,
            };
          }
          break;
        case "kill":
          flag.status = "killed";
          break;
        case "restore":
          flag.status = "active";
          break;
      }

      flag.updatedAt = new Date();
      this.flags.set(change.flagKey, flag);
    }

    release.status = "deployed";
    release.deployedAt = new Date();
    release.deployedBy = deployedBy;
    release.snapshots = snapshots;
    this.releases.set(releaseId, release);

    await this.addHistory({
      action: "release.deployed",
      at: new Date(),
      releaseId,
      by: deployedBy,
    });
  }

  async rollbackRelease(
    releaseId: string,
    rolledBackBy?: string,
    reason?: string
  ): Promise<void> {
    const release = this.releases.get(releaseId);
    if (!release) throw new ReleaseNotFoundError(releaseId);

    if (release.snapshots && release.snapshots.length > 0) {
      // Snapshot-driven rollback — exact restoration of prior state.
      for (const snap of release.snapshots) {
        const flag = this.flags.get(snap.flagKey);
        if (!flag) continue;
        flag.defaultValue = snap.beforeValue;
        flag.status = snap.beforeStatus;
        flag.rollout = snap.beforeRollout
          ? { ...snap.beforeRollout, rampSchedule: snap.beforeRollout.rampSchedule?.slice() }
          : undefined;
        flag.updatedAt = new Date();
        this.flags.set(snap.flagKey, flag);
      }
    } else {
      // Legacy fallback for releases deployed before snapshots existed.
      for (const change of release.changes) {
        const flag = this.flags.get(change.flagKey);
        if (!flag) continue;
        switch (change.action) {
          case "enable":
            flag.defaultValue = false;
            break;
          case "disable":
            flag.defaultValue = true;
            break;
          case "kill":
            flag.status = "active";
            break;
          case "restore":
            flag.status = "killed";
            break;
        }
        flag.updatedAt = new Date();
        this.flags.set(change.flagKey, flag);
      }
    }

    release.status = "rolled_back";
    release.rolledBackAt = new Date();
    release.rolledBackBy = rolledBackBy;
    release.rollbackReason = reason;
    this.releases.set(releaseId, release);

    await this.addHistory({
      action: "release.rolled_back",
      at: new Date(),
      releaseId,
      by: rolledBackBy,
      reason,
    });
  }

  // ── Sticky Assignments ───────────────────────────────────────────────

  async getUserAssignment(flagKey: string, userId: string): Promise<string | null> {
    return this.assignments.get(`${flagKey}:${userId}`) || null;
  }

  async getUserAssignments(
    flagKeys: string[],
    userId: string
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const key of flagKeys) {
      const v = this.assignments.get(`${key}:${userId}`);
      if (v) out[key] = v;
    }
    return out;
  }

  async setUserAssignment(
    flagKey: string,
    userId: string,
    variantKey: string
  ): Promise<void> {
    this.assignments.set(`${flagKey}:${userId}`, variantKey);
  }

  // ── History ──────────────────────────────────────────────────────────

  async addHistory(entry: Omit<HistoryEntry, "id">): Promise<void> {
    this.history.push({ ...entry, id: this.genId("hist") });
  }

  async getHistory(
    flagKey: string,
    opts?: { limit?: number }
  ): Promise<HistoryEntry[]> {
    let entries = this.history.filter((h) => h.flagKey === flagKey);
    entries.sort((a, b) => b.at.getTime() - a.at.getTime());
    if (opts?.limit) {
      entries = entries.slice(0, opts.limit);
    }
    return entries;
  }

  // ── Impressions ──────────────────────────────────────────────────────

  async trackImpression(params: {
    flagKey: string;
    userId: string;
    value: unknown;
    variant: string | null;
    reason: string;
  }): Promise<void> {
    this.impressions.push({ ...params, at: new Date() });
  }

  // ── Bulk Operations ──────────────────────────────────────────────────

  async getAllActiveFlags(opts?: {
    namespace?: string;
    tags?: string[];
    keys?: string[];
    limit?: number;
    offset?: number;
  }): Promise<Flag[]> {
    let flags = Array.from(this.flags.values()).filter((f) => f.status === "active");

    if (opts?.namespace) {
      flags = flags.filter(
        (f) => f.namespace === opts.namespace || f.key.startsWith(`${opts.namespace}.`)
      );
    }

    if (opts?.tags && opts.tags.length > 0) {
      flags = flags.filter(
        (f) => f.tags && opts.tags!.some((t) => f.tags!.includes(t))
      );
    }

    if (opts?.keys && opts.keys.length > 0) {
      flags = flags.filter((f) => opts.keys!.includes(f.key));
    }

    const offset = opts?.offset ?? 0;
    if (opts?.limit !== undefined) {
      flags = flags.slice(offset, offset + opts.limit);
    } else if (offset > 0) {
      flags = flags.slice(offset);
    }

    return flags.map((f) => ({ ...f }));
  }

  // ── Tags ─────────────────────────────────────────────────────────────

  async addTags(flagKey: string, tags: string[]): Promise<void> {
    const flag = this.flags.get(flagKey);
    if (!flag) throw new FlagNotFoundError(flagKey);

    const existing = new Set(flag.tags || []);
    for (const t of tags) existing.add(t);
    flag.tags = Array.from(existing);
    flag.updatedAt = new Date();
    this.flags.set(flagKey, flag);
  }

  async removeTags(flagKey: string, tags: string[]): Promise<void> {
    const flag = this.flags.get(flagKey);
    if (!flag) throw new FlagNotFoundError(flagKey);

    const toRemove = new Set(tags);
    flag.tags = (flag.tags || []).filter((t) => !toRemove.has(t));
    flag.updatedAt = new Date();
    this.flags.set(flagKey, flag);
  }

  // ── Internal: Get rules for evaluation ───────────────────────────────

  /** Get rules for a flag. Used internally by the evaluator. */
  getRulesForFlag(flagKey: string): FlagRule[] {
    return [...(this.rules.get(flagKey) || [])];
  }
}

/**
 * In-memory cache adapter. Data lost on process restart.
 */
export class MemoryCacheAdapter implements CacheAdapter {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async delPattern(pattern: string): Promise<void> {
    // Simple glob-to-regex for pattern matching
    const regex = new RegExp(
      "^" + escapeRegex(pattern).replace(/\\\*/g, ".*").replace(/\\\?/g, ".") + "$"
    );
    for (const key of this.store.keys()) {
      if (regex.test(key)) {
        this.store.delete(key);
      }
    }
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * Factory function to create a memory adapter.
 */
export function createMemoryAdapter(): MemoryDbAdapter {
  return new MemoryDbAdapter();
}
