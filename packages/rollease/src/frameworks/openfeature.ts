// ============================================================================
// Rollease SDK — OpenFeature Provider
//
// Wraps a Rollease FlagManager as a CNCF OpenFeature Provider, giving instant
// compatibility with the OpenFeature ecosystem (Sentry, Datadog, etc.).
//
// Usage:
//
//   import { OpenFeature } from '@openfeature/server-sdk'
//   import { createRolleaseProvider } from 'rollease/openfeature'
//   import { rl } from '@/lib/rollease'
//
//   OpenFeature.setProvider(createRolleaseProvider(rl.flags))
//
//   const client = OpenFeature.getClient()
//   const enabled = await client.getBooleanValue('checkout-v2', false, {
//     targetingKey: userId,
//   })
// ============================================================================

import type { FlagManager } from "../engine/manager";
import type { FlagContext } from "../core/types";

// ── OpenFeature type stubs ─────────────────────────────────────────────────
// Defined locally to avoid a hard dependency on @openfeature/core.
// The real types are structurally identical — this file is fully compatible
// when @openfeature/server-sdk is installed.

export type OpenFeatureValue = boolean | string | number | Record<string, unknown>;

export interface OpenFeatureEvaluationContext {
  targetingKey?: string;
  [key: string]: unknown;
}

export type OpenFeatureReason =
  | "TARGETING_MATCH"
  | "SPLIT"
  | "DISABLED"
  | "DEFAULT"
  | "CACHED"
  | "ERROR"
  | "STATIC"
  | string;

export interface OpenFeatureResolutionDetails<T> {
  value: T;
  variant?: string;
  reason?: OpenFeatureReason;
  flagMetadata?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export interface OpenFeatureProvider {
  readonly metadata: { name: string };
  initialize?(): Promise<void>;
  onClose?(): Promise<void>;
  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: OpenFeatureEvaluationContext
  ): Promise<OpenFeatureResolutionDetails<boolean>>;
  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: OpenFeatureEvaluationContext
  ): Promise<OpenFeatureResolutionDetails<string>>;
  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: OpenFeatureEvaluationContext
  ): Promise<OpenFeatureResolutionDetails<number>>;
  resolveObjectEvaluation<T extends Record<string, unknown>>(
    flagKey: string,
    defaultValue: T,
    context: OpenFeatureEvaluationContext
  ): Promise<OpenFeatureResolutionDetails<T>>;
}

// ── Context conversion ────────────────────────────────────────────────────────

function toRolleaseContext(ctx: OpenFeatureEvaluationContext): FlagContext {
  const { targetingKey, ...rest } = ctx;
  return {
    userId: targetingKey,
    attributes: rest as Record<string, unknown>,
  };
}

function toOpenFeatureReason(reason: string): OpenFeatureReason {
  const map: Record<string, OpenFeatureReason> = {
    kill_switch: "DISABLED",
    disabled: "DISABLED",
    not_scheduled: "DISABLED",
    expired: "DISABLED",
    default: "DEFAULT",
    assignment: "SPLIT",
    rule_match: "TARGETING_MATCH",
    percentage: "SPLIT",
    weighted_random: "SPLIT",
    override: "STATIC",
    prerequisite_not_met: "DISABLED",
    exclusion_group_miss: "SPLIT",
    exclusion_layer_not_found: "ERROR",
    error_fallback: "ERROR",
  };
  return map[reason] ?? "DEFAULT";
}

// ── Provider implementation ───────────────────────────────────────────────────

export class RolleaseOpenFeatureProvider implements OpenFeatureProvider {
  readonly metadata = { name: "Rollease" };

  constructor(private readonly manager: FlagManager) {}

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: OpenFeatureEvaluationContext
  ): Promise<OpenFeatureResolutionDetails<boolean>> {
    return this.resolve<boolean>(flagKey, defaultValue, context);
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: OpenFeatureEvaluationContext
  ): Promise<OpenFeatureResolutionDetails<string>> {
    return this.resolve<string>(flagKey, defaultValue, context);
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: OpenFeatureEvaluationContext
  ): Promise<OpenFeatureResolutionDetails<number>> {
    return this.resolve<number>(flagKey, defaultValue, context);
  }

  async resolveObjectEvaluation<T extends Record<string, unknown>>(
    flagKey: string,
    defaultValue: T,
    context: OpenFeatureEvaluationContext
  ): Promise<OpenFeatureResolutionDetails<T>> {
    return this.resolve<T>(flagKey, defaultValue, context);
  }

  private async resolve<T>(
    flagKey: string,
    defaultValue: T,
    context: OpenFeatureEvaluationContext
  ): Promise<OpenFeatureResolutionDetails<T>> {
    try {
      const ctx = toRolleaseContext(context);
      const result = await this.manager.evaluate<T>(flagKey, ctx);
      return {
        value: result.value ?? defaultValue,
        variant: result.variant ?? undefined,
        reason: toOpenFeatureReason(result.reason),
        flagMetadata: { ruleId: result.ruleId },
      };
    } catch (e: unknown) {
      return {
        value: defaultValue,
        reason: "ERROR",
        errorCode: (e as { name?: string }).name ?? "GENERAL",
        errorMessage: (e as { message?: string }).message,
      };
    }
  }
}

/**
 * Create a Rollease OpenFeature Provider.
 *
 * ```ts
 * import { OpenFeature } from '@openfeature/server-sdk'
 * import { createRolleaseProvider } from 'rollease/openfeature'
 *
 * OpenFeature.setProvider(createRolleaseProvider(rl.flags))
 * ```
 */
export function createRolleaseProvider(
  manager: FlagManager
): RolleaseOpenFeatureProvider {
  return new RolleaseOpenFeatureProvider(manager);
}
