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

// ── OpenFeature Hook Lifecycle ─────────────────────────────────────────────
// Implements OpenFeature hook spec: before → (after | error) → finally

export interface OpenFeatureHookContext {
  flagKey: string;
  defaultValue: unknown;
  context: OpenFeatureEvaluationContext;
  provider: { metadata: { name: string } };
}

export interface OpenFeatureHook {
  /** Called before flag evaluation. Return a modified context to override evaluation context. */
  before?(
    hookContext: OpenFeatureHookContext
  ): OpenFeatureEvaluationContext | void | Promise<OpenFeatureEvaluationContext | void>;
  /** Called after successful evaluation. */
  after?(
    hookContext: OpenFeatureHookContext,
    details: OpenFeatureResolutionDetails<unknown>
  ): void | Promise<void>;
  /** Called when evaluation throws. */
  error?(
    hookContext: OpenFeatureHookContext,
    error: Error
  ): void | Promise<void>;
  /** Always called — success or error. */
  finally?(
    hookContext: OpenFeatureHookContext
  ): void | Promise<void>;
}

export interface OpenFeatureProvider {
  readonly metadata: { name: string };
  hooks?: OpenFeatureHook[];
  initialize?(): Promise<void>;
  onClose?(): Promise<void>;
  /** OpenFeature tracking spec — send a tracking event. */
  track?(
    trackingEventName: string,
    context: OpenFeatureEvaluationContext,
    details?: { value?: number; targetingKey?: string; [key: string]: unknown }
  ): void;
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
  readonly hooks: OpenFeatureHook[] = [];

  constructor(
    private readonly manager: FlagManager,
    opts?: { hooks?: OpenFeatureHook[] }
  ) {
    if (opts?.hooks) this.hooks.push(...opts.hooks);
  }

  async initialize(): Promise<void> {
    // No async init required — FlagManager is already running.
  }

  async onClose(): Promise<void> {
    await this.manager.close();
  }

  /** OpenFeature tracking spec. Fires a custom event through FlagManager.trackEvent(). */
  track(
    trackingEventName: string,
    context: OpenFeatureEvaluationContext,
    details?: { value?: number; [key: string]: unknown }
  ): void {
    const ctx = toRolleaseContext(context);
    const { value, ...rest } = details ?? {};
    this.manager.trackEvent({
      event: trackingEventName,
      value,
      metadata: rest as Record<string, unknown>,
      context: ctx,
      userId: ctx.userId,
    }).catch(() => { /* fire-and-forget */ });
  }

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
    const hookCtx: OpenFeatureHookContext = {
      flagKey,
      defaultValue,
      context,
      provider: this,
    };

    // Run before hooks — each can modify the evaluation context.
    let evalContext = context;
    for (const hook of this.hooks) {
      try {
        const result = await hook.before?.(hookCtx);
        if (result) evalContext = result;
      } catch { /* hook errors do not abort evaluation per spec */ }
    }

    let details: OpenFeatureResolutionDetails<T>;
    try {
      const ctx = toRolleaseContext(evalContext);
      const result = await this.manager.evaluate<T>(flagKey, ctx);
      details = {
        value: (result.value ?? defaultValue) as T,
        variant: result.variant ?? undefined,
        reason: toOpenFeatureReason(result.reason),
        flagMetadata: {
          ruleId: result.ruleId,
          evaluatedAt: result.evaluatedAt.toISOString(),
        },
      };

      // Run after hooks
      for (const hook of this.hooks) {
        try { await hook.after?.(hookCtx, details); } catch { /* swallow */ }
      }
    } catch (e: unknown) {
      details = {
        value: defaultValue,
        reason: "ERROR",
        errorCode: (e as { name?: string }).name ?? "GENERAL",
        errorMessage: (e as { message?: string }).message,
      };

      // Run error hooks
      for (const hook of this.hooks) {
        try { await hook.error?.(hookCtx, e instanceof Error ? e : new Error(String(e))); } catch { /* swallow */ }
      }
    } finally {
      // Run finally hooks — always
      for (const hook of this.hooks) {
        try { await hook.finally?.(hookCtx); } catch { /* swallow */ }
      }
    }

    return details;
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
  manager: FlagManager,
  opts?: { hooks?: OpenFeatureHook[] }
): RolleaseOpenFeatureProvider {
  return new RolleaseOpenFeatureProvider(manager, opts);
}
