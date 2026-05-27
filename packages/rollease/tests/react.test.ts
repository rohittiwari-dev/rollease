// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderHook, render, act, waitFor } from "@testing-library/react";
import {
  RolleaseProvider,
  useFlag,
  useVariant,
  useFlags,
  useFlagDetails,
  useFlagValue,
  useWatchFlag,
  useFlagSet,
  useRollease,
  FeatureGate,
  FeatureRequire,
} from "../src/frameworks/react";

describe("React Integration (Hooks & Components)", () => {
  describe("Context Error Check", () => {
    it("should throw error when hook is called outside provider", () => {
      // Prevent console.error clutter in test output
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => renderHook(() => useFlag("test"))).toThrow(
        "Rollease hooks must be used within a <RolleaseProvider>"
      );
      consoleSpy.mockRestore();
    });
  });

  describe("Hooks inside Provider context", () => {
    const initialFlags = {
      booleanFlag: true,
      plainStringFlag: "hello-world",
      numberFlag: 42,
      disabledFlag: false,
      detailedFlag: {
        key: "detailedFlag",
        value: "v1-value",
        enabled: true,
        variant: "treatment",
        reason: "rule_match" as any,
        ruleId: "r-1",
        evaluatedAt: new Date(),
      },
    };

    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(RolleaseProvider, { initialFlags, children });

    const wrapperEmpty = ({ children }: { children: React.ReactNode }) =>
      React.createElement(RolleaseProvider, { children });

    it("should process initialFlags correctly with mixed values", () => {
      const { result } = renderHook(() => useRollease(), { wrapper });
      expect(result.current.flags.booleanFlag).toBe(true);
      expect(result.current.flags.plainStringFlag).toBe("hello-world");
      expect(result.current.flags.detailedFlag).toBe("v1-value");

      expect(result.current.flagDetails.detailedFlag.ruleId).toBe("r-1");
      expect(result.current.flagDetails.booleanFlag.enabled).toBe(true);
      expect(result.current.flagDetails.booleanFlag.reason).toBe("default");
    });

    it("should initialize with empty flags if initialFlags is missing", () => {
      const { result } = renderHook(() => useRollease(), { wrapper: wrapperEmpty });
      expect(result.current.flags).toEqual({});
      expect(result.current.flagDetails).toEqual({});
    });

    // ── useFlag ──────────────────────────────────────────────────────────

    it("useFlag returns correct enabled + lifecycle states", () => {
      const { result } = renderHook(() => useFlag("booleanFlag"), { wrapper });
      expect(result.current.enabled).toBe(true);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isRefetching).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.lastUpdatedAt).toBeInstanceOf(Date);
      expect(typeof result.current.refetch).toBe("function");
      expect(typeof result.current.invalidate).toBe("function");

      const { result: missingRes } = renderHook(() => useFlag("missing"), { wrapper });
      expect(missingRes.current.enabled).toBe(false);
    });

    // ── useVariant ───────────────────────────────────────────────────────

    it("useVariant returns variant with lifecycle states", () => {
      const { result: detailedRes } = renderHook(() => useVariant("detailedFlag"), { wrapper });
      expect(detailedRes.current.variant?.key).toBe("treatment");
      expect(detailedRes.current.variant?.value).toBe("v1-value");
      expect(detailedRes.current.variant?.reason).toBe("rule_match");
      expect(detailedRes.current.isLoading).toBe(false);
      expect(typeof detailedRes.current.refetch).toBe("function");

      // Plain flag (fallback to key: 'default')
      const { result: plainRes } = renderHook(() => useVariant("plainStringFlag"), { wrapper });
      expect(plainRes.current.variant?.key).toBe("default");
      expect(plainRes.current.variant?.value).toBe("hello-world");

      // Missing flag
      const { result: missingRes } = renderHook(() => useVariant("missing"), { wrapper });
      expect(missingRes.current.variant).toBeNull();
    });

    // ── useFlags ─────────────────────────────────────────────────────────

    it("useFlags returns flags map with lifecycle states", () => {
      const { result } = renderHook(() => useFlags(), { wrapper });
      expect(result.current.flags.booleanFlag).toBe(true);
      expect(result.current.flags.plainStringFlag).toBe("hello-world");
      expect(result.current.isLoading).toBe(false);
      expect(typeof result.current.refetch).toBe("function");
    });

    // ── useFlagDetails ───────────────────────────────────────────────────

    it("useFlagDetails returns details with lifecycle states", () => {
      const { result: detailedRes } = renderHook(() => useFlagDetails("detailedFlag"), { wrapper });
      expect(detailedRes.current.details.ruleId).toBe("r-1");
      expect(detailedRes.current.isLoading).toBe(false);
      expect(typeof detailedRes.current.refetch).toBe("function");

      const { result: missingRes } = renderHook(() => useFlagDetails("missing"), { wrapper });
      expect(missingRes.current.details.value).toBeUndefined();
      expect(missingRes.current.details.reason).toBe("default");
    });

    // ── useFlagValue ─────────────────────────────────────────────────────

    it("useFlagValue returns typed value with fallback default", () => {
      const { result: numResult } = renderHook(() => useFlagValue<number>("numberFlag", 0), { wrapper });
      expect(numResult.current).toBe(42);

      const { result: missingResult } = renderHook(() => useFlagValue<string>("missing_key", "fallback"), { wrapper });
      expect(missingResult.current).toBe("fallback");

      const { result: boolResult } = renderHook(() => useFlagValue<boolean>("booleanFlag", false), { wrapper });
      expect(boolResult.current).toBe(true);
    });

    // ── useWatchFlag ─────────────────────────────────────────────────────

    it("useWatchFlag returns memoized flag snapshot", () => {
      const { result } = renderHook(() => useWatchFlag("detailedFlag"), { wrapper });
      expect(result.current.enabled).toBe(true);
      expect(result.current.value).toBe("v1-value");
      expect(result.current.variant).toBe("treatment");
      expect(result.current.reason).toBe("rule_match");
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();

      const { result: missingRes } = renderHook(() => useWatchFlag("missing"), { wrapper });
      expect(missingRes.current.enabled).toBe(false);
      expect(missingRes.current.value).toBeUndefined();
    });

    // ── useFlagSet ───────────────────────────────────────────────────────

    it("useFlagSet returns enabled status for multiple flags", () => {
      const { result } = renderHook(
        () => useFlagSet(["booleanFlag", "disabledFlag", "missing"]),
        { wrapper }
      );
      expect(result.current.features).toEqual({
        booleanFlag: true,
        disabledFlag: false,
        missing: false,
      });
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    // ── useRollease ──────────────────────────────────────────────────────

    it("useRollease returns full context with control functions", () => {
      const { result } = renderHook(() => useRollease(), { wrapper });
      expect(result.current.flags).toBeDefined();
      expect(result.current.flagDetails).toBeDefined();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isRefetching).toBe(false);
      expect(result.current.error).toBeNull();
      expect(typeof result.current.refetch).toBe("function");
      expect(typeof result.current.invalidate).toBe("function");
      expect(result.current.lastUpdatedAt).toBeInstanceOf(Date);
    });
  });

  // ── Loading State ────────────────────────────────────────────────────────

  describe("Loading State (client-side fetch)", () => {
    it("isLoading is true when flagsUrl is set without initialFlags", () => {
      // Mock fetch to hang (never resolves)
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(() => new Promise(() => {})) as any;

      const asyncWrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(RolleaseProvider, {
          flagsUrl: "/api/flags",
          refreshInterval: 0,
          children,
        });

      const { result } = renderHook(() => useFlag("any"), { wrapper: asyncWrapper });
      expect(result.current.isLoading).toBe(true);
      expect(result.current.enabled).toBe(false);

      globalThis.fetch = originalFetch;
    });

    it("isLoading is false when initialFlags are provided alongside flagsUrl", () => {
      const hybridWrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(RolleaseProvider, {
          initialFlags: { test: true },
          flagsUrl: "/api/flags",
          refreshInterval: 0,
          children,
        });

      const { result } = renderHook(() => useFlag("test"), { wrapper: hybridWrapper });
      expect(result.current.isLoading).toBe(false);
      expect(result.current.enabled).toBe(true);
    });
  });

  // ── Error Handling ───────────────────────────────────────────────────────

  describe("Error Handling", () => {
    it("error is populated when fetch fails", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
        })
      ) as any;

      const errorWrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(RolleaseProvider, {
          flagsUrl: "/api/flags",
          refreshInterval: 0,
          children,
        });

      const { result } = renderHook(() => useFlag("any"), { wrapper: errorWrapper });

      await waitFor(() => {
        expect(result.current.error).not.toBeNull();
      });

      expect(result.current.error?.message).toContain("500");
      expect(result.current.isLoading).toBe(false);

      globalThis.fetch = originalFetch;
    });
  });

  // ── FeatureGate Component ────────────────────────────────────────────────

  describe("FeatureGate Component", () => {
    const initialFlags = {
      activeFlag: true,
      disabledFlag: false,
    };

    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(RolleaseProvider, { initialFlags, children });

    it("should render children if flag is enabled", () => {
      const { container } = render(
        React.createElement(
          FeatureGate,
          { flag: "activeFlag", fallback: "fallback-content" },
          "children-content"
        ),
        { wrapper }
      );
      expect(container.textContent).toBe("children-content");
    });

    it("should render fallback if flag is disabled", () => {
      const { container } = render(
        React.createElement(
          FeatureGate,
          { flag: "disabledFlag", fallback: "fallback-content" },
          "children-content"
        ),
        { wrapper }
      );
      expect(container.textContent).toBe("fallback-content");
    });

    it("should render null if flag is disabled and no fallback", () => {
      const { container } = render(
        React.createElement(
          FeatureGate,
          { flag: "disabledFlag" },
          "children-content"
        ),
        { wrapper }
      );
      expect(container.textContent).toBe("");
    });
  });

  // ── FeatureRequire Component ─────────────────────────────────────────────

  describe("FeatureRequire Component", () => {
    const initialFlags = {
      flagA: true,
      flagB: true,
      flagC: false,
    };

    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(RolleaseProvider, { initialFlags, children });

    it("renders children when all flags are enabled", () => {
      const { container } = render(
        React.createElement(
          FeatureRequire,
          { flags: ["flagA", "flagB"] },
          "all-enabled"
        ),
        { wrapper }
      );
      expect(container.textContent).toBe("all-enabled");
    });

    it("renders fallback when any flag is disabled", () => {
      const { container } = render(
        React.createElement(
          FeatureRequire,
          { flags: ["flagA", "flagC"], fallback: "not-ready" },
          "all-enabled"
        ),
        { wrapper }
      );
      expect(container.textContent).toBe("not-ready");
    });

    it("renders null when any flag is disabled and no fallback", () => {
      const { container } = render(
        React.createElement(
          FeatureRequire,
          { flags: ["flagA", "flagC"] },
          "all-enabled"
        ),
        { wrapper }
      );
      expect(container.textContent).toBe("");
    });
  });
});
