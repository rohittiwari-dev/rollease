// ============================================================================
// Rollease SDK — Internal Symbols
// Used to attach private state (e.g. transport secret) to the RolleaseClient
// object without exposing it via property enumeration or JSON serialization.
// ============================================================================

/**
 * Symbol-keyed slot for the transport secret. The secret never appears on
 * `Object.keys(client)` and is silently dropped by `JSON.stringify(client)`.
 *
 * Use a `Symbol.for` so that multiple bundled copies of the SDK can still
 * agree on the key in the rare case of duplicate installations.
 */
export const INTERNAL_SECRET = Symbol.for("rollease.internal.secret");

export type WithInternalSecret = {
  [INTERNAL_SECRET]?: () => string;
};

/** Auto-attached to every tracked event for downstream attribution. */
export const SDK_NAME = "rollease";
// IMPORTANT: keep in sync with package.json `version`. CI checks this match.
export const SDK_VERSION = "0.0.0-alpha.0";
