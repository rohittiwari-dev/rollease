// ============================================================================
// Rollease SDK — Test Utilities
//
// Zero-config mock client for unit tests.  Backed by the real in-memory
// adapter so evaluation semantics are identical to production — no stubs or
// simplified logic paths.
//
// Usage:
//
//   import { createMockRollease, mockFlag } from 'rollease/testing'
//
//   const rl = createMockRollease({
//     flags: {
//       'checkout-v2': true,
//       'theme':       'dark',
//       'max-items':   { value: 25, type: 'number' },
//     },
//   })
//
//   expect(await rl.flags.isEnabled('checkout-v2', {})).toBe(true)
//   expect(await rl.flags.getValue<string>('theme', {})).toBe('dark')
//
//   // Override a flag mid-test
//   await rl.setFlag('checkout-v2', false)
//   expect(await rl.flags.isEnabled('checkout-v2', {})).toBe(false)

import { FlagManager } from "../engine/manager";
import { MemoryDbAdapter, MemoryCacheAdapter } from "../db/memory";
import { noopLogger } from "../core/logger";
import { INTERNAL_SECRET } from "../core/internal";
import type {
  FlagContext,
  FlagType,
  RolleaseHooks,
  WebhookConfig,
} from "../core/types";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MockFlagDefinition {
  /** Evaluated value. @default true for boolean flags */
  value?: unknown;
  /** Flag type. Inferred from value if omitted. */
  type?: FlagType;
  /** Whether the flag is enabled. @default true */
  enabled?: boolean;
  /** Default value when flag is disabled. */
  defaultValue?: unknown;
  /** Variant key for multivariate flags. */
  variant?: string;
  /** Flag description. */
  description?: string;
  /** Flag tags. */
  tags?: string[];
}

export type MockFlagMap = Record<
  string,
  boolean | string | number | MockFlagDefinition
>;

export interface MockRolleaseOptions {
  /** Flags to pre-seed. Values can be shorthand (boolean/string/number) or full definitions. */
  flags?: MockFlagMap;
  /** Optional hooks (useful for testing RBAC-denial behavior). */
  hooks?: RolleaseHooks;
  /** Webhooks (useful for testing dispatch side-effects). */
  webhooks?: WebhookConfig[];
  /** Secret for the internal signing slot. @default 'rollease-test-secret-xxxx' */
  secret?: string;
}

export interface MockRolleaseClient {
  /** The FlagManager instance — full production API available. */
  flags: FlagManager;
  /**
   * Set a flag's enabled state and default value for the current test.
   * Creates the flag if it doesn't exist; updates it if it does.
   */
  setFlag(key: string, value: unknown): Promise<void>;
  /** Reset a flag back to its original seeded value. */
  resetFlag(key: string): Promise<void>;
  /** Reset ALL flags back to their seeded state. */
  resetAll(): Promise<void>;
  /**
   * Force-override a flag value for the duration of a test without touching
   * the DB — uses the .rolleaserc.json local-override mechanism internally.
   * Faster than setFlag() for simple boolean gates.
   */
  overrideFlag(key: string, value: unknown): void;
  /** Clear a specific local override. */
  clearOverride(key: string): void;
  /** Clear all local overrides. */
  clearAllOverrides(): void;
  /** Clean up resources. Call in afterEach/afterAll. */
  close(): Promise<void>;
  /** Symbol-keyed accessor matching the production RolleaseClient shape. */
  [INTERNAL_SECRET]?: () => string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function inferType(value: unknown): FlagType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (value !== null && typeof value === "object") return "json";
  return "boolean";
}

function normalizeDef(
  key: string,
  raw: boolean | string | number | MockFlagDefinition
): MockFlagDefinition {
  if (typeof raw === "boolean" || typeof raw === "string" || typeof raw === "number") {
    return { value: raw, enabled: true };
  }
  return raw;
}

/** Convenience builder for creating flag definitions with full type safety. */
export function mockFlag(
  key: string,
  def: boolean | string | number | MockFlagDefinition
): { key: string; def: MockFlagDefinition } {
  return { key, def: normalizeDef(key, def) };
}

// ── Factory ───────────────────────────────────────────────────────────────────

export async function createMockRollease(
  options: MockRolleaseOptions = {}
): Promise<MockRolleaseClient> {
  const secret = options.secret ?? "rollease-test-secret-32chars-xx";
  const db = new MemoryDbAdapter();
  const l1Cache = new MemoryCacheAdapter();

  const flags = new FlagManager({
    db,
    l2Cache: l1Cache,
    l1TtlMs: 0, // disable caching in tests for immediate consistency
    l2TtlMs: 0,
    useLocalOverrides: false,
    logger: noopLogger,
    hooks: options.hooks,
    webhooks: options.webhooks,
  });

  // Seed initial flags
  const initialDefs: Record<string, MockFlagDefinition> = {};
  if (options.flags) {
    for (const [key, raw] of Object.entries(options.flags)) {
      const def = normalizeDef(key, raw);
      initialDefs[key] = def;

      const value = def.value ?? (def.enabled !== false ? true : false);
      const type = def.type ?? inferType(value);
      const defaultValue = def.defaultValue ?? (type === "boolean" ? false : value);

      await flags.create({
        key,
        type,
        defaultValue,
        description: def.description,
        tags: def.tags,
      });

      if (def.enabled === false) {
        await flags.kill(key, {});
      }
    }
  }

  // Local overrides map (in-memory, injected into the manager's override cache)
  const localOverrides: Record<string, unknown> = {};

  const client: MockRolleaseClient = {
    flags,

    async setFlag(key: string, value: unknown): Promise<void> {
      const existing = await db.getFlag(key).catch(() => null);
      const type = inferType(value);
      if (!existing) {
        await flags.create({ key, type, defaultValue: value });
      } else {
        await flags.update(key, { defaultValue: value });
        if (existing.status !== "active") {
          await flags.restore(key, {});
        }
      }
    },

    async resetFlag(key: string): Promise<void> {
      const original = initialDefs[key];
      if (!original) {
        // Flag wasn't seeded — delete it if it exists
        const existing = await db.getFlag(key).catch(() => null);
        if (existing) await db.deleteFlag(key);
        return;
      }
      const value = original.value ?? true;
      const type = original.type ?? inferType(value);
      const existing = await db.getFlag(key).catch(() => null);
      if (existing) {
        await flags.update(key, { defaultValue: value });
        if (original.enabled === false) {
          await flags.kill(key, {});
        } else if (existing.status !== "active") {
          await flags.restore(key, {});
        }
      } else {
        await flags.create({
          key,
          type,
          defaultValue: original.defaultValue ?? value,
        });
      }
    },

    async resetAll(): Promise<void> {
      // Drop all flags and re-seed from initialDefs
      const current = await db.listFlags({});
      for (const flag of current.data) {
        await db.deleteFlag(flag.key);
      }
      for (const [key, def] of Object.entries(initialDefs)) {
        const value = def.value ?? true;
        const type = def.type ?? inferType(value);
        await flags.create({
          key,
          type,
          defaultValue: def.defaultValue ?? value,
        });
        if (def.enabled === false) await flags.kill(key, {});
      }
    },

    overrideFlag(key: string, value: unknown): void {
      localOverrides[key] = value;
      // Inject into manager's internal override cache directly
      const m = flags as unknown as {
        overrideCache: Record<string, unknown> | null;
        overrideReadAt: number;
      };
      m.overrideCache = { ...localOverrides };
      m.overrideReadAt = Date.now() + 60_000 * 60; // 1 hour — prevents re-read
    },

    clearOverride(key: string): void {
      delete localOverrides[key];
      const m = flags as unknown as {
        overrideCache: Record<string, unknown> | null;
        overrideReadAt: number;
      };
      m.overrideCache = Object.keys(localOverrides).length ? { ...localOverrides } : null;
    },

    clearAllOverrides(): void {
      for (const key of Object.keys(localOverrides)) {
        delete localOverrides[key];
      }
      const m = flags as unknown as { overrideCache: Record<string, unknown> | null };
      m.overrideCache = null;
    },

    async close(): Promise<void> {
      // MemoryDbAdapter has no connections to close
    },
  };

  Object.defineProperty(client, INTERNAL_SECRET, {
    value: () => secret,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return client;
}

/**
 * Synchronous version — seeds flags eagerly using direct DB writes.
 * Useful in beforeAll/beforeEach without top-level await.
 *
 * Note: returns a Promise; use with `await` or call `createMockRollease` instead.
 */
export { createMockRollease as createMock };
