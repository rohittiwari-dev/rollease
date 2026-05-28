// ============================================================================
// Rollease SDK — Vue 3 Integration
// ============================================================================
//
// Composition API composables and a Vue plugin for reactive feature flags.
//
// Usage:
//
//   // lib/rollease.ts
//   import { createRolleaseClient } from 'rollease/client'
//   export const rlClient = createRolleaseClient({
//     baseUrl: '/api/rollease',
//     context: () => ({ userId: getCurrentUserId() }),
//     streaming: true,
//   })
//
//   // main.ts
//   import { createApp } from 'vue'
//   import { RolleasePlugin } from 'rollease/vue'
//   import { rlClient } from './lib/rollease'
//
//   createApp(App).use(RolleasePlugin, { client: rlClient }).mount('#app')
//
//   // In components:
//   import { useFlag, useVariant, useFlagValue } from 'rollease/vue'
//
//   const { enabled, isLoading } = useFlag('checkout-v2')
//   const { variant } = useVariant('pricing-layout')
//   const maxItems = useFlagValue('max-items', 25)
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

// ── Vue type stubs ─────────────────────────────────────────────────────────
// Defined locally to avoid hard dependency on 'vue'.
// These are structurally identical to Vue 3 runtime types.

type Ref<T> = { value: T; readonly __v_isRef: true };
type ShallowRef<T> = Ref<T>;
type ComputedRef<T> = Ref<T> & { readonly effect: unknown };
type Plugin = { install: (app: AppLike, ...options: unknown[]) => void };
type InjectionKey<T> = symbol & { __injectionType?: T };
type AppLike = {
  provide<T>(key: InjectionKey<T> | string | symbol, value: T): void;
  config: { globalProperties: Record<string, unknown> };
};

// We use dynamic import for Vue APIs to avoid bundling vue into the SDK.
let _vue: VueAPI | null = null;

interface VueAPI {
  ref<T>(value: T): Ref<T>;
  shallowRef<T>(value: T): ShallowRef<T>;
  computed<T>(getter: () => T): ComputedRef<T>;
  inject<T>(key: InjectionKey<T> | string | symbol, defaultValue?: T): T | undefined;
  provide<T>(key: InjectionKey<T> | string | symbol, value: T): void;
  onScopeDispose(fn: () => void): void;
  triggerRef(ref: ShallowRef<unknown>): void;
  getCurrentInstance(): unknown | null;
}

async function getVue(): Promise<VueAPI> {
  if (_vue) return _vue;
  try {
    _vue = (await import("vue" as string)) as unknown as VueAPI;
    return _vue;
  } catch {
    throw new Error(
      "[Rollease] Vue integration requires 'vue' to be installed as a peer dependency."
    );
  }
}

// Synchronous access — only works after plugin install or first async composable call.
function getVueSync(): VueAPI {
  if (!_vue) {
    throw new Error(
      "[Rollease] Vue APIs not loaded. Ensure the RolleasePlugin is installed or call a composable asynchronously first."
    );
  }
  return _vue;
}

// ── Injection Key ──────────────────────────────────────────────────────────

const ROLLEASE_KEY: InjectionKey<RolleaseVueContext> = Symbol("rollease");

interface RolleaseVueContext {
  client: RolleaseBrowserClient;
  flags: ShallowRef<FlagMap>;
  flagDetails: ShallowRef<DetailedFlagMap>;
  isLoading: Ref<boolean>;
  isRefetching: Ref<boolean>;
  error: Ref<Error | null>;
  lastUpdatedAt: Ref<Date | null>;
}

// ── Plugin ─────────────────────────────────────────────────────────────────

export interface RolleasePluginOptions {
  /** A RolleaseBrowserClient from 'rollease/client'. */
  client: RolleaseBrowserClient;
}

/**
 * Vue plugin that provides Rollease flag state to the entire component tree.
 *
 * ```ts
 * import { createApp } from 'vue'
 * import { RolleasePlugin } from 'rollease/vue'
 *
 * createApp(App).use(RolleasePlugin, { client: rlClient }).mount('#app')
 * ```
 */
export const RolleasePlugin: Plugin = {
  install(app: AppLike, ...options: unknown[]) {
    const opts = options[0] as RolleasePluginOptions;
    if (!opts?.client) {
      throw new Error(
        "[Rollease] RolleasePlugin requires a 'client' option. " +
        "Pass { client: createRolleaseClient(...) } when installing."
      );
    }

    // Eagerly load Vue APIs during plugin install.
    try {
      _vue = require("vue") as unknown as VueAPI;
    } catch {
      throw new Error(
        "[Rollease] Vue integration requires 'vue' to be installed."
      );
    }

    const vue = getVueSync();
    const client = opts.client;

    // Reactive state
    const flags = vue.shallowRef<FlagMap>(client.flags());
    const flagDetails = vue.shallowRef<DetailedFlagMap>(client.flagDetails());
    const isLoading = vue.ref(true);
    const isRefetching = vue.ref(false);
    const error = vue.ref<Error | null>(null);
    const lastUpdatedAt = vue.ref<Date | null>(null);

    // Subscribe to changes
    const unsub = client.onChange(() => {
      flags.value = client.flags();
      flagDetails.value = client.flagDetails();
      vue.triggerRef(flags);
      vue.triggerRef(flagDetails);
      isRefetching.value = false;
      lastUpdatedAt.value = new Date();
    });

    // Wait for ready
    client
      .ready()
      .then(() => {
        flags.value = client.flags();
        flagDetails.value = client.flagDetails();
        vue.triggerRef(flags);
        vue.triggerRef(flagDetails);
        isLoading.value = false;
        lastUpdatedAt.value = new Date();
      })
      .catch((err: Error) => {
        error.value = err;
        isLoading.value = false;
      });

    const ctx: RolleaseVueContext = {
      client,
      flags,
      flagDetails,
      isLoading,
      isRefetching,
      error,
      lastUpdatedAt,
    };

    app.provide(ROLLEASE_KEY, ctx);

    // Store unsub for potential cleanup
    app.config.globalProperties.__rolleaseUnsub = unsub;
  },
};

// ── Internal Context Hook ──────────────────────────────────────────────────

function useRolleaseContext(): RolleaseVueContext {
  const vue = getVueSync();
  const ctx = vue.inject<RolleaseVueContext>(ROLLEASE_KEY);
  if (!ctx) {
    throw new Error(
      "[Rollease] No Rollease context found. Install the RolleasePlugin first: " +
      "app.use(RolleasePlugin, { client })"
    );
  }
  return ctx;
}

// ── Composables ────────────────────────────────────────────────────────────

/**
 * Check if a boolean flag is enabled.
 *
 * ```vue
 * <script setup>
 * import { useFlag } from 'rollease/vue'
 * const { enabled, isLoading } = useFlag('checkout-v2')
 * </script>
 * ```
 */
export function useFlag(key: string): {
  enabled: ComputedRef<boolean>;
  isLoading: Ref<boolean>;
  isRefetching: Ref<boolean>;
  error: Ref<Error | null>;
  lastUpdatedAt: Ref<Date | null>;
  refetch: () => Promise<void>;
  invalidate: () => Promise<void>;
} {
  const vue = getVueSync();
  const ctx = useRolleaseContext();

  const enabled = vue.computed(() => {
    const detail = ctx.flagDetails.value[key] as FlagResult | undefined;
    return detail ? detail.enabled : Boolean(ctx.flags.value[key]);
  });

  return {
    enabled,
    isLoading: ctx.isLoading,
    isRefetching: ctx.isRefetching,
    error: ctx.error,
    lastUpdatedAt: ctx.lastUpdatedAt,
    refetch: () => ctx.client.refetch(),
    invalidate: async () => {
      ctx.isLoading.value = true;
      await ctx.client.refetch();
    },
  };
}

/**
 * Get the variant of a multivariate flag.
 *
 * ```vue
 * <script setup>
 * import { useVariant } from 'rollease/vue'
 * const { variant, isLoading } = useVariant('pricing-layout')
 * </script>
 * ```
 */
export function useVariant(key: string): {
  variant: ComputedRef<Variant | null>;
  isLoading: Ref<boolean>;
  isRefetching: Ref<boolean>;
  error: Ref<Error | null>;
  lastUpdatedAt: Ref<Date | null>;
  refetch: () => Promise<void>;
} {
  const vue = getVueSync();
  const ctx = useRolleaseContext();

  const variant = vue.computed<Variant | null>(() => {
    const detail = ctx.flagDetails.value[key] as FlagResult | undefined;
    if (!detail) {
      const value = ctx.flags.value[key];
      return value !== undefined
        ? { key: "default", value, reason: "default" as EvalReason }
        : null;
    }
    return {
      key: detail.variant || "default",
      value: detail.value,
      reason: detail.reason,
    };
  });

  return {
    variant,
    isLoading: ctx.isLoading,
    isRefetching: ctx.isRefetching,
    error: ctx.error,
    lastUpdatedAt: ctx.lastUpdatedAt,
    refetch: () => ctx.client.refetch(),
  };
}

/**
 * Get the typed value of a flag with a fallback default.
 *
 * ```vue
 * <script setup>
 * import { useFlagValue } from 'rollease/vue'
 * const maxItems = useFlagValue('max-items', 25)
 * const theme = useFlagValue('theme', 'light')
 * </script>
 * ```
 */
export function useFlagValue<T = unknown>(
  key: string,
  defaultValue: T
): ComputedRef<T> {
  const vue = getVueSync();
  const ctx = useRolleaseContext();

  return vue.computed(() => {
    const value = ctx.flags.value[key];
    return (value !== undefined ? value : defaultValue) as T;
  });
}

/**
 * Get all flags as a reactive map.
 *
 * ```vue
 * <script setup>
 * import { useFlags } from 'rollease/vue'
 * const { flags, isLoading } = useFlags()
 * </script>
 * ```
 */
export function useFlags(): {
  flags: ShallowRef<FlagMap>;
  isLoading: Ref<boolean>;
  isRefetching: Ref<boolean>;
  error: Ref<Error | null>;
  lastUpdatedAt: Ref<Date | null>;
  refetch: () => Promise<void>;
} {
  const ctx = useRolleaseContext();
  return {
    flags: ctx.flags,
    isLoading: ctx.isLoading,
    isRefetching: ctx.isRefetching,
    error: ctx.error,
    lastUpdatedAt: ctx.lastUpdatedAt,
    refetch: () => ctx.client.refetch(),
  };
}

/**
 * Get full evaluation details for a specific flag.
 *
 * ```vue
 * <script setup>
 * import { useFlagDetails } from 'rollease/vue'
 * const { details } = useFlagDetails('checkout-v2')
 * </script>
 * ```
 */
export function useFlagDetails(key: string): {
  details: ComputedRef<FlagResult>;
  isLoading: Ref<boolean>;
  error: Ref<Error | null>;
} {
  const vue = getVueSync();
  const ctx = useRolleaseContext();

  const details = vue.computed<FlagResult>(() => {
    const detail = ctx.flagDetails.value[key] as FlagResult | undefined;
    return (
      detail || {
        key,
        value: undefined,
        variant: null,
        enabled: false,
        reason: "default" as EvalReason,
        ruleId: null,
        evaluatedAt: new Date(),
      }
    );
  });

  return {
    details,
    isLoading: ctx.isLoading,
    error: ctx.error,
  };
}

/**
 * Access the underlying RolleaseBrowserClient instance.
 *
 * ```vue
 * <script setup>
 * import { useRolleaseClient } from 'rollease/vue'
 * const client = useRolleaseClient()
 * client.identify({ userId: 'new-user' })
 * </script>
 * ```
 */
export function useRolleaseClient(): RolleaseBrowserClient {
  const ctx = useRolleaseContext();
  return ctx.client;
}

/**
 * Check multiple flags at once.
 *
 * ```vue
 * <script setup>
 * import { useFlagSet } from 'rollease/vue'
 * const features = useFlagSet(['checkout-v2', 'dark-mode', 'beta-api'])
 * // features.value → { 'checkout-v2': true, 'dark-mode': false, 'beta-api': true }
 * </script>
 * ```
 */
export function useFlagSet(keys: string[]): ComputedRef<Record<string, boolean>> {
  const vue = getVueSync();
  const ctx = useRolleaseContext();

  return vue.computed(() => {
    const result: Record<string, boolean> = {};
    for (const key of keys) {
      const detail = ctx.flagDetails.value[key] as FlagResult | undefined;
      result[key] = detail ? detail.enabled : Boolean(ctx.flags.value[key]);
    }
    return result;
  });
}
