import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  rolleaseMiddleware,
  getFlag,
  getAllFlags,
  getAllFlagsDetailed,
  createSignedFlagPayload,
  createSignedDetailedPayload,
  readSignedFlagPayload,
} from "../src/frameworks/next";
import type { RolleaseClient } from "../src/index";
import type { DetailedFlagMap, FlagResult } from "../src/core/types";

const TEST_SECRET = "test-secret-at-least-16-chars";

// Variables to control next/headers mock returns
let mockHeadersVal: string | null = null;
let mockCookiesVal: any = null;
let throwHeadersError = false;

// Mock next/server
const mockSet = vi.fn();
const mockNext = vi.fn().mockReturnValue({
  cookies: {
    set: mockSet,
  },
});

vi.mock("next/server", () => {
  return {
    NextResponse: {
      next: (args?: any) => mockNext(args),
    },
    NextRequest: class MockNextRequest {
      public headers = new Map();
      constructor(public url: string = "http://localhost") {}
    },
  };
});

// Mock next/headers
vi.mock("next/headers", () => {
  return {
    headers: vi.fn().mockImplementation(() => {
      if (throwHeadersError) {
        throw new Error("not in server context");
      }
      return Promise.resolve({
        get: (k: string) => {
          if (k === "x-rollease-flags") return mockHeadersVal;
          return null;
        },
      });
    }),
    cookies: vi.fn().mockImplementation(() => {
      if (throwHeadersError) {
        throw new Error("not in server context");
      }
      return Promise.resolve({
        get: (k: string) => {
          if (k === "rollease-flags") return mockCookiesVal;
          return null;
        },
      });
    }),
  };
});

function makeFlagResult(
  key: string,
  value: unknown,
  reason: FlagResult["reason"] = "default",
  variant: string | null = null
): FlagResult {
  return {
    key,
    value,
    variant,
    enabled: Boolean(value),
    reason,
    ruleId: null,
    evaluatedAt: new Date(),
  };
}

function mockClient(
  detailed: DetailedFlagMap,
  opts: { secret?: string; rejectWith?: Error } = {}
): RolleaseClient {
  const secret = opts.secret ?? TEST_SECRET;
  const client: any = {
    __rollease: { secret },
    flags: {
      evaluateAllDetailed: opts.rejectWith
        ? vi.fn().mockRejectedValue(opts.rejectWith)
        : vi.fn().mockResolvedValue(detailed),
      evaluateAll: opts.rejectWith
        ? vi.fn().mockRejectedValue(opts.rejectWith)
        : vi.fn().mockResolvedValue(
            Object.fromEntries(Object.entries(detailed).map(([k, r]) => [k, r.value]))
          ),
    },
    close: async () => {},
  };
  return client as RolleaseClient;
}

describe("Next.js Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeadersVal = null;
    mockCookiesVal = null;
    throwHeadersError = false;
  });

  describe("rolleaseMiddleware", () => {
    it("evaluates detailed flags and injects signed envelope", async () => {
      const client = mockClient({
        "feature-flag": makeFlagResult("feature-flag", true, "rule_match", "treatment"),
      });

      const middleware = rolleaseMiddleware(client, {
        userIdExtractor: () => "user-123",
        flagContext: () => ({ environment: "production" }),
        flags: ["feature-flag"],
      });

      const req: any = { url: "http://localhost", headers: new Headers() };
      const res = await middleware(req);
      expect(res).toBeDefined();

      expect(mockSet).toHaveBeenCalledWith(
        "rollease-flags",
        expect.any(String),
        expect.any(Object)
      );

      const injectedHeaders = mockNext.mock.calls[0][0].request.headers as Headers;
      const headerEnvelope = injectedHeaders.get("x-rollease-flags");
      expect(headerEnvelope).toBeTruthy();
      // v2 envelope flattens to FlagMap when read via readSignedFlagPayload.
      expect(await readSignedFlagPayload(headerEnvelope!, TEST_SECRET)).toEqual({
        "feature-flag": true,
      });
    });

    it("logs and returns NextResponse.next() on evaluation failure", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = mockClient({}, { rejectWith: new Error("eval error") });

      const middleware = rolleaseMiddleware(client);
      const req: any = { url: "http://localhost", headers: new Headers() };
      const res = await middleware(req);

      expect(res).toBeDefined();
      expect(consoleSpy).toHaveBeenCalledWith(
        "[Rollease] Middleware evaluation failed:",
        expect.any(Error)
      );
      consoleSpy.mockRestore();
    });
  });

  describe("Server Component helpers (v2 detailed envelope)", () => {
    it("preserves variant and reason from a v2 envelope", async () => {
      const detailed: DetailedFlagMap = {
        "my-flag": makeFlagResult("my-flag", { mode: "dark" }, "rule_match", "variant-b"),
      };
      mockHeadersVal = await createSignedDetailedPayload(detailed, TEST_SECRET);

      const res = await getFlag("my-flag", undefined, { secret: TEST_SECRET });
      expect(res.value).toEqual({ mode: "dark" });
      expect(res.variant).toBe("variant-b");
      expect(res.reason).toBe("rule_match");
      expect(res.enabled).toBe(true);

      const full = await getAllFlagsDetailed({ secret: TEST_SECRET });
      expect(full["my-flag"].variant).toBe("variant-b");
      expect(full["my-flag"].evaluatedAt).toBeInstanceOf(Date);
    });

    it("still reads legacy v1 envelopes (with a warning)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockHeadersVal = await createSignedFlagPayload(
        { "my-flag": "legacy-value" },
        TEST_SECRET
      );

      const res = await getFlag("my-flag", undefined, { secret: TEST_SECRET });
      expect(res.value).toBe("legacy-value");
      expect(res.variant).toBeNull(); // v1 didn't carry variant
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("legacy v1 flag envelope")
      );
      warnSpy.mockRestore();
    });

    it("rejects tampered envelopes", async () => {
      const envelope = await createSignedDetailedPayload(
        { "my-flag": makeFlagResult("my-flag", true) },
        TEST_SECRET
      );
      mockHeadersVal = envelope.replace(/\.[^.]+$/, ".tampered-sig");

      const res = await getFlag("my-flag", false, { secret: TEST_SECRET });
      expect(res.value).toBe(false);
    });

    it("rejects envelopes signed with a different secret", async () => {
      mockHeadersVal = await createSignedDetailedPayload(
        { "my-flag": makeFlagResult("my-flag", true) },
        "different-secret-16-chars-or-more"
      );

      const res = await getFlag("my-flag", false, { secret: TEST_SECRET });
      expect(res.value).toBe(false);
    });

    it("rejects envelopes older than maxAgeMs (replay protection)", async () => {
      const detailed = { "my-flag": makeFlagResult("my-flag", true) };
      // Forge an envelope with a timestamp 10 minutes ago.
      const tenMinAgo = Date.now() - 10 * 60_000;
      mockHeadersVal = await createSignedDetailedPayload(
        detailed,
        TEST_SECRET,
        tenMinAgo
      );

      const res = await getFlag("my-flag", false, {
        secret: TEST_SECRET,
        maxAgeMs: 5 * 60_000,
      });
      expect(res.value).toBe(false);
    });

    it("rejects future-dated envelopes (clock-skew attack)", async () => {
      const detailed = { "my-flag": makeFlagResult("my-flag", true) };
      // Forge an envelope dated 10 minutes in the future.
      const future = Date.now() + 10 * 60_000;
      mockHeadersVal = await createSignedDetailedPayload(
        detailed,
        TEST_SECRET,
        future
      );

      const res = await getFlag("my-flag", false, { secret: TEST_SECRET });
      expect(res.value).toBe(false);
    });

    it("returns flags from cookies as a fallback when no header is present", async () => {
      mockHeadersVal = null;
      const envelope = await createSignedDetailedPayload(
        { "my-flag": makeFlagResult("my-flag", "cookie-value") },
        TEST_SECRET
      );
      mockCookiesVal = { value: encodeURIComponent(envelope) };

      const res = await getFlag("my-flag", undefined, { secret: TEST_SECRET });
      expect(res.value).toBe("cookie-value");
    });

    it("rejects unsigned JSON by default", async () => {
      mockHeadersVal = JSON.stringify({ "my-flag": true });
      const res = await getFlag("my-flag", false, { secret: TEST_SECRET });
      expect(res.value).toBe(false);
    });

    it("allowUnsigned: true still accepts plain JSON (migration escape hatch)", async () => {
      mockHeadersVal = JSON.stringify({ "my-flag": true });
      const res = await getFlag("my-flag", false, { allowUnsigned: true });
      expect(res.value).toBe(true);
    });

    it("falls back to defaults when no transport is present", async () => {
      mockHeadersVal = null;
      mockCookiesVal = null;
      const res = await getFlag("missing", "fallback", { secret: TEST_SECRET });
      expect(res.value).toBe("fallback");
      expect(res.enabled).toBe(false);
      expect(await getAllFlags({ secret: TEST_SECRET })).toEqual({});
    });

    it("returns empty when run outside Next.js server context", async () => {
      throwHeadersError = true;
      const res = await getFlag("any", "default", { secret: TEST_SECRET });
      expect(res.value).toBe("default");
      expect(await getAllFlags({ secret: TEST_SECRET })).toEqual({});
    });
  });

  describe("Secret-source priority", () => {
    it("uses INTERNAL_SECRET symbol from createRollease over legacy __rollease.secret", async () => {
      const { createRollease, INTERNAL_SECRET } = await import("../src/index");
      const { createMemoryAdapter } = await import("../src/db/memory");
      const rl = createRollease({
        db: createMemoryAdapter(),
        secret: TEST_SECRET,
      });

      // The legacy __rollease accessor must be absent on the new client.
      expect((rl as any).__rollease).toBeUndefined();

      // The symbol-keyed getter is present and returns the secret.
      const getter = (rl as any)[INTERNAL_SECRET];
      expect(typeof getter).toBe("function");
      expect(getter()).toBe(TEST_SECRET);

      // JSON.stringify must not leak the secret.
      const json = JSON.stringify(rl);
      expect(json).not.toContain(TEST_SECRET);

      await rl.close();
    });
  });
});
