import { describe, expect, it } from "vitest";
import {
  isSafeFlagKey,
  assertSafeFlagKey,
  assertSafeConditionGroup,
  findUnsafeConditionIssue,
  conditionReferencesSegment,
  walkConditions,
  validateOverridePath,
  FORBIDDEN_KEYS,
} from "../src/core/security";
import { FlagManager } from "../src/engine/manager";
import { MemoryDbAdapter } from "../src/db/memory";
import { ValidationError } from "../src/core/errors";

describe("Security helpers", () => {
  describe("flag key validation", () => {
    it("rejects prototype-pollution keys", () => {
      for (const key of FORBIDDEN_KEYS) {
        expect(isSafeFlagKey(key)).toBe(false);
        expect(() => assertSafeFlagKey(key)).toThrow(ValidationError);
      }
    });

    it("rejects uppercase, spaces, and empty keys", () => {
      expect(isSafeFlagKey("")).toBe(false);
      expect(isSafeFlagKey("UPPERCASE")).toBe(false);
      expect(isSafeFlagKey("has space")).toBe(false);
      expect(isSafeFlagKey(null)).toBe(false);
      expect(isSafeFlagKey(undefined)).toBe(false);
      expect(isSafeFlagKey(123 as unknown)).toBe(false);
    });

    it("accepts safe keys", () => {
      expect(isSafeFlagKey("new_checkout")).toBe(true);
      expect(isSafeFlagKey("billing.v2")).toBe(true);
      expect(isSafeFlagKey("exp.pricing-a-b")).toBe(true);
      expect(isSafeFlagKey("a")).toBe(true);
    });

    it("FlagManager.create rejects __proto__ as a flag key", async () => {
      const manager = new FlagManager({ db: new MemoryDbAdapter() });
      await expect(
        manager.create({ key: "__proto__", type: "boolean", defaultValue: false })
      ).rejects.toThrow(ValidationError);
    });

    it("FlagManager.createSegment rejects prototype-pollution keys", async () => {
      const manager = new FlagManager({ db: new MemoryDbAdapter() });
      await expect(
        manager.createSegment({ key: "constructor", rules: {} })
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("conditionReferencesSegment (replaces JSON.stringify.includes)", () => {
    it("matches only segment-dimension leaves, not arbitrary string occurrences", () => {
      // The segment we're searching for is literally named "user".
      // The rule references the string "user" as a userType value — NOT as a
      // segment dimension. The old JSON.stringify check would false-positive.
      const usageInUserType = conditionReferencesSegment(
        {
          any: [{ dimension: "userType", op: "eq", value: "user" }],
        },
        "user"
      );
      expect(usageInUserType).toBe(false);

      // The same key as a real segment leaf must match.
      const usageInSegment = conditionReferencesSegment(
        {
          any: [{ dimension: "segment", op: "in", value: "user" }],
        },
        "user"
      );
      expect(usageInSegment).toBe(true);
    });

    it("matches segment-in-array values", () => {
      expect(
        conditionReferencesSegment(
          { any: [{ dimension: "segment", op: "in", value: ["a", "b", "c"] }] },
          "b"
        )
      ).toBe(true);

      expect(
        conditionReferencesSegment(
          { any: [{ dimension: "segment", op: "in", value: ["x"] }] },
          "b"
        )
      ).toBe(false);
    });

    it("descends into nested condition groups", () => {
      expect(
        conditionReferencesSegment(
          {
            all: [
              { dimension: "userType", op: "eq", value: "enterprise" },
              {
                any: [{ dimension: "segment", op: "in", value: "power_users" }],
              },
            ],
          },
          "power_users"
        )
      ).toBe(true);
    });

    it("handles missing/empty groups", () => {
      expect(conditionReferencesSegment(undefined, "x")).toBe(false);
      expect(conditionReferencesSegment({}, "x")).toBe(false);
      expect(conditionReferencesSegment({ all: [] }, "x")).toBe(false);
    });
  });

  describe("walkConditions generic", () => {
    it("visits every leaf and short-circuits on true", () => {
      const seen: string[] = [];
      const stopped = walkConditions(
        {
          all: [
            { dimension: "a", op: "eq", value: 1 },
            {
              any: [
                { dimension: "b", op: "eq", value: 2 },
                { dimension: "STOP", op: "eq", value: 3 },
                { dimension: "c", op: "eq", value: 4 },
              ],
            },
          ],
        },
        (leaf) => {
          seen.push(String(leaf.dimension));
          return leaf.dimension === "STOP";
        }
      );
      expect(stopped).toBe(true);
      expect(seen).toEqual(["a", "b", "STOP"]);
    });

    it("returns false for non-group input", () => {
      expect(walkConditions(null as never, () => true)).toBe(false);
      expect(walkConditions("string" as never, () => true)).toBe(false);
    });
  });

  describe("findUnsafeConditionIssue edge cases", () => {
    it("rejects when a child is neither a leaf nor a group (primitive in array)", () => {
      const issue = findUnsafeConditionIssue(
        // @ts-expect-error — intentionally malformed: string in all array
        { all: ["not-a-leaf-or-group"] },
        "conditions"
      );
      expect(issue).toMatch(/must be a condition leaf or group/);
    });

    it("rejects when all/any/none is not an array", () => {
      const issue = findUnsafeConditionIssue(
        // @ts-expect-error — intentionally malformed: string instead of array
        { all: "not-an-array" },
        "conditions"
      );
      expect(issue).toMatch(/must be an array/);
    });

    it("rejects when condition count exceeds MAX_CONDITION_NODES (100)", () => {
      // MAX_CONDITION_NODES counts group calls, not leaves. Build a branching
      // tree: depth=2 with 10 branches each → 1 + 10 + 100 = 111 groups.
      type Group = { any?: unknown[]; all?: unknown[] };
      function makeGroup(depth: number): Group {
        if (depth === 0) {
          return { all: [{ dimension: "userId", op: "eq", value: "u" }] };
        }
        return { any: Array.from({ length: 10 }, () => makeGroup(depth - 1)) };
      }
      const issue = findUnsafeConditionIssue(makeGroup(2) as never, "conditions");
      expect(typeof issue).toBe("string");
      expect(issue).toMatch(/exceeds maximum condition count/);
    });

    it("returns null and does not throw for a valid condition group", () => {
      const issue = findUnsafeConditionIssue(
        { all: [{ dimension: "userId", op: "eq", value: "u1" }] },
        "conditions"
      );
      expect(issue).toBeNull();
      expect(() =>
        assertSafeConditionGroup(
          { any: [{ dimension: "region", op: "eq", value: "us" }] }
        )
      ).not.toThrow();
    });
  });

  describe("validateOverridePath (path-traversal)", () => {
    it("rejects paths that escape cwd", () => {
      expect(() =>
        validateOverridePath("../../../etc/passwd", "/home/user/proj")
      ).toThrow(ValidationError);
    });

    it("rejects absolute paths outside cwd", () => {
      expect(() => validateOverridePath("/etc/passwd", "/home/user/proj")).toThrow(
        ValidationError
      );
    });

    it("accepts paths inside cwd", () => {
      expect(() =>
        validateOverridePath(".rolleaserc.json", "/home/user/proj")
      ).not.toThrow();
      expect(() =>
        validateOverridePath("config/overrides.json", "/home/user/proj")
      ).not.toThrow();
    });

    it("rejects empty input", () => {
      expect(() => validateOverridePath("", "/home/user/proj")).toThrow(
        ValidationError
      );
    });
  });
});
