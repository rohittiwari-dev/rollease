// ============================================================================
// Rollease SDK — Exposure/Impression Deduplication
// ============================================================================
//
// Client-side and server-side deduplication for flag evaluation impressions.
// Prevents recording the same evaluation more than once per context window.
//
// Usage:
//
//   import { createExposureTracker } from 'rollease/core/exposure'
//
//   const tracker = createExposureTracker({ windowMs: 60_000 })
//   const rl = createRollease({
//     hooks: {
//       onEvaluate: (result, context) => {
//         if (tracker.shouldTrack(result, context)) {
//           db.trackImpression(result)
//         }
//       },
//     },
//   })
//
// ============================================================================

import type { FlagResult, FlagContext } from "../core/types";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ExposureTrackerConfig {
  /**
   * Time window in milliseconds within which duplicate impressions are suppressed.
   * @default 60_000 (1 minute)
   */
  windowMs?: number;
  /**
   * Max entries in the dedup cache. When exceeded, oldest entries are evicted.
   * @default 10_000
   */
  maxEntries?: number;
  /**
   * Which fields to include in the dedup key. Default: flag key + user ID + value.
   */
  keyFields?: Array<"flagKey" | "userId" | "value" | "variant" | "reason">;
}

export interface ExposureTracker {
  /** Check if this evaluation should be tracked (returns false if duplicate). */
  shouldTrack(result: FlagResult, context: FlagContext): boolean;
  /** Manually mark an evaluation as tracked. */
  mark(result: FlagResult, context: FlagContext): void;
  /** Get count of tracked (deduplicated) impressions. */
  stats(): ExposureStats;
  /** Reset all tracking state. */
  reset(): void;
}

export interface ExposureStats {
  totalEvaluations: number;
  uniqueImpressions: number;
  duplicatesSuppressed: number;
  cacheSize: number;
}

// ── Implementation ─────────────────────────────────────────────────────────

/**
 * Create an exposure tracker for deduplicating flag evaluation impressions.
 *
 * ```ts
 * const tracker = createExposureTracker({ windowMs: 60_000 })
 * // In hooks:
 * if (tracker.shouldTrack(result, context)) {
 *   // Record impression
 * }
 * ```
 */
export function createExposureTracker(
  config: ExposureTrackerConfig = {}
): ExposureTracker {
  const {
    windowMs = 60_000,
    maxEntries = 10_000,
    keyFields = ["flagKey", "userId", "value"],
  } = config;

  // LRU-ish dedup cache: key → last tracked timestamp
  const cache = new Map<string, number>();
  let totalEvals = 0;
  let uniqueImpressions = 0;
  let duplicatesSuppressed = 0;

  function makeKey(result: FlagResult, context: FlagContext): string {
    const parts: string[] = [];
    for (const field of keyFields) {
      switch (field) {
        case "flagKey":
          parts.push(`k:${result.key}`);
          break;
        case "userId":
          parts.push(`u:${context.userId ?? "anon"}`);
          break;
        case "value":
          parts.push(`v:${JSON.stringify(result.value)}`);
          break;
        case "variant":
          parts.push(`var:${result.variant ?? "null"}`);
          break;
        case "reason":
          parts.push(`r:${result.reason}`);
          break;
      }
    }
    return parts.join("|");
  }

  function evictExpired(): void {
    const now = Date.now();
    for (const [key, ts] of cache) {
      if (now - ts > windowMs) {
        cache.delete(key);
      }
    }
  }

  function evictOldest(): void {
    if (cache.size <= maxEntries) return;
    // Delete oldest entries (first inserted since Map maintains order)
    const toRemove = cache.size - maxEntries;
    let removed = 0;
    for (const key of cache.keys()) {
      if (removed >= toRemove) break;
      cache.delete(key);
      removed++;
    }
  }

  return {
    shouldTrack(result: FlagResult, context: FlagContext): boolean {
      totalEvals++;
      const key = makeKey(result, context);
      const now = Date.now();
      const lastTracked = cache.get(key);

      if (lastTracked !== undefined && now - lastTracked < windowMs) {
        // Duplicate within window — suppress
        duplicatesSuppressed++;
        return false;
      }

      // New or expired — track it
      cache.set(key, now);
      uniqueImpressions++;

      // Periodic cleanup
      if (cache.size > maxEntries) {
        evictExpired();
        evictOldest();
      }

      return true;
    },

    mark(result: FlagResult, context: FlagContext): void {
      const key = makeKey(result, context);
      cache.set(key, Date.now());
    },

    stats(): ExposureStats {
      return {
        totalEvaluations: totalEvals,
        uniqueImpressions,
        duplicatesSuppressed,
        cacheSize: cache.size,
      };
    },

    reset(): void {
      cache.clear();
      totalEvals = 0;
      uniqueImpressions = 0;
      duplicatesSuppressed = 0;
    },
  };
}
