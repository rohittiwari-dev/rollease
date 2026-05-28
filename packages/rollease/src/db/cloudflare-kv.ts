// ============================================================================
// Rollease SDK — Cloudflare KV Adapter
// ============================================================================
//
// DbAdapter implementation for Cloudflare Workers KV.
// Mirrors MemoryDbAdapter but persists to KV.
//
// ============================================================================

import type {
  Flag,
  FlagRule,
  FlagStatus,
  Segment,
  SegmentUsage,
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
  ExclusionLayer,
  ExclusionLayerAllocation,
  TrackEventInput,
  TrackingEvent,
} from "../core/types";
import type { DbAdapter } from "./adapter";

// ── KV Binding Interface ───────────────────────────────────────────────────

interface KVNamespace {
  get(key: string, options?: { type?: "text" | "json" }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

// ── Key Prefixes ───────────────────────────────────────────────────────────

const PFX = {
  flag: "rl:f:", rules: "rl:r:", segment: "rl:s:", release: "rl:rel:",
  history: "rl:h:", assignment: "rl:a:", event: "rl:e:", layer: "rl:l:",
} as const;

// ── Adapter ────────────────────────────────────────────────────────────────

export class CloudflareKVAdapter implements DbAdapter {
  private kv: KVNamespace;
  private ns: string;
  private _counter = 0;

  constructor(kv: KVNamespace, opts?: { namespace?: string }) {
    this.kv = kv;
    this.ns = opts?.namespace ?? "";
  }

  private k(prefix: string, id: string): string {
    return this.ns ? `${this.ns}:${prefix}${id}` : `${prefix}${id}`;
  }
  private gid(pfx = "id"): string {
    return `${pfx}_${++this._counter}_${Date.now().toString(36)}`;
  }
  private async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.kv.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }
  private putJson(key: string, value: unknown, ttl?: number): Promise<void> {
    return this.kv.put(key, JSON.stringify(value), ttl ? { expirationTtl: ttl } : undefined);
  }

  // ── Flag CRUD ──────────────────────────────────────────────────────────

  async createFlag(input: CreateFlagInput): Promise<Flag> {
    const existing = await this.getFlag(input.key);
    if (existing) throw Object.assign(new Error(`Flag "${input.key}" already exists`), { name: "FlagConflictError" });

    const now = new Date();
    const flag: Flag = {
      id: this.gid("flag"),
      key: input.key,
      type: input.type,
      status: "active",
      defaultValue: input.defaultValue,
      description: input.description,
      namespace: input.namespace,
      tags: input.tags || [],
      locked: false,
      environments: input.environments,
      variants: input.variants?.map((v) => ({ ...v, id: this.gid("var") })),
      rollout: input.rollout,
      scheduledAt: input.scheduledAt || null,
      expiresAt: input.expiresAt || null,
      prerequisites: input.prerequisites,
      environmentDefaults: input.environmentDefaults,
      lastEvaluatedAt: null,
      exclusionLayer: input.exclusionLayer,
      clientVisible: input.clientVisible ?? false,
      createdAt: now,
      updatedAt: now,
    };
    await this.putJson(this.k(PFX.flag, flag.key), flag);
    await this.putJson(this.k(PFX.rules, flag.key), []);
    return flag;
  }

  async getFlag(key: string): Promise<Flag | null> {
    return this.getJson<Flag>(this.k(PFX.flag, key));
  }

  async listFlags(input: ListFlagsInput): Promise<ListFlagsResult> {
    const prefix = this.k(PFX.flag, "");
    const result = await this.kv.list({ prefix, limit: 1000 });
    const all: Flag[] = [];
    for (const kv of result.keys) {
      const f = await this.getJson<Flag>(kv.name);
      if (f) all.push(f);
    }
    let filtered = all;
    if (input.status) filtered = filtered.filter((f) => f.status === input.status);
    if (input.namespace) filtered = filtered.filter((f) => f.namespace === input.namespace || f.key.startsWith(`${input.namespace}.`));
    if (input.tags?.length) filtered = filtered.filter((f) => f.tags && input.tags!.some((t) => f.tags!.includes(t)));
    if (input.environment) filtered = filtered.filter((f) => !f.environments || f.environments.includes(input.environment!));
    if (input.search) { const q = input.search.toLowerCase(); filtered = filtered.filter((f) => f.key.toLowerCase().includes(q) || f.description?.toLowerCase().includes(q)); }
    filtered.sort((a, b) => a.key.localeCompare(b.key));
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 50;
    return { data: filtered.slice(offset, offset + limit), total: filtered.length, hasMore: offset + limit < filtered.length };
  }

  async updateFlag(key: string, input: UpdateFlagInput): Promise<Flag> {
    const flag = await this.getFlag(key);
    if (!flag) throw Object.assign(new Error(`Flag "${key}" not found`), { name: "FlagNotFoundError" });
    const updated: Flag = { ...flag, ...input, id: flag.id, key: flag.key, type: flag.type, status: flag.status, createdAt: flag.createdAt, updatedAt: new Date() };
    await this.putJson(this.k(PFX.flag, key), updated);
    return updated;
  }

  async setFlagStatus(key: string, status: FlagStatus): Promise<void> {
    const flag = await this.getFlag(key);
    if (!flag) throw Object.assign(new Error(`Flag "${key}" not found`), { name: "FlagNotFoundError" });
    flag.status = status;
    flag.updatedAt = new Date();
    await this.putJson(this.k(PFX.flag, key), flag);
  }

  async deleteFlag(key: string): Promise<void> {
    await this.kv.delete(this.k(PFX.flag, key));
    await this.kv.delete(this.k(PFX.rules, key));
    await this.kv.delete(this.k(PFX.history, key));
  }

  async cloneFlag(sourceKey: string, newKey: string, includeRules: boolean, includeRollout: boolean): Promise<Flag> {
    const source = await this.getFlag(sourceKey);
    if (!source) throw Object.assign(new Error(`Flag "${sourceKey}" not found`), { name: "FlagNotFoundError" });
    const now = new Date();
    const cloned: Flag = { ...source, id: this.gid("flag"), key: newKey, status: "active", locked: false, lockedReason: undefined, rollout: includeRollout ? source.rollout : undefined, variants: source.variants?.map((v) => ({ ...v, id: this.gid("var") })), createdAt: now, updatedAt: now };
    await this.putJson(this.k(PFX.flag, newKey), cloned);
    if (includeRules) {
      const rules = await this.listRules(sourceKey);
      const clonedRules = rules.map((r) => ({ ...r, id: this.gid("rule"), flagKey: newKey }));
      await this.putJson(this.k(PFX.rules, newKey), clonedRules);
    } else {
      await this.putJson(this.k(PFX.rules, newKey), []);
    }
    return cloned;
  }

  // ── Rollout ────────────────────────────────────────────────────────────

  async setRollout(key: string, rollout: { percentage?: number; sticky?: boolean; hashKey?: string; rampSchedule?: { at: string; percentage: number }[] }): Promise<void> {
    const flag = await this.getFlag(key);
    if (!flag) throw Object.assign(new Error(`Flag "${key}" not found`), { name: "FlagNotFoundError" });
    flag.rollout = {
      percentage: rollout.percentage ?? flag.rollout?.percentage ?? 0,
      sticky: rollout.sticky ?? flag.rollout?.sticky ?? true,
      hashKey: rollout.hashKey ?? flag.rollout?.hashKey ?? "userId",
      rampSchedule: rollout.rampSchedule ?? flag.rollout?.rampSchedule,
    };
    flag.updatedAt = new Date();
    await this.putJson(this.k(PFX.flag, key), flag);
  }

  // ── Rules ──────────────────────────────────────────────────────────────

  async addRule(flagKey: string, input: AddRuleInput): Promise<FlagRule> {
    const rules = await this.listRules(flagKey);
    const rule: FlagRule = {
      id: this.gid("rule"), flagKey, name: input.name, priority: input.priority, value: input.value,
      conditions: input.conditions, enabled: input.enabled ?? true, rolloutPct: input.rolloutPct,
      isHoldout: input.isHoldout, variantId: input.variantId, userIds: input.userIds,
      description: input.description, metadata: input.metadata,
    };
    rules.push(rule);
    rules.sort((a, b) => a.priority - b.priority);
    await this.putJson(this.k(PFX.rules, flagKey), rules);
    return rule;
  }

  async updateRule(flagKey: string, ruleId: string, input: UpdateRuleInput): Promise<FlagRule> {
    const rules = await this.listRules(flagKey);
    const idx = rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) throw new Error(`Rule "${ruleId}" not found`);
    rules[idx] = { ...rules[idx], ...input };
    rules.sort((a, b) => a.priority - b.priority);
    await this.putJson(this.k(PFX.rules, flagKey), rules);
    return rules[idx];
  }

  async removeRule(flagKey: string, ruleId: string): Promise<void> {
    const rules = await this.listRules(flagKey);
    await this.putJson(this.k(PFX.rules, flagKey), rules.filter((r) => r.id !== ruleId));
  }

  async listRules(flagKey: string): Promise<FlagRule[]> {
    return (await this.getJson<FlagRule[]>(this.k(PFX.rules, flagKey))) ?? [];
  }

  async reorderRules(flagKey: string, ordering: RuleOrdering[]): Promise<void> {
    const rules = await this.listRules(flagKey);
    for (const { ruleId, priority } of ordering) {
      const rule = rules.find((r) => r.id === ruleId);
      if (rule) rule.priority = priority;
    }
    rules.sort((a, b) => a.priority - b.priority);
    await this.putJson(this.k(PFX.rules, flagKey), rules);
  }

  // ── Segments ───────────────────────────────────────────────────────────

  async createSegment(input: CreateSegmentInput): Promise<Segment> {
    const now = new Date();
    const segment: Segment = { key: input.key, description: input.description, rules: input.rules, createdAt: now, updatedAt: now };
    await this.putJson(this.k(PFX.segment, input.key), segment);
    return segment;
  }

  async updateSegment(key: string, input: UpdateSegmentInput): Promise<Segment> {
    const segment = await this.getSegment(key);
    if (!segment) throw new Error(`Segment "${key}" not found`);
    const updated: Segment = { ...segment, ...input, updatedAt: new Date() };
    await this.putJson(this.k(PFX.segment, key), updated);
    return updated;
  }

  async deleteSegment(key: string): Promise<void> { await this.kv.delete(this.k(PFX.segment, key)); }

  async listSegments(): Promise<Segment[]> {
    const result = await this.kv.list({ prefix: this.k(PFX.segment, ""), limit: 1000 });
    const segs: Segment[] = [];
    for (const kv of result.keys) { const s = await this.getJson<Segment>(kv.name); if (s) segs.push(s); }
    return segs;
  }

  async getSegment(key: string): Promise<Segment | null> {
    return this.getJson<Segment>(this.k(PFX.segment, key));
  }

  async getSegmentUsage(_key: string): Promise<SegmentUsage[]> {
    return []; // Would need full rule scan — not efficient in KV
  }

  // ── Releases ───────────────────────────────────────────────────────────

  async createRelease(input: CreateReleaseInput): Promise<Release> {
    const now = new Date();
    const release: Release = {
      id: this.gid("rel"), name: input.name, description: input.description,
      environment: input.environment, status: input.scheduledAt ? "scheduled" : "pending",
      changes: input.changes, scheduledAt: input.scheduledAt || null,
      deployedAt: null, rolledBackAt: null,
      requiresApproval: input.requiresApproval, requiredApprovers: input.requiredApprovers,
      approvalStatus: input.requiresApproval ? "pending" : undefined,
      approvals: input.requiresApproval ? [] : undefined, createdAt: now,
    };
    await this.putJson(this.k(PFX.release, release.id), release);
    return release;
  }

  async getRelease(releaseId: string): Promise<Release | null> {
    return this.getJson<Release>(this.k(PFX.release, releaseId));
  }

  async listReleases(filters?: { environment?: string; status?: string; limit?: number }): Promise<Release[]> {
    const result = await this.kv.list({ prefix: this.k(PFX.release, ""), limit: 1000 });
    let releases: Release[] = [];
    for (const kv of result.keys) { const r = await this.getJson<Release>(kv.name); if (r) releases.push(r); }
    if (filters?.environment) releases = releases.filter((r) => r.environment === filters.environment);
    if (filters?.status) releases = releases.filter((r) => r.status === filters.status);
    if (filters?.limit) releases = releases.slice(0, filters.limit);
    return releases;
  }

  async deployRelease(releaseId: string, deployedBy?: string): Promise<void> {
    const release = await this.getRelease(releaseId);
    if (!release) throw new Error(`Release "${releaseId}" not found`);
    const snapshots: ReleaseSnapshot[] = [];
    for (const change of release.changes) {
      const flag = await this.getFlag(change.flagKey);
      if (!flag) continue;
      snapshots.push({ flagKey: change.flagKey, beforeValue: flag.defaultValue, beforeStatus: flag.status, beforeRollout: flag.rollout });
      switch (change.action) {
        case "enable": flag.defaultValue = change.value ?? true; flag.status = "active"; break;
        case "disable": flag.defaultValue = change.value ?? false; break;
        case "setValue": flag.defaultValue = change.value; break;
        case "kill": flag.status = "killed"; break;
        case "restore": flag.status = "active"; break;
      }
      flag.updatedAt = new Date();
      await this.putJson(this.k(PFX.flag, change.flagKey), flag);
    }
    release.status = "deployed"; release.deployedAt = new Date(); release.deployedBy = deployedBy; release.snapshots = snapshots;
    await this.putJson(this.k(PFX.release, releaseId), release);
  }

  async rollbackRelease(releaseId: string, rolledBackBy?: string, reason?: string): Promise<void> {
    const release = await this.getRelease(releaseId);
    if (!release) throw new Error(`Release "${releaseId}" not found`);
    if (release.snapshots) {
      for (const snap of release.snapshots) {
        const flag = await this.getFlag(snap.flagKey);
        if (!flag) continue;
        flag.defaultValue = snap.beforeValue; flag.status = snap.beforeStatus; flag.rollout = snap.beforeRollout; flag.updatedAt = new Date();
        await this.putJson(this.k(PFX.flag, snap.flagKey), flag);
      }
    }
    release.status = "rolled_back"; release.rolledBackAt = new Date(); release.rolledBackBy = rolledBackBy; release.rollbackReason = reason;
    await this.putJson(this.k(PFX.release, releaseId), release);
  }

  // ── Sticky Assignments ─────────────────────────────────────────────────

  async getUserAssignment(flagKey: string, userId: string): Promise<string | null> {
    return this.kv.get(this.k(PFX.assignment, `${flagKey}:${userId}`));
  }

  async setUserAssignment(flagKey: string, userId: string, variantKey: string): Promise<void> {
    await this.kv.put(this.k(PFX.assignment, `${flagKey}:${userId}`), variantKey);
  }

  // ── History ────────────────────────────────────────────────────────────

  async addHistory(entry: Omit<HistoryEntry, "id">): Promise<void> {
    const key = entry.flagKey ?? "_global";
    const histKey = this.k(PFX.history, key);
    const history = (await this.getJson<HistoryEntry[]>(histKey)) ?? [];
    history.push({ ...entry, id: this.gid("hist") } as HistoryEntry);
    if (history.length > 500) history.splice(0, history.length - 500);
    await this.putJson(histKey, history);
  }

  async getHistory(flagKey: string, opts?: { limit?: number }): Promise<HistoryEntry[]> {
    const history = (await this.getJson<HistoryEntry[]>(this.k(PFX.history, flagKey))) ?? [];
    return opts?.limit ? history.slice(-opts.limit) : history;
  }

  // ── Tags ───────────────────────────────────────────────────────────────

  async addTags(flagKey: string, tags: string[]): Promise<void> {
    const flag = await this.getFlag(flagKey);
    if (!flag) throw new Error(`Flag "${flagKey}" not found`);
    const s = new Set(flag.tags ?? []);
    for (const t of tags) s.add(t);
    flag.tags = [...s]; flag.updatedAt = new Date();
    await this.putJson(this.k(PFX.flag, flagKey), flag);
  }

  async removeTags(flagKey: string, tags: string[]): Promise<void> {
    const flag = await this.getFlag(flagKey);
    if (!flag) throw new Error(`Flag "${flagKey}" not found`);
    const rm = new Set(tags);
    flag.tags = (flag.tags ?? []).filter((t) => !rm.has(t)); flag.updatedAt = new Date();
    await this.putJson(this.k(PFX.flag, flagKey), flag);
  }

  // ── Bulk ───────────────────────────────────────────────────────────────

  async getAllActiveFlags(opts?: { namespace?: string; tags?: string[]; keys?: string[]; limit?: number; offset?: number }): Promise<Flag[]> {
    const result = await this.listFlags({ status: "active", namespace: opts?.namespace, tags: opts?.tags, limit: opts?.limit, offset: opts?.offset });
    let flags = result.data;
    if (opts?.keys?.length) flags = flags.filter((f) => opts.keys!.includes(f.key));
    return flags;
  }

  // ── Events (optional) ─────────────────────────────────────────────────

  async trackEvent(input: TrackEventInput): Promise<TrackingEvent> {
    const event: TrackingEvent = { id: this.gid("evt"), userId: input.userId, anonymousId: input.anonymousId, event: input.event, value: input.value, metadata: input.metadata, context: input.context, createdAt: new Date() };
    await this.putJson(this.k(PFX.event, event.id), event, 86400 * 30);
    return event;
  }

  async trackImpression(params: { flagKey: string; userId: string; value: unknown; variant: string | null; reason: string }): Promise<void> {
    const key = this.k(PFX.event, `imp_${params.flagKey}_${params.userId}_${Date.now()}`);
    await this.putJson(key, { ...params, trackedAt: new Date() }, 86400 * 30);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async close(): Promise<void> { /* No-op — KV bindings are request-scoped */ }
}
