// ============================================================================
// Rollease SDK - Repository-backed Database Adapter
// Shared persistence logic for ORM adapters.
// ============================================================================

import type { DbAdapter } from "./adapter";
import type {
  AddRuleInput,
  CreateFlagInput,
  CreateReleaseInput,
  CreateSegmentInput,
  ExclusionLayer,
  ExclusionLayerAllocation,
  Flag,
  FlagPrerequisite,
  FlagRule,
  FlagStatus,
  HistoryEntry,
  ListFlagsInput,
  ListFlagsResult,
  Release,
  ReleaseSnapshot,
  RuleOrdering,
  Segment,
  SegmentUsage,
  UpdateFlagInput,
  UpdateRuleInput,
  UpdateSegmentInput,
} from "../core/types";
import {
  FlagConflictError,
  FlagNotFoundError,
  ReleaseNotFoundError,
  RuleNotFoundError,
  SegmentNotFoundError,
  ValidationError,
} from "../core/errors";
import {
  assertSafeConditionGroup,
  conditionReferencesSegment,
} from "../core/security";

export type RepositoryName =
  | "Flag"
  | "Rule"
  | "Segment"
  | "Release"
  | "Assignment"
  | "History"
  | "Impression";

/**
 * Repositories that are optional for backwards-compatibility. If absent,
 * the corresponding feature (e.g. exclusion layers) is disabled at runtime
 * but the adapter still constructs and the required surface keeps working.
 */
export type OptionalRepositoryName = "ExclusionLayer";

/** Combined name union for typing of the repository map. */
export type AnyRepositoryName = RepositoryName | OptionalRepositoryName;

export interface RepositoryFindManyOptions {
  where?: Record<string, unknown>;
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
}

export interface RowRepository {
  create(values: Record<string, unknown>): Promise<unknown>;
  findOne(where: Record<string, unknown>): Promise<unknown | null>;
  findMany(options?: RepositoryFindManyOptions): Promise<unknown[]>;
  update(
    where: Record<string, unknown>,
    values: Record<string, unknown>
  ): Promise<unknown | null | void>;
  delete(where: Record<string, unknown>): Promise<void>;
  deleteMany(where: Record<string, unknown>): Promise<void>;
}

/**
 * Set of row repositories required by the adapter. Optional repos (e.g.
 * `ExclusionLayer`) are added via the Partial intersection so existing
 * users without those tables continue to construct without errors.
 */
export type RepositorySet = Record<RepositoryName, RowRepository> &
  Partial<Record<OptionalRepositoryName, RowRepository>>;

export const ROLLEASE_REPOSITORY_NAMES: RepositoryName[] = [
  "Flag",
  "Rule",
  "Segment",
  "Release",
  "Assignment",
  "History",
  "Impression",
];

export const ROLLEASE_OPTIONAL_REPOSITORY_NAMES: OptionalRepositoryName[] = [
  "ExclusionLayer",
];

export const ROLLEASE_REPOSITORY_REQUIRED_COLUMNS: Record<
  AnyRepositoryName,
  string[]
> = {
  Flag: [
    "id",
    "key",
    "type",
    "status",
    "defaultValue",
    "description",
    "namespace",
    "tags",
    "locked",
    "lockedReason",
    "environments",
    "variants",
    "rollout",
    "scheduledAt",
    "expiresAt",
    "prerequisites",
    "environmentDefaults",
    "exclusionLayer",
    "lastEvaluatedAt",
    "createdAt",
    "updatedAt",
  ],
  Rule: [
    "id",
    "flagKey",
    "name",
    "priority",
    "value",
    "conditions",
    "enabled",
    "rolloutPct",
    "isHoldout",
    "variantId",
    "userIds",
    "description",
    "metadata",
  ],
  Segment: ["key", "description", "rules", "createdAt", "updatedAt"],
  Release: [
    "id",
    "name",
    "description",
    "environment",
    "status",
    "changes",
    "snapshots",
    "scheduledAt",
    "deployedAt",
    "deployedBy",
    "rolledBackAt",
    "rolledBackBy",
    "rollbackReason",
    "requiresApproval",
    "requiredApprovers",
    "approvalStatus",
    "approvals",
    "rejectionReason",
    "createdAt",
  ],
  Assignment: ["flagKey", "userId", "variantKey"],
  History: ["id", "flagKey", "action", "by", "at", "changes", "reason", "releaseId"],
  Impression: ["id", "flagKey", "userId", "value", "variant", "reason", "at"],
  ExclusionLayer: ["key", "description", "flagKeys", "allocations"],
};


export class RepositoryDbAdapter implements DbAdapter {
  protected repositories: RepositorySet;
  private closeHandler?: () => Promise<void>;
  private idCounter = 0;

  constructor(
    repositories: RepositorySet,
    opts: { close?: () => Promise<void> } = {}
  ) {
    validateRepositorySet(repositories);
    this.repositories = repositories;
    this.closeHandler = opts.close;
  }

  private genId(prefix: string): string {
    return `${prefix}_${++this.idCounter}_${Date.now().toString(36)}`;
  }

  async createFlag(input: CreateFlagInput): Promise<Flag> {
    if (await this.getFlag(input.key)) {
      throw new FlagConflictError(input.key, "flag");
    }

    const now = new Date();
    const row = await this.repositories.Flag.create({
      id: this.genId("flag"),
      key: input.key,
      type: input.type,
      status: "active",
      defaultValue: input.defaultValue,
      description: input.description,
      namespace: input.namespace,
      tags: input.tags || [],
      locked: false,
      lockedReason: undefined,
      environments: input.environments,
      variants: input.variants?.map((variant) => ({
        ...variant,
        id: this.genId("var"),
      })),
      rollout: input.rollout,
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      // Tier 2/3 fields — persist when provided so the storage layer doesn't
      // silently drop them, which would make these features no-ops on Prisma
      // and Drizzle.
      prerequisites: input.prerequisites ?? null,
      environmentDefaults: input.environmentDefaults ?? null,
      exclusionLayer: input.exclusionLayer ?? null,
      lastEvaluatedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await this.addHistory({
      flagKey: input.key,
      action: "flag.created",
      at: now,
      changes: { input },
    });

    return toFlag(row);
  }

  async getFlag(key: string): Promise<Flag | null> {
    const row = await this.repositories.Flag.findOne({ key });
    return row ? toFlag(row) : null;
  }

  async listFlags(input: ListFlagsInput = {}): Promise<ListFlagsResult> {
    let flags = (await this.repositories.Flag.findMany()).map(toFlag);

    if (input.status) {
      flags = flags.filter((flag) => flag.status === input.status);
    }
    if (input.namespace) {
      flags = flags.filter(
        (flag) =>
          flag.namespace === input.namespace ||
          flag.key.startsWith(`${input.namespace}.`)
      );
    }
    if (input.tags?.length) {
      flags = flags.filter((flag) =>
        input.tags!.some((tag) => flag.tags?.includes(tag))
      );
    }
    if (input.environment) {
      flags = flags.filter(
        (flag) =>
          !flag.environments || flag.environments.includes(input.environment!)
      );
    }
    if (input.search) {
      const search = input.search.toLowerCase();
      flags = flags.filter(
        (flag) =>
          flag.key.toLowerCase().includes(search) ||
          Boolean(flag.description?.toLowerCase().includes(search))
      );
    }
    if (input.staleAfter) {
      const staleThreshold = new Date(input.staleAfter).getTime();
      flags = flags.filter((flag) => {
        // Treat never-evaluated flags as stale (very old).
        const evaluatedAt = flag.lastEvaluatedAt
          ? new Date(flag.lastEvaluatedAt).getTime()
          : 0;
        return evaluatedAt < staleThreshold;
      });
    }

    const total = flags.length;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 50;
    return {
      data: flags.slice(offset, offset + limit),
      total,
      hasMore: offset + limit < total,
    };
  }

  async updateFlag(key: string, input: UpdateFlagInput): Promise<Flag> {
    const current = await this.getFlag(key);
    if (!current) throw new FlagNotFoundError(key);

    await this.repositories.Flag.update(
      { key },
      stripUndefined({
        ...input,
        scheduledAt:
          input.scheduledAt === undefined
            ? undefined
            : input.scheduledAt
              ? new Date(input.scheduledAt)
              : null,
        expiresAt:
          input.expiresAt === undefined
            ? undefined
            : input.expiresAt
              ? new Date(input.expiresAt)
              : null,
        updatedAt: new Date(),
      })
    );

    await this.addHistory({
      flagKey: key,
      action: "flag.updated",
      at: new Date(),
      changes: input as Record<string, unknown>,
    });

    return (await this.getFlag(key))!;
  }

  async setFlagStatus(key: string, status: FlagStatus): Promise<void> {
    if (!(await this.getFlag(key))) throw new FlagNotFoundError(key);
    await this.repositories.Flag.update(
      { key },
      { status, updatedAt: new Date() }
    );
  }

  async deleteFlag(key: string): Promise<void> {
    if (!(await this.getFlag(key))) throw new FlagNotFoundError(key);

    await this.repositories.Flag.delete({ key });
    await this.repositories.Rule.deleteMany({ flagKey: key });
    await this.repositories.Assignment.deleteMany({ flagKey: key });
    await this.addHistory({ flagKey: key, action: "flag.deleted", at: new Date() });
  }

  async cloneFlag(
    sourceKey: string,
    newKey: string,
    includeRules: boolean,
    includeRollout: boolean
  ): Promise<Flag> {
    const source = await this.getFlag(sourceKey);
    if (!source) throw new FlagNotFoundError(sourceKey);
    if (await this.getFlag(newKey)) throw new FlagConflictError(newKey, "flag");

    const cloned = await this.createFlag({
      key: newKey,
      type: source.type,
      defaultValue: source.defaultValue,
      description: source.description,
      namespace: source.namespace,
      tags: source.tags,
      environments: source.environments,
      variants: source.variants?.map(({ key, value, weight, description }) => ({
        key,
        value,
        weight,
        description,
      })),
      rollout: includeRollout ? source.rollout : undefined,
      scheduledAt: source.scheduledAt ? new Date(source.scheduledAt).toISOString() : null,
      expiresAt: source.expiresAt ? new Date(source.expiresAt).toISOString() : null,
    });

    if (includeRules) {
      const rules = await this.listRules(sourceKey);
      for (const rule of rules) {
        await this.addRule(newKey, {
          name: rule.name,
          priority: rule.priority,
          value: rule.value,
          conditions: rule.conditions,
          enabled: rule.enabled,
          rolloutPct: rule.rolloutPct,
          isHoldout: rule.isHoldout,
          variantId: rule.variantId,
        });
      }
    }

    return cloned;
  }

  async setRollout(
    key: string,
    rollout: {
      percentage?: number;
      sticky?: boolean;
      hashKey?: string;
      rampSchedule?: { at: string; percentage: number }[];
    }
  ): Promise<void> {
    const flag = await this.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);

    const nextRollout = {
      percentage: rollout.percentage ?? flag.rollout?.percentage ?? 0,
      sticky: rollout.sticky ?? flag.rollout?.sticky ?? true,
      hashKey: rollout.hashKey ?? flag.rollout?.hashKey ?? "userId",
      rampSchedule: rollout.rampSchedule ?? flag.rollout?.rampSchedule,
    };

    await this.repositories.Flag.update(
      { key },
      { rollout: nextRollout, updatedAt: new Date() }
    );
    await this.addHistory({
      flagKey: key,
      action: "rollout.set",
      at: new Date(),
      changes: { before: flag.rollout, after: nextRollout },
    });
  }

  async addRule(flagKey: string, input: AddRuleInput): Promise<FlagRule> {
    if (!(await this.getFlag(flagKey))) throw new FlagNotFoundError(flagKey);
    assertSafeConditionGroup(input.conditions, "rule.conditions");

    const row = await this.repositories.Rule.create({
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
      // Tier 2 — persist user-list, description, and operational metadata.
      userIds: input.userIds ?? null,
      description: input.description ?? null,
      metadata: input.metadata ?? null,
    });

    await this.addHistory({
      flagKey,
      action: "rule.added",
      at: new Date(),
      changes: { rule: toRule(row) },
    });

    return toRule(row);
  }

  async updateRule(
    flagKey: string,
    ruleId: string,
    input: UpdateRuleInput
  ): Promise<FlagRule> {
    const rule = await this.repositories.Rule.findOne({ flagKey, id: ruleId });
    if (!rule) throw new RuleNotFoundError(flagKey, ruleId);
    if (input.conditions) assertSafeConditionGroup(input.conditions, "rule.conditions");

    await this.repositories.Rule.update(
      { flagKey, id: ruleId },
      stripUndefined(input as Record<string, unknown>)
    );
    await this.addHistory({
      flagKey,
      action: "rule.updated",
      at: new Date(),
      changes: { ruleId, input },
    });

    const updated = await this.repositories.Rule.findOne({ flagKey, id: ruleId });
    return toRule(updated!);
  }

  async removeRule(flagKey: string, ruleId: string): Promise<void> {
    const rule = await this.repositories.Rule.findOne({ flagKey, id: ruleId });
    if (!rule) throw new RuleNotFoundError(flagKey, ruleId);
    await this.repositories.Rule.delete({ flagKey, id: ruleId });
    await this.addHistory({
      flagKey,
      action: "rule.removed",
      at: new Date(),
      changes: { ruleId },
    });
  }

  async listRules(flagKey: string): Promise<FlagRule[]> {
    return (
      await this.repositories.Rule.findMany({
        where: { flagKey },
        orderBy: [{ field: "priority", direction: "asc" }],
      })
    )
      .map(toRule)
      .sort((a, b) => a.priority - b.priority);
  }

  async reorderRules(
    flagKey: string,
    ordering: RuleOrdering[]
  ): Promise<void> {
    for (const item of ordering) {
      await this.repositories.Rule.update(
        { flagKey, id: item.ruleId },
        { priority: item.priority }
      );
    }
    await this.addHistory({
      flagKey,
      action: "rule.reordered",
      at: new Date(),
      changes: { ordering },
    });
  }

  async createSegment(input: CreateSegmentInput): Promise<Segment> {
    if (await this.getSegment(input.key)) {
      throw new FlagConflictError(input.key, "segment");
    }
    assertSafeConditionGroup(input.rules, "segment.rules");

    const now = new Date();
    return toSegment(
      await this.repositories.Segment.create({
        key: input.key,
        description: input.description,
        rules: input.rules,
        createdAt: now,
        updatedAt: now,
      })
    );
  }

  async updateSegment(key: string, input: UpdateSegmentInput): Promise<Segment> {
    if (!(await this.getSegment(key))) throw new SegmentNotFoundError(key);
    if (input.rules) assertSafeConditionGroup(input.rules, "segment.rules");

    await this.repositories.Segment.update(
      { key },
      stripUndefined({ ...input, updatedAt: new Date() })
    );
    return (await this.getSegment(key))!;
  }

  async deleteSegment(key: string): Promise<void> {
    if (!(await this.getSegment(key))) throw new SegmentNotFoundError(key);
    await this.repositories.Segment.delete({ key });
  }

  async listSegments(): Promise<Segment[]> {
    return (await this.repositories.Segment.findMany()).map(toSegment);
  }

  async getSegment(key: string): Promise<Segment | null> {
    const row = await this.repositories.Segment.findOne({ key });
    return row ? toSegment(row) : null;
  }

  async getSegmentUsage(key: string): Promise<SegmentUsage[]> {
    const usage: SegmentUsage[] = [];
    const rows = await this.repositories.Rule.findMany();
    for (const row of rows) {
      const rule = toRule(row);
      if (conditionReferencesSegment(rule.conditions, key)) {
        usage.push({ flagKey: rule.flagKey, ruleId: rule.id });
      }
    }
    return usage;
  }

  async createRelease(input: CreateReleaseInput): Promise<Release> {
    const now = new Date();
    return toRelease(
      await this.repositories.Release.create({
        id: this.genId("rel"),
        name: input.name,
        description: input.description,
        environment: input.environment,
        status: input.scheduledAt ? "scheduled" : "pending",
        changes: input.changes,
        snapshots: [],
        scheduledAt: input.scheduledAt || null,
        deployedAt: null,
        deployedBy: undefined,
        rolledBackAt: null,
        rolledBackBy: undefined,
        rollbackReason: undefined,
        // Tier 2 — approval workflow fields.
        requiresApproval: input.requiresApproval ?? false,
        requiredApprovers: input.requiredApprovers ?? null,
        approvalStatus: input.requiresApproval ? "pending" : null,
        approvals: [],
        rejectionReason: null,
        createdAt: now,
      })
    );
  }

  async approveRelease(
    releaseId: string,
    approverId: string
  ): Promise<Release> {
    const release = await this.getRequiredRelease(releaseId);
    const approvals = Array.isArray(release.approvals) ? [...release.approvals] : [];
    if (!approvals.includes(approverId)) {
      approvals.push(approverId);
    }

    let approvalStatus: Release["approvalStatus"] = release.approvalStatus ?? "pending";
    const required = release.requiredApprovers ?? [];
    if (required.length > 0) {
      if (required.every((req) => approvals.includes(req))) {
        approvalStatus = "approved";
      }
    } else if (approvals.length > 0) {
      approvalStatus = "approved";
    }

    await this.repositories.Release.update(
      { id: releaseId },
      { approvals, approvalStatus }
    );
    await this.addHistory({
      action: "release.approved",
      at: new Date(),
      releaseId,
      by: approverId,
    });
    return (await this.getRequiredRelease(releaseId));
  }

  async rejectRelease(
    releaseId: string,
    rejectorId: string,
    reason?: string
  ): Promise<Release> {
    await this.getRequiredRelease(releaseId);
    await this.repositories.Release.update(
      { id: releaseId },
      { approvalStatus: "rejected", rejectionReason: reason ?? null }
    );
    await this.addHistory({
      action: "release.rejected",
      at: new Date(),
      releaseId,
      by: rejectorId,
      reason,
    });
    return (await this.getRequiredRelease(releaseId));
  }

  async getRelease(releaseId: string): Promise<Release | null> {
    const row = await this.repositories.Release.findOne({ id: releaseId });
    return row ? toRelease(row) : null;
  }

  async listReleases(filters?: {
    environment?: string;
    status?: string;
    limit?: number;
  }): Promise<Release[]> {
    let releases = (await this.repositories.Release.findMany()).map(toRelease);
    if (filters?.environment) {
      releases = releases.filter((release) => release.environment === filters.environment);
    }
    if (filters?.status) {
      releases = releases.filter((release) => release.status === filters.status);
    }
    releases.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return filters?.limit ? releases.slice(0, filters.limit) : releases;
  }

  async deployRelease(releaseId: string, deployedBy?: string): Promise<void> {
    const release = await this.getRequiredRelease(releaseId);
    const snapshots: ReleaseSnapshot[] = [];
    const snapshotted = new Set<string>();

    for (const change of release.changes) {
      const flag = await this.getFlag(change.flagKey);
      if (!flag) continue;

      // Capture before-state for exact rollback restoration.
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

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      switch (change.action) {
        case "enable":
          patch.defaultValue = change.value ?? true;
          patch.status = "active";
          break;
        case "disable":
          patch.defaultValue = change.value ?? false;
          break;
        case "setValue":
          patch.defaultValue = change.value;
          break;
        case "setRollout":
          if (change.rollout) {
            patch.rollout = {
              percentage: change.rollout.percentage ?? flag.rollout?.percentage ?? 0,
              sticky: change.rollout.sticky ?? flag.rollout?.sticky ?? true,
              hashKey: change.rollout.hashKey ?? flag.rollout?.hashKey ?? "userId",
              rampSchedule: change.rollout.rampSchedule ?? flag.rollout?.rampSchedule,
            };
          }
          break;
        case "kill":
          patch.status = "killed";
          break;
        case "restore":
          patch.status = "active";
          break;
      }
      await this.repositories.Flag.update({ key: change.flagKey }, patch);
    }

    await this.repositories.Release.update(
      { id: releaseId },
      {
        status: "deployed",
        deployedAt: new Date(),
        deployedBy,
        snapshots,
      }
    );
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
    const release = await this.getRequiredRelease(releaseId);

    if (release.snapshots && release.snapshots.length > 0) {
      for (const snap of release.snapshots) {
        const flag = await this.getFlag(snap.flagKey);
        if (!flag) continue;
        await this.repositories.Flag.update(
          { key: snap.flagKey },
          {
            defaultValue: snap.beforeValue,
            status: snap.beforeStatus,
            rollout: snap.beforeRollout ?? null,
            updatedAt: new Date(),
          }
        );
      }
    } else {
      // Legacy fallback for releases deployed before snapshots existed.
      for (const change of release.changes) {
        const flag = await this.getFlag(change.flagKey);
        if (!flag) continue;

        const patch: Record<string, unknown> = { updatedAt: new Date() };
        switch (change.action) {
          case "enable":
            patch.defaultValue = false;
            break;
          case "disable":
            patch.defaultValue = true;
            break;
          case "kill":
            patch.status = "active";
            break;
          case "restore":
            patch.status = "killed";
            break;
        }
        await this.repositories.Flag.update({ key: change.flagKey }, patch);
      }
    }

    await this.repositories.Release.update(
      { id: releaseId },
      {
        status: "rolled_back",
        rolledBackAt: new Date(),
        rolledBackBy,
        rollbackReason: reason,
      }
    );
    await this.addHistory({
      action: "release.rolled_back",
      at: new Date(),
      releaseId,
      by: rolledBackBy,
      reason,
    });
  }

  async getUserAssignment(flagKey: string, userId: string): Promise<string | null> {
    const row = await this.repositories.Assignment.findOne({ flagKey, userId });
    return row ? String(plain(row).variantKey) : null;
  }

  async getUserAssignments(
    flagKeys: string[],
    userId: string
  ): Promise<Record<string, string>> {
    if (flagKeys.length === 0) return {};
    // Most repositories accept simple `{ field: value }` where-clauses; for
    // a multi-key match we fan out one findOne per key but keep this single
    // method so callers benefit from the batched signature today and from a
    // future `findMany({ where: { userId, flagKey: { in: [...] } } })` later.
    const out: Record<string, string> = {};
    const rows = await this.repositories.Assignment.findMany({
      where: { userId },
    });
    const wanted = new Set(flagKeys);
    for (const row of rows) {
      const data = plain(row);
      const key = String(data.flagKey);
      if (wanted.has(key)) {
        out[key] = String(data.variantKey);
      }
    }
    return out;
  }

  async setUserAssignment(
    flagKey: string,
    userId: string,
    variantKey: string
  ): Promise<void> {
    const existing = await this.repositories.Assignment.findOne({ flagKey, userId });
    if (existing) {
      await this.repositories.Assignment.update({ flagKey, userId }, { variantKey });
      return;
    }
    await this.repositories.Assignment.create({ flagKey, userId, variantKey });
  }

  async addHistory(entry: Omit<HistoryEntry, "id">): Promise<void> {
    await this.repositories.History.create({ ...entry, id: this.genId("hist") });
  }

  async getHistory(
    flagKey: string,
    opts?: { limit?: number }
  ): Promise<HistoryEntry[]> {
    const entries = (
      await this.repositories.History.findMany({
        where: { flagKey },
        orderBy: [{ field: "at", direction: "desc" }],
      })
    )
      .map(toHistory)
      .sort((a, b) => b.at.getTime() - a.at.getTime());
    return opts?.limit ? entries.slice(0, opts.limit) : entries;
  }

  async trackImpression(params: {
    flagKey: string;
    userId: string;
    value: unknown;
    variant: string | null;
    reason: string;
  }): Promise<void> {
    await this.repositories.Impression.create({
      ...params,
      id: this.genId("imp"),
      at: new Date(),
    });
  }

  async getAllActiveFlags(opts?: {
    namespace?: string;
    tags?: string[];
    keys?: string[];
    limit?: number;
    offset?: number;
  }): Promise<Flag[]> {
    // Fetch ALL active flags first, then apply filters, then paginate.
    // This ensures namespace/tags/keys filters don't miss results that
    // happen to fall outside the first page boundary.
    const list = await this.listFlags({ status: "active" });
    let flags = list.data;
    if (opts?.namespace) {
      flags = flags.filter(
        (flag) =>
          flag.namespace === opts.namespace ||
          flag.key.startsWith(`${opts.namespace}.`)
      );
    }
    if (opts?.tags?.length) {
      flags = flags.filter((flag) =>
        opts.tags!.some((tag) => flag.tags?.includes(tag))
      );
    }
    if (opts?.keys?.length) {
      flags = flags.filter((flag) => opts.keys!.includes(flag.key));
    }
    // Apply pagination AFTER filtering
    const offset = opts?.offset ?? 0;
    if (opts?.limit !== undefined) {
      flags = flags.slice(offset, offset + opts.limit);
    } else if (offset > 0) {
      flags = flags.slice(offset);
    }
    return flags;
  }

  async addTags(flagKey: string, tags: string[]): Promise<void> {
    const flag = await this.getFlag(flagKey);
    if (!flag) throw new FlagNotFoundError(flagKey);
    const merged = Array.from(new Set([...(flag.tags || []), ...tags]));
    await this.repositories.Flag.update(
      { key: flagKey },
      { tags: merged, updatedAt: new Date() }
    );
  }

  async removeTags(flagKey: string, tags: string[]): Promise<void> {
    const flag = await this.getFlag(flagKey);
    if (!flag) throw new FlagNotFoundError(flagKey);
    const toRemove = new Set(tags);
    const next = (flag.tags || []).filter((tag) => !toRemove.has(tag));
    await this.repositories.Flag.update(
      { key: flagKey },
      { tags: next, updatedAt: new Date() }
    );
  }

  // ── Exclusion Layers ─────────────────────────────────────────────────
  // Optional repository — these methods throw a clear, actionable error
  // when the `ExclusionLayer` repository isn't provided. The manager
  // surfaces this as a ValidationError to the caller.

  async createExclusionLayer(input: ExclusionLayer): Promise<ExclusionLayer> {
    const repo = this.requireExclusionRepo();
    const existing = await repo.findOne({ key: input.key });
    if (existing) throw new FlagConflictError(input.key, "exclusion layer");
    await repo.create({
      key: input.key,
      description: input.description ?? null,
      flagKeys: input.flagKeys,
      allocations: input.allocations,
    });
    return input;
  }

  async getExclusionLayer(key: string): Promise<ExclusionLayer | null> {
    if (!this.repositories.ExclusionLayer) return null;
    const row = await this.repositories.ExclusionLayer.findOne({ key });
    return row ? toExclusionLayer(row) : null;
  }

  async updateExclusionLayer(
    key: string,
    allocations: ExclusionLayerAllocation[]
  ): Promise<ExclusionLayer> {
    const repo = this.requireExclusionRepo();
    const row = await repo.findOne({ key });
    if (!row) {
      throw new ValidationError(`Exclusion layer "${key}" not found`, {
        exclusionLayer: key,
      });
    }
    await repo.update({ key }, { allocations });
    const updated = await repo.findOne({ key });
    return toExclusionLayer(updated!);
  }

  async deleteExclusionLayer(key: string): Promise<void> {
    const repo = this.requireExclusionRepo();
    const row = await repo.findOne({ key });
    if (!row) {
      throw new ValidationError(`Exclusion layer "${key}" not found`, {
        exclusionLayer: key,
      });
    }
    await repo.delete({ key });
  }

  async listExclusionLayers(): Promise<ExclusionLayer[]> {
    if (!this.repositories.ExclusionLayer) return [];
    const rows = await this.repositories.ExclusionLayer.findMany();
    return rows.map(toExclusionLayer);
  }

  // ── Stale Flag Detection ─────────────────────────────────────────────

  async touchFlagEvaluation(key: string): Promise<void> {
    // Best-effort: never throws so callers can safely fire-and-forget.
    try {
      await this.repositories.Flag.update(
        { key },
        { lastEvaluatedAt: new Date() }
      );
    } catch {
      // swallow — touch is a hint, not load-bearing.
    }
  }

  async close(): Promise<void> {
    await this.closeHandler?.();
  }

  private requireExclusionRepo(): RowRepository {
    const repo = this.repositories.ExclusionLayer;
    if (!repo) {
      throw new ValidationError(
        "Exclusion layers require an 'ExclusionLayer' repository — register one in your adapter.",
        { repository: "ExclusionLayer" }
      );
    }
    return repo;
  }

  private async getRequiredRelease(releaseId: string): Promise<Release> {
    const release = await this.getRelease(releaseId);
    if (!release) throw new ReleaseNotFoundError(releaseId);
    return release;
  }
}

export function validateRepositorySet(repositories: Partial<RepositorySet>): void {
  for (const name of ROLLEASE_REPOSITORY_NAMES) {
    const repository = repositories[name];
    if (!repository) {
      throw new ValidationError(`Missing repository "${name}"`, { repository: name });
    }
    for (const method of ["create", "findOne", "findMany", "update", "delete", "deleteMany"] as const) {
      if (typeof repository[method] !== "function") {
        throw new ValidationError(`Repository "${name}" is missing method "${method}"`, {
          repository: name,
          method,
        });
      }
    }
  }
  // Optional repositories are validated only when present — keeps the
  // adapter constructor backwards-compatible with users who don't yet have
  // an ExclusionLayer table.
  for (const name of ROLLEASE_OPTIONAL_REPOSITORY_NAMES) {
    const repository = repositories[name];
    if (!repository) continue;
    for (const method of ["create", "findOne", "findMany", "update", "delete", "deleteMany"] as const) {
      if (typeof repository[method] !== "function") {
        throw new ValidationError(`Repository "${name}" is missing method "${method}"`, {
          repository: name,
          method,
        });
      }
    }
  }
}

export function toFlag(row: unknown): Flag {
  const data = plain(row);
  return {
    id: String(data.id),
    key: String(data.key),
    type: data.type as Flag["type"],
    status: data.status as FlagStatus,
    defaultValue: data.defaultValue,
    description: optionalString(data.description),
    namespace: optionalString(data.namespace),
    tags: arrayOrUndefined<string>(data.tags),
    locked: Boolean(data.locked),
    lockedReason: optionalString(data.lockedReason),
    environments: arrayOrUndefined<string>(data.environments),
    variants: arrayOrUndefined(data.variants),
    rollout: data.rollout as Flag["rollout"],
    scheduledAt: nullableDate(data.scheduledAt),
    expiresAt: nullableDate(data.expiresAt),
    prerequisites: arrayOrUndefined<FlagPrerequisite>(data.prerequisites),
    environmentDefaults:
      data.environmentDefaults &&
      typeof data.environmentDefaults === "object" &&
      !Array.isArray(data.environmentDefaults)
        ? (data.environmentDefaults as Record<string, unknown>)
        : undefined,
    exclusionLayer: optionalString(data.exclusionLayer),
    lastEvaluatedAt: nullableDate(data.lastEvaluatedAt),
    createdAt: date(data.createdAt),
    updatedAt: date(data.updatedAt),
  };
}

export function toRule(row: unknown): FlagRule {
  const data = plain(row);
  return {
    id: String(data.id),
    flagKey: String(data.flagKey),
    name: optionalString(data.name),
    priority: Number(data.priority),
    value: data.value,
    conditions: data.conditions as FlagRule["conditions"],
    enabled: Boolean(data.enabled),
    rolloutPct: optionalNumber(data.rolloutPct),
    isHoldout: optionalBoolean(data.isHoldout),
    variantId: optionalString(data.variantId),
    userIds: arrayOrUndefined<string>(data.userIds),
    description: optionalString(data.description),
    metadata:
      data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
        ? (data.metadata as Record<string, unknown>)
        : undefined,
  };
}

export function toExclusionLayer(row: unknown): ExclusionLayer {
  const data = plain(row);
  return {
    key: String(data.key),
    description: optionalString(data.description),
    flagKeys: arrayOrUndefined<string>(data.flagKeys) ?? [],
    allocations:
      (arrayOrUndefined<ExclusionLayerAllocation>(data.allocations) ?? []),
  };
}

export function toSegment(row: unknown): Segment {
  const data = plain(row);
  return {
    key: String(data.key),
    description: optionalString(data.description),
    rules: data.rules as Segment["rules"],
    createdAt: date(data.createdAt),
    updatedAt: date(data.updatedAt),
  };
}

export function toRelease(row: unknown): Release {
  const data = plain(row);
  return {
    id: String(data.id),
    name: String(data.name),
    description: optionalString(data.description),
    environment: optionalString(data.environment),
    status: data.status as Release["status"],
    changes: data.changes as Release["changes"],
    snapshots: arrayOrUndefined<ReleaseSnapshot>(data.snapshots),
    scheduledAt: data.scheduledAt ? new Date(data.scheduledAt).toISOString() : null,
    deployedAt: nullableDate(data.deployedAt),
    deployedBy: optionalString(data.deployedBy),
    rolledBackAt: nullableDate(data.rolledBackAt),
    rolledBackBy: optionalString(data.rolledBackBy),
    rollbackReason: optionalString(data.rollbackReason),
    requiresApproval: data.requiresApproval === undefined
      ? undefined
      : Boolean(data.requiresApproval),
    requiredApprovers: arrayOrUndefined<string>(data.requiredApprovers),
    approvalStatus:
      data.approvalStatus === "pending" ||
      data.approvalStatus === "approved" ||
      data.approvalStatus === "rejected"
        ? data.approvalStatus
        : undefined,
    approvals: arrayOrUndefined<string>(data.approvals),
    rejectionReason: optionalString(data.rejectionReason),
    createdAt: date(data.createdAt),
  };
}

export function toHistory(row: unknown): HistoryEntry {
  const data = plain(row);
  return {
    id: String(data.id),
    flagKey: optionalString(data.flagKey),
    action: data.action as HistoryEntry["action"],
    by: optionalString(data.by),
    at: date(data.at),
    changes: data.changes as HistoryEntry["changes"],
    reason: optionalString(data.reason),
    releaseId: optionalString(data.releaseId),
  };
}

export function plain(row: unknown): Record<string, any> {
  if (row && typeof row === "object" && "get" in row) {
    const getter = (row as { get: (opts?: Record<string, unknown>) => unknown }).get;
    return getter.call(row, { plain: true }) as Record<string, any>;
  }
  return row as Record<string, any>;
}

export function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as T;
}

export function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

export function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}

export function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

export function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

export function optionalBoolean(value: unknown): boolean | undefined {
  return value === null || value === undefined ? undefined : Boolean(value);
}

export function arrayOrUndefined<T = unknown>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? (value as T[]) : undefined;
}
