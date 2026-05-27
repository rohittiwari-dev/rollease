// ============================================================================
// Rollease SDK — React Integration
// Provider, hooks, and declarative components.
// ============================================================================

import * as React from "react";
import type { FlagResult, FlagMap, Variant, EvalReason } from "../core/types";

// ── Context ────────────────────────────────────────────────────────────────

interface RolleaseContextValue {
  flags: FlagMap;
  flagDetails: Record<string, FlagResult>;
}

const RolleaseContext = React.createContext<RolleaseContextValue | null>(null);

// ── Provider ───────────────────────────────────────────────────────────────

export interface RolleaseProviderProps {
  /** Pre-evaluated flag values (key → value map) */
  initialFlags?: FlagMap | Record<string, FlagResult>;
  /** Children components */
  children: React.ReactNode;
}

/**
 * RolleaseProvider supplies flag evaluation results to React applications.
 * Typically populated with pre-evaluated flags from server-side rendering
 * to eliminate loading waterfalls.
 *
 * ```tsx
 * <RolleaseProvider initialFlags={flags}>
 *   <App />
 * </RolleaseProvider>
 * ```
 */
export function RolleaseProvider({ initialFlags, children }: RolleaseProviderProps) {
  const value = React.useMemo<RolleaseContextValue>(() => {
    if (!initialFlags) {
      return { flags: {}, flagDetails: {} };
    }

    const flags: FlagMap = {};
    const flagDetails: Record<string, FlagResult> = {};
    const now = new Date();

    for (const [key, val] of Object.entries(initialFlags)) {
      if (val && typeof val === "object" && "reason" in val && "evaluatedAt" in val) {
        // It's a FlagResult
        const result = val as FlagResult;
        flags[key] = result.value;
        flagDetails[key] = result;
      } else {
        // It's a plain value
        flags[key] = val;
        flagDetails[key] = {
          key,
          value: val,
          variant: null,
          enabled: Boolean(val),
          reason: "default" as EvalReason,
          ruleId: null,
          evaluatedAt: now,
        };
      }
    }

    return { flags, flagDetails };
  }, [initialFlags]);

  return React.createElement(RolleaseContext.Provider, { value }, children);
}

// ── Hooks ──────────────────────────────────────────────────────────────────

function useRolleaseContext(): RolleaseContextValue {
  const ctx = React.useContext(RolleaseContext);
  if (!ctx) {
    throw new Error(
      "Rollease hooks must be used within a <RolleaseProvider>. " +
      "Wrap your app with <RolleaseProvider initialFlags={...}>."
    );
  }
  return ctx;
}

/**
 * Hook to check if a boolean flag is enabled.
 *
 * ```tsx
 * const { enabled } = useFlag('new_checkout')
 * ```
 */
export function useFlag(key: string): {
  enabled: boolean;
  loading: boolean;
  error: null;
} {
  const { flags, flagDetails } = useRolleaseContext();
  const detail = flagDetails[key];

  return {
    enabled: detail ? detail.enabled : Boolean(flags[key]),
    loading: false,
    error: null,
  };
}

/**
 * Hook to get the variant of a multivariate flag.
 *
 * ```tsx
 * const { variant } = useVariant('pricing_layout')
 * // variant → { key: 'horizontal', value: { columns: 1 }, reason: 'weighted_random' }
 * ```
 */
export function useVariant(key: string): {
  variant: Variant | null;
  loading: boolean;
  error: null;
} {
  const { flags, flagDetails } = useRolleaseContext();
  const detail = flagDetails[key];

  if (!detail) {
    return {
      variant: flags[key] !== undefined
        ? { key: "default", value: flags[key], reason: "default" as EvalReason }
        : null,
      loading: false,
      error: null,
    };
  }

  return {
    variant: {
      key: detail.variant || "default",
      value: detail.value,
      reason: detail.reason,
    },
    loading: false,
    error: null,
  };
}

/**
 * Hook to get all flag values.
 *
 * ```tsx
 * const flags = useFlags()
 * // flags → { new_checkout: true, pricing_layout: { columns: 1 } }
 * ```
 */
export function useFlags(): FlagMap {
  const { flags } = useRolleaseContext();
  return flags;
}

/**
 * Hook to get full evaluation details for a flag.
 *
 * ```tsx
 * const details = useFlagDetails('new_checkout')
 * // details → { key, value, variant, enabled, reason, ruleId, evaluatedAt }
 * ```
 */
export function useFlagDetails(key: string): FlagResult {
  const { flagDetails } = useRolleaseContext();
  return (
    flagDetails[key] || {
      key,
      value: undefined,
      variant: null,
      enabled: false,
      reason: "default" as EvalReason,
      ruleId: null,
      evaluatedAt: new Date(),
    }
  );
}

/**
 * Hook to access the raw Rollease context.
 */
export function useRollease(): RolleaseContextValue {
  return useRolleaseContext();
}

// ── Declarative Components ─────────────────────────────────────────────────

export interface FeatureGateProps {
  /** Flag key to check */
  flag: string;
  /** Content shown when flag is disabled (optional) */
  fallback?: React.ReactNode;
  /** Content shown when flag is enabled */
  children: React.ReactNode;
}

/**
 * Declarative feature gate component.
 * Shows children when flag is enabled, fallback otherwise.
 *
 * ```tsx
 * <FeatureGate flag="new_invoice_list" fallback={<LegacyList />}>
 *   <NewInvoiceList />
 * </FeatureGate>
 * ```
 */
export function FeatureGate({ flag, fallback, children }: FeatureGateProps) {
  const { enabled } = useFlag(flag);

  if (!enabled) {
    return fallback ? React.createElement(React.Fragment, null, fallback) : null;
  }

  return React.createElement(React.Fragment, null, children);
}
