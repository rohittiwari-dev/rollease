// ============================================================================
// Rollease SDK — Vercel KV Adapter
// ============================================================================
//
// DbAdapter implementation for Vercel KV (Redis-compatible, @vercel/kv).
// Uses structural typing — no hard dependency on @vercel/kv.
//
// Usage:
//
//   import { kv } from '@vercel/kv'
//   import { createVercelKVAdapter } from 'rollease/db/vercel-kv'
//
//   const rl = createRollease({ db: createVercelKVAdapter(kv) })
//
// ============================================================================

import type {
  Flag, FlagRule, FlagStatus, Segment, SegmentUsage, Release, ReleaseSnapshot,
  HistoryEntry, CreateFlagInput, UpdateFlagInput, ListFlagsInput, ListFlagsResult,
  AddRuleInput, UpdateRuleInput, RuleOrdering, CreateSegmentInput, UpdateSegmentInput,
  CreateReleaseInput, ExclusionLayer, ExclusionLayerAllocation, TrackEventInput, TrackingEvent,
} from "../core/types";
import type { DbAdapter } from "./adapter";
import {
  FlagConflictError, FlagNotFoundError, ValidationError,
  ReleaseNotFoundError, RuleNotFoundError, SegmentNotFoundError,
} from "../core/errors";

// ── Vercel KV Interface (structural typing) ────────────────────────────────

interface VercelKV {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ex?: number; nx?: boolean }): Promise<"OK" | null>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  hset(key: string, values: Record<string, unknown>): Promise<number>;
  hget<T = unknown>(key: string, field: string): Promise<T | null>;
  hgetall<T = unknown>(key: string): Promise<T | null>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  rpush(key: string, ...values: unknown[]): Promise<number>;
  lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]>;
}

// ── Key Prefixes ───────────────────────────────────────────────────────────

const PFX = {
  flag: "rl:f:", rules: "rl:r:", segment: "rl:s:", release: "rl:rel:",
  history: "rl:h:", assignment: "rl:a:", event: "rl:e:", impression: "rl:imp:",
  layer: "rl:l:",
} as const;

// ── Adapter ────────────────────────────────────────────────────────────────

export class VercelKVAdapter implements DbAdapter {
  private kv: VercelKV;
  private ns: string;
  private idCounter = 0;

  constructor(kv: VercelKV, opts?: { namespace?: string }) {
    this.kv = kv;
    this.ns = opts?.namespace ? `${opts.namespace}:` : "";
  }

  private k(prefix: string, id: string): string {
    return `${this.ns}${prefix}${id}`;
  }

  private genId(): string {
    return `${Date.now().toString(36)}_${(++this.idCounter).toString(36)}`;
  }

  async createFlag(input: CreateFlagInput): Promise<Flag> {
    const existing = await this.kv.get(this.k(PFX.flag, input.key));
    if (existing) throw new FlagConflictError(input.key, "flag");
    const now = new Date();
    const flag: Flag = {
      id: this.genId(),
      key: input.key,
      type: input.type,
      status: "active",
      defaultValue: input.defaultValue,
      description: input.description,
      namespace: input.namespace,
      tags: input.tags ?? [],
      locked: false,
      environments: input.environments,
      variants: input.variants as Flag["variants"],
      rollout: input.rollout,
      scheduledAt: input.scheduledAt,
      expiresAt: input.expiresAt,
      prerequisites: input.prerequisites,
      environmentDefaults: input.environmentDefaults,
      exclusionLayer: input.exclusionLayer,
      clientVisible: input.clientVisible,
      createdAt: now,
      updatedAt: now,
    };
    await this.kv.set(this.k(PFX.flag, input.key), JSON.stringify(flag));
    return flag;
  }

  async getFlag(key: string): Promise<Flag | null> {
    const raw = await this.kv.get<string>(this.k(PFX.flag, key));
    if (!raw) return null;
    return JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as Flag;
  }

  async listFlags(input: ListFlagsInput): Promise<ListFlagsResult> {
    const keys = await this.kv.keys(`${this.ns}${PFX.flag}*`);
    const all: Flag[] = [];
    for (const k of keys) {
      const raw = await this.kv.get<string>(k);
      if (raw) all.push(JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as Flag);
    }
    let data = all;
    if (input.status) data = data.filter((f) => f.status === input.status);
    if (input.namespace) data = data.filter((f) => f.namespace === input.namespace);
    if (input.tags?.length) data = data.filter((f) => input.tags!.some((t) => f.tags?.includes(t)));
    if (input.search) {
      const q = input.search.toLowerCase();
      data = data.filter((f) => f.key.toLowerCase().includes(q) || f.description?.toLowerCase().includes(q));
    }
    if (input.staleAfter) {
      const cutoff = new Date(input.staleAfter);
      data = data.filter((f) => !f.lastEvaluatedAt || new Date(f.lastEvaluatedAt) < cutoff);
    }
    const total = data.length;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? total;
    const page = data.slice(offset, offset + limit);
    return { data: page, total, hasMore: offset + limit < total };
  }

  async updateFlag(key: string, patch: UpdateFlagInput): Promise<Flag> {
    const flag = await this.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    const updated: Flag = { ...flag, ...patch, updatedAt: new Date() };
    await this.kv.set(this.k(PFX.flag, key), JSON.stringify(updated));
    return updated;
  }

  async setFlagStatus(key: string, status: FlagStatus): Promise<void> {
    const flag = await this.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    await this.kv.set(this.k(PFX.flag, key), JSON.stringify({ ...flag, status, updatedAt: new Date() }));
  }

  async deleteFlag(key: string): Promise<void> {
    await this.kv.del(this.k(PFX.flag, key), this.k(PFX.rules, key), this.k(PFX.history, key));
  }

  async cloneFlag(sourceKey: string, newKey: string, includeRules: boolean, includeRollout: boolean): Promise<Flag> {
    const source = await this.getFlag(sourceKey);
    if (!source) throw new FlagNotFoundError(sourceKey);
    const existing = await this.getFlag(newKey);
    if (existing) throw new FlagConflictError(newKey, "flag");
    const now = new Date();
    const cloned: Flag = {
      ...source,
      id: this.genId(),
      key: newKey,
      rollout: includeRollout ? source.rollout : undefined,
      createdAt: now,
      updatedAt: now,
    };
    await this.kv.set(this.k(PFX.flag, newKey), JSON.stringify(cloned));
    if (includeRules) {
      const rules = await this.listRules(sourceKey);
      for (const rule of rules) {
        await this.addRule(newKey, { ...rule, actor: undefined });
      }
    }
    return cloned;
  }

  async setRollout(key: string, rollout: { percentage?: number; sticky?: boolean; hashKey?: string; rampSchedule?: { at: string; percentage: number }[] }): Promise<void> {
    const flag = await this.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    await this.kv.set(this.k(PFX.flag, key), JSON.stringify({ ...flag, rollout, updatedAt: new Date() }));
  }

  async addRule(flagKey: string, input: AddRuleInput): Promise<FlagRule> {
    const rule: FlagRule = {
      id: this.genId(),
      flagKey,
      name: input.name,
      priority: input.priority,
      value: input.value,
      conditions: input.conditions,
      enabled: input.enabled ?? true,
      rolloutPct: input.rolloutPct,
      isHoldout: input.isHoldout,
      variantId: input.variantId,
      userIds: input.userIds,
      description: input.description,
      metadata: input.metadata,
    };
    const existing = await this.listRules(flagKey);
    existing.push(rule);
    existing.sort((a, b) => a.priority - b.priority);
    await this.kv.set(this.k(PFX.rules, flagKey), JSON.stringify(existing));
    return rule;
  }

  async updateRule(flagKey: string, ruleId: string, patch: UpdateRuleInput): Promise<FlagRule> {
    const rules = await this.listRules(flagKey);
    const idx = rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) throw new RuleNotFoundError(flagKey, ruleId);
    rules[idx] = { ...rules[idx], ...patch };
    rules.sort((a, b) => a.priority - b.priority);
    await this.kv.set(this.k(PFX.rules, flagKey), JSON.stringify(rules));
    return rules[idx];
  }

  async removeRule(flagKey: string, ruleId: string): Promise<void> {
    const rules = (await this.listRules(flagKey)).filter((r) => r.id !== ruleId);
    await this.kv.set(this.k(PFX.rules, flagKey), JSON.stringify(rules));
  }

  async listRules(flagKey: string): Promise<FlagRule[]> {
    const raw = await this.kv.get<string>(this.k(PFX.rules, flagKey));
    if (!raw) return [];
    const arr = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as FlagRule[];
    return arr.sort((a, b) => a.priority - b.priority);
  }

  async reorderRules(flagKey: string, ordering: RuleOrdering[]): Promise<void> {
    const rules = await this.listRules(flagKey);
    for (const { ruleId, priority } of ordering) {
      const r = rules.find((x) => x.id === ruleId);
      if (r) r.priority = priority;
    }
    rules.sort((a, b) => a.priority - b.priority);
    await this.kv.set(this.k(PFX.rules, flagKey), JSON.stringify(rules));
  }

  async createSegment(input: CreateSegmentInput): Promise<Segment> {
    const existing = await this.getSegment(input.key);
    if (existing) throw new FlagConflictError(input.key, "segment");
    const now = new Date();
    const seg: Segment = { key: input.key, description: input.description, rules: input.rules, createdAt: now, updatedAt: now };
    await this.kv.set(this.k(PFX.segment, input.key), JSON.stringify(seg));
    return seg;
  }

  async updateSegment(key: string, patch: UpdateSegmentInput): Promise<Segment> {
    const seg = await this.getSegment(key);
    if (!seg) throw new SegmentNotFoundError(key);
    const updated = { ...seg, ...patch, updatedAt: new Date() };
    await this.kv.set(this.k(PFX.segment, key), JSON.stringify(updated));
    return updated;
  }

  async deleteSegment(key: string): Promise<void> {
    await this.kv.del(this.k(PFX.segment, key));
  }

  async listSegments(): Promise<Segment[]> {
    const keys = await this.kv.keys(`${this.ns}${PFX.segment}*`);
    const segs: Segment[] = [];
    for (const k of keys) {
      const raw = await this.kv.get<string>(k);
      if (raw) segs.push(JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as Segment);
    }
    return segs;
  }

  async getSegment(key: string): Promise<Segment | null> {
    const raw = await this.kv.get<string>(this.k(PFX.segment, key));
    if (!raw) return null;
    return JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as Segment;
  }

  async getSegmentUsage(key: string): Promise<SegmentUsage[]> {
    const flagKeys = await this.kv.keys(`${this.ns}${PFX.flag}*`);
    const usage: SegmentUsage[] = [];
    for (const k of flagKeys) {
      const rules = await this.listRules(k.slice((this.ns + PFX.flag).length));
      for (const rule of rules) {
        if (JSON.stringify(rule.conditions).includes(`"${key}"`)) {
          usage.push({ flagKey: k.slice((this.ns + PFX.flag).length), ruleId: rule.id });
        }
      }
    }
    return usage;
  }

  async createRelease(input: CreateReleaseInput): Promise<Release> {
    const now = new Date();
    const release: Release = {
      id: this.genId(),
      name: input.name,
      description: input.description,
      environment: input.environment,
      status: "pending",
      changes: input.changes,
      scheduledAt: input.scheduledAt,
      requiresApproval: input.requiresApproval,
      requiredApprovers: input.requiredApprovers,
      approvalStatus: input.requiresApproval ? "pending" : undefined,
      approvals: [],
      createdAt: now,
    };
    await this.kv.set(this.k(PFX.release, release.id), JSON.stringify(release));
    return release;
  }

  async getRelease(releaseId: string): Promise<Release | null> {
    const raw = await this.kv.get<string>(this.k(PFX.release, releaseId));
    if (!raw) return null;
    return JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as Release;
  }

  async listReleases(filters?: { environment?: string; status?: string; limit?: number }): Promise<Release[]> {
    const keys = await this.kv.keys(`${this.ns}${PFX.release}*`);
    const releases: Release[] = [];
    for (const k of keys) {
      const raw = await this.kv.get<string>(k);
      if (raw) releases.push(JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as Release);
    }
    let data = releases;
    if (filters?.environment) data = data.filter((r) => r.environment === filters.environment);
    if (filters?.status) data = data.filter((r) => r.status === filters.status);
    if (filters?.limit) data = data.slice(0, filters.limit);
    return data;
  }

  async deployRelease(releaseId: string, deployedBy?: string): Promise<void> {
    const release = await this.getRelease(releaseId);
    if (!release) throw new ReleaseNotFoundError(releaseId);
    if (release.requiresApproval && release.approvalStatus !== "approved") {
      throw new ValidationError(`Release requires approval`);
    }
    const snapshots: ReleaseSnapshot[] = [];
    for (const change of release.changes) {
      const flag = await this.getFlag(change.flagKey);
      if (flag) {
        snapshots.push({ flagKey: flag.key, beforeValue: flag.defaultValue, beforeStatus: flag.status, beforeRollout: flag.rollout });
        if (change.action === "enable") await this.setFlagStatus(change.flagKey, "active");
        if (change.action === "disable") await this.setFlagStatus(change.flagKey, "killed");
        if (change.action === "kill") await this.setFlagStatus(change.flagKey, "killed");
        if (change.action === "restore") await this.setFlagStatus(change.flagKey, "active");
        if (change.action === "setValue" && change.value !== undefined) {
          await this.updateFlag(change.flagKey, { defaultValue: change.value });
        }
        if (change.action === "setRollout" && change.rollout) {
          await this.setRollout(change.flagKey, change.rollout as { percentage?: number; sticky?: boolean; hashKey?: string });
        }
      }
    }
    const updated = { ...release, status: "deployed" as const, snapshots, deployedAt: new Date(), deployedBy };
    await this.kv.set(this.k(PFX.release, releaseId), JSON.stringify(updated));
  }

  async rollbackRelease(releaseId: string, rolledBackBy?: string, reason?: string): Promise<void> {
    const release = await this.getRelease(releaseId);
    if (!release) throw new ReleaseNotFoundError(releaseId);
    if (release.snapshots?.length) {
      for (const snap of release.snapshots) {
        await this.updateFlag(snap.flagKey, { defaultValue: snap.beforeValue });
        await this.setFlagStatus(snap.flagKey, snap.beforeStatus);
        if (snap.beforeRollout) await this.setRollout(snap.flagKey, snap.beforeRollout as { percentage?: number; sticky?: boolean; hashKey?: string });
      }
    }
    const updated = { ...release, status: "rolled_back" as const, rolledBackAt: new Date(), rolledBackBy, rollbackReason: reason };
    await this.kv.set(this.k(PFX.release, releaseId), JSON.stringify(updated));
  }

  async approveRelease(releaseId: string, approverId: string): Promise<Release> {
    const release = await this.getRelease(releaseId);
    if (!release) throw new ReleaseNotFoundError(releaseId);
    const approvals = [...(release.approvals ?? []), approverId];
    const required = release.requiredApprovers ?? [];
    const allApproved = required.length === 0 || required.every((r) => approvals.includes(r));
    const updated = { ...release, approvals, approvalStatus: allApproved ? "approved" as const : "pending" as const };
    await this.kv.set(this.k(PFX.release, releaseId), JSON.stringify(updated));
    return updated;
  }

  async rejectRelease(releaseId: string, rejectorId: string, reason?: string): Promise<Release> {
    const release = await this.getRelease(releaseId);
    if (!release) throw new ReleaseNotFoundError(releaseId);
    const updated = { ...release, approvalStatus: "rejected" as const, rejectionReason: reason };
    await this.kv.set(this.k(PFX.release, releaseId), JSON.stringify(updated));
    return updated;
  }

  async listScheduledReleases(): Promise<Release[]> {
    const now = new Date();
    const all = await this.listReleases();
    return all.filter((r) => {
      if (r.status !== "pending" && r.status !== "scheduled") return false;
      if (!r.scheduledAt) return false;
      return new Date(r.scheduledAt) <= now;
    });
  }

  async getUserAssignment(flagKey: string, userId: string): Promise<string | null> {
    return this.kv.get<string>(this.k(PFX.assignment, `${flagKey}:${userId}`));
  }

  async setUserAssignment(flagKey: string, userId: string, variantKey: string): Promise<void> {
    await this.kv.set(this.k(PFX.assignment, `${flagKey}:${userId}`), variantKey);
  }

  async addHistory(entry: Omit<HistoryEntry, "id">): Promise<void> {
    const id = this.genId();
    const key = entry.flagKey ?? "__global";
    await this.kv.rpush(this.k(PFX.history, key), JSON.stringify({ ...entry, id }));
  }

  async getHistory(flagKey: string, opts?: { limit?: number }): Promise<HistoryEntry[]> {
    const raw = await this.kv.lrange<string>(this.k(PFX.history, flagKey), 0, -1);
    const entries = raw.map((r) => JSON.parse(typeof r === "string" ? r : JSON.stringify(r)) as HistoryEntry);
    entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return opts?.limit ? entries.slice(0, opts.limit) : entries;
  }

  async trackImpression(params: { flagKey: string; userId: string; value: unknown; variant: string | null; reason: string }): Promise<void> {
    await this.kv.rpush(this.k(PFX.impression, params.flagKey), JSON.stringify({ ...params, at: new Date().toISOString() }));
  }

  async trackEvent(event: TrackEventInput): Promise<TrackingEvent> {
    const tracked: TrackingEvent = {
      id: this.genId(),
      userId: event.userId,
      anonymousId: event.anonymousId,
      event: event.event,
      value: event.value,
      metadata: event.metadata,
      context: event.context,
      createdAt: event.ts ? new Date(event.ts as string) : new Date(),
    };
    await this.kv.rpush(this.k(PFX.event, event.userId ?? "anon"), JSON.stringify(tracked));
    return tracked;
  }

  async getAllActiveFlags(opts?: { namespace?: string; tags?: string[]; keys?: string[]; limit?: number; offset?: number }): Promise<Flag[]> {
    const result = await this.listFlags({ status: "active", namespace: opts?.namespace, tags: opts?.tags, limit: opts?.limit, offset: opts?.offset });
    return opts?.keys ? result.data.filter((f) => opts.keys!.includes(f.key)) : result.data;
  }

  async addTags(flagKey: string, tags: string[]): Promise<void> {
    const flag = await this.getFlag(flagKey);
    if (!flag) throw new FlagNotFoundError(flagKey);
    const merged = Array.from(new Set([...(flag.tags ?? []), ...tags]));
    await this.updateFlag(flagKey, { tags: merged });
  }

  async removeTags(flagKey: string, tags: string[]): Promise<void> {
    const flag = await this.getFlag(flagKey);
    if (!flag) throw new FlagNotFoundError(flagKey);
    const toRemove = new Set(tags);
    await this.updateFlag(flagKey, { tags: (flag.tags ?? []).filter((t) => !toRemove.has(t)) });
  }

  async touchFlagEvaluation(key: string): Promise<void> {
    const flag = await this.getFlag(key);
    if (flag) {
      await this.kv.set(this.k(PFX.flag, key), JSON.stringify({ ...flag, lastEvaluatedAt: new Date() }));
    }
  }

  async forgetUser(userId: string): Promise<void> {
    await this.kv.del(this.k(PFX.assignment, `*:${userId}`));
  }

  async close(): Promise<void> {
    // Vercel KV connections are managed externally; no-op.
  }
}

export function createVercelKVAdapter(kv: VercelKV, opts?: { namespace?: string }): VercelKVAdapter {
  return new VercelKVAdapter(kv, opts);
}
