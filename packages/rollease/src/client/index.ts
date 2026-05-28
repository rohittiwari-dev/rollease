// ============================================================================
// Rollease SDK — Browser Client
// ============================================================================
//
// Zero-dependency browser client for Rollease.  Pairs with the server handler
// (`rl.createHandler(...)`) so the browser can fetch evaluated flag values,
// subscribe to real-time changes via SSE, and report analytics events — all
// without exposing the DB or the server secret.
//
// Usage:
//
//   // lib/rollease-client.ts  (shared between client components)
//   import { createRolleaseClient } from 'rollease/client'
//
//   export const rlClient = createRolleaseClient({
//     baseUrl:  '/api/rollease',
//     context:  () => ({ userId: getCurrentUserId() }),
//     streaming: true,
//   })
//
//   // In React (see rollease/react):
//   <RolleaseProvider client={rlClient}>{children}</RolleaseProvider>
//
//   // Outside React (vanilla JS):
//   await rlClient.ready()
//   const isEnabled = rlClient.flag('checkout-v2', false)

import type { FlagContext, FlagMap, DetailedFlagMap, FlagResult } from "../core/types";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RolleaseClientConfig {
  /** Base URL of the mounted Rollease handler (e.g. '/api/rollease'). */
  baseUrl: string;

  /**
   * User context sent with every evaluation request.
   * Can be a static object or a sync/async factory called before each fetch.
   */
  context?: FlagContext | (() => FlagContext | Promise<FlagContext>);

  /**
   * Enable SSE streaming for real-time flag updates.
   * Falls back to polling when the environment doesn't support EventSource.
   * @default false
   */
  streaming?: boolean;

  /**
   * Polling interval in milliseconds.  Set to 0 to disable polling.
   * When streaming is true, polling is the reconnect fallback only.
   * @default 0  (disabled)
   */
  refreshInterval?: number;

  /**
   * Cache evaluated flags in localStorage so the client starts with values
   * on the next page load before the first fetch completes.
   * @default false
   */
  localStorage?: boolean;

  /** Key used to persist flags in localStorage. @default 'rollease:flags' */
  localStorageKey?: string;

  /** Extra headers added to every request. */
  headers?: Record<string, string>;

  /** Public client key configured on the Rollease handler. */
  clientKey?: string;

  /** Number of analytics events to batch before flushing. @default 10 */
  eventBatchSize?: number;

  /** Maximum delay before flushing analytics events. @default 5000 */
  eventFlushIntervalMs?: number;

  /** Stable anonymous identifier used for tracking before sign-in. */
  anonymousId?: string;

  /** Called after flags are refreshed. */
  onFlagsChange?: (flags: DetailedFlagMap) => void;

  /** Called when a fetch/stream error occurs. */
  onError?: (err: Error) => void;
}

export interface RolleaseBrowserClient {
  /**
   * Returns a flag's evaluated value synchronously.
   * Returns `defaultValue` before `ready()` resolves.
   */
  flag<T = boolean>(key: string, defaultValue: T): T;

  /** Current evaluated FlagMap (key → value). */
  flags(): FlagMap;

  /** Current detailed evaluation results (key → { value, variant, reason }). */
  flagDetails(): DetailedFlagMap;

  /** Resolves when the first fetch completes. */
  ready(): Promise<void>;

  /** Force an immediate refetch from the server. */
  refetch(): Promise<void>;

  /**
   * Update the user context (e.g. after sign-in) and refetch flags.
   * Also reconnects the SSE stream with the new context.
   */
  identify(context: FlagContext): Promise<void>;

  /**
   * Send an analytics event to the server.
   * Fire-and-forget — does not block the UI.
   */
  track(
    event: string,
    props?: { value?: number; metadata?: Record<string, unknown> }
  ): void;

  /** Flush queued analytics events immediately. */
  flush(): Promise<void>;

  /**
   * Subscribe to any flag change.
   * Returns an unsubscribe function.
   */
  onChange(listener: () => void): () => void;

  /**
   * Subscribe to changes on a specific flag key.
   * Returns an unsubscribe function.
   */
  onFlagChange(key: string, listener: (value: unknown) => void): () => void;

  /** Tear down SSE / polling / timers.  Call on component unmount or page navigation. */
  destroy(): void;
}

// ── Internals ─────────────────────────────────────────────────────────────────

function encodeContext(ctx: FlagContext): string {
  const json = JSON.stringify(ctx);
  if (typeof btoa !== "undefined") return btoa(json);
  return Buffer.from(json).toString("base64");
}

const LS_KEY = "rollease:flags";

// ── Factory ───────────────────────────────────────────────────────────────────

export function createRolleaseClient(
  config: RolleaseClientConfig
): RolleaseBrowserClient {
  const {
    baseUrl,
    streaming = false,
    refreshInterval = 0,
    localStorage: useLocalStorage = false,
    localStorageKey = LS_KEY,
    headers: extraHeaders = {},
    clientKey,
    eventBatchSize = 10,
    eventFlushIntervalMs = 5000,
    anonymousId,
    onFlagsChange,
    onError,
  } = config;

  let currentContext: FlagContext = {};
  let detailedFlags: DetailedFlagMap = {};
  let readyResolve!: () => void;
  let readyReject!: (err: Error) => void;
  let isReady = false;
  const readyPromise = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });

  const listeners = new Set<() => void>();
  const flagListeners = new Map<string, Set<(v: unknown) => void>>();

  let eventSource: EventSource | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let eventFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  const eventQueue: Array<{
    userId?: string;
    anonymousId?: string;
    event: string;
    value?: number;
    metadata?: Record<string, unknown>;
  }> = [];

  // ── Context resolution ────────────────────────────────────────────────────

  async function resolveContext(): Promise<FlagContext> {
    const ctx = config.context;
    if (!ctx) return currentContext;
    if (typeof ctx === "function") return ctx();
    return ctx;
  }

  // ── Flag state ────────────────────────────────────────────────────────────

  function applyFlags(newFlags: DetailedFlagMap): void {
    const prevFlags = detailedFlags;
    detailedFlags = newFlags;

    if (useLocalStorage && typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(localStorageKey, JSON.stringify(newFlags));
      } catch {
        // quota exceeded — ignore
      }
    }

    // Notify per-key listeners for changed flags
    for (const [key, result] of Object.entries(newFlags)) {
      const prev = prevFlags[key];
      if (prev?.value !== result.value) {
        flagListeners.get(key)?.forEach((l) => l(result.value));
      }
    }

    listeners.forEach((l) => l());
    onFlagsChange?.(newFlags);
  }

  function loadCached(): boolean {
    if (!useLocalStorage || typeof localStorage === "undefined") return false;
    try {
      const raw = localStorage.getItem(localStorageKey);
      if (!raw) return false;
      detailedFlags = JSON.parse(raw) as DetailedFlagMap;
      return true;
    } catch {
      return false;
    }
  }

  // ── HTTP fetch ─────────────────────────────────────────────────────────────

  async function buildHeaders(): Promise<Record<string, string>> {
    const ctx = await resolveContext();
    currentContext = ctx;
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Rollease-Context": encodeContext(ctx),
      ...extraHeaders,
    };
    if (clientKey) {
      h["X-Rollease-Client-Key"] = clientKey;
    }
    return h;
  }

  async function fetchFlags(): Promise<void> {
    const headers = await buildHeaders();
    const res = await fetch(`${baseUrl}/flags`, { headers });
    if (!res.ok) {
      throw new Error(`Rollease: flags fetch failed (${res.status})`);
    }
    const data = (await res.json()) as { flags: DetailedFlagMap };
    applyFlags(data.flags);
  }

  // ── SSE stream ────────────────────────────────────────────────────────────

  function connectSSE(): void {
    if (typeof EventSource === "undefined") return;
    eventSource?.close();

    const params = new URLSearchParams({ context: encodeContext(currentContext) });
    if (clientKey) params.set("clientKey", clientKey);
    const url = `${baseUrl}/flags/stream?${params.toString()}`;
    eventSource = new EventSource(url);

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as { flags: DetailedFlagMap };
        applyFlags(data.flags);
        if (!isReady) { isReady = true; readyResolve(); }
      } catch {
        // ignore malformed SSE data
      }
    };

    eventSource.onerror = () => {
      // Browser auto-reconnects; surface error to caller
      const e = new Error("Rollease: SSE connection error");
      onError?.(e);
    };
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  function startPolling(): void {
    if (!refreshInterval || pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        await fetchFlags();
        if (!isReady) { isReady = true; readyResolve(); }
      } catch (e) {
        onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    }, refreshInterval);
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function scheduleEventFlush(): void {
    if (eventFlushTimer || eventQueue.length === 0) return;
    eventFlushTimer = setTimeout(() => {
      eventFlushTimer = null;
      flushEvents().catch((e) =>
        onError?.(e instanceof Error ? e : new Error(String(e)))
      );
    }, eventFlushIntervalMs);
  }

  async function flushEvents(): Promise<void> {
    if (eventFlushTimer) {
      clearTimeout(eventFlushTimer);
      eventFlushTimer = null;
    }
    if (eventQueue.length === 0) return;
    const batch = eventQueue.splice(0, eventQueue.length);
    const headers = await buildHeaders();
    const res = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({ events: batch }),
    });
    if (!res.ok) {
      eventQueue.unshift(...batch);
      throw new Error(`Rollease: event flush failed (${res.status})`);
    }
  }

  async function init(): Promise<void> {
    // Hydrate from localStorage for zero-flicker on mount
    const hasCached = loadCached();
    if (hasCached && !isReady) {
      isReady = true;
      readyResolve();
    }

    try {
      await fetchFlags();
      if (!isReady) { isReady = true; readyResolve(); }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      onError?.(err);
      if (!isReady) { readyReject(err); }
      return;
    }

    if (streaming) {
      connectSSE();
    } else {
      startPolling();
    }
  }

  // Kick off immediately — intentionally unawaited
  if (!destroyed) {
    init().catch(() => { /* handled inside init */ });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    flag<T = boolean>(key: string, defaultValue: T): T {
      const result = detailedFlags[key] as FlagResult<T> | undefined;
      return (result?.value ?? defaultValue) as T;
    },

    flags(): FlagMap {
      const out: FlagMap = {};
      for (const [k, v] of Object.entries(detailedFlags)) {
        out[k] = (v as FlagResult).value;
      }
      return out;
    },

    flagDetails(): DetailedFlagMap {
      return { ...detailedFlags };
    },

    ready(): Promise<void> {
      return readyPromise;
    },

    async refetch(): Promise<void> {
      await fetchFlags();
    },

    async identify(context: FlagContext): Promise<void> {
      currentContext = context;
      await fetchFlags();
      if (streaming) connectSSE();
    },

    track(event: string, props?: { value?: number; metadata?: Record<string, unknown> }): void {
      eventQueue.push({
        userId: currentContext.userId,
        anonymousId,
        event,
        ...props,
      });
      if (eventQueue.length >= eventBatchSize) {
        flushEvents().catch((e) =>
          onError?.(e instanceof Error ? e : new Error(String(e)))
        );
      } else {
        scheduleEventFlush();
      }
    },

    async flush(): Promise<void> {
      await flushEvents();
    },

    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    onFlagChange(key: string, listener: (value: unknown) => void): () => void {
      if (!flagListeners.has(key)) flagListeners.set(key, new Set());
      flagListeners.get(key)!.add(listener);
      return () => flagListeners.get(key)?.delete(listener);
    },

    destroy(): void {
      destroyed = true;
      stopPolling();
      if (eventFlushTimer) {
        clearTimeout(eventFlushTimer);
        eventFlushTimer = null;
      }
      flushEvents().catch(() => { /* fire-and-forget on teardown */ });
      eventSource?.close();
      eventSource = null;
      listeners.clear();
      flagListeners.clear();
    },
  };
}
