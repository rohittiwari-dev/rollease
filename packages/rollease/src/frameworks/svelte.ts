// ============================================================================
// Rollease SDK — Svelte Integration
// ============================================================================
//
// Svelte store-based integration for reactive feature flags.
// Works with Svelte 4 (stores) and Svelte 5 (runes-compatible).
//
// Usage:
//
//   // lib/rollease.ts
//   import { createRolleaseClient } from 'rollease/client'
//   import { createRolleaseStore } from 'rollease/svelte'
//
//   const client = createRolleaseClient({ baseUrl: '/api/rollease', streaming: true })
//   export const rollease = createRolleaseStore(client)
//
//   // In Svelte components:
//   <script>
//     import { rollease } from '$lib/rollease'
//     const { flag, variant, flagValue, flags } = rollease
//   </script>
//
//   {#if $flag('checkout-v2').enabled}
//     <NewCheckout />
//   {:else}
//     <OldCheckout />
//   {/if}
//
// ============================================================================

import type {
  FlagResult,
  FlagMap,
  DetailedFlagMap,
  Variant,
  EvalReason,
} from "../core/types";
import type { RolleaseBrowserClient } from "../client/index";

// ── Svelte store contract ──────────────────────────────────────────────────
// Minimal Svelte readable store interface to avoid hard dep on 'svelte/store'.

type Unsubscriber = () => void;
type Subscriber<T> = (value: T) => void;

interface Readable<T> {
  subscribe(run: Subscriber<T>, invalidate?: () => void): Unsubscriber;
}

// ── Flag Store Types ───────────────────────────────────────────────────────

export interface FlagState {
  enabled: boolean;
  value: unknown;
  variant: string | null;
  reason: EvalReason;
  isLoading: boolean;
  error: Error | null;
}

export interface RolleaseStore {
  /** Get a reactive flag state store for a specific key. */
  flag(key: string): Readable<FlagState>;
  /** Get a reactive variant store for a specific key. */
  variant(key: string): Readable<Variant | null>;
  /** Get a reactive typed value store with a fallback default. */
  flagValue<T = unknown>(key: string, defaultValue: T): Readable<T>;
  /** Get all flags as a reactive map. */
  flags: Readable<FlagMap>;
  /** Get all flag details as a reactive map. */
  flagDetails: Readable<DetailedFlagMap>;
  /** Loading state. */
  isLoading: Readable<boolean>;
  /** Last error. */
  error: Readable<Error | null>;
  /** Force refetch. */
  refetch(): Promise<void>;
  /** Access the underlying client. */
  client: RolleaseBrowserClient;
  /** Clean up subscriptions. */
  destroy(): void;
}

// ── Store Factory ──────────────────────────────────────────────────────────

/**
 * Create a Rollease Svelte store from a browser client.
 *
 * ```ts
 * import { createRolleaseClient } from 'rollease/client'
 * import { createRolleaseStore } from 'rollease/svelte'
 *
 * const client = createRolleaseClient({ baseUrl: '/api/rollease' })
 * export const rollease = createRolleaseStore(client)
 * ```
 */
export function createRolleaseStore(
  client: RolleaseBrowserClient
): RolleaseStore {
  // Subscriber sets for each store
  const flagSubscribers = new Set<Subscriber<FlagMap>>();
  const detailSubscribers = new Set<Subscriber<DetailedFlagMap>>();
  const loadingSubscribers = new Set<Subscriber<boolean>>();
  const errorSubscribers = new Set<Subscriber<Error | null>>();

  // Current state
  let currentFlags: FlagMap = client.flags();
  let currentDetails: DetailedFlagMap = client.flagDetails();
  let currentLoading = true;
  let currentError: Error | null = null;

  function notifyAll() {
    currentFlags = client.flags();
    currentDetails = client.flagDetails();
    flagSubscribers.forEach((s) => s(currentFlags));
    detailSubscribers.forEach((s) => s(currentDetails));
  }

  // Subscribe to client changes
  const unsubClient = client.onChange(() => {
    notifyAll();
    currentLoading = false;
    loadingSubscribers.forEach((s) => s(currentLoading));
  });

  // Wait for ready
  client
    .ready()
    .then(() => {
      notifyAll();
      currentLoading = false;
      loadingSubscribers.forEach((s) => s(currentLoading));
    })
    .catch((err: Error) => {
      currentError = err;
      currentLoading = false;
      errorSubscribers.forEach((s) => s(currentError));
      loadingSubscribers.forEach((s) => s(currentLoading));
    });

  // ── Readable factory ───────────────────────────────────────────────────

  function createReadable<T>(
    getCurrentValue: () => T,
    subscribers: Set<Subscriber<T>>
  ): Readable<T> {
    return {
      subscribe(run: Subscriber<T>, invalidate?: () => void): Unsubscriber {
        subscribers.add(run);
        run(getCurrentValue());
        return () => {
          subscribers.delete(run);
          invalidate?.();
        };
      },
    };
  }

  // Per-key subscriber sets (lazy)
  const keyFlagSubs = new Map<string, Set<Subscriber<FlagState>>>();
  const keyVariantSubs = new Map<string, Set<Subscriber<Variant | null>>>();
  const keyValueSubs = new Map<string, Set<Subscriber<unknown>>>();

  // Propagate global changes to per-key stores
  const unsubKeyPropagation = client.onChange(() => {
    for (const [key, subs] of keyFlagSubs) {
      const state = makeFlagState(key);
      subs.forEach((s) => s(state));
    }
    for (const [key, subs] of keyVariantSubs) {
      const v = makeVariant(key);
      subs.forEach((s) => s(v));
    }
    for (const [key, subs] of keyValueSubs) {
      const val = client.flags()[key];
      subs.forEach((s) => s(val));
    }
  });

  function makeFlagState(key: string): FlagState {
    const detail = currentDetails[key] as FlagResult | undefined;
    return {
      enabled: detail ? detail.enabled : Boolean(currentFlags[key]),
      value: detail ? detail.value : currentFlags[key],
      variant: detail?.variant ?? null,
      reason: detail?.reason ?? ("default" as EvalReason),
      isLoading: currentLoading,
      error: currentError,
    };
  }

  function makeVariant(key: string): Variant | null {
    const detail = currentDetails[key] as FlagResult | undefined;
    if (!detail) {
      const value = currentFlags[key];
      return value !== undefined
        ? { key: "default", value, reason: "default" as EvalReason }
        : null;
    }
    return {
      key: detail.variant || "default",
      value: detail.value,
      reason: detail.reason,
    };
  }

  return {
    flag(key: string): Readable<FlagState> {
      if (!keyFlagSubs.has(key)) keyFlagSubs.set(key, new Set());
      return createReadable(() => makeFlagState(key), keyFlagSubs.get(key)!);
    },

    variant(key: string): Readable<Variant | null> {
      if (!keyVariantSubs.has(key)) keyVariantSubs.set(key, new Set());
      return createReadable(() => makeVariant(key), keyVariantSubs.get(key)!);
    },

    flagValue<T = unknown>(key: string, defaultValue: T): Readable<T> {
      if (!keyValueSubs.has(key)) keyValueSubs.set(key, new Set());
      return createReadable(
        () => {
          const value = currentFlags[key];
          return (value !== undefined ? value : defaultValue) as T;
        },
        keyValueSubs.get(key)! as Set<Subscriber<T>>
      );
    },

    flags: createReadable(() => currentFlags, flagSubscribers),
    flagDetails: createReadable(() => currentDetails, detailSubscribers),
    isLoading: createReadable(() => currentLoading, loadingSubscribers),
    error: createReadable(() => currentError, errorSubscribers),

    refetch: () => client.refetch(),
    client,

    destroy() {
      unsubClient();
      unsubKeyPropagation();
      flagSubscribers.clear();
      detailSubscribers.clear();
      loadingSubscribers.clear();
      errorSubscribers.clear();
      keyFlagSubs.clear();
      keyVariantSubs.clear();
      keyValueSubs.clear();
    },
  };
}

// ── SvelteKit Server Helper ────────────────────────────────────────────────

/**
 * SvelteKit `load` function helper for server-side flag evaluation.
 *
 * ```ts
 * // +page.server.ts
 * import { loadFlags } from 'rollease/svelte'
 * import { rl } from '$lib/server/rollease'
 *
 * export const load = loadFlags(rl, (event) => ({
 *   userId: event.locals.user?.id,
 * }))
 * ```
 */
export function loadFlags<Event extends { locals: Record<string, unknown> }>(
  client: { flags: { evaluateAll: (ctx: Record<string, unknown>) => Promise<FlagMap> } },
  contextExtractor: (event: Event) => Record<string, unknown>
): (event: Event) => Promise<{ flags: FlagMap }> {
  return async (event: Event) => {
    const context = contextExtractor(event);
    const flags = await client.flags.evaluateAll(context);
    return { flags };
  };
}
