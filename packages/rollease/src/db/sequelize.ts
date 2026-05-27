// ============================================================================
// Rollease SDK - Sequelize Database Adapter
// ============================================================================

import type { DbAdapter } from "./adapter";
import type {
  AddRuleInput,
  CreateFlagInput,
  CreateReleaseInput,
  CreateSegmentInput,
  Flag,
  FlagRule,
  FlagStatus,
  HistoryEntry,
  ListFlagsInput,
  ListFlagsResult,
  Release,
  ReleaseSnapshot,
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

type ModelLike = {
  rawAttributes?: Record<string, unknown>;
  tableAttributes?: Record<string, unknown>;
  getAttributes?: () => Record<string, unknown>;
  create(values: Record<string, unknown>): Promise<unknown>;
  findOne(options: { where: Record<string, unknown> }): Promise<unknown | null>;
  findAll(options?: {
    where?: Record<string, unknown>;
    order?: Array<[string, "ASC" | "DESC"]>;
  }): Promise<unknown[]>;
  update(
    values: Record<string, unknown>,
    options: { where: Record<string, unknown> }
  ): Promise<unknown>;
  destroy(options: { where: Record<string, unknown> }): Promise<unknown>;
};

type SequelizeLike = {
  define: (
    modelName: string,
    attributes: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => ModelLike;
  sync?: (options?: Record<string, unknown>) => Promise<unknown>;
  close?: () => Promise<unknown>;
};

type SequelizeModuleLike = {
  DataTypes: Record<string, unknown>;
};

type Models = {
  Flag: ModelLike;
  Rule: ModelLike;
  Segment: ModelLike;
  Release: ModelLike;
  Assignment: ModelLike;
  History: ModelLike;
  Impression: ModelLike;
};

export type SequelizeAdapterModelName = keyof Models;
export type SequelizeAdapterModels = Partial<Record<SequelizeAdapterModelName, ModelLike>>;

export interface SequelizeAdapterOptions {
  /** Sequelize instance owned by the application. */
  sequelize: SequelizeLike;
  /** Optional sequelize module injection for tests or custom module loading. */
  sequelizeModule?: SequelizeModuleLike;
  /** Optional existing Sequelize models. Missing models are defined by Rollease. */
  models?: SequelizeAdapterModels;
  /** Validate that models expose every column Rollease needs. Defaults to true. */
  validateColumns?: boolean;
  /** Table prefix. Defaults to "rollease_". */
  tablePrefix?: string;
  /** Model name prefix. Defaults to "Rollease". */
  modelNamePrefix?: string;
  /** Call sequelize.sync() after defining models. */
  sync?: boolean | Record<string, unknown>;
}



export const ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS: Record<
  SequelizeAdapterModelName,
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
    "createdAt",
  ],
  Assignment: ["flagKey", "userId", "variantKey"],
  History: ["id", "flagKey", "action", "by", "at", "changes", "reason", "releaseId"],
  Impression: ["id", "flagKey", "userId", "value", "variant", "reason", "at"],
};

export class SequelizeDbAdapter implements DbAdapter {
  private sequelize: SequelizeLike;
  private sequelizeModule?: SequelizeModuleLike;
  private providedModels?: SequelizeAdapterModels;
  private validateColumns: boolean;
  private tablePrefix: string;
  private modelNamePrefix: string;
  private syncOptions: boolean | Record<string, unknown>;
  private models?: Models;
  private initPromise?: Promise<void>;
  private idCounter = 0;

  constructor(options: SequelizeAdapterOptions) {
    this.sequelize = options.sequelize;
    this.sequelizeModule = options.sequelizeModule;
    this.providedModels = options.models;
    this.validateColumns = options.validateColumns ?? true;
    this.tablePrefix = options.tablePrefix ?? "rollease_";
    this.modelNamePrefix = options.modelNamePrefix ?? "Rollease";
    this.syncOptions = options.sync ?? false;
  }

  private genId(prefix: string): string {
    return `${prefix}_${++this.idCounter}_${Date.now().toString(36)}`;
  }

  async sync(options?: Record<string, unknown>): Promise<void> {
    await this.ensureInitialized();
    if (this.sequelize.sync) {
      await this.sequelize.sync(options ?? {});
    }
  }

  async createFlag(input: CreateFlagInput): Promise<Flag> {
    const models = await this.getModels();
    if (await this.getFlag(input.key)) {
      throw new FlagConflictError(input.key, "flag");
    }

    const now = new Date();
    const row = await models.Flag.create({
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
      createdAt: now,
      updatedAt: now,
    });

    await this.addHistory({
      flagKey: input.key,
      action: "flag.created",
      at: now,
      changes: { input },
    });

    return this.toFlag(row);
  }

  async getFlag(key: string): Promise<Flag | null> {
    const models = await this.getModels();
    const row = await models.Flag.findOne({ where: { key } });
    return row ? this.toFlag(row) : null;
  }

  async listFlags(input: ListFlagsInput = {}): Promise<ListFlagsResult> {
    const models = await this.getModels();
    let flags = (await models.Flag.findAll()).map((row) => this.toFlag(row));

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
    const models = await this.getModels();
    const current = await this.getFlag(key);
    if (!current) throw new FlagNotFoundError(key);

    await models.Flag.update(
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
      }),
      { where: { key } }
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
    const models = await this.getModels();
    if (!(await this.getFlag(key))) throw new FlagNotFoundError(key);
    await models.Flag.update({ status, updatedAt: new Date() }, { where: { key } });
  }

  async deleteFlag(key: string): Promise<void> {
    const models = await this.getModels();
    if (!(await this.getFlag(key))) throw new FlagNotFoundError(key);

    await models.Flag.destroy({ where: { key } });
    await models.Rule.destroy({ where: { flagKey: key } });
    await models.Assignment.destroy({ where: { flagKey: key } });
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

    const models = await this.getModels();
    await models.Flag.update(
      { rollout: nextRollout, updatedAt: new Date() },
      { where: { key } }
    );
    await this.addHistory({
      flagKey: key,
      action: "rollout.set",
      at: new Date(),
      changes: { before: flag.rollout, after: nextRollout },
    });
  }

  async addRule(flagKey: string, input: AddRuleInput): Promise<FlagRule> {
    const models = await this.getModels();
    if (!(await this.getFlag(flagKey))) throw new FlagNotFoundError(flagKey);
    assertSafeConditionGroup(input.conditions, "rule.conditions");

    const row = await models.Rule.create({
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
    });

    await this.addHistory({
      flagKey,
      action: "rule.added",
      at: new Date(),
      changes: { rule: this.toRule(row) },
    });

    return this.toRule(row);
  }

  async updateRule(
    flagKey: string,
    ruleId: string,
    input: UpdateRuleInput
  ): Promise<FlagRule> {
    const models = await this.getModels();
    const rule = await models.Rule.findOne({ where: { flagKey, id: ruleId } });
    if (!rule) throw new RuleNotFoundError(flagKey, ruleId);
    if (input.conditions) assertSafeConditionGroup(input.conditions, "rule.conditions");

    await models.Rule.update(stripUndefined(input as Record<string, unknown>), {
      where: { flagKey, id: ruleId },
    });
    await this.addHistory({
      flagKey,
      action: "rule.updated",
      at: new Date(),
      changes: { ruleId, input },
    });

    const updated = await models.Rule.findOne({ where: { flagKey, id: ruleId } });
    return this.toRule(updated!);
  }

  async removeRule(flagKey: string, ruleId: string): Promise<void> {
    const models = await this.getModels();
    const rule = await models.Rule.findOne({ where: { flagKey, id: ruleId } });
    if (!rule) throw new RuleNotFoundError(flagKey, ruleId);
    await models.Rule.destroy({ where: { flagKey, id: ruleId } });
    await this.addHistory({
      flagKey,
      action: "rule.removed",
      at: new Date(),
      changes: { ruleId },
    });
  }

  async listRules(flagKey: string): Promise<FlagRule[]> {
    const models = await this.getModels();
    return (
      await models.Rule.findAll({
        where: { flagKey },
        order: [["priority", "ASC"]],
      })
    ).map((row) => this.toRule(row));
  }

  async reorderRules(
    flagKey: string,
    ordering: { ruleId: string; priority: number }[]
  ): Promise<void> {
    const models = await this.getModels();
    for (const item of ordering) {
      await models.Rule.update(
        { priority: item.priority },
        { where: { flagKey, id: item.ruleId } }
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
    const models = await this.getModels();
    if (await this.getSegment(input.key)) {
      throw new FlagConflictError(input.key, "segment");
    }
    assertSafeConditionGroup(input.rules, "segment.rules");

    const now = new Date();
    return this.toSegment(
      await models.Segment.create({
        key: input.key,
        description: input.description,
        rules: input.rules,
        createdAt: now,
        updatedAt: now,
      })
    );
  }

  async updateSegment(key: string, input: UpdateSegmentInput): Promise<Segment> {
    const models = await this.getModels();
    if (!(await this.getSegment(key))) throw new SegmentNotFoundError(key);
    if (input.rules) assertSafeConditionGroup(input.rules, "segment.rules");

    await models.Segment.update(
      stripUndefined({ ...input, updatedAt: new Date() }),
      { where: { key } }
    );
    return (await this.getSegment(key))!;
  }

  async deleteSegment(key: string): Promise<void> {
    const models = await this.getModels();
    if (!(await this.getSegment(key))) throw new SegmentNotFoundError(key);
    await models.Segment.destroy({ where: { key } });
  }

  async listSegments(): Promise<Segment[]> {
    const models = await this.getModels();
    return (await models.Segment.findAll()).map((row) => this.toSegment(row));
  }

  async getSegment(key: string): Promise<Segment | null> {
    const models = await this.getModels();
    const row = await models.Segment.findOne({ where: { key } });
    return row ? this.toSegment(row) : null;
  }

  async getSegmentUsage(key: string): Promise<SegmentUsage[]> {
    const models = await this.getModels();
    const usage: SegmentUsage[] = [];
    const rows = await models.Rule.findAll();
    for (const row of rows) {
      const rule = this.toRule(row);
      if (conditionReferencesSegment(rule.conditions, key)) {
        usage.push({ flagKey: rule.flagKey, ruleId: rule.id });
      }
    }
    return usage;
  }

  async createRelease(input: CreateReleaseInput): Promise<Release> {
    const models = await this.getModels();
    const now = new Date();
    return this.toRelease(
      await models.Release.create({
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
        createdAt: now,
      })
    );
  }

  async getRelease(releaseId: string): Promise<Release | null> {
    const models = await this.getModels();
    const row = await models.Release.findOne({ where: { id: releaseId } });
    return row ? this.toRelease(row) : null;
  }

  async listReleases(filters?: {
    environment?: string;
    status?: string;
    limit?: number;
  }): Promise<Release[]> {
    const models = await this.getModels();
    let releases = (await models.Release.findAll()).map((row) =>
      this.toRelease(row)
    );
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
    const models = await this.getModels();
    const snapshots: ReleaseSnapshot[] = [];
    const snapshotted = new Set<string>();

    for (const change of release.changes) {
      const flag = await this.getFlag(change.flagKey);
      if (!flag) continue;

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
      await models.Flag.update(patch, { where: { key: change.flagKey } });
    }

    await models.Release.update(
      {
        status: "deployed",
        deployedAt: new Date(),
        deployedBy,
        snapshots,
      },
      { where: { id: releaseId } }
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
    const models = await this.getModels();

    if (release.snapshots && release.snapshots.length > 0) {
      for (const snap of release.snapshots) {
        const flag = await this.getFlag(snap.flagKey);
        if (!flag) continue;
        await models.Flag.update(
          {
            defaultValue: snap.beforeValue,
            status: snap.beforeStatus,
            rollout: snap.beforeRollout ?? null,
            updatedAt: new Date(),
          },
          { where: { key: snap.flagKey } }
        );
      }
    } else {
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
        await models.Flag.update(patch, { where: { key: change.flagKey } });
      }
    }

    await models.Release.update(
      {
        status: "rolled_back",
        rolledBackAt: new Date(),
        rolledBackBy,
        rollbackReason: reason,
      },
      { where: { id: releaseId } }
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
    const models = await this.getModels();
    const row = await models.Assignment.findOne({ where: { flagKey, userId } });
    return row ? String(plain(row).variantKey) : null;
  }

  async getUserAssignments(
    flagKeys: string[],
    userId: string
  ): Promise<Record<string, string>> {
    if (flagKeys.length === 0) return {};
    const models = await this.getModels();
    const rows = await models.Assignment.findAll({ where: { userId } });
    const out: Record<string, string> = {};
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
    const models = await this.getModels();
    const existing = await models.Assignment.findOne({ where: { flagKey, userId } });
    if (existing) {
      await models.Assignment.update({ variantKey }, { where: { flagKey, userId } });
      return;
    }
    await models.Assignment.create({ flagKey, userId, variantKey });
  }

  async addHistory(entry: Omit<HistoryEntry, "id">): Promise<void> {
    const models = await this.getModels();
    await models.History.create({ ...entry, id: this.genId("hist") });
  }

  async getHistory(
    flagKey: string,
    opts?: { limit?: number }
  ): Promise<HistoryEntry[]> {
    const models = await this.getModels();
    const entries = (
      await models.History.findAll({ where: { flagKey }, order: [["at", "DESC"]] })
    ).map((row) => this.toHistory(row));
    return opts?.limit ? entries.slice(0, opts.limit) : entries;
  }

  async trackImpression(params: {
    flagKey: string;
    userId: string;
    value: unknown;
    variant: string | null;
    reason: string;
  }): Promise<void> {
    const models = await this.getModels();
    await models.Impression.create({ ...params, id: this.genId("imp"), at: new Date() });
  }

  async getAllActiveFlags(opts?: {
    namespace?: string;
    tags?: string[];
    keys?: string[];
    limit?: number;
    offset?: number;
  }): Promise<Flag[]> {
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
    const models = await this.getModels();
    await models.Flag.update(
      { tags: merged, updatedAt: new Date() },
      { where: { key: flagKey } }
    );
  }

  async removeTags(flagKey: string, tags: string[]): Promise<void> {
    const flag = await this.getFlag(flagKey);
    if (!flag) throw new FlagNotFoundError(flagKey);
    const toRemove = new Set(tags);
    const next = (flag.tags || []).filter((tag) => !toRemove.has(tag));
    const models = await this.getModels();
    await models.Flag.update(
      { tags: next, updatedAt: new Date() },
      { where: { key: flagKey } }
    );
  }

  async close(): Promise<void> {
    if (this.sequelize.close) {
      await this.sequelize.close();
    }
  }

  private async getRequiredRelease(releaseId: string): Promise<Release> {
    const release = await this.getRelease(releaseId);
    if (!release) throw new ReleaseNotFoundError(releaseId);
    return release;
  }

  private async getModels(): Promise<Models> {
    await this.ensureInitialized();
    return this.models!;
  }

  private async ensureInitialized(): Promise<void> {
    this.initPromise ??= this.initialize();
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    const module = this.sequelizeModule ?? (await loadSequelizeModule());
    const DataTypes = module.DataTypes;
    const table = (name: string) => `${this.tablePrefix}${name}`;
    const model = (name: string) => `${this.modelNamePrefix}${name}`;

    this.models = {
      Flag: this.useModel(
        "Flag",
        model("Flag"),
        {
          id: field(DataTypes, "STRING", { primaryKey: true }),
          key: field(DataTypes, "STRING", { unique: true, allowNull: false }),
          type: field(DataTypes, "STRING", { allowNull: false }),
          status: field(DataTypes, "STRING", { allowNull: false }),
          defaultValue: field(DataTypes, "JSON", { allowNull: false }),
          description: field(DataTypes, "TEXT"),
          namespace: field(DataTypes, "STRING"),
          tags: field(DataTypes, "JSON"),
          locked: field(DataTypes, "BOOLEAN"),
          lockedReason: field(DataTypes, "TEXT"),
          environments: field(DataTypes, "JSON"),
          variants: field(DataTypes, "JSON"),
          rollout: field(DataTypes, "JSON"),
          scheduledAt: field(DataTypes, "DATE"),
          expiresAt: field(DataTypes, "DATE"),
          createdAt: field(DataTypes, "DATE", { allowNull: false }),
          updatedAt: field(DataTypes, "DATE", { allowNull: false }),
        },
        { tableName: table("flags"), timestamps: false }
      ),
      Rule: this.useModel(
        "Rule",
        model("Rule"),
        {
          id: field(DataTypes, "STRING", { primaryKey: true }),
          flagKey: field(DataTypes, "STRING", { allowNull: false }),
          name: field(DataTypes, "STRING"),
          priority: field(DataTypes, "INTEGER", { allowNull: false }),
          value: field(DataTypes, "JSON"),
          conditions: field(DataTypes, "JSON", { allowNull: false }),
          enabled: field(DataTypes, "BOOLEAN", { allowNull: false }),
          rolloutPct: field(DataTypes, "FLOAT"),
          isHoldout: field(DataTypes, "BOOLEAN"),
          variantId: field(DataTypes, "STRING"),
        },
        { tableName: table("rules"), timestamps: false }
      ),
      Segment: this.useModel(
        "Segment",
        model("Segment"),
        {
          key: field(DataTypes, "STRING", { primaryKey: true }),
          description: field(DataTypes, "TEXT"),
          rules: field(DataTypes, "JSON", { allowNull: false }),
          createdAt: field(DataTypes, "DATE", { allowNull: false }),
          updatedAt: field(DataTypes, "DATE", { allowNull: false }),
        },
        { tableName: table("segments"), timestamps: false }
      ),
      Release: this.useModel(
        "Release",
        model("Release"),
        {
          id: field(DataTypes, "STRING", { primaryKey: true }),
          name: field(DataTypes, "STRING", { allowNull: false }),
          description: field(DataTypes, "TEXT"),
          environment: field(DataTypes, "STRING"),
          status: field(DataTypes, "STRING", { allowNull: false }),
          changes: field(DataTypes, "JSON", { allowNull: false }),
          snapshots: field(DataTypes, "JSON"),
          scheduledAt: field(DataTypes, "DATE"),
          deployedAt: field(DataTypes, "DATE"),
          deployedBy: field(DataTypes, "STRING"),
          rolledBackAt: field(DataTypes, "DATE"),
          rolledBackBy: field(DataTypes, "STRING"),
          rollbackReason: field(DataTypes, "TEXT"),
          createdAt: field(DataTypes, "DATE", { allowNull: false }),
        },
        { tableName: table("releases"), timestamps: false }
      ),
      Assignment: this.useModel(
        "Assignment",
        model("Assignment"),
        {
          flagKey: field(DataTypes, "STRING", { primaryKey: true }),
          userId: field(DataTypes, "STRING", { primaryKey: true }),
          variantKey: field(DataTypes, "STRING", { allowNull: false }),
        },
        { tableName: table("assignments"), timestamps: false }
      ),
      History: this.useModel(
        "History",
        model("History"),
        {
          id: field(DataTypes, "STRING", { primaryKey: true }),
          flagKey: field(DataTypes, "STRING"),
          action: field(DataTypes, "STRING", { allowNull: false }),
          by: field(DataTypes, "STRING"),
          at: field(DataTypes, "DATE", { allowNull: false }),
          changes: field(DataTypes, "JSON"),
          reason: field(DataTypes, "TEXT"),
          releaseId: field(DataTypes, "STRING"),
        },
        { tableName: table("history"), timestamps: false }
      ),
      Impression: this.useModel(
        "Impression",
        model("Impression"),
        {
          id: field(DataTypes, "STRING", { primaryKey: true }),
          flagKey: field(DataTypes, "STRING", { allowNull: false }),
          userId: field(DataTypes, "STRING", { allowNull: false }),
          value: field(DataTypes, "JSON"),
          variant: field(DataTypes, "STRING"),
          reason: field(DataTypes, "STRING", { allowNull: false }),
          at: field(DataTypes, "DATE", { allowNull: false }),
        },
        { tableName: table("impressions"), timestamps: false }
      ),
    };

    if (this.validateColumns) {
      validateSequelizeAdapterModels(this.models);
    }

    if (this.syncOptions && this.sequelize.sync) {
      await this.sequelize.sync(
        this.syncOptions === true ? {} : this.syncOptions
      );
    }
  }

  private useModel(
    key: SequelizeAdapterModelName,
    modelName: string,
    attributes: Record<string, unknown>,
    options?: Record<string, unknown>
  ): ModelLike {
    return this.providedModels?.[key] ?? this.sequelize.define(modelName, attributes, options);
  }

  private toFlag(row: unknown): Flag {
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
      createdAt: date(data.createdAt),
      updatedAt: date(data.updatedAt),
    };
  }

  private toRule(row: unknown): FlagRule {
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
    };
  }

  private toSegment(row: unknown): Segment {
    const data = plain(row);
    return {
      key: String(data.key),
      description: optionalString(data.description),
      rules: data.rules as Segment["rules"],
      createdAt: date(data.createdAt),
      updatedAt: date(data.updatedAt),
    };
  }

  private toRelease(row: unknown): Release {
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
      createdAt: date(data.createdAt),
    };
  }

  private toHistory(row: unknown): HistoryEntry {
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
}

export function createSequelizeAdapter(
  options: SequelizeAdapterOptions
): SequelizeDbAdapter {
  return new SequelizeDbAdapter(options);
}

export function validateSequelizeAdapterModels(
  models: SequelizeAdapterModels
): void {
  for (const modelName of Object.keys(
    ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS
  ) as SequelizeAdapterModelName[]) {
    const model = models[modelName];
    if (!model) {
      throw new ValidationError(`Missing Sequelize model "${modelName}"`, {
        model: modelName,
      });
    }

    const columns = getModelColumnNames(model);
    if (!columns) {
      throw new ValidationError(
        `Cannot validate Sequelize model "${modelName}". Expose rawAttributes or getAttributes().`,
        { model: modelName }
      );
    }

    const missing = ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS[modelName].filter(
      (column) => !columns.has(column)
    );
    if (missing.length > 0) {
      throw new ValidationError(
        `Sequelize model "${modelName}" is missing required Rollease columns`,
        { model: modelName, missingColumns: missing }
      );
    }
  }
}

async function loadSequelizeModule(): Promise<SequelizeModuleLike> {
  const moduleName = "sequelize";
  return (await import(moduleName)) as SequelizeModuleLike;
}

function field(
  DataTypes: Record<string, unknown>,
  type: string,
  options: Record<string, unknown> = {}
): Record<string, unknown> {
  return { type: DataTypes[type], ...options };
}

function getModelColumnNames(model: ModelLike): Set<string> | null {
  const attributes =
    (typeof model.getAttributes === "function" ? model.getAttributes() : undefined) ??
    model.rawAttributes ??
    model.tableAttributes;
  return attributes ? new Set(Object.keys(attributes)) : null;
}

function plain(row: unknown): Record<string, any> {
  if (row && typeof row === "object" && "get" in row) {
    const getter = (row as { get: (opts?: Record<string, unknown>) => unknown }).get;
    return getter.call(row, { plain: true }) as Record<string, any>;
  }
  return row as Record<string, any>;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as T;
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function optionalBoolean(value: unknown): boolean | undefined {
  return value === null || value === undefined ? undefined : Boolean(value);
}

function arrayOrUndefined<T = unknown>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? (value as T[]) : undefined;
}
