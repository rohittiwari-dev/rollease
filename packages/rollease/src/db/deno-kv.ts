// ============================================================================
// Rollease SDK — Deno KV Adapter
// ============================================================================
//
// DbAdapter implementation for Deno KV.
// Uses structural typing — no hard dependency on Deno globals.
//
// Usage (Deno):
//
//   import { createDenoKVAdapter } from 'rollease/db/deno-kv'
//
//   const kv = await Deno.openKv()
//   const rl = createRollease({ db: createDenoKVAdapter(kv) })
//
// ============================================================================

import type {
  Flag, FlagRule, FlagStatus, Segment, SegmentUsage, Release, ReleaseSnapshot,
  HistoryEntry, CreateFlagInput, UpdateFlagInput, ListFlagsInput, ListFlagsResult,
  AddRuleInput, UpdateRuleInput, RuleOrdering, CreateSegmentInput, UpdateSegmentInput,
  CreateReleaseInput, TrackEventInput, TrackingEvent,
} from "../core/types";
import type { DbAdapter } from "./adapter";
import {
  FlagConflictError, FlagNotFoundError, ValidationError,
  ReleaseNotFoundError, RuleNotFoundError, SegmentNotFoundError,
} from "../core/errors";

// ── Deno KV Interface (structural typing) ──────────────────────────────────

interface DenoKvEntry<T> {
  key: unknown[];
  value: T;
  versionstamp: string;
}

interface DenoKvIterator<T> {
  [Symbol.asyncIterator](): AsyncIterator<DenoKvEntry<T>>;
}

interface DenoKv {
  get<T = unknown>(key: unknown[]): Promise<DenoKvEntry<T>>;
  set(key: unknown[], value: unknown): Promise<{ ok: boolean; versionstamp: string }>;
  delete(key: unknown[]): Promise<void>;
  list<T = unknown>(opts: { prefix: unknown[]; limit?: number }): DenoKvIterator<T>;
  close(): void;
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class DenoKVAdapter implements DbAdapter {
  private kv: DenoKv;
  private ns: string[];
  private idCounter = 0;

  constructor(kv: DenoKv, opts?: { namespace?: string }) {
    this.kv = kv;
    this.ns = opts?.namespace ? [opts.namespace] : [];
  }

  private k(...parts: string[]): unknown[] {
    return [...this.ns, ...parts];
  }

  private genId(): string {
    return `${Date.now().toString(36)}_${(++this.idCounter).toString(36)}`;
  }

  private async getAll<T>(prefix: string[]): Promise<Array<{ key: unknown[]; value: T }>> {
    const results: Array<{ key: unknown[]; value: T }> = [];
    const iter = this.kv.list<T>({ prefix: [...this.ns, ...prefix] });
    for await (const entry of iter) {
      results.push({ key: entry.key, value: entry.value });
    }
    return results;
  }

  async createFlag(input: CreateFlagInput): Promise<Flag> {
    const existing = await this.kv.get(this.k("flag", input.key));
    if (existing.value !== null) throw new FlagConflictError(input.key, "flag");
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
    await this.kv.set(this.k("flag", input.key), flag);
    return flag;
  }

  async getFlag(key: string): Promise<Flag | null> {
    const entry = await this.kv.get<Flag>(this.k("flag", key));
    return entry.value;
  }

  async listFlags(input: ListFlagsInput): Promise<ListFlagsResult> {
    const entries = await this.getAll<Flag>(["flag"]);
    let data = entries.map((e) => e.value);
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
    return { data: data.slice(offset, offset + limit), total, hasMore: offset + limit < total };
  }

  async updateFlag(key: string, patch: UpdateFlagInput): Promise<Flag> {
    const flag = await this.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    const updated = { ...flag, ...patch, updatedAt: new Date() };
    await this.kv.set(this.k("flag", key), updated);
    return updated;
  }

  async setFlagStatus(key: string, status: FlagStatus): Promise<void> {
    const flag = await this.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    await this.kv.set(this.k("flag", key), { ...flag, status, updatedAt: new Date() });
  }

  async deleteFlag(key: string): Promise<void> {
    await this.kv.delete(this.k("flag", key));
    await this.kv.delete(this.k("rules", key));
  }

  async cloneFlag(sourceKey: string, newKey: string, includeRules: boolean, includeRollout: boolean): Promise<Flag> {
    const source = await this.getFlag(sourceKey);
    if (!source) throw new FlagNotFoundError(sourceKey);
    const existing = await this.getFlag(newKey);
    if (existing) throw new FlagConflictError(newKey, "flag");
    const now = new Date();
    const cloned: Flag = { ...source, id: this.genId(), key: newKey, rollout: includeRollout ? source.rollout : undefined, createdAt: now, updatedAt: now };
    await this.kv.set(this.k("flag", newKey), cloned);
    if (includeRules) {
      const rules = await this.listRules(sourceKey);
      for (const rule of rules) await this.addRule(newKey, { ...rule, actor: undefined });
    }
    return cloned;
  }

  async setRollout(key: string, rollout: { percentage?: number; sticky?: boolean; hashKey?: string; rampSchedule?: { at: string; percentage: number }[] }): Promise<void> {
    const flag = await this.getFlag(key);
    if (!flag) throw new FlagNotFoundError(key);
    await this.kv.set(this.k("flag", key), { ...flag, rollout, updatedAt: new Date() });
  }

  async addRule(flagKey: string, input: AddRuleInput): Promise<FlagRule> {
    const rule: FlagRule = {
      id: this.genId(), flagKey, name: input.name, priority: input.priority,
      value: input.value, conditions: input.conditions, enabled: input.enabled ?? true,
      rolloutPct: input.rolloutPct, isHoldout: input.isHoldout, variantId: input.variantId,
      userIds: input.userIds, description: input.description, metadata: input.metadata,
    };
    const existing = await this.listRules(flagKey);
    existing.push(rule);
    existing.sort((a, b) => a.priority - b.priority);
    await this.kv.set(this.k("rules", flagKey), existing);
    return rule;
  }

  async updateRule(flagKey: string, ruleId: string, patch: UpdateRuleInput): Promise<FlagRule> {
    const rules = await this.listRules(flagKey);
    const idx = rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) throw new RuleNotFoundError(flagKey, ruleId);
    rules[idx] = { ...rules[idx], ...patch };
    await this.kv.set(this.k("rules", flagKey), rules);
    return rules[idx];
  }

  async removeRule(flagKey: string, ruleId: string): Promise<void> {
    const rules = (await this.listRules(flagKey)).filter((r) => r.id !== ruleId);
    await this.kv.set(this.k("rules", flagKey), rules);
  }

  async listRules(flagKey: string): Promise<FlagRule[]> {
    const entry = await this.kv.get<FlagRule[]>(this.k("rules", flagKey));
    return (entry.value ?? []).sort((a, b) => a.priority - b.priority);
  }

  async reorderRules(flagKey: string, ordering: RuleOrdering[]): Promise<void> {
    const rules = await this.listRules(flagKey);
    for (const { ruleId, priority } of ordering) {
      const r = rules.find((x) => x.id === ruleId);
      if (r) r.priority = priority;
    }
    await this.kv.set(this.k("rules", flagKey), rules);
  }

  async createSegment(input: CreateSegmentInput): Promise<Segment> {
    const existing = await this.getSegment(input.key);
    if (existing) throw new FlagConflictError(input.key, "segment");
    const now = new Date();
    const seg: Segment = { key: input.key, description: input.description, rules: input.rules, createdAt: now, updatedAt: now };
    await this.kv.set(this.k("segment", input.key), seg);
    return seg;
  }

  async updateSegment(key: string, patch: UpdateSegmentInput): Promise<Segment> {
    const seg = await this.getSegment(key);
    if (!seg) throw new SegmentNotFoundError(key);
    const updated = { ...seg, ...patch, updatedAt: new Date() };
    await this.kv.set(this.k("segment", key), updated);
    return updated;
  }

  async deleteSegment(key: string): Promise<void> {
    await this.kv.delete(this.k("segment", key));
  }

  async listSegments(): Promise<Segment[]> {
    return (await this.getAll<Segment>(["segment"])).map((e) => e.value);
  }

  async getSegment(key: string): Promise<Segment | null> {
    return (await this.kv.get<Segment>(this.k("segment", key))).value;
  }

  async getSegmentUsage(key: string): Promise<SegmentUsage[]> {
    const entries = await this.getAll<Flag>(["flag"]);
    const usage: SegmentUsage[] = [];
    for (const { value: flag } of entries) {
      const rules = await this.listRules(flag.key);
      for (const rule of rules) {
        if (JSON.stringify(rule.conditions).includes(`"${key}"`)) {
          usage.push({ flagKey: flag.key, ruleId: rule.id });
        }
      }
    }
    return usage;
  }

  async createRelease(input: CreateReleaseInput): Promise<Release> {
    const now = new Date();
    const release: Release = {
      id: this.genId(), name: input.name, description: input.description,
      environment: input.environment, status: "pending", changes: input.changes,
      scheduledAt: input.scheduledAt, requiresApproval: input.requiresApproval,
      requiredApprovers: input.requiredApprovers,
      approvalStatus: input.requiresApproval ? "pending" : undefined,
      approvals: [], createdAt: now,
    };
    await this.kv.set(this.k("release", release.id), release);
    return release;
  }

  async getRelease(id: string): Promise<Release | null> {
    return (await this.kv.get<Release>(this.k("release", id))).value;
  }

  async listReleases(filters?: { environment?: string; status?: string; limit?: number }): Promise<Release[]> {
    let data = (await this.getAll<Release>(["release"])).map((e) => e.value);
    if (filters?.environment) data = data.filter((r) => r.environment === filters.environment);
    if (filters?.status) data = data.filter((r) => r.status === filters.status);
    return filters?.limit ? data.slice(0, filters.limit) : data;
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
        snapshots.push({ flagKey: flag.key, beforeValue: flag.defaultValue, beforeStatus: flag.status });
        if (change.action === "enable" || change.action === "restore") await this.setFlagStatus(change.flagKey, "active");
        if (change.action === "disable" || change.action === "kill") await this.setFlagStatus(change.flagKey, "killed");
        if (change.action === "setValue" && change.value !== undefined) await this.updateFlag(change.flagKey, { defaultValue: change.value });
        if (change.action === "setRollout" && change.rollout) await this.setRollout(change.flagKey, change.rollout as { percentage?: number; sticky?: boolean; hashKey?: string });
      }
    }
    await this.kv.set(this.k("release", releaseId), { ...release, status: "deployed", snapshots, deployedAt: new Date(), deployedBy });
  }

  async rollbackRelease(releaseId: string, rolledBackBy?: string, reason?: string): Promise<void> {
    const release = await this.getRelease(releaseId);
    if (!release) throw new ReleaseNotFoundError(releaseId);
    if (release.snapshots) {
      for (const snap of release.snapshots) {
        await this.updateFlag(snap.flagKey, { defaultValue: snap.beforeValue });
        await this.setFlagStatus(snap.flagKey, snap.beforeStatus);
      }
    }
    await this.kv.set(this.k("release", releaseId), { ...release, status: "rolled_back", rolledBackAt: new Date(), rolledBackBy, rollbackReason: reason });
  }

  async approveRelease(releaseId: string, approverId: string): Promise<Release> {
    const release = await this.getRelease(releaseId);
    if (!release) throw new ReleaseNotFoundError(releaseId);
    const approvals = [...(release.approvals ?? []), approverId];
    const required = release.requiredApprovers ?? [];
    const allApproved = required.length === 0 || required.every((r) => approvals.includes(r));
    const updated = { ...release, approvals, approvalStatus: allApproved ? "approved" as const : "pending" as const };
    await this.kv.set(this.k("release", releaseId), updated);
    return updated;
  }

  async rejectRelease(releaseId: string, _rejectorId: string, reason?: string): Promise<Release> {
    const release = await this.getRelease(releaseId);
    if (!release) throw new ReleaseNotFoundError(releaseId);
    const updated = { ...release, approvalStatus: "rejected" as const, rejectionReason: reason };
    await this.kv.set(this.k("release", releaseId), updated);
    return updated;
  }

  async listScheduledReleases(): Promise<Release[]> {
    const now = new Date();
    return (await this.listReleases()).filter((r) => {
      if (r.status !== "pending" && r.status !== "scheduled") return false;
      if (!r.scheduledAt) return false;
      return new Date(r.scheduledAt) <= now;
    });
  }

  async getUserAssignment(flagKey: string, userId: string): Promise<string | null> {
    return (await this.kv.get<string>(this.k("assignment", `${flagKey}:${userId}`))).value;
  }

  async setUserAssignment(flagKey: string, userId: string, variantKey: string): Promise<void> {
    await this.kv.set(this.k("assignment", `${flagKey}:${userId}`), variantKey);
  }

  async addHistory(entry: Omit<HistoryEntry, "id">): Promise<void> {
    const id = this.genId();
    const key = entry.flagKey ?? "__global";
    const existing = (await this.kv.get<HistoryEntry[]>(this.k("history", key))).value ?? [];
    await this.kv.set(this.k("history", key), [...existing, { ...entry, id }]);
  }

  async getHistory(flagKey: string, opts?: { limit?: number }): Promise<HistoryEntry[]> {
    const entries = (await this.kv.get<HistoryEntry[]>(this.k("history", flagKey))).value ?? [];
    const sorted = [...entries].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return opts?.limit ? sorted.slice(0, opts.limit) : sorted;
  }

  async trackImpression(params: { flagKey: string; userId: string; value: unknown; variant: string | null; reason: string }): Promise<void> {
    const key = this.k("impression", params.flagKey);
    const existing = (await this.kv.get<Array<typeof params & { at: string }>>(key)).value ?? [];
    await this.kv.set(key, [...existing, { ...params, at: new Date().toISOString() }]);
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
    const key = this.k("event", event.userId ?? "anon");
    const existing = (await this.kv.get<TrackingEvent[]>(key)).value ?? [];
    await this.kv.set(key, [...existing, tracked]);
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
    if (flag) await this.kv.set(this.k("flag", key), { ...flag, lastEvaluatedAt: new Date() });
  }

  async forgetUser(userId: string): Promise<void> {
    // Delete all assignment keys for this user
    const entries = await this.getAll<string>(["assignment"]);
    for (const { key } of entries) {
      if (String(key[key.length - 1]).endsWith(`:${userId}`)) {
        await this.kv.delete(key);
      }
    }
  }

  async close(): Promise<void> {
    this.kv.close();
  }
}

export function createDenoKVAdapter(kv: DenoKv, opts?: { namespace?: string }): DenoKVAdapter {
  return new DenoKVAdapter(kv, opts);
}
