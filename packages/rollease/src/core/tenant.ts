// ============================================================================
// Rollease SDK — Multi-Tenant Storage Namespacing
// ============================================================================
//
// Wraps any DbAdapter with tenant-scoped key namespacing.
//
// Usage:
//
//   import { createTenantAdapter } from 'rollease/core/tenant'
//   import { MemoryDbAdapter } from 'rollease/db/memory'
//
//   const baseDb = new MemoryDbAdapter()
//   const tenantDb = createTenantAdapter(baseDb, { tenantId: 'acme-corp' })
//
//   const rl = createRollease({ db: tenantDb, secret: '...' })
//
// ============================================================================

import type { DbAdapter } from "../db/adapter";
import type {
  Flag,
  FlagRule,
  FlagStatus,
  Segment,
  SegmentUsage,
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
  TrackEventInput,
  TrackingEvent,
} from "../core/types";

// ── Configuration ──────────────────────────────────────────────────────────

export interface TenantAdapterConfig {
  /** Tenant identifier used as namespace prefix. */
  tenantId: string;
  /**
   * Namespace separator between tenant ID and flag key.
   * @default ':'
   */
  separator?: string;
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Wrap a DbAdapter with tenant-scoped key namespacing.
 *
 * All flag keys, segment keys, and other identifiers are prefixed with
 * `{tenantId}{separator}` transparently. This enables safe multi-tenant
 * isolation over a shared database instance.
 *
 * ```ts
 * const tenantDb = createTenantAdapter(sharedDb, { tenantId: 'acme' })
 * // Flag key "checkout-v2" becomes "acme:checkout-v2" in storage
 * ```
 */
export function createTenantAdapter(
  inner: DbAdapter,
  config: TenantAdapterConfig
): DbAdapter {
  const { tenantId, separator = ":" } = config;
  const prefix = `${tenantId}${separator}`;

  function ns(key: string): string {
    return key.startsWith(prefix) ? key : `${prefix}${key}`;
  }
  function uns(key: string): string {
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }
  function unsFlag(flag: Flag): Flag {
    return { ...flag, key: uns(flag.key) };
  }
  function unsRule(rule: FlagRule): FlagRule {
    return { ...rule, flagKey: uns(rule.flagKey) };
  }
  function unsSegment(seg: Segment): Segment {
    return { ...seg, key: uns(seg.key) };
  }

  const adapter: DbAdapter = {
    // ── Flag CRUD ────────────────────────────────────────────────────────

    async createFlag(input: CreateFlagInput): Promise<Flag> {
      const result = await inner.createFlag({ ...input, key: ns(input.key) });
      return unsFlag(result);
    },

    async getFlag(key: string): Promise<Flag | null> {
      const result = await inner.getFlag(ns(key));
      return result ? unsFlag(result) : null;
    },

    async listFlags(input: ListFlagsInput): Promise<ListFlagsResult> {
      const result = await inner.listFlags({
        ...input,
        namespace: input.namespace ? ns(input.namespace) : prefix.slice(0, -separator.length),
      });
      return {
        ...result,
        data: result.data.map(unsFlag),
      };
    },

    async updateFlag(key: string, input: UpdateFlagInput): Promise<Flag> {
      return unsFlag(await inner.updateFlag(ns(key), input));
    },

    async setFlagStatus(key: string, status: FlagStatus): Promise<void> {
      return inner.setFlagStatus(ns(key), status);
    },

    async deleteFlag(key: string): Promise<void> {
      return inner.deleteFlag(ns(key));
    },

    async cloneFlag(sourceKey: string, newKey: string, includeRules: boolean, includeRollout: boolean): Promise<Flag> {
      return unsFlag(await inner.cloneFlag(ns(sourceKey), ns(newKey), includeRules, includeRollout));
    },

    // ── Rollout ──────────────────────────────────────────────────────────

    async setRollout(key: string, rollout: Parameters<DbAdapter["setRollout"]>[1]): Promise<void> {
      return inner.setRollout(ns(key), rollout);
    },

    // ── Rules ────────────────────────────────────────────────────────────

    async addRule(flagKey: string, input: AddRuleInput): Promise<FlagRule> {
      return unsRule(await inner.addRule(ns(flagKey), input));
    },

    async updateRule(flagKey: string, ruleId: string, input: UpdateRuleInput): Promise<FlagRule> {
      return unsRule(await inner.updateRule(ns(flagKey), ruleId, input));
    },

    async removeRule(flagKey: string, ruleId: string): Promise<void> {
      return inner.removeRule(ns(flagKey), ruleId);
    },

    async listRules(flagKey: string): Promise<FlagRule[]> {
      return (await inner.listRules(ns(flagKey))).map(unsRule);
    },

    async reorderRules(flagKey: string, ordering: RuleOrdering[]): Promise<void> {
      return inner.reorderRules(ns(flagKey), ordering);
    },

    // ── Segments ─────────────────────────────────────────────────────────

    async createSegment(input: CreateSegmentInput): Promise<Segment> {
      return unsSegment(await inner.createSegment({ ...input, key: ns(input.key) }));
    },

    async updateSegment(key: string, input: UpdateSegmentInput): Promise<Segment> {
      return unsSegment(await inner.updateSegment(ns(key), input));
    },

    async deleteSegment(key: string): Promise<void> {
      return inner.deleteSegment(ns(key));
    },

    async listSegments(): Promise<Segment[]> {
      return (await inner.listSegments()).filter((s) => s.key.startsWith(prefix)).map(unsSegment);
    },

    async getSegment(key: string): Promise<Segment | null> {
      const result = await inner.getSegment(ns(key));
      return result ? unsSegment(result) : null;
    },

    async getSegmentUsage(key: string): Promise<SegmentUsage[]> {
      const usage = await inner.getSegmentUsage(ns(key));
      return usage.map((u) => ({ ...u, flagKey: uns(u.flagKey) }));
    },

    // ── Releases ─────────────────────────────────────────────────────────

    async createRelease(input: CreateReleaseInput): Promise<Release> {
      return inner.createRelease({
        ...input,
        changes: input.changes.map((c) => ({ ...c, flagKey: ns(c.flagKey) })),
      });
    },

    async getRelease(releaseId: string): Promise<Release | null> {
      return inner.getRelease(releaseId);
    },

    async listReleases(filters?: Parameters<DbAdapter["listReleases"]>[0]): Promise<Release[]> {
      return inner.listReleases(filters);
    },

    async deployRelease(releaseId: string, deployedBy?: string): Promise<void> {
      return inner.deployRelease(releaseId, deployedBy);
    },

    async rollbackRelease(releaseId: string, rolledBackBy?: string, reason?: string): Promise<void> {
      return inner.rollbackRelease(releaseId, rolledBackBy, reason);
    },

    // ── Assignments ──────────────────────────────────────────────────────

    async getUserAssignment(flagKey: string, userId: string): Promise<string | null> {
      return inner.getUserAssignment(ns(flagKey), userId);
    },

    async setUserAssignment(flagKey: string, userId: string, variantKey: string): Promise<void> {
      return inner.setUserAssignment(ns(flagKey), userId, variantKey);
    },

    // ── History ──────────────────────────────────────────────────────────

    async addHistory(entry: Omit<HistoryEntry, "id">): Promise<void> {
      return inner.addHistory({
        ...entry,
        flagKey: entry.flagKey ? ns(entry.flagKey) : undefined,
      });
    },

    async getHistory(flagKey: string, opts?: { limit?: number }): Promise<HistoryEntry[]> {
      return inner.getHistory(ns(flagKey), opts);
    },

    // ── Tags ─────────────────────────────────────────────────────────────

    async addTags(flagKey: string, tags: string[]): Promise<void> {
      return inner.addTags(ns(flagKey), tags);
    },

    async removeTags(flagKey: string, tags: string[]): Promise<void> {
      return inner.removeTags(ns(flagKey), tags);
    },

    // ── Bulk ─────────────────────────────────────────────────────────────

    async getAllActiveFlags(opts?: Parameters<DbAdapter["getAllActiveFlags"]>[0]): Promise<Flag[]> {
      const flags = await inner.getAllActiveFlags({
        ...opts,
        namespace: opts?.namespace ? ns(opts.namespace) : prefix.slice(0, -separator.length),
      });
      return flags.filter((f) => f.key.startsWith(prefix)).map(unsFlag);
    },

    // ── Optional methods ─────────────────────────────────────────────────

    ...(inner.trackEvent && {
      async trackEvent(input: TrackEventInput): Promise<TrackingEvent> {
        return inner.trackEvent!(input);
      },
    }),

    ...(inner.trackImpression && {
      async trackImpression(params: Parameters<NonNullable<DbAdapter["trackImpression"]>>[0]): Promise<void> {
        return inner.trackImpression!({ ...params, flagKey: ns(params.flagKey) });
      },
    }),

    ...(inner.forgetUser && {
      async forgetUser(userId: string, scope?: Parameters<NonNullable<DbAdapter["forgetUser"]>>[1]): Promise<void> {
        return inner.forgetUser!(userId, scope);
      },
    }),

    ...(inner.close && {
      async close(): Promise<void> {
        return inner.close!();
      },
    }),
  };

  return adapter;
}
