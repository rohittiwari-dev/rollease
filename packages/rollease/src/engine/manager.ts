// ============================================================================
// Rollease SDK — Flag Manager
// The main rl.flags API surface.
// ============================================================================

import type {
  CacheAdapter,
  DbAdapter,
  InvalidationBus,
  InvalidationMessage,
} from "../db/adapter";
import type {
  AuditActor,
  Flag,
  FlagContext,
  FlagResult,
  FlagMap,
  DetailedFlagMap,
  Variant,
  FlagRule,
  FlagPrerequisite,
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
  BulkCreateResult,
  BulkUpdateResult,
  WebhookConfig,
  WebhookPayload,
  ExclusionLayer,
  ExclusionLayerAllocation,
  MultiContext,
  ResilienceConfig,
  PrivacyConfig,
  TelemetryAdapter,
  RolleaseHealthResult,
  TrackEventInput,
  TrackingEvent,
} from "../core/types";
import {
  FlagNotFoundError,
  FlagLockedError,
  ValidationError,
  ReleaseConflictError,
} from "../core/errors";
import { evaluateFlag, evaluateConditionGroup } from "./evaluator";
import { WebhookDispatcher } from "../core/webhook";
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
import type { MetricsAdapter } from "../core/metrics";
import { createExposureTracker, type ExposureTracker } from "../core/exposure";

type ChangeListener = (event: {
  flagKey: string;
  action: string;
  value?: unknown;
}) => void;

const OVERRIDE_CACHE_TTL_MS = 5000;
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 100;
const DEFAULT_CIRCUIT_THRESHOLD = 5;
const DEFAULT_CIRCUIT_WINDOW_MS = 30_000;
const DEFAULT_CIRCUIT_RESET_AFTER_MS = 30_000;

type CircuitPhase = "closed" | "open" | "half_open";

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
  private impressions: Required<Omit<ImpressionConfig, "dedupe">> & Pick<ImpressionConfig, "dedupe">;
  private logger: RolleaseLogger;
  private evaluateAllPageSize: number;
  private autoResolveSegments: boolean;
  private webhookDispatcher: WebhookDispatcher;
  private environment?: string;
  private overrideCache: Record<string, unknown> | null = null;
  private overrideReadAt = 0;
  private resilience: ResilienceConfig;
  private privacy: PrivacyConfig;
  private telemetry?: TelemetryAdapter;
  private evalCount = 0;
  private cacheHitCount = 0;
  private cacheMissCount = 0;
  private startedAt = Date.now();
  private invalidationBus?: InvalidationBus;
  private invalidationUnsubscribe?: () => void;
  private instanceId = `rl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  private circuitPhase: CircuitPhase = "closed";
  private circuitFailures = 0;
  private circuitWindowStartedAt = Date.now();
  private circuitOpenedAt = 0;
  private metrics?: MetricsAdapter;
  private exposureTracker?: ExposureTracker;
  private dbReader?: DbAdapter;

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
    webhooks?: WebhookConfig[];
    environment?: string;
    resilience?: ResilienceConfig;
    privacy?: PrivacyConfig;
    telemetry?: TelemetryAdapter;
    invalidationBus?: InvalidationBus;
    metrics?: MetricsAdapter;
    dbReader?: DbAdapter;
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
      dedupe: opts.impressions?.dedupe,
    };
    this.metrics = opts.metrics;
    this.dbReader = opts.dbReader;
    if (opts.impressions?.dedupe) {
      this.exposureTracker = createExposureTracker(opts.impressions.dedupe);
    }
    this.logger = opts.logger ?? noopLogger;
    this.evaluateAllPageSize = opts.evaluateAllPageSize ?? DEFAULT_PAGE_SIZE;
    this.autoResolveSegments = opts.autoResolveSegments ?? false;
    this.webhookDispatcher = new WebhookDispatcher(opts.webhooks || [], this.logger);
    this.environment = opts.environment;
    this.resilience = opts.resilience ?? {};
    this.privacy = opts.privacy ?? {};
    this.telemetry = opts.telemetry;
    this.invalidationBus = opts.invalidationBus;
    if (this.invalidationBus) {
      Promise.resolve(
        this.invalidationBus.subscribe((message) =>
          this.handleInvalidation(message)
        )
      )
        .then((unsubscribe) => {
          this.invalidationUnsubscribe = unsubscribe;
        })
        .catch((err) => {
          this.logger.warn("invalidation bus subscription failed", {
            err: errMessage(err),
          });
        });
    }
  }

  // ── Flag CRUD ────────────────────────────────────────────────────────

  async create(input: CreateFlagInput): Promise<Flag> {
    assertSafeFlagKey(input.key, "flag key");

    // Validate default value type matches flag type
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

    // Validate variant weights sum to 100 for multivariate flags
    if (input.type === "multivariate" && input.variants && input.variants.length > 0) {
      const totalWeight = input.variants.reduce((sum, v) => sum + v.weight, 0);
      if (totalWeight !== 100) {
        throw new ValidationError(
          `Multivariate flag "${input.key}" variant weights must sum to 100, got ${totalWeight}`,
          { flagKey: input.key, totalWeight, variants: input.variants.map((v) => ({ key: v.key, weight: v.weight })) }
        );
      }
    }

    // Validate prerequisites — no self-reference, no circular chains
    if (input.prerequisites && input.prerequisites.length > 0) {
      for (const prereq of input.prerequisites) {
        if (prereq.flagKey === input.key) {
          throw new ValidationError(
            `Flag "${input.key}" cannot have itself as a prerequisite`,
            { flagKey: input.key }
          );
        }
      }
      await this.validatePrerequisiteChain(input.key, input.prerequisites);
    }

    await this.runMutationHook("flag.created", input.key, input.actor);
    const flag = await this.db.createFlag(input);
    await this.bustCache(input.key);
    this.emit({ flagKey: input.key, action: "created" });
    this.webhookDispatcher.dispatch("flag.created", input.key, { flag });
    return flag;
  }

  async get(key: string): Promise<Flag> {
    const flag = await this.withDbResilience("getFlag", () => this.db.getFlag(key));
    if (!flag) throw new FlagNotFoundError(key);
    return flag;
  }

  async list(filters?: ListFlagsInput): Promise<ListFlagsResult> {
    return this.withDbResilience("listFlags", () =>
      this.db.listFlags(filters || {})
    );
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

    // If the update touches prerequisites, re-validate the chain so we don't
    // introduce a cycle through an edit. (Same logic that runs on create.)
    const patchedPrerequisites = (safePatch as { prerequisites?: unknown }).prerequisites;
    if (Array.isArray(patchedPrerequisites)) {
      for (const prereq of patchedPrerequisites as FlagPrerequisite[]) {
        if (prereq?.flagKey === key) {
          throw new ValidationError(
            `Flag "${key}" cannot have itself as a prerequisite`,
            { flagKey: key }
          );
        }
      }
      await this.validatePrerequisiteChain(
        key,
        patchedPrerequisites as FlagPrerequisite[]
      );
    }

    await this.runMutationHook("flag.updated", key, actor);
    const updated = await this.db.updateFlag(key, safePatch);
    await this.bustCache(key);
    this.emit({ flagKey: key, action: "updated" });
    this.webhookDispatcher.dispatch("flag.updated", key, { updated });
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
    this.webhookDispatcher.dispatch(action, key, { updated });
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
    this.webhookDispatcher.dispatch("flag.archived", key, { reason: opts?.reason });
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
    this.webhookDispatcher.dispatch("flag.restored", key, { reason: opts?.reason });
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
    this.webhookDispatcher.dispatch("flag.deleted", key, {});
  }

  async clone(key: string, opts: CloneFlagInput): Promise<Flag> {
    assertSafeFlagKey(opts.newKey, "flag key");
    await this.runMutationHook("flag.cloned", opts.newKey, opts.actor);
    const cloned = await this.db.cloneFlag(
      key,
      opts.newKey,
      opts.includeRules ?? true,
      opts.includeRollout ?? false
    );
    // Bust both the new key (in case a negative-cache entry exists from a
    // prior lookup) and the source key's rules cache (some adapters rewrite
    // rules during clone).
    await this.bustCache(opts.newKey);
    await this.bustCache(key);
    this.emit({ flagKey: opts.newKey, action: "cloned" });
    this.webhookDispatcher.dispatch("flag.cloned", opts.newKey, { cloned, sourceKey: key });
    return cloned;
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

  async evaluateMultiContext<T = unknown>(
    key: string,
    multiContext: MultiContext
  ): Promise<FlagResult<T>> {
    const keys = Object.keys(multiContext.contexts);
    if (keys.length === 0) {
      return this.evaluate<T>(key, {});
    }

    // Validate `primaryKey` early — silently falling back to the first
    // context key on a typo would leak the wrong identity into evaluation.
    if (
      multiContext.primaryKey !== undefined &&
      !keys.includes(multiContext.primaryKey)
    ) {
      throw new ValidationError(
        `MultiContext.primaryKey "${multiContext.primaryKey}" does not match any provided context`,
        { primaryKey: multiContext.primaryKey, available: keys }
      );
    }

    const primaryKey = multiContext.primaryKey || keys[0];
    const primary = multiContext.contexts[primaryKey] || {};

    const mergedContext: FlagContext = {
      userId: primary.userId,
      environment: primary.environment,
      version: primary.version,
      region: primary.region,
      userType: primary.userType,
      ip: primary.ip,
      tenantId: primary.tenantId,
      attributes: {},
      segments: [],
    };

    const attributes: Record<string, unknown> = {};
    const segmentsSet = new Set<string>();

    for (const ctxKey of keys) {
      if (ctxKey === primaryKey) continue;
      const ctx = multiContext.contexts[ctxKey];
      if (ctx.attributes) {
        Object.assign(attributes, ctx.attributes);
      }
      if (ctx.segments) {
        for (const seg of ctx.segments) {
          segmentsSet.add(seg);
        }
      }
    }

    if (primary.attributes) {
      Object.assign(attributes, primary.attributes);
    }
    if (primary.segments) {
      for (const seg of primary.segments) {
        segmentsSet.add(seg);
      }
    }

    for (const ctxKey of keys) {
      if (ctxKey === primaryKey) continue;
      const ctx = multiContext.contexts[ctxKey];
      if (!mergedContext.userId && ctx.userId) mergedContext.userId = ctx.userId;
      if (!mergedContext.environment && ctx.environment) mergedContext.environment = ctx.environment;
      if (!mergedContext.version && ctx.version) mergedContext.version = ctx.version;
      if (!mergedContext.region && ctx.region) mergedContext.region = ctx.region;
      if (!mergedContext.userType && ctx.userType) mergedContext.userType = ctx.userType;
      if (!mergedContext.ip && ctx.ip) mergedContext.ip = ctx.ip;
      if (!mergedContext.tenantId && ctx.tenantId) mergedContext.tenantId = ctx.tenantId;
    }

    mergedContext.attributes = attributes;
    mergedContext.segments = Array.from(segmentsSet);

    // Apply environment scoping consistently with single-context evaluate().
    if (this.environment && !mergedContext.environment) {
      mergedContext.environment = this.environment;
    }

    return this.evaluate<T>(key, mergedContext);
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
    opts?: { keys?: string[]; namespace?: string; tags?: string[]; trace?: boolean }
  ): Promise<DetailedFlagMap> {
    if (opts?.keys && opts.keys.length === 0) return {};

    let activeContext = context;
    if (this.environment && !activeContext.environment) {
      activeContext = { ...activeContext, environment: this.environment };
    }

    // Auto-resolve segments once for the whole bulk eval — matches the
    // single-eval path. Skipped when caller pre-populated context.segments.
    if (
      this.autoResolveSegments &&
      (!activeContext.segments || activeContext.segments.length === 0)
    ) {
      activeContext = {
        ...activeContext,
        segments: await this.resolveSegments(activeContext),
      };
    }

    const result: DetailedFlagMap = {};
    const allFlags: Flag[] = [];

    // Stream pages of active flags so the DB query never returns the whole
    // table in one shot.
    let offset = 0;
    while (true) {
      const page = await this.withDbResilience("getAllActiveFlags", () =>
        this.db.getAllActiveFlags({
          keys: opts?.keys,
          namespace: opts?.namespace,
          tags: opts?.tags,
          limit: this.evaluateAllPageSize,
          offset,
        })
      );
      if (page.length === 0) break;
      allFlags.push(...page);
      if (page.length < this.evaluateAllPageSize) break;
      offset += page.length;
    }

    // Filter flags by environment if context specifies an environment
    let filteredFlags = allFlags;
    if (activeContext.environment) {
      filteredFlags = allFlags.filter(
        (f) => !f.environments || f.environments.length === 0 || f.environments.includes(activeContext.environment!)
      );
    }

    // Batch assignment lookups so we don't issue N round-trips.
    let assignments: Record<string, string> = {};
    if (activeContext.userId && filteredFlags.length > 0) {
      const flagKeys = filteredFlags.map((f) => f.key);
      if (typeof this.db.getUserAssignments === "function") {
        assignments = await this.withDbResilience("getUserAssignments", () =>
          this.db.getUserAssignments!(flagKeys, activeContext.userId!)
        );
      } else {
        for (const key of flagKeys) {
          const v = await this.withDbResilience("getUserAssignment", () =>
            this.db.getUserAssignment(key, activeContext.userId!)
          );
          if (v) assignments[key] = v;
        }
      }
    }

    // Build a lookup so prerequisite resolution can find sibling flags in O(1)
    // without re-fetching them per child.
    const flagsByKey = new Map<string, Flag>();
    for (const f of filteredFlags) flagsByKey.set(f.key, f);
    // Memoize prereq evaluation so a flag referenced multiple times is
    // resolved once per bulk call.
    const prereqResultCache = new Map<string, FlagResult>();

    for (const flag of filteredFlags) {
      try {
        await this.runBeforeEvaluation(flag.key, activeContext);
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

      let exclusionLayer: ExclusionLayer | undefined;
      if (flag.exclusionLayer) {
        const layer = await this.getExclusionLayerCached(flag.exclusionLayer);
        if (layer) {
          exclusionLayer = layer;
        }
      }

      // Resolve prerequisites — recursive, cached, cycle-safe.
      let prerequisiteResults: Record<string, FlagResult> | undefined;
      if (flag.prerequisites && flag.prerequisites.length > 0) {
        prerequisiteResults = {};
        for (const prereq of flag.prerequisites) {
          let prereqResult = prereqResultCache.get(prereq.flagKey);
          if (!prereqResult) {
            prereqResult = await this.evaluate(prereq.flagKey, activeContext);
            prereqResultCache.set(prereq.flagKey, prereqResult);
          }
          prerequisiteResults[prereq.flagKey] = prereqResult;
        }
      }

      const evalResult = evaluateFlag(flag, activeContext, {
        rules,
        userAssignment: assignments[flag.key] ?? undefined,
        localOverride: this.getLocalOverride(flag.key),
        exclusionLayer,
        prerequisiteResults,
        onWarning: (msg, meta) => this.logger.warn(msg, meta),
        trace: opts?.trace,
      });
      result[flag.key] = evalResult;
      this.metrics?.increment("rollease_evaluations_total", { flag: flag.key });
      this.maybeTrackImpression(evalResult, activeContext);
      this.fireOnEvaluate(evalResult, activeContext);
      this.touchFlagEvaluation(flag.key);
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
    this.webhookDispatcher.dispatch("flag.killed", key, { reason: opts?.reason });
  }

  async killAll(opts: {
    environment?: string;
    reason?: string;
    killedBy?: string;
    actor?: AuditActor;
  }): Promise<void> {
    await this.runMutationHook("flag.killed", undefined, opts.actor);
    const flags = await this.db.getAllActiveFlags();
    const at = new Date();
    for (const flag of flags) {
      // Per-flag audit + webhook so incident response can replay exactly which
      // flags were affected by a bulk kill. The bulk emit() event below is
      // still preserved for legacy listeners.
      await this.db.setFlagStatus(flag.key, "killed");
      await this.db.addHistory({
        flagKey: flag.key,
        action: "flag.killed",
        by: opts.actor ?? opts.killedBy,
        reason: opts.reason,
        at,
      });
      this.webhookDispatcher.dispatch("flag.killed", flag.key, {
        reason: opts.reason,
        bulk: true,
      });
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
    const at = new Date();
    for (const flag of allFlags.data) {
      await this.db.setFlagStatus(flag.key, "active");
      await this.db.addHistory({
        flagKey: flag.key,
        action: "flag.restored",
        by: opts.actor ?? opts.restoredBy,
        at,
      });
      this.webhookDispatcher.dispatch("flag.restored", flag.key, { bulk: true });
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
    this.webhookDispatcher.dispatch("rule.added", flagKey, { rule: created });
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
    this.webhookDispatcher.dispatch("rule.updated", flagKey, { rule: updated });
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
    this.webhookDispatcher.dispatch("rule.removed", flagKey, { ruleId });
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
    this.webhookDispatcher.dispatch("rollout.set", key, { rollout: config });
  }

  // ── Segments ─────────────────────────────────────────────────────────

  async createSegment(input: CreateSegmentInput): Promise<Segment> {
    assertSafeFlagKey(input.key, "segment key");
    assertSafeConditionGroup(input.rules, "segment.rules");
    await this.runMutationHook("segment.created", undefined, input.actor);
    const segment = await this.db.createSegment(input);
    this.webhookDispatcher.dispatch("segment.created", undefined, { segment });
    return segment;
  }

  async updateSegment(key: string, patch: UpdateSegmentInput): Promise<Segment> {
    if (patch.rules) {
      assertSafeConditionGroup(patch.rules, "segment.rules");
    }
    await this.runMutationHook("segment.updated", undefined, patch.actor);
    const segment = await this.db.updateSegment(key, patch);
    this.webhookDispatcher.dispatch("segment.updated", undefined, { segment });
    return segment;
  }

  async deleteSegment(key: string, opts?: { actor?: AuditActor }): Promise<void> {
    await this.runMutationHook("segment.deleted", undefined, opts?.actor);
    await this.db.deleteSegment(key);
    this.webhookDispatcher.dispatch("segment.deleted", undefined, { key });
  }

  async listSegments(): Promise<Segment[]> {
    return this.db.listSegments();
  }

  async getSegmentUsage(key: string): Promise<SegmentUsage[]> {
    return this.db.getSegmentUsage(key);
  }

  // ── Exclusion Layers ──────────────────────────────────────────────────

  async createExclusionLayer(
    input: ExclusionLayer,
    opts?: { actor?: AuditActor }
  ): Promise<ExclusionLayer> {
    if (!this.db.createExclusionLayer) {
      throw new ValidationError("Exclusion layers are not supported by the database adapter");
    }
    assertSafeFlagKey(input.key, "exclusion layer key");
    assertValidExclusionLayer(input);
    // Surface as `segment.created` since there's no dedicated history action
    // — RBAC hooks can still gate it via that closest-fit predicate.
    await this.runMutationHook("segment.created", undefined, opts?.actor);
    const created = await this.db.createExclusionLayer(input);
    this.webhookDispatcher.dispatch("segment.created", undefined, {
      exclusionLayer: created,
    });
    return created;
  }

  async getExclusionLayer(key: string): Promise<ExclusionLayer | null> {
    if (!this.db.getExclusionLayer) return null;
    return this.db.getExclusionLayer(key);
  }

  async updateExclusionLayer(
    key: string,
    allocations: ExclusionLayerAllocation[],
    opts?: { actor?: AuditActor }
  ): Promise<ExclusionLayer> {
    if (!this.db.updateExclusionLayer || !this.db.getExclusionLayer) {
      throw new ValidationError("Exclusion layers are not supported by the database adapter");
    }
    const layer = await this.db.getExclusionLayer(key);
    if (!layer) {
      throw new ValidationError(`Exclusion layer "${key}" not found`, {
        exclusionLayer: key,
      });
    }
    assertValidExclusionLayer({ ...layer, allocations });
    await this.runMutationHook("segment.updated", undefined, opts?.actor);
    if (layer) {
      for (const flagKey of layer.flagKeys) {
        await this.bustCache(flagKey);
      }
    }
    for (const alloc of allocations) {
      await this.bustCache(alloc.flagKey);
    }
    await this.l1Cache.del(`rollease:exclusion_layer:${key}`);
    if (this.l2Cache) {
      await this.l2Cache.del(`rollease:exclusion_layer:${key}`);
    }
    const updated = await this.db.updateExclusionLayer(key, allocations);
    this.webhookDispatcher.dispatch("segment.updated", undefined, {
      exclusionLayer: updated,
    });
    return updated;
  }

  async deleteExclusionLayer(
    key: string,
    opts?: { actor?: AuditActor }
  ): Promise<void> {
    if (!this.db.deleteExclusionLayer || !this.db.getExclusionLayer) {
      throw new ValidationError("Exclusion layers are not supported by the database adapter");
    }
    await this.runMutationHook("segment.deleted", undefined, opts?.actor);
    const layer = await this.db.getExclusionLayer(key);
    if (layer) {
      for (const flagKey of layer.flagKeys) {
        await this.bustCache(flagKey);
      }
    }
    await this.l1Cache.del(`rollease:exclusion_layer:${key}`);
    if (this.l2Cache) {
      await this.l2Cache.del(`rollease:exclusion_layer:${key}`);
    }
    await this.db.deleteExclusionLayer(key);
    this.webhookDispatcher.dispatch("segment.deleted", undefined, {
      exclusionLayer: key,
    });
  }

  async listExclusionLayers(): Promise<ExclusionLayer[]> {
    if (!this.db.listExclusionLayers) return [];
    return this.db.listExclusionLayers();
  }

  // ── Releases ─────────────────────────────────────────────────────────

  async createRelease(input: CreateReleaseInput): Promise<Release> {
    await this.runMutationHook("release.created", undefined, input.actor);
    const release = await this.db.createRelease(input);
    this.webhookDispatcher.dispatch("release.created", undefined, {
      releaseId: release.id,
      pending: true,
      requiresApproval: release.requiresApproval ?? false,
    });
    return release;
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
        case "setRollout":
          // Rollout doesn't change defaultValue/status. Preview shows the
          // status as unchanged but surfaces the rollout delta via the
          // change's `rollout` field, which the caller can inspect.
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
    const release = await this.db.getRelease(releaseId);
    if (!release) throw new ValidationError("Release not found", { releaseId });

    if (release.requiresApproval && release.approvalStatus !== "approved") {
      throw new ReleaseConflictError(
        `Cannot deploy release "${release.name}" (${releaseId}) because it requires approval and is currently ${release.approvalStatus || "pending"}`
      );
    }

    await this.runMutationHook("release.deployed", undefined, opts?.actor);
    await this.db.deployRelease(releaseId, opts?.deployedBy);
    await this.bustAllCaches();
    this.emit({ flagKey: "*", action: "release_deployed" });
    this.webhookDispatcher.dispatch("release.deployed", undefined, { releaseId });
  }

  async rollbackRelease(releaseId: string, opts?: RollbackReleaseInput): Promise<void> {
    await this.runMutationHook("release.rolled_back", undefined, opts?.actor);
    await this.db.rollbackRelease(releaseId, opts?.rolledBackBy, opts?.reason);
    await this.bustAllCaches();
    this.emit({ flagKey: "*", action: "release_rolled_back" });
    this.webhookDispatcher.dispatch("release.rolled_back", undefined, { releaseId, reason: opts?.reason });
  }

  async approveRelease(releaseId: string, approverId: string, opts?: { actor?: AuditActor }): Promise<Release> {
    if (!this.db.approveRelease) {
      throw new ValidationError("Release approvals are not supported by the database adapter");
    }
    await this.runMutationHook("release.approved", undefined, opts?.actor);
    const release = await this.db.approveRelease(releaseId, approverId);
    this.emit({ flagKey: "*", action: "release_approved" });
    this.webhookDispatcher.dispatch("release.approved", undefined, {
      releaseId,
      approverId,
      approvalStatus: release.approvalStatus,
    });
    return release;
  }

  async rejectRelease(releaseId: string, rejectorId: string, opts?: { reason?: string; actor?: AuditActor }): Promise<Release> {
    if (!this.db.rejectRelease) {
      throw new ValidationError("Release approvals are not supported by the database adapter");
    }
    await this.runMutationHook("release.rejected", undefined, opts?.actor);
    const release = await this.db.rejectRelease(releaseId, rejectorId, opts?.reason);
    this.emit({ flagKey: "*", action: "release_rejected" });
    this.webhookDispatcher.dispatch("release.rejected", undefined, {
      releaseId,
      rejectorId,
      reason: opts?.reason,
    });
    return release;
  }

  async listReleases(filters?: {
    environment?: string;
    status?: string;
    limit?: number;
  }): Promise<Release[]> {
    return this.db.listReleases(filters);
  }

  // ── Health ───────────────────────────────────────────────────────────

  async health(): Promise<RolleaseHealthResult> {
    const start = Date.now();
    let dbStatus: "ok" | "error" = "ok";
    try {
      await this.withDbResilience("health.listFlags", () =>
        this.db.listFlags({ limit: 1 })
      );
    } catch {
      dbStatus = "error";
    }
    let cacheStatus: "ok" | "error" | "disabled" = this.l2Cache ? "ok" : "disabled";
    if (this.l2Cache) {
      try {
        const key = "rollease:health";
        await this.l2Cache.set(key, "ok", 1000);
        await this.l2Cache.get(key);
        await this.l2Cache.del(key);
      } catch {
        cacheStatus = "error";
      }
    }
    const latencyMs = Date.now() - start;
    const total = this.cacheHitCount + this.cacheMissCount;
    const cacheHitRate = total > 0 ? this.cacheHitCount / total : 0;
    return {
      status:
        dbStatus === "error"
          ? "unhealthy"
          : cacheStatus === "error"
            ? "degraded"
            : "healthy",
      db: dbStatus,
      cache: cacheStatus,
      circuit: this.resilience.circuitBreaker ? this.circuitPhase : "disabled",
      latencyMs,
      evalCount: this.evalCount,
      cacheHits: this.cacheHitCount,
      cacheMisses: this.cacheMissCount,
      cacheHitRate,
      uptimeMs: Date.now() - this.startedAt,
      ts: Date.now(),
    };
  }

  /** Return serialized Prometheus-format metrics. Returns empty string when no metrics adapter is configured. */
  getMetrics(): string {
    return this.metrics?.serialize() ?? "";
  }

  // ── Privacy / GDPR ───────────────────────────────────────────────────

  async forgetUser(
    userId: string,
    scope?: Array<"impressions" | "assignments" | "history" | "events">
  ): Promise<void> {
    if (!this.db.forgetUser) {
      throw new ValidationError(
        "forgetUser is not supported by the current database adapter"
      );
    }
    await this.db.forgetUser(userId, scope);
  }

  // ── Scheduled Releases ───────────────────────────────────────────────

  async trackEvent(event: TrackEventInput): Promise<TrackingEvent | void> {
    if (!event.event || typeof event.event !== "string") {
      throw new ValidationError("event is required");
    }
    if (!this.db.trackEvent) {
      this.logger.debug("trackEvent skipped: adapter does not support events", {
        event: event.event,
      });
      return;
    }
    const safeContext = event.context ? this.scrubContext(event.context) : undefined;
    return this.withDbResilience("trackEvent", () =>
      this.db.trackEvent!({ ...event, context: safeContext })
    );
  }

  async close(): Promise<void> {
    this.invalidationUnsubscribe?.();
    if (this.invalidationBus?.close) {
      await this.invalidationBus.close();
    }
  }

  async runScheduledReleases(): Promise<{
    deployed: string[];
    failed: Array<{ id: string; error: string }>;
  }> {
    if (!this.db.listScheduledReleases) {
      return { deployed: [], failed: [] };
    }
    const releases = await this.withDbResilience("listScheduledReleases", () =>
      this.db.listScheduledReleases!()
    );
    const deployed: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const release of releases) {
      try {
        await this.deployRelease(release.id);
        deployed.push(release.id);
      } catch (err) {
        failed.push({ id: release.id, error: errMessage(err) });
        this.logger.warn("scheduled release deployment failed", {
          releaseId: release.id,
          err: errMessage(err),
        });
      }
    }
    return { deployed, failed };
  }

  // ── Tags ─────────────────────────────────────────────────────────────

  async addTags(
    key: string,
    tags: string[],
    opts?: { actor?: AuditActor }
  ): Promise<void> {
    await this.runMutationHook("tags.added", key, opts?.actor);
    await this.db.addTags(key, tags);
    await this.db.addHistory({
      flagKey: key,
      action: "tags.added",
      by: opts?.actor,
      changes: { tags },
      at: new Date(),
    });
    await this.bustCache(key);
    this.emit({ flagKey: key, action: "tags_added" });
    this.webhookDispatcher.dispatch("tags.added", key, { tags });
  }

  async removeTags(
    key: string,
    tags: string[],
    opts?: { actor?: AuditActor }
  ): Promise<void> {
    await this.runMutationHook("tags.removed", key, opts?.actor);
    await this.db.removeTags(key, tags);
    await this.db.addHistory({
      flagKey: key,
      action: "tags.removed",
      by: opts?.actor,
      changes: { tags },
      at: new Date(),
    });
    await this.bustCache(key);
    this.emit({ flagKey: key, action: "tags_removed" });
    this.webhookDispatcher.dispatch("tags.removed", key, { tags });
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

  /** Register a local Javascript/Typescript event listener callback */
  on(event: HistoryAction | "*", callback: (payload: WebhookPayload) => void | Promise<void>): void {
    this.webhookDispatcher.on(event, callback);
  }

  /** Remove a local Javascript/Typescript event listener callback */
  off(event: HistoryAction | "*", callback: (payload: WebhookPayload) => void | Promise<void>): void {
    this.webhookDispatcher.off(event, callback);
  }

  // ── Stale Flag Detection ────────────────────────────────────────────

  /**
   * Return flags that haven't been evaluated since `staleDays` ago.
   * Useful for cleaning up flag debt.
   */
  async getStaleFlags(opts?: {
    staleDays?: number;
    namespace?: string;
  }): Promise<Flag[]> {
    const days = opts?.staleDays ?? 30;
    const staleAfter = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000
    ).toISOString();
    const result = await this.withDbResilience("listFlags", () =>
      this.db.listFlags({
        staleAfter,
        namespace: opts?.namespace,
        status: "active",
      })
    );
    return result.data;
  }

  // ── Bulk Operations ─────────────────────────────────────────────────

  /**
   * Create multiple flags in a single call. Individual failures are returned
   * as errors — not thrown — so partial successes are possible.
   */
  async bulkCreate(inputs: CreateFlagInput[]): Promise<BulkCreateResult> {
    const created: Flag[] = [];
    const errors: Array<{ key: string; error: string }> = [];

    for (const input of inputs) {
      try {
        const flag = await this.create(input);
        created.push(flag);
      } catch (err) {
        errors.push({
          key: input.key,
          error: errMessage(err),
        });
      }
    }

    return { created, errors };
  }

  /**
   * Update multiple flags in a single call. Individual failures are returned
   * as errors — not thrown — so partial successes are possible.
   */
  async bulkUpdate(
    updates: Array<{ key: string; patch: UpdateFlagInput }>
  ): Promise<BulkUpdateResult> {
    const updated: Flag[] = [];
    const errors: Array<{ key: string; error: string }> = [];

    for (const { key, patch } of updates) {
      try {
        const flag = await this.update(key, patch);
        updated.push(flag);
      } catch (err) {
        errors.push({
          key,
          error: errMessage(err),
        });
      }
    }

    return { updated, errors };
  }

  /**
   * Delete multiple flags in a single call. Requires `confirm: true`.
   * Stops at the first failure and throws.
   */
  async bulkDelete(
    keys: string[],
    opts?: { confirm: boolean; actor?: AuditActor }
  ): Promise<void> {
    if (opts?.confirm !== true) {
      throw new ValidationError(
        "Bulk deletion requires { confirm: true }",
        {}
      );
    }
    for (const key of keys) {
      await this.delete(key, { confirm: true, actor: opts?.actor });
    }
  }

  // ── Evaluation (public detailed result) ─────────────────────────────

  /**
   * Evaluate a single flag and return the full FlagResult (value, variant,
   * reason, ruleId, evaluatedAt). This is the detailed counterpart to
   * `isEnabled`/`getValue`/`getVariant` — use it when you need the reason
   * (e.g. for analytics, debugging, or RBAC auditing).
   *
   * ```ts
   * const result = await rl.flags.evaluate('checkout_v2', { userId: 'u1' })
   * console.log(result.value, result.reason, result.variant)
   * ```
   */
  async evaluate<T = unknown>(
    key: string,
    context: FlagContext,
    callOptions?: { trace?: boolean }
  ): Promise<FlagResult<T>> {
    this.evalCount++;
    this.metrics?.increment("rollease_evaluations_total", { flag: key });
    const start = Date.now();
    const span = this.telemetry?.startSpan("rollease.evaluate", { "flag.key": key });
    try {
      const result = await this.evaluateInternal<T>(key, context, undefined, callOptions?.trace);
      span?.setAttribute("flag.value", String(result.value));
      span?.setAttribute("flag.reason", result.reason);
      span?.setAttribute("flag.variant", result.variant ?? "");
      span?.end("ok");
      this.metrics?.histogram("rollease_evaluation_duration_seconds", (Date.now() - start) / 1000, { flag: key });
      return result;
    } catch (err) {
      span?.end("error", err instanceof Error ? err : new Error(String(err)));
      this.metrics?.increment("rollease_errors_total", { flag: key, operation: "evaluate" });
      if (this.resilience.fallbackOnError) {
        this.logger.warn("evaluate failed, returning fallback", {
          flagKey: key,
          err: errMessage(err),
        });
        return errorFallbackResult<T>(key);
      }
      throw err;
    }
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  /**
   * Internal evaluation with cycle-tracking for recursive prerequisite
   * resolution. The public `evaluate()` delegates here without exposing the
   * chain bookkeeping.
   */
  private async evaluateInternal<T = unknown>(
    key: string,
    context: FlagContext,
    prereqChain?: Set<string>,
    trace?: boolean
  ): Promise<FlagResult<T>> {
    if (this.environment && !context.environment) {
      context = { ...context, environment: this.environment };
    }

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

    // Environment filter: if the flag is scoped to specific environments and the
    // current context specifies an environment, skip flags not targeting it.
    if (
      context.environment &&
      flag.environments &&
      flag.environments.length > 0 &&
      !flag.environments.includes(context.environment)
    ) {
      return missingFlagResult<T>(key);
    }

    // Resolve prerequisites recursively
    let prerequisiteResults: Record<string, FlagResult> | undefined;
    if (flag.prerequisites && flag.prerequisites.length > 0) {
      const chain = prereqChain ?? new Set<string>();
      chain.add(key);
      prerequisiteResults = {};
      for (const prereq of flag.prerequisites) {
        if (chain.has(prereq.flagKey)) {
          // Circular dependency detected — fail closed
          this.logger.warn("circular prerequisite detected", {
            flagKey: key,
            prereqKey: prereq.flagKey,
            chain: Array.from(chain),
          });
          return missingFlagResult<T>(key);
        }
        if (chain.size > 10) {
          this.logger.warn("prerequisite chain depth exceeded", {
            flagKey: key,
            depth: chain.size,
          });
          return missingFlagResult<T>(key);
        }
        prerequisiteResults[prereq.flagKey] = await this.evaluateInternal(
          prereq.flagKey,
          context,
          new Set(chain)
        );
      }
    }

    const rules = await this.getRulesCached(key);
    let assignment: string | null = null;
    if (context.userId) {
      assignment = await this.withDbResilience("getUserAssignment", () =>
        this.db.getUserAssignment(key, context.userId!)
      );
    }

    let exclusionLayer: ExclusionLayer | undefined;
    if (flag.exclusionLayer) {
      const layer = await this.getExclusionLayerCached(flag.exclusionLayer);
      if (layer) {
        exclusionLayer = layer;
      }
    }

    const result = evaluateFlag<T>(flag, context, {
      rules,
      userAssignment: assignment || undefined,
      localOverride: this.getLocalOverride(key),
      prerequisiteResults,
      exclusionLayer,
      onWarning: (msg, meta) => this.logger.warn(msg, meta),
      trace,
    });

    this.maybeTrackImpression(result, context);
    this.fireOnEvaluate(result, context);

    // Fire-and-forget touch for stale flag detection
    this.touchFlagEvaluation(key);

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
      const segments = await this.withDbResilience("listSegments", () =>
        this.db.listSegments()
      );
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

  private async withDbResilience<T>(
    operation: string,
    fn: () => Promise<T>
  ): Promise<T> {
    this.throwIfCircuitOpen(operation);
    const retry = this.resilience.retry;
    const attempts = retry ? Math.max(1, retry.attempts ?? DEFAULT_RETRY_ATTEMPTS) : 1;
    const backoffMs = retry?.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    const jitter = retry?.jitter ?? true;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const result = await fn();
        this.recordDbSuccess();
        return result;
      } catch (err) {
        lastErr = err;
        this.recordDbFailure();
        if (attempt >= attempts || this.circuitPhase === "open") break;
        await sleep(backoffMsForAttempt(backoffMs, attempt, jitter));
      }
    }

    this.logger.warn("database operation failed", {
      operation,
      err: errMessage(lastErr),
    });
    throw lastErr;
  }

  private throwIfCircuitOpen(operation: string): void {
    const cfg = this.resilience.circuitBreaker;
    if (!cfg || this.circuitPhase !== "open") return;
    const resetAfterMs = cfg.resetAfterMs ?? DEFAULT_CIRCUIT_RESET_AFTER_MS;
    if (Date.now() - this.circuitOpenedAt >= resetAfterMs) {
      this.circuitPhase = "half_open";
      return;
    }
    throw new Error(`Rollease circuit breaker open for ${operation}`);
  }

  private recordDbSuccess(): void {
    if (!this.resilience.circuitBreaker) return;
    this.circuitPhase = "closed";
    this.circuitFailures = 0;
    this.circuitWindowStartedAt = Date.now();
    this.circuitOpenedAt = 0;
  }

  private recordDbFailure(): void {
    const cfg = this.resilience.circuitBreaker;
    if (!cfg) return;
    const now = Date.now();
    const windowMs = cfg.windowMs ?? DEFAULT_CIRCUIT_WINDOW_MS;
    if (now - this.circuitWindowStartedAt > windowMs) {
      this.circuitWindowStartedAt = now;
      this.circuitFailures = 0;
    }
    this.circuitFailures++;
    const threshold = cfg.threshold ?? DEFAULT_CIRCUIT_THRESHOLD;
    if (this.circuitFailures >= threshold || this.circuitPhase === "half_open") {
      this.circuitPhase = "open";
      this.circuitOpenedAt = now;
      this.logger.warn("database circuit breaker opened", {
        failures: this.circuitFailures,
        threshold,
      });
    }
  }

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
      this.cacheHitCount++;
      this.metrics?.increment("rollease_cache_hits_total", { tier: "l1", flag: key });
      return parseCachedFlag(l1Hit);
    }

    // L2
    if (this.l2Cache) {
      const l2Hit = await this.l2Cache.get(cacheKey);
      if (l2Hit !== null) {
        this.cacheHitCount++;
        this.metrics?.increment("rollease_cache_hits_total", { tier: "l2", flag: key });
        await this.l1Cache.set(cacheKey, l2Hit, this.l1TtlMs);
        return parseCachedFlag(l2Hit);
      }
    }

    // DB
    this.cacheMissCount++;
    this.metrics?.increment("rollease_cache_misses_total", { flag: key });
    const dbToUse = this.dbReader ?? this.db;
    const flag = await this.withDbResilience("getFlag", () => dbToUse.getFlag(key));
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

    const rules = await this.withDbResilience("listRules", () =>
      this.db.listRules(key)
    );
    const serialized = JSON.stringify(rules);
    await this.l1Cache.set(cacheKey, serialized, this.l1TtlMs);
    if (this.l2Cache) {
      await this.l2Cache.set(cacheKey, serialized, this.l2TtlMs);
    }
    return rules;
  }

  private async getExclusionLayerCached(key: string): Promise<ExclusionLayer | null> {
    if (!this.db.getExclusionLayer) return null;
    const cacheKey = `rollease:exclusion_layer:${key}`;

    const l1Hit = await this.l1Cache.get(cacheKey);
    if (l1Hit !== null) {
      if (l1Hit === "null") return null;
      return JSON.parse(l1Hit) as ExclusionLayer;
    }

    if (this.l2Cache) {
      const l2Hit = await this.l2Cache.get(cacheKey);
      if (l2Hit !== null) {
        await this.l1Cache.set(cacheKey, l2Hit, this.l1TtlMs);
        if (l2Hit === "null") return null;
        return JSON.parse(l2Hit) as ExclusionLayer;
      }
    }

    const layer = await this.withDbResilience("getExclusionLayer", () =>
      this.db.getExclusionLayer!(key)
    );
    const serialized = JSON.stringify(layer);
    await this.l1Cache.set(cacheKey, serialized || "null", this.l1TtlMs);
    if (this.l2Cache) {
      await this.l2Cache.set(cacheKey, serialized || "null", this.l2TtlMs);
    }
    return layer;
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

  private async bustCache(
    key: string,
    opts?: { publish?: boolean }
  ): Promise<void> {
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
    if (opts?.publish !== false) {
      await this.publishInvalidation({ scope: "flag", key });
    }
  }

  private async bustAllCaches(opts?: { publish?: boolean }): Promise<void> {
    await this.l1Cache.delPattern("rollease:*");
    if (this.l2Cache?.delPattern) {
      await this.l2Cache.delPattern("rollease:*");
    }
    if (opts?.publish !== false) {
      await this.publishInvalidation({ scope: "all" });
    }
  }

  private async publishInvalidation(
    message: Omit<InvalidationMessage, "sourceId" | "ts">
  ): Promise<void> {
    if (!this.invalidationBus) return;
    try {
      await this.invalidationBus.publish({
        ...message,
        sourceId: this.instanceId,
        ts: Date.now(),
      });
    } catch (err) {
      this.logger.warn("invalidation publish failed", {
        key: message.key,
        scope: message.scope,
        err: errMessage(err),
      });
    }
  }

  private async handleInvalidation(message: InvalidationMessage): Promise<void> {
    if (message.sourceId === this.instanceId) return;
    if (message.scope === "all") {
      await this.bustAllCaches({ publish: false });
      this.emit({ flagKey: "*", action: "invalidated_all" });
      return;
    }
    if (!message.key) return;
    await this.bustCache(message.key, { publish: false });
    this.emit({
      flagKey: message.key,
      action: message.action ?? "invalidated",
    });
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
    // Pass scrubbed context so PII never reaches hook handlers.
    await this.hooks.onBeforeEvaluation({ flagKey, context: this.scrubContext(context) });
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
    // Deduplication: skip if this (user, flag, value) was tracked recently.
    if (this.exposureTracker && !this.exposureTracker.shouldTrack(result, context)) {
      return;
    }
    const safe = this.scrubContext(context);
    this.metrics?.increment("rollease_impressions_total", { flag: result.key, reason: result.reason });
    // Fire-and-forget — never block evaluation on impression IO.
    this.db
      .trackImpression({
        flagKey: result.key,
        userId: safe.userId!,
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

  private scrubContext(ctx: FlagContext): FlagContext {
    if (!this.privacy.privateAttributes?.length) return ctx;
    const attrs = { ...(ctx.attributes ?? {}) };
    const scrubbed: Record<string, unknown> = { ...ctx };
    for (const k of this.privacy.privateAttributes) {
      // Scrub from ctx.attributes
      if (k in attrs) attrs[k] = "[REDACTED]";
      // Also scrub top-level FlagContext fields (userId, region, tenantId, ip, etc.)
      if (k in scrubbed) scrubbed[k] = "[REDACTED]";
    }
    return { ...scrubbed, attributes: attrs } as FlagContext;
  }

  // ── Prerequisite Validation ───────────────────────────────────────────

  /**
   * Validate that a set of prerequisites does not create circular
   * dependency chains. Uses DFS with max depth of 10.
   */
  private async validatePrerequisiteChain(
    flagKey: string,
    prerequisites: FlagPrerequisite[],
    visited: Set<string> = new Set()
  ): Promise<void> {
    visited.add(flagKey);
    if (visited.size > 10) {
      throw new ValidationError(
        `Prerequisite chain for "${flagKey}" exceeds maximum depth of 10`,
        { flagKey, chain: Array.from(visited) }
      );
    }
    for (const prereq of prerequisites) {
      if (visited.has(prereq.flagKey)) {
        throw new ValidationError(
          `Circular prerequisite chain detected: ${Array.from(visited).join(" → ")} → ${prereq.flagKey}`,
          { flagKey, circular: prereq.flagKey, chain: Array.from(visited) }
        );
      }
      // Check if the prerequisite flag itself has prerequisites
      const prereqFlag = await this.db.getFlag(prereq.flagKey);
      if (prereqFlag?.prerequisites && prereqFlag.prerequisites.length > 0) {
        await this.validatePrerequisiteChain(
          prereq.flagKey,
          prereqFlag.prerequisites,
          new Set(visited)
        );
      }
    }
  }

  // ── Stale Flag Detection (fire-and-forget) ────────────────────────────

  private touchFlagEvaluation(key: string): void {
    if (!this.db.touchFlagEvaluation) return;
    this.db.touchFlagEvaluation(key).catch((err) => {
      this.logger.debug("touchFlagEvaluation failed", {
        flagKey: key,
        err: errMessage(err),
      });
    });
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

function errorFallbackResult<T>(key: string): FlagResult<T> {
  return {
    key,
    value: null as T,
    variant: null,
    enabled: false,
    reason: "error_fallback",
    ruleId: null,
    evaluatedAt: new Date(),
  };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMsForAttempt(baseMs: number, attempt: number, jitter: boolean): number {
  const exponential = baseMs * Math.max(1, 2 ** (attempt - 1));
  if (!jitter) return exponential;
  return Math.floor(exponential * (0.5 + Math.random()));
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

/**
 * Validate an exclusion layer: bucket ranges within 0..100, no overlap,
 * allocations only point at flags that the layer declares.
 *
 * Without these checks, overlapping buckets would silently put the same user
 * into multiple mutually-exclusive experiments, defeating the layer's purpose.
 */
function assertValidExclusionLayer(layer: ExclusionLayer): void {
  if (!Array.isArray(layer.flagKeys) || layer.flagKeys.length === 0) {
    throw new ValidationError("Exclusion layer must declare at least one flag", {
      exclusionLayer: layer.key,
    });
  }
  if (!Array.isArray(layer.allocations)) {
    throw new ValidationError("Exclusion layer allocations must be an array", {
      exclusionLayer: layer.key,
    });
  }
  const declaredFlags = new Set(layer.flagKeys);
  // Sort by startBucket so overlap detection runs in O(n log n).
  const sorted = [...layer.allocations].sort(
    (a, b) => a.startBucket - b.startBucket
  );
  let prevEnd = 0;
  for (const alloc of sorted) {
    if (!declaredFlags.has(alloc.flagKey)) {
      throw new ValidationError(
        `Exclusion layer allocation references flag "${alloc.flagKey}" which is not in flagKeys`,
        { exclusionLayer: layer.key, allocation: alloc }
      );
    }
    if (
      typeof alloc.startBucket !== "number" ||
      typeof alloc.endBucket !== "number" ||
      !Number.isFinite(alloc.startBucket) ||
      !Number.isFinite(alloc.endBucket)
    ) {
      throw new ValidationError(
        "Exclusion layer allocation buckets must be finite numbers",
        { exclusionLayer: layer.key, allocation: alloc }
      );
    }
    if (alloc.startBucket < 0 || alloc.endBucket > 100) {
      throw new ValidationError(
        "Exclusion layer allocation buckets must be within [0, 100]",
        { exclusionLayer: layer.key, allocation: alloc }
      );
    }
    if (alloc.startBucket >= alloc.endBucket) {
      throw new ValidationError(
        "Exclusion layer allocation startBucket must be strictly less than endBucket",
        { exclusionLayer: layer.key, allocation: alloc }
      );
    }
    if (alloc.startBucket < prevEnd) {
      throw new ValidationError(
        "Exclusion layer allocations must not overlap — sort by startBucket and ensure each range is disjoint",
        { exclusionLayer: layer.key, conflictingAllocation: alloc }
      );
    }
    prevEnd = alloc.endBucket;
  }
}
