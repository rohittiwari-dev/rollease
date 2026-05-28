// ============================================================================
// Rollease SDK — Read-Replica Routing
// ============================================================================
//
// Wraps a primary + read-replica DbAdapter pair, routing read operations to
// the replica and write operations to the primary. Supports eventual consistency
// with a write-through window.
//
// Usage:
//
//   import { createReplicaRouter } from 'rollease/core/replica'
//
//   const router = createReplicaRouter({
//     primary: primaryDb,
//     replica: replicaDb,
//     writeThroughMs: 500,
//   })
//
//   const rl = createRollease({ db: router, secret: '...' })
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
} from "../core/types";

// ── Configuration ──────────────────────────────────────────────────────────

export interface ReplicaRouterConfig {
  /** Primary (writable) database. */
  primary: DbAdapter;
  /** Read replica database. */
  replica: DbAdapter;
  /**
   * After a write, route reads to primary for this many milliseconds
   * to ensure read-your-writes consistency.
   * @default 1000
   */
  writeThroughMs?: number;
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a read-replica routing adapter.
 *
 * Reads go to the replica by default, but route to primary for
 * `writeThroughMs` after any write to ensure read-your-writes consistency.
 */
export function createReplicaRouter(config: ReplicaRouterConfig): DbAdapter {
  const { primary, replica, writeThroughMs = 1000 } = config;

  let lastWriteAt = 0;

  function reader(): DbAdapter {
    if (Date.now() - lastWriteAt < writeThroughMs) {
      return primary; // Write-through window — read from primary
    }
    return replica;
  }

  function markWrite(): void {
    lastWriteAt = Date.now();
  }

  return {
    // ── Reads → replica (or primary in write-through window) ───────────

    getFlag: (key) => reader().getFlag(key),
    listFlags: (input) => reader().listFlags(input),
    getAllActiveFlags: (opts) => reader().getAllActiveFlags(opts),
    listRules: (flagKey) => reader().listRules(flagKey),
    getSegment: (key) => reader().getSegment(key),
    listSegments: () => reader().listSegments(),
    getSegmentUsage: (key) => reader().getSegmentUsage(key),
    getRelease: (id) => reader().getRelease(id),
    listReleases: (filters) => reader().listReleases(filters),
    getUserAssignment: (flagKey, userId) => reader().getUserAssignment(flagKey, userId),
    getHistory: (flagKey, opts) => reader().getHistory(flagKey, opts),

    // ── Writes → primary ──────────────────────────────────────────────

    async createFlag(input: CreateFlagInput): Promise<Flag> {
      markWrite();
      return primary.createFlag(input);
    },
    async updateFlag(key: string, input: UpdateFlagInput): Promise<Flag> {
      markWrite();
      return primary.updateFlag(key, input);
    },
    async setFlagStatus(key: string, status: FlagStatus): Promise<void> {
      markWrite();
      return primary.setFlagStatus(key, status);
    },
    async deleteFlag(key: string): Promise<void> {
      markWrite();
      return primary.deleteFlag(key);
    },
    async cloneFlag(sourceKey: string, newKey: string, includeRules: boolean, includeRollout: boolean): Promise<Flag> {
      markWrite();
      return primary.cloneFlag(sourceKey, newKey, includeRules, includeRollout);
    },
    async setRollout(key: string, rollout: Parameters<DbAdapter["setRollout"]>[1]): Promise<void> {
      markWrite();
      return primary.setRollout(key, rollout);
    },
    async addRule(flagKey: string, input: AddRuleInput): Promise<FlagRule> {
      markWrite();
      return primary.addRule(flagKey, input);
    },
    async updateRule(flagKey: string, ruleId: string, input: UpdateRuleInput): Promise<FlagRule> {
      markWrite();
      return primary.updateRule(flagKey, ruleId, input);
    },
    async removeRule(flagKey: string, ruleId: string): Promise<void> {
      markWrite();
      return primary.removeRule(flagKey, ruleId);
    },
    async reorderRules(flagKey: string, ordering: RuleOrdering[]): Promise<void> {
      markWrite();
      return primary.reorderRules(flagKey, ordering);
    },
    async createSegment(input: CreateSegmentInput): Promise<Segment> {
      markWrite();
      return primary.createSegment(input);
    },
    async updateSegment(key: string, input: UpdateSegmentInput): Promise<Segment> {
      markWrite();
      return primary.updateSegment(key, input);
    },
    async deleteSegment(key: string): Promise<void> {
      markWrite();
      return primary.deleteSegment(key);
    },
    async createRelease(input: CreateReleaseInput): Promise<Release> {
      markWrite();
      return primary.createRelease(input);
    },
    async deployRelease(releaseId: string, deployedBy?: string): Promise<void> {
      markWrite();
      return primary.deployRelease(releaseId, deployedBy);
    },
    async rollbackRelease(releaseId: string, rolledBackBy?: string, reason?: string): Promise<void> {
      markWrite();
      return primary.rollbackRelease(releaseId, rolledBackBy, reason);
    },
    async setUserAssignment(flagKey: string, userId: string, variantKey: string): Promise<void> {
      markWrite();
      return primary.setUserAssignment(flagKey, userId, variantKey);
    },
    async addHistory(entry: Omit<HistoryEntry, "id">): Promise<void> {
      markWrite();
      return primary.addHistory(entry);
    },
    async addTags(flagKey: string, tags: string[]): Promise<void> {
      markWrite();
      return primary.addTags(flagKey, tags);
    },
    async removeTags(flagKey: string, tags: string[]): Promise<void> {
      markWrite();
      return primary.removeTags(flagKey, tags);
    },

    // ── Optional methods (delegate to primary) ──────────────────────────

    ...(primary.trackEvent && { trackEvent: primary.trackEvent.bind(primary) }),
    ...(primary.trackImpression && { trackImpression: primary.trackImpression.bind(primary) }),
    ...(primary.forgetUser && { forgetUser: primary.forgetUser.bind(primary) }),
    ...(primary.getUserAssignments && { getUserAssignments: primary.getUserAssignments.bind(primary) }),
    ...(primary.touchFlagEvaluation && { touchFlagEvaluation: primary.touchFlagEvaluation.bind(primary) }),
    ...(primary.approveRelease && { approveRelease: primary.approveRelease.bind(primary) }),
    ...(primary.rejectRelease && { rejectRelease: primary.rejectRelease.bind(primary) }),
    ...(primary.close && {
      async close() {
        await primary.close?.();
        await replica.close?.();
      },
    }),
  };
}
