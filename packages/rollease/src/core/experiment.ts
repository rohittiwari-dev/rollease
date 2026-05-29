// ============================================================================
// Rollease SDK — Experiment / Statistics Hooks
// ============================================================================
//
// Pluggable hooks for connecting Rollease flag evaluations to external
// experiment and statistics backends (Statsig, GrowthBook, custom).
//
// Usage:
//
//   import { createExperimentHooks } from 'rollease/experiment'
//
//   const rl = createRollease({
//     ...,
//     hooks: createExperimentHooks({
//       onExpose: (flagKey, variant, context) => {
//         statsigClient.logExposure(flagKey, variant, context.userId)
//       },
//       onConvert: (metricKey, value, context) => {
//         statsigClient.logEvent(metricKey, value, context.userId)
//       },
//     }),
//   })
//
// ============================================================================

import type { FlagContext, FlagResult, RolleaseHooks } from "./types";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ExperimentBackend {
  /**
   * Called when a user is exposed to an experiment (rule_match, percentage,
   * or weighted_random). Use this to log exposures to your stats backend.
   */
  onExpose(flagKey: string, variant: string | null, context: FlagContext, result: FlagResult): void;

  /**
   * Called when a conversion event is tracked via `rl.flags.trackEvent()`.
   * Wire this to metric collection in your stats backend.
   */
  onConvert?(metricKey: string, value: number | undefined, context: FlagContext | undefined): void;
}

/** Evaluation reasons that indicate an active experiment exposure. */
export const EXPERIMENT_REASONS = new Set([
  "rule_match",
  "percentage",
  "weighted_random",
  "assignment",
]);

/**
 * Create Rollease lifecycle hooks that bridge to an external experiment backend.
 *
 * ```ts
 * const rl = createRollease({
 *   hooks: createExperimentHooks({
 *     onExpose: (key, variant, ctx) => myBackend.logExposure(key, variant, ctx.userId),
 *   }),
 * })
 * ```
 */
export function createExperimentHooks(backend: ExperimentBackend): RolleaseHooks {
  return {
    onEvaluate(result: FlagResult, context: FlagContext): void {
      if (EXPERIMENT_REASONS.has(result.reason)) {
        backend.onExpose(result.key, result.variant, context, result);
      }
    },
  };
}

/**
 * Wrap an existing `hooks` config with experiment hooks, merging the
 * `onEvaluate` callbacks so neither is dropped.
 */
export function withExperimentHooks(
  existingHooks: RolleaseHooks | undefined,
  backend: ExperimentBackend
): RolleaseHooks {
  const experimentHooks = createExperimentHooks(backend);
  const existingOnEvaluate = existingHooks?.onEvaluate;
  return {
    ...existingHooks,
    onEvaluate(result: FlagResult, context: FlagContext): void {
      existingOnEvaluate?.(result, context);
      experimentHooks.onEvaluate?.(result, context);
    },
  };
}
