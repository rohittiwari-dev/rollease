import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  rolleaseMiddleware,
  getFlag,
  getAllFlags,
  createSignedFlagPayload,
  readSignedFlagPayload,
} from "../src/frameworks/next";
import type { RolleaseClient } from "../src/index";

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
      next: (args: any) => mockNext(args),
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

describe("Next.js Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeadersVal = null;
    mockCookiesVal = null;
    throwHeadersError = false;
  });

  describe("rolleaseMiddleware", () => {
    const mockClient = {
      __rollease: {
        secret: TEST_SECRET,
      },
      flags: {
        evaluateAll: vi.fn().mockResolvedValue({ "feature-flag": true }),
      },
    } as unknown as RolleaseClient;

    it("should evaluate and inject flags into headers and cookies", async () => {
      const middleware = rolleaseMiddleware(mockClient, {
        userIdExtractor: () => "user-123",
        flagContext: () => ({ environment: "production" }),
        flags: ["feature-flag"],
      });

      const req: any = {
        url: "http://localhost",
        headers: new Headers(),
      };

      const res = await middleware(req);
      expect(res).toBeDefined();

      // Headers injection check
      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            headers: expect.any(Headers),
          }),
        })
      );

      // Cookie injection check
      expect(mockSet).toHaveBeenCalledWith("rollease-flags", expect.any(String), expect.any(Object));

      const injectedHeaders = mockNext.mock.calls[0][0].request.headers as Headers;
      const headerEnvelope = injectedHeaders.get("x-rollease-flags");
      expect(headerEnvelope).toBeTruthy();
      expect(await readSignedFlagPayload(headerEnvelope!, TEST_SECRET)).toEqual({
        "feature-flag": true,
      });

      const cookieEnvelope = decodeURIComponent(mockSet.mock.calls[0][1]);
      expect(await readSignedFlagPayload(cookieEnvelope, TEST_SECRET)).toEqual({
        "feature-flag": true,
      });
    });

    it("should catch errors, log them, and fall back to NextResponse.next()", async () => {
      const faultyClient = {
        __rollease: {
          secret: TEST_SECRET,
        },
        flags: {
          evaluateAll: vi.fn().mockRejectedValue(new Error("eval error")),
        },
      } as unknown as RolleaseClient;

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const middleware = rolleaseMiddleware(faultyClient);
      const req: any = { url: "http://localhost", headers: new Headers() };

      const res = await middleware(req);
      expect(res).toBeDefined();
      expect(consoleSpy).toHaveBeenCalledWith("[Rollease] Middleware evaluation failed:", expect.any(Error));

      consoleSpy.mockRestore();
    });
  });

  describe("Server Components Helpers", () => {
    it("should retrieve flags from request headers", async () => {
      mockHeadersVal = await createSignedFlagPayload(
        { "my-flag": "header-value" },
        TEST_SECRET
      );

      const res = await getFlag("my-flag", undefined, { secret: TEST_SECRET });
      expect(res.value).toBe("header-value");
      expect(res.enabled).toBe(true);

      const all = await getAllFlags({ secret: TEST_SECRET });
      expect(all).toEqual({ "my-flag": "header-value" });
    });

    it("should retrieve flags from request cookies if not in headers", async () => {
      mockHeadersVal = null;
      const envelope = await createSignedFlagPayload(
        { "my-flag": "cookie-value" },
        TEST_SECRET
      );
      mockCookiesVal = {
        value: encodeURIComponent(envelope),
      };

      const res = await getFlag("my-flag", undefined, { secret: TEST_SECRET });
      expect(res.value).toBe("cookie-value");

      const all = await getAllFlags({ secret: TEST_SECRET });
      expect(all).toEqual({ "my-flag": "cookie-value" });
    });

    it("should reject forged unsigned flag headers by default", async () => {
      mockHeadersVal = JSON.stringify({ "my-flag": true });

      const res = await getFlag("my-flag", false, { secret: TEST_SECRET });
      expect(res.value).toBe(false);

      const all = await getAllFlags({ secret: TEST_SECRET });
      expect(all).toEqual({});
    });

    it("should reject tampered signed flag headers", async () => {
      const envelope = await createSignedFlagPayload({ "my-flag": true }, TEST_SECRET);
      mockHeadersVal = envelope.replace(/\.[^.]+$/, ".tampered");

      const res = await getFlag("my-flag", false, { secret: TEST_SECRET });
      expect(res.value).toBe(false);
    });

    it("should allow unsigned JSON only when explicitly enabled", async () => {
      mockHeadersVal = JSON.stringify({ "my-flag": true });

      const res = await getFlag("my-flag", false, { allowUnsigned: true });
      expect(res.value).toBe(true);
    });

    it("should fallback to defaults when flags are missing", async () => {
      mockHeadersVal = null;
      mockCookiesVal = null;

      const res = await getFlag("missing-flag", "fallback-default", { secret: TEST_SECRET });
      expect(res.value).toBe("fallback-default");
      expect(res.enabled).toBe(false);

      const all = await getAllFlags({ secret: TEST_SECRET });
      expect(all).toEqual({});
    });

    it("should return null/empty object if next/headers throws (run outside Next.js server context)", async () => {
      throwHeadersError = true;

      const res = await getFlag("any-flag", "default", { secret: TEST_SECRET });
      expect(res.value).toBe("default");

      const all = await getAllFlags({ secret: TEST_SECRET });
      expect(all).toEqual({});
    });
  });
});
