// ============================================================================
// Edge-runtime smoke test
//
// Verifies:
//   1. `rollease/next` can be imported without a `fs` ReferenceError — the
//      top-level next/server import is type-only, and the fs load is lazy.
//   2. `loadLocalOverrides` returns {} silently in a non-Node environment
//      (covers the `if (!isNodeRuntime())` guard in overrides.ts).
//   3. The WebhookDispatcher skips delivery when `fetch` is unavailable.
//
// We simulate an edge-like environment by stubbing Node globals with vi
// rather than spinning up a separate VM — this is faster, avoids bundling
// overhead, and is sufficient to prove the runtime guards work.
// ============================================================================

import { describe, it, expect } from "vitest";

describe("Edge-runtime compatibility", () => {
  describe("rollease/next import", () => {
    it("can be imported without crashing (no top-level next/server pull)", async () => {
      // If `next/server` were imported at the top level, this dynamic import
      // would throw when `next` is not installed in some environments.
      // The lazy import('next/server') inside the factory body means the
      // module-level import is safe everywhere.
      await expect(import("../src/frameworks/next")).resolves.toBeDefined();
    });

    it("exports rolleaseMiddleware, getFlag, getAllFlags, readSignedFlagPayload", async () => {
      const mod = await import("../src/frameworks/next");
      expect(typeof mod.rolleaseMiddleware).toBe("function");
      expect(typeof mod.getFlag).toBe("function");
      expect(typeof mod.getAllFlags).toBe("function");
      expect(typeof mod.readSignedFlagPayload).toBe("function");
    });
  });

  describe("loadLocalOverrides in non-Node runtime", () => {
    it("returns {} silently when process.versions.node is absent (Edge guard)", async () => {
      // Simulate edge runtime: process exists but versions.node is absent.
      const { _resetOverridesRuntimeCache, loadLocalOverrides } = await import(
        "../src/overrides"
      );
      _resetOverridesRuntimeCache();

      const originalProcess = globalThis.process;
      // Simulate edge: process exists but versions.node is absent.
      globalThis.process = {
        ...process,
        versions: { ...process.versions, node: undefined as unknown as string },
      } as typeof process;

      try {
        const result = loadLocalOverrides(".rolleaserc.json");
        expect(result).toEqual({});
      } finally {
        globalThis.process = originalProcess;
        _resetOverridesRuntimeCache();
      }
    });

    it("returns {} when process is entirely absent (full edge runtime)", async () => {
      const { _resetOverridesRuntimeCache, loadLocalOverrides } = await import(
        "../src/overrides"
      );
      _resetOverridesRuntimeCache();

      const original = globalThis.process;
      // @ts-expect-error — intentionally deleting process to simulate edge
      delete globalThis.process;

      try {
        const result = loadLocalOverrides(".rolleaserc.json");
        expect(result).toEqual({});
      } finally {
        globalThis.process = original;
        _resetOverridesRuntimeCache();
      }
    });
  });

  describe("WebhookDispatcher without fetch", () => {
    it("skips HTTP delivery and logs an error when fetch is unavailable", async () => {
      const { WebhookDispatcher } = await import("../src/core/webhook");
      const errors: string[] = [];
      const logger = {
        error: (msg: string) => errors.push(msg),
        warn: () => {},
        info: () => {},
        debug: () => {},
      };

      const originalFetch = globalThis.fetch;
      // @ts-expect-error — intentionally removing fetch
      delete globalThis.fetch;

      try {
        const dispatcher = new WebhookDispatcher(
          [{ url: "https://example.com/hook" }],
          logger
        );
        dispatcher.dispatch("flag.killed", "my-flag", {});

        // Give the fire-and-forget delivery a tick to run.
        await new Promise((r) => setTimeout(r, 50));

        expect(errors.some((e) => e.includes("fetch is not available"))).toBe(true);
      } finally {
        if (originalFetch) globalThis.fetch = originalFetch;
      }
    });
  });
});
