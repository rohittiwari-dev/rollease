// ============================================================================
// Rollease SDK — Angular Integration
// ============================================================================
//
// Angular 17+ integration using signals and standalone APIs.
//
// Usage:
//
//   // app.config.ts
//   import { provideRollease } from 'rollease/angular'
//   export const appConfig: ApplicationConfig = {
//     providers: [provideRollease({ baseUrl: '/api/rollease', streaming: true })]
//   }
//
//   // In components:
//   import { injectFlag, injectVariant, injectFlagValue } from 'rollease/angular'
//
//   @Component({ ... })
//   export class MyComponent {
//     isCheckoutV2 = injectFlag('checkout-v2')
//     pricing = injectVariant('pricing-layout')
//     maxItems = injectFlagValue('max-items', 25)
//   }
//
// ============================================================================

import type {
  FlagResult,
  FlagMap,
  DetailedFlagMap,
  Variant,
  EvalReason,
  FlagContext,
} from "../core/types";
import type {
  RolleaseBrowserClient,
  RolleaseClientConfig,
} from "../client/index";

// ── Angular type stubs ─────────────────────────────────────────────────────
// Defined locally to avoid hard dependency on '@angular/core'.

type Signal<T> = { (): T; readonly [Symbol.toStringTag]?: string };
type WritableSignal<T> = Signal<T> & {
  set(value: T): void;
  update(fn: (value: T) => T): void;
};
type InjectionToken<T> = { __tokenType?: T; _desc: string };
type Provider = unknown;
type EnvironmentProviders = { ɵproviders: Provider[] };
type DestroyRef = { onDestroy(fn: () => void): void };

// Dynamic import for Angular APIs
let _ng: AngularAPI | null = null;

interface AngularAPI {
  signal<T>(initialValue: T): WritableSignal<T>;
  inject<T>(token: InjectionToken<T>): T;
  InjectionToken: new <T>(desc: string) => InjectionToken<T>;
  makeEnvironmentProviders(providers: Provider[]): EnvironmentProviders;
  DestroyRef: { new (): DestroyRef };
}

function getAngular(): AngularAPI {
  if (_ng) return _ng;
  try {
    _ng = require("@angular/core") as unknown as AngularAPI;
    return _ng;
  } catch {
    throw new Error(
      "[Rollease] Angular integration requires '@angular/core' to be installed."
    );
  }
}

// ── Injection Token ────────────────────────────────────────────────────────

const ROLLEASE_CLIENT_TOKEN_DESC = "RolleaseClient";

let _clientToken: InjectionToken<RolleaseBrowserClient> | null = null;

function getClientToken(): InjectionToken<RolleaseBrowserClient> {
  if (!_clientToken) {
    const ng = getAngular();
    _clientToken = new ng.InjectionToken<RolleaseBrowserClient>(ROLLEASE_CLIENT_TOKEN_DESC);
  }
  return _clientToken;
}

// ── State ──────────────────────────────────────────────────────────────────

interface RolleaseAngularState {
  client: RolleaseBrowserClient;
  flags: WritableSignal<FlagMap>;
  flagDetails: WritableSignal<DetailedFlagMap>;
  isLoading: WritableSignal<boolean>;
  error: WritableSignal<Error | null>;
  lastUpdatedAt: WritableSignal<Date | null>;
  unsub: () => void;
}

let _state: RolleaseAngularState | null = null;

function getState(): RolleaseAngularState {
  if (!_state) {
    throw new Error(
      "[Rollease] No Rollease state initialized. Call provideRollease() in your app config first."
    );
  }
  return _state;
}

// ── Provider ───────────────────────────────────────────────────────────────

export interface RolleaseAngularConfig extends Partial<RolleaseClientConfig> {
  /** Pre-created client. If provided, config options are ignored. */
  client?: RolleaseBrowserClient;
}

/**
 * Provide Rollease to an Angular application.
 *
 * ```ts
 * // app.config.ts
 * import { provideRollease } from 'rollease/angular'
 *
 * export const appConfig = {
 *   providers: [
 *     provideRollease({ baseUrl: '/api/rollease', streaming: true })
 *   ]
 * }
 * ```
 */
export function provideRollease(
  config: RolleaseAngularConfig
): EnvironmentProviders {
  const ng = getAngular();

  // Lazy-import the client factory
  let client: RolleaseBrowserClient;
  if (config.client) {
    client = config.client;
  } else {
    const { createRolleaseClient } = require("../client/index") as {
      createRolleaseClient: (cfg: RolleaseClientConfig) => RolleaseBrowserClient;
    };
    client = createRolleaseClient(config as RolleaseClientConfig);
  }

  // Create reactive signals
  const flags = ng.signal<FlagMap>(client.flags());
  const flagDetails = ng.signal<DetailedFlagMap>(client.flagDetails());
  const isLoading = ng.signal(true);
  const error = ng.signal<Error | null>(null);
  const lastUpdatedAt = ng.signal<Date | null>(null);

  // Subscribe to changes
  const unsub = client.onChange(() => {
    flags.set(client.flags());
    flagDetails.set(client.flagDetails());
    isLoading.set(false);
    lastUpdatedAt.set(new Date());
  });

  // Wait for ready
  client
    .ready()
    .then(() => {
      flags.set(client.flags());
      flagDetails.set(client.flagDetails());
      isLoading.set(false);
      lastUpdatedAt.set(new Date());
    })
    .catch((err: Error) => {
      error.set(err);
      isLoading.set(false);
    });

  _state = { client, flags, flagDetails, isLoading, error, lastUpdatedAt, unsub };

  const token = getClientToken();
  return ng.makeEnvironmentProviders([
    { provide: token, useValue: client },
  ]);
}

// ── Inject Functions ───────────────────────────────────────────────────────

/**
 * Inject a reactive boolean flag signal.
 *
 * ```ts
 * export class MyComponent {
 *   isEnabled = injectFlag('checkout-v2')
 *   // template: @if (isEnabled()) { <NewCheckout /> }
 * }
 * ```
 */
export function injectFlag(key: string): Signal<boolean> {
  const ng = getAngular();
  const state = getState();

  // Return a computed-like signal derived from flagDetails
  const sig = ng.signal(false);

  function update() {
    const detail = state.flagDetails()[key] as FlagResult | undefined;
    sig.set(detail ? detail.enabled : Boolean(state.flags()[key]));
  }

  update();
  const unsub = state.client.onChange(update);

  // Auto-cleanup if DestroyRef is available
  try {
    const destroyRef = ng.inject(ng.DestroyRef as unknown as InjectionToken<DestroyRef>);
    destroyRef.onDestroy(unsub);
  } catch {
    // Not in injection context — caller is responsible for cleanup
  }

  return sig as Signal<boolean>;
}

/**
 * Inject a reactive variant signal.
 *
 * ```ts
 * export class MyComponent {
 *   pricing = injectVariant('pricing-layout')
 *   // template: {{ pricing()?.key }}
 * }
 * ```
 */
export function injectVariant(key: string): Signal<Variant | null> {
  const ng = getAngular();
  const state = getState();

  const sig = ng.signal<Variant | null>(null);

  function update() {
    const detail = state.flagDetails()[key] as FlagResult | undefined;
    if (!detail) {
      const value = state.flags()[key];
      sig.set(
        value !== undefined
          ? { key: "default", value, reason: "default" as EvalReason }
          : null
      );
    } else {
      sig.set({
        key: detail.variant || "default",
        value: detail.value,
        reason: detail.reason,
      });
    }
  }

  update();
  const unsub = state.client.onChange(update);

  try {
    const destroyRef = ng.inject(ng.DestroyRef as unknown as InjectionToken<DestroyRef>);
    destroyRef.onDestroy(unsub);
  } catch { /* not in injection context */ }

  return sig as Signal<Variant | null>;
}

/**
 * Inject a reactive typed flag value signal with a fallback default.
 *
 * ```ts
 * export class MyComponent {
 *   maxItems = injectFlagValue('max-items', 25)
 *   theme = injectFlagValue('theme', 'light')
 * }
 * ```
 */
export function injectFlagValue<T = unknown>(
  key: string,
  defaultValue: T
): Signal<T> {
  const ng = getAngular();
  const state = getState();

  const sig = ng.signal<T>(defaultValue);

  function update() {
    const value = state.flags()[key];
    sig.set((value !== undefined ? value : defaultValue) as T);
  }

  update();
  const unsub = state.client.onChange(update);

  try {
    const destroyRef = ng.inject(ng.DestroyRef as unknown as InjectionToken<DestroyRef>);
    destroyRef.onDestroy(unsub);
  } catch { /* not in injection context */ }

  return sig as Signal<T>;
}

/**
 * Inject the reactive loading state.
 */
export function injectIsLoading(): Signal<boolean> {
  const state = getState();
  return state.isLoading as Signal<boolean>;
}

/**
 * Inject the reactive error state.
 */
export function injectError(): Signal<Error | null> {
  const state = getState();
  return state.error as Signal<Error | null>;
}

/**
 * Inject all flags as a reactive signal map.
 */
export function injectFlags(): Signal<FlagMap> {
  const state = getState();
  return state.flags as Signal<FlagMap>;
}

/**
 * Inject the underlying RolleaseBrowserClient.
 */
export function injectRolleaseClient(): RolleaseBrowserClient {
  const state = getState();
  return state.client;
}
