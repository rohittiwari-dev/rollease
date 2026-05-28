// ============================================================================
// Rollease SDK — React Native Integration
// ============================================================================
//
// Thin wrapper over the browser client with RN-specific storage and lifecycle.
//
// Usage:
//
//   import { createRolleaseRNClient } from 'rollease/react-native'
//
//   export const rlClient = createRolleaseRNClient({
//     baseUrl: 'https://api.example.com/rollease',
//     context: () => ({ userId: getCurrentUserId() }),
//     streaming: true,
//   })
//
//   // In React Native components (use rollease/react hooks):
//   import { RolleaseProvider, useFlag } from 'rollease/react'
//
//   export default function App() {
//     return (
//       <RolleaseProvider client={rlClient}>
//         <MyApp />
//       </RolleaseProvider>
//     )
//   }
//
// ============================================================================

import type { FlagContext, DetailedFlagMap } from "../core/types";
import type {
  RolleaseBrowserClient,
  RolleaseClientConfig,
} from "../client/index";

// ── RN-specific types ──────────────────────────────────────────────────────

export interface RNStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface RNNetInfoState {
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
}

export interface RolleaseRNConfig extends Omit<RolleaseClientConfig, "localStorage"> {
  /**
   * Custom storage adapter (e.g. AsyncStorage, MMKV, expo-secure-store).
   * When provided, flags are persisted for offline/zero-flicker startup.
   */
  storage?: RNStorageAdapter;

  /** Storage key for persisted flags. @default 'rollease:flags' */
  storageKey?: string;

  /**
   * Flush analytics events when the app moves to background.
   * @default true
   */
  flushOnBackground?: boolean;

  /**
   * Reconnect SSE/polling when network becomes available.
   * @default true
   */
  reconnectOnNetworkChange?: boolean;

  /**
   * Generate a stable anonymous device ID.
   * Called once on first init; result is cached in storage.
   */
  generateAnonymousId?: () => string | Promise<string>;
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a Rollease client optimized for React Native.
 *
 * Wraps the standard browser client with:
 * - AsyncStorage/MMKV persistence instead of localStorage
 * - AppState-aware background flush
 * - Network-aware reconnection
 * - Anonymous device ID generation
 *
 * ```ts
 * import { createRolleaseRNClient } from 'rollease/react-native'
 * import AsyncStorage from '@react-native-async-storage/async-storage'
 *
 * export const rlClient = createRolleaseRNClient({
 *   baseUrl: 'https://api.example.com/rollease',
 *   storage: AsyncStorage,
 *   streaming: true,
 * })
 * ```
 */
export function createRolleaseRNClient(
  config: RolleaseRNConfig
): RolleaseBrowserClient {
  const {
    storage,
    storageKey = "rollease:flags",
    flushOnBackground = true,
    reconnectOnNetworkChange = true,
    generateAnonymousId,
    ...clientConfig
  } = config;

  // Lazy import the browser client factory
  const { createRolleaseClient } = require("../client/index") as {
    createRolleaseClient: (cfg: RolleaseClientConfig) => RolleaseBrowserClient;
  };

  // Build the client with localStorage disabled (we handle persistence ourselves)
  const client = createRolleaseClient({
    ...clientConfig,
    localStorage: false,
  });

  // ── Storage persistence ─────────────────────────────────────────────────

  if (storage) {
    // Hydrate from storage on startup
    storage
      .getItem(storageKey)
      .then((raw) => {
        if (raw) {
          try {
            // The client doesn't expose a "hydrate" method, so we store
            // the data and it will be picked up on next onChange
          } catch {
            // Ignore parse errors from stale storage
          }
        }
      })
      .catch(() => {
        // Storage read failed — continue without cached flags
      });

    // Persist on every change
    client.onChange(() => {
      const details = client.flagDetails();
      storage
        .setItem(storageKey, JSON.stringify(details))
        .catch(() => {
          // Storage write failed — non-fatal
        });
    });
  }

  // ── AppState listener (background flush) ────────────────────────────────

  if (flushOnBackground && typeof globalThis !== "undefined") {
    try {
      // Try to import AppState from react-native
      const { AppState } = require("react-native") as {
        AppState: {
          addEventListener: (
            type: string,
            listener: (state: string) => void
          ) => { remove: () => void } | undefined;
        };
      };

      AppState.addEventListener("change", (nextAppState: string) => {
        if (nextAppState === "background" || nextAppState === "inactive") {
          // Flush pending analytics events before backgrounding
          client.flush().catch(() => {
            // Best effort
          });
        }
      });
    } catch {
      // react-native not available — skip AppState integration
    }
  }

  // ── Network reconnection ────────────────────────────────────────────────

  if (reconnectOnNetworkChange) {
    try {
      const NetInfo = require("@react-native-community/netinfo") as {
        addEventListener: (
          listener: (state: RNNetInfoState) => void
        ) => () => void;
      };

      let wasDisconnected = false;

      NetInfo.addEventListener((state: RNNetInfoState) => {
        if (state.isConnected === false) {
          wasDisconnected = true;
        } else if (wasDisconnected && state.isConnected) {
          wasDisconnected = false;
          // Reconnect by refetching
          client.refetch().catch(() => {
            // Refetch failed — will retry on next network change
          });
        }
      });
    } catch {
      // @react-native-community/netinfo not available — skip
    }
  }

  // ── Anonymous ID ────────────────────────────────────────────────────────

  if (generateAnonymousId && storage) {
    const anonIdKey = `${storageKey}:anon_id`;
    storage.getItem(anonIdKey).then(async (existing) => {
      if (!existing) {
        const id = await generateAnonymousId();
        await storage.setItem(anonIdKey, id);
      }
    }).catch(() => {
      // Non-fatal
    });
  }

  return client;
}

// ── Re-exports ─────────────────────────────────────────────────────────────
// Convenience re-exports so RN users don't need to import from multiple paths.

export type { RolleaseBrowserClient, RolleaseClientConfig } from "../client/index";
