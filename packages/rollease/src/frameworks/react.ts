// ============================================================================
// Rollease SDK — React Integration
// Provider, hooks, and declarative components.
// ============================================================================

import * as React from "react";
import type { FlagResult, FlagMap, Variant, EvalReason } from "../core/types";
import type { RolleaseBrowserClient } from "../client/index";

// ── Context ────────────────────────────────────────────────────────────────

interface RolleaseContextValue {
  flags: FlagMap;
  flagDetails: Record<string, FlagResult>;
  /** True while the initial flag fetch (from flagsUrl) is in-flight */
  isLoading: boolean;
  /** True while a background refresh is in-flight (not the initial load) */
  isRefetching: boolean;
  /** Last fetch error (cleared on successful fetch) */
  error: Error | null;
  /** Manually trigger a refetch of flags from flagsUrl */
  refetch: () => Promise<void>;
  /** Invalidate all cached flags and refetch from flagsUrl */
  invalidate: () => Promise<void>;
  /** Timestamp of the last successful fetch */
  lastUpdatedAt: Date | null;
}

const RolleaseContext = React.createContext<RolleaseContextValue | null>(null);

// ── Provider ───────────────────────────────────────────────────────────────

export interface RolleaseProviderProps {
  /**
   * A `RolleaseBrowserClient` from `rollease/client`.
   * When provided, the provider subscribes to real-time flag changes
   * from the client and exposes `refetch()` / `identify()` via context.
   * Takes precedence over `flagsUrl`.
   */
  client?: RolleaseBrowserClient;
  /** Pre-evaluated flag values (key → value map or FlagResult map) */
  initialFlags?: FlagMap | Record<string, FlagResult>;
  /**
   * URL to fetch flags from. When set, flags are fetched on mount
   * and optionally polled at `refreshInterval`.
   * Ignored when `client` is provided.
   */
  flagsUrl?: string;
  /**
   * Polling interval in ms (default: 30000). Set 0 to disable polling.
   * Only used when `flagsUrl` is set (not `client`).
   */
  refreshInterval?: number;
  /** Custom fetch options (headers, credentials, etc.) */
  fetchOptions?: RequestInit;
  /** Called after flags are successfully refreshed from flagsUrl */
  onRefresh?: (flags: FlagMap) => void;
  /** Called when a fetch error occurs */
  onError?: (error: Error) => void;
  /** Children components */
  children: React.ReactNode;
}

/**
 * Parses raw flag data into normalized flags and flagDetails maps.
 */
function parseFlagData(
  raw: Record<string, unknown>
): { flags: FlagMap; flagDetails: Record<string, FlagResult> } {
  const flags: FlagMap = {};
  const flagDetails: Record<string, FlagResult> = {};
  const now = new Date();

  for (const [key, val] of Object.entries(raw)) {
    if (val && typeof val === "object" && "reason" in val && "evaluatedAt" in val) {
      const result = val as FlagResult;
      flags[key] = result.value;
      flagDetails[key] = result;
    } else {
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
}

/**
 * RolleaseProvider supplies flag evaluation results to React applications.
 *
 * **Server-rendered (no loading state):**
 * ```tsx
 * <RolleaseProvider initialFlags={serverFlags}>
 *   <App />
 * </RolleaseProvider>
 * ```
 *
 * **Client-fetched (with loading/error states):**
 * ```tsx
 * <RolleaseProvider flagsUrl="/api/flags" refreshInterval={15000}>
 *   <App />
 * </RolleaseProvider>
 * ```
 */
export function RolleaseProvider({
  client,
  initialFlags,
  flagsUrl,
  refreshInterval = 30_000,
  fetchOptions,
  onRefresh,
  onError,
  children,
}: RolleaseProviderProps) {
  // ── Client-based mode ────────────────────────────────────────────────────
  // When a RolleaseBrowserClient is supplied, delegate all state management
  // to it.  This is the preferred pattern with rl.createHandler().

  const applyClientDetails = React.useCallback(
    (
      details: Record<string, FlagResult>,
      setFlags: React.Dispatch<React.SetStateAction<FlagMap>>,
      setFlagDetails: React.Dispatch<React.SetStateAction<Record<string, FlagResult>>>,
      setLastUpdatedAt: React.Dispatch<React.SetStateAction<Date | null>>
    ) => {
      const newFlags: FlagMap = {};
      for (const [k, v] of Object.entries(details)) {
        newFlags[k] = (v as FlagResult).value;
      }
      setFlags(newFlags);
      setFlagDetails(details);
      setLastUpdatedAt(new Date());
    },
    []
  );

  // ── Shared state ─────────────────────────────────────────────────────────

  // Parse initial flags (if provided synchronously)
  const initialParsed = React.useMemo(() => {
    if (!initialFlags) {
      return { flags: {} as FlagMap, flagDetails: {} as Record<string, FlagResult> };
    }
    return parseFlagData(initialFlags as Record<string, unknown>);
  }, [initialFlags]);

  const [flags, setFlags] = React.useState<FlagMap>(initialParsed.flags);
  const [flagDetails, setFlagDetails] = React.useState<Record<string, FlagResult>>(initialParsed.flagDetails);
  const [isLoading, setIsLoading] = React.useState<boolean>(
    client ? true : (!!flagsUrl && !initialFlags)
  );
  const [isRefetching, setIsRefetching] = React.useState(false);
  const [error, setError] = React.useState<Error | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = React.useState<Date | null>(
    initialFlags ? new Date() : null
  );

  // Stable refs for callbacks
  const onRefreshRef = React.useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;
  const fetchOptionsRef = React.useRef(fetchOptions);
  fetchOptionsRef.current = fetchOptions;

  // ── Client effect ─────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!client) return;

    // Sync immediately from whatever the client has cached
    applyClientDetails(
      client.flagDetails() as Record<string, FlagResult>,
      setFlags, setFlagDetails, setLastUpdatedAt
    );

    // Wait for the client's first fetch to complete
    let mounted = true;
    client.ready().then(() => {
      if (!mounted) return;
      applyClientDetails(
        client.flagDetails() as Record<string, FlagResult>,
        setFlags, setFlagDetails, setLastUpdatedAt
      );
      setIsLoading(false);
    }).catch((err: Error) => {
      if (!mounted) return;
      setError(err);
      setIsLoading(false);
      onErrorRef.current?.(err);
    });

    // Subscribe to subsequent changes (SSE / polling)
    const unsub = client.onChange(() => {
      if (!mounted) return;
      applyClientDetails(
        client.flagDetails() as Record<string, FlagResult>,
        setFlags, setFlagDetails, setLastUpdatedAt
      );
      setIsRefetching(false);
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [client, applyClientDetails]);

  // ── Sync initialFlags prop changes ────────────────────────────────────────
  React.useEffect(() => {
    if (client) return; // client takes priority
    setFlags(initialParsed.flags);
    setFlagDetails(initialParsed.flagDetails);
    if (initialFlags) {
      setLastUpdatedAt(new Date());
      setIsLoading(false);
    }
  }, [client, initialParsed, initialFlags]);

  // ── URL-fetch mode ────────────────────────────────────────────────────────
  const fetchFlagsFromUrl = React.useCallback(
    async (opts?: { isInitial?: boolean }) => {
      if (!flagsUrl || client) return;
      if (!opts?.isInitial && typeof document !== "undefined" && document.hidden) return;

      if (opts?.isInitial) {
        setIsLoading(true);
      } else {
        setIsRefetching(true);
      }

      try {
        const res = await fetch(flagsUrl, fetchOptionsRef.current);
        if (!res.ok) {
          throw new Error(`Flag fetch failed: ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        const parsed = parseFlagData(data as Record<string, unknown>);
        setFlags(parsed.flags);
        setFlagDetails(parsed.flagDetails);
        setError(null);
        setLastUpdatedAt(new Date());
        onRefreshRef.current?.(parsed.flags);
      } catch (err) {
        const fetchErr = err instanceof Error ? err : new Error(String(err));
        setError(fetchErr);
        onErrorRef.current?.(fetchErr);
      } finally {
        setIsLoading(false);
        setIsRefetching(false);
      }
    },
    [flagsUrl, client]
  );

  const refetch = React.useCallback(async () => {
    if (client) {
      setIsRefetching(true);
      await client.refetch();
      // onChange listener above will update state
    } else {
      await fetchFlagsFromUrl({ isInitial: false });
    }
  }, [client, fetchFlagsFromUrl]);

  const invalidate = React.useCallback(async () => {
    if (client) {
      setFlags({});
      setFlagDetails({});
      setLastUpdatedAt(null);
      setIsLoading(true);
      await client.refetch();
    } else {
      setFlags({});
      setFlagDetails({});
      setLastUpdatedAt(null);
      await fetchFlagsFromUrl({ isInitial: true });
    }
  }, [client, fetchFlagsFromUrl]);

  // Initial fetch on mount (url mode only)
  React.useEffect(() => {
    if (flagsUrl && !initialFlags && !client) {
      fetchFlagsFromUrl({ isInitial: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagsUrl, client]);

  // Polling (url mode only)
  React.useEffect(() => {
    if (!flagsUrl || client || refreshInterval <= 0) return;
    const id = setInterval(() => fetchFlagsFromUrl({ isInitial: false }), refreshInterval);
    return () => clearInterval(id);
  }, [flagsUrl, client, refreshInterval, fetchFlagsFromUrl]);

  const value = React.useMemo<RolleaseContextValue>(
    () => ({
      flags,
      flagDetails,
      isLoading,
      isRefetching,
      error,
      refetch,
      invalidate,
      lastUpdatedAt,
    }),
    [flags, flagDetails, isLoading, isRefetching, error, refetch, invalidate, lastUpdatedAt]
  );

  return React.createElement(RolleaseContext.Provider, { value }, children);
}

// ── Internal Context Hook ──────────────────────────────────────────────────

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

// ── Hooks ──────────────────────────────────────────────────────────────────

/**
 * Hook to check if a boolean flag is enabled.
 * Returns loading/error states and control functions for async flag fetching.
 *
 * ```tsx
 * const { enabled, isLoading, error, refetch } = useFlag('new_checkout')
 *
 * if (isLoading) return <Skeleton />
 * if (error) return <ErrorBanner error={error} onRetry={refetch} />
 * if (enabled) return <NewCheckout />
 * ```
 */
export function useFlag(key: string): {
  enabled: boolean;
  isLoading: boolean;
  isRefetching: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  invalidate: () => Promise<void>;
  lastUpdatedAt: Date | null;
} {
  const { flags, flagDetails, isLoading, isRefetching, error, refetch, invalidate, lastUpdatedAt } =
    useRolleaseContext();
  const detail = flagDetails[key];

  return {
    enabled: detail ? detail.enabled : Boolean(flags[key]),
    isLoading,
    isRefetching,
    error,
    refetch,
    invalidate,
    lastUpdatedAt,
  };
}

/**
 * Hook to get the variant of a multivariate flag.
 * Returns loading/error states and control functions for async flag fetching.
 *
 * ```tsx
 * const { variant, isLoading, error } = useVariant('pricing_layout')
 * // variant → { key: 'horizontal', value: { columns: 1 }, reason: 'weighted_random' }
 * ```
 */
export function useVariant(key: string): {
  variant: Variant | null;
  isLoading: boolean;
  isRefetching: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  invalidate: () => Promise<void>;
  lastUpdatedAt: Date | null;
} {
  const { flags, flagDetails, isLoading, isRefetching, error, refetch, invalidate, lastUpdatedAt } =
    useRolleaseContext();
  const detail = flagDetails[key];

  let variant: Variant | null;
  if (!detail) {
    variant = flags[key] !== undefined
      ? { key: "default", value: flags[key], reason: "default" as EvalReason }
      : null;
  } else {
    variant = {
      key: detail.variant || "default",
      value: detail.value,
      reason: detail.reason,
    };
  }

  return {
    variant,
    isLoading,
    isRefetching,
    error,
    refetch,
    invalidate,
    lastUpdatedAt,
  };
}

/**
 * Hook to get all flag values as a flat key→value map.
 * Includes loading/error states for async-aware rendering.
 *
 * ```tsx
 * const { flags, isLoading } = useFlags()
 * if (isLoading) return <Loader />
 * // flags → { new_checkout: true, pricing_layout: { columns: 1 } }
 * ```
 */
export function useFlags(): {
  flags: FlagMap;
  isLoading: boolean;
  isRefetching: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  invalidate: () => Promise<void>;
  lastUpdatedAt: Date | null;
} {
  const { flags, isLoading, isRefetching, error, refetch, invalidate, lastUpdatedAt } =
    useRolleaseContext();
  return { flags, isLoading, isRefetching, error, refetch, invalidate, lastUpdatedAt };
}

/**
 * Hook to get full evaluation details for a specific flag.
 * Includes the full FlagResult plus async lifecycle states.
 *
 * ```tsx
 * const { details, isLoading } = useFlagDetails('new_checkout')
 * // details → { key, value, variant, enabled, reason, ruleId, evaluatedAt }
 * ```
 */
export function useFlagDetails(key: string): {
  details: FlagResult;
  isLoading: boolean;
  isRefetching: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  invalidate: () => Promise<void>;
  lastUpdatedAt: Date | null;
} {
  const { flagDetails, isLoading, isRefetching, error, refetch, invalidate, lastUpdatedAt } =
    useRolleaseContext();

  const details = flagDetails[key] || {
    key,
    value: undefined,
    variant: null,
    enabled: false,
    reason: "default" as EvalReason,
    ruleId: null,
    evaluatedAt: new Date(),
  };

  return { details, isLoading, isRefetching, error, refetch, invalidate, lastUpdatedAt };
}

/**
 * Hook to get the typed value of a flag with a fallback default.
 * Prevents undefined values from leaking into your rendering logic.
 *
 * ```tsx
 * const maxRetries = useFlagValue<number>('max_retries', 3)
 * const theme = useFlagValue<string>('theme', 'light')
 * ```
 */
export function useFlagValue<T = unknown>(key: string, defaultValue: T): T {
  const { flags } = useRolleaseContext();
  const value = flags[key];
  return (value !== undefined ? value : defaultValue) as T;
}

/**
 * Hook to access full Rollease context: flags, details, loading, error,
 * refetch, and invalidate. The kitchen-sink hook.
 *
 * ```tsx
 * const { flags, isLoading, error, refetch, invalidate, lastUpdatedAt } = useRollease()
 * ```
 */
export function useRollease(): RolleaseContextValue {
  return useRolleaseContext();
}

/**
 * Hook that only re-renders when specific flag keys change.
 * Use for performance-sensitive components that only care about a subset of flags.
 *
 * ```tsx
 * const { enabled, value } = useWatchFlag('feature_x')
 * ```
 */
export function useWatchFlag(key: string): {
  enabled: boolean;
  value: unknown;
  variant: string | null;
  reason: EvalReason;
  isLoading: boolean;
  error: Error | null;
} {
  const { flagDetails, isLoading, error } = useRolleaseContext();
  const detail = flagDetails[key];

  return React.useMemo(
    () => ({
      enabled: detail?.enabled ?? false,
      value: detail?.value,
      variant: detail?.variant ?? null,
      reason: detail?.reason ?? ("default" as EvalReason),
      isLoading,
      error,
    }),
    [detail?.enabled, detail?.value, detail?.variant, detail?.reason, isLoading, error]
  );
}

/**
 * Hook to check multiple flags at once. Returns an object keyed by flag name
 * with enabled status. Useful for rendering based on multiple feature gates.
 *
 * ```tsx
 * const features = useFlagSet(['new_checkout', 'dark_mode', 'beta_api'])
 * // features → { new_checkout: true, dark_mode: false, beta_api: true }
 * ```
 */
export function useFlagSet(keys: string[]): {
  features: Record<string, boolean>;
  isLoading: boolean;
  error: Error | null;
} {
  const { flags, flagDetails, isLoading, error } = useRolleaseContext();

  const features = React.useMemo(() => {
    const result: Record<string, boolean> = {};
    for (const key of keys) {
      const detail = flagDetails[key];
      result[key] = detail ? detail.enabled : Boolean(flags[key]);
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flags, flagDetails, ...keys]);

  return { features, isLoading, error };
}

// ── Declarative Components ─────────────────────────────────────────────────

export interface FeatureGateProps {
  /** Flag key to check */
  flag: string;
  /** Content shown when flag is disabled (optional) */
  fallback?: React.ReactNode;
  /** Content shown while flags are still loading (optional) */
  loading?: React.ReactNode;
  /**
   * Children rendered when the flag is enabled. Optional so the gate can be
   * used declaratively for side-effects only or as a "render nothing when
   * disabled" guard. With no children, an empty Fragment is rendered when
   * the flag is on.
   */
  children?: React.ReactNode;
}

/**
 * Declarative feature gate component.
 * Shows children when flag is enabled, fallback when disabled,
 * and a loading state while flags are being fetched.
 *
 * ```tsx
 * <FeatureGate
 *   flag="new_invoice_list"
 *   loading={<InvoiceListSkeleton />}
 *   fallback={<LegacyList />}
 * >
 *   <NewInvoiceList />
 * </FeatureGate>
 * ```
 */
export function FeatureGate({ flag, fallback, loading, children }: FeatureGateProps) {
  const { enabled, isLoading } = useFlag(flag);

  if (isLoading && loading) {
    return React.createElement(React.Fragment, null, loading);
  }

  if (!enabled) {
    return fallback ? React.createElement(React.Fragment, null, fallback) : null;
  }

  return React.createElement(React.Fragment, null, children);
}

/**
 * Component that renders children only when ALL specified flags are enabled.
 *
 * ```tsx
 * <FeatureRequire flags={['beta_api', 'new_checkout']}>
 *   <BetaCheckoutFlow />
 * </FeatureRequire>
 * ```
 */
export function FeatureRequire({
  flags: flagKeys,
  fallback,
  children,
}: {
  flags: string[];
  fallback?: React.ReactNode;
  /**
   * Children rendered when all flags are enabled. Optional — same rationale
   * as {@link FeatureGateProps.children}.
   */
  children?: React.ReactNode;
}) {
  const { features } = useFlagSet(flagKeys);
  const allEnabled = flagKeys.every((key) => features[key]);

  if (!allEnabled) {
    return fallback ? React.createElement(React.Fragment, null, fallback) : null;
  }

  return React.createElement(React.Fragment, null, children);
}
