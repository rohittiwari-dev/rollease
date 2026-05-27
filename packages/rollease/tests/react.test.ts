// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderHook, render } from "@testing-library/react";
import {
  RolleaseProvider,
  useFlag,
  useVariant,
  useFlags,
  useFlagDetails,
  useRollease,
  FeatureGate,
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

    it("should return correct flag status via useFlag", () => {
      const { result } = renderHook(() => useFlag("booleanFlag"), { wrapper });
      expect(result.current.enabled).toBe(true);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();

      const { result: missingRes } = renderHook(() => useFlag("missing"), { wrapper });
      expect(missingRes.current.enabled).toBe(false);
    });

    it("should return correct variant via useVariant", () => {
      // Detailed flag with variant
      const { result: detailedRes } = renderHook(() => useVariant("detailedFlag"), { wrapper });
      expect(detailedRes.current.variant?.key).toBe("treatment");
      expect(detailedRes.current.variant?.value).toBe("v1-value");
      expect(detailedRes.current.variant?.reason).toBe("rule_match");

      // Plain flag (fallback to key: 'default')
      const { result: plainRes } = renderHook(() => useVariant("plainStringFlag"), { wrapper });
      expect(plainRes.current.variant?.key).toBe("default");
      expect(plainRes.current.variant?.value).toBe("hello-world");

      // Missing flag
      const { result: missingRes } = renderHook(() => useVariant("missing"), { wrapper });
      expect(missingRes.current.variant).toBeNull();
    });

    it("should return flags map via useFlags", () => {
      const { result } = renderHook(() => useFlags(), { wrapper });
      expect(result.current.booleanFlag).toBe(true);
      expect(result.current.plainStringFlag).toBe("hello-world");
    });

    it("should return details via useFlagDetails", () => {
      const { result: detailedRes } = renderHook(() => useFlagDetails("detailedFlag"), { wrapper });
      expect(detailedRes.current.ruleId).toBe("r-1");

      const { result: missingRes } = renderHook(() => useFlagDetails("missing"), { wrapper });
      expect(missingRes.current.value).toBeUndefined();
      expect(missingRes.current.reason).toBe("default");
    });
  });

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
});
