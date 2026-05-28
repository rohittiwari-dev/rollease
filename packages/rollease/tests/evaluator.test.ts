import { describe, expect, it } from "vitest";
import { evaluateFlag } from "../src/engine/evaluator";
import type { Flag, FlagRule, Segment } from "../src/core/types";

describe("Flag Evaluation Engine", () => {
  const baseFlag: Flag = {
    id: "flag-1",
    key: "feature-test",
    type: "boolean",
    status: "active",
    defaultValue: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  describe("Step 1-4: Basic checks & Date Window", () => {
    it("should respect killed status (kill switch)", () => {
      const flag = { ...baseFlag, status: "killed" as const };
      const res = evaluateFlag(flag, {});
      expect(res.value).toBe(false);
      expect(res.reason).toBe("kill_switch");
    });

    it("should respect archived status (disabled)", () => {
      const flag = { ...baseFlag, status: "archived" as const, defaultValue: "fallback-val" };
      const res = evaluateFlag(flag, {});
      expect(res.value).toBe("fallback-val");
      expect(res.reason).toBe("disabled");
    });

    it("should evaluate scheduledAt in future (not scheduled yet)", () => {
      const flag = {
        ...baseFlag,
        scheduledAt: new Date(Date.now() + 10000).toISOString(),
      };
      const res = evaluateFlag(flag, {});
      expect(res.value).toBe(false);
      expect(res.reason).toBe("not_scheduled");
    });

    it("should evaluate expiresAt in past (expired)", () => {
      const flag = {
        ...baseFlag,
        expiresAt: new Date(Date.now() - 10000).toISOString(),
      };
      const res = evaluateFlag(flag, {});
      expect(res.value).toBe(false);
      expect(res.reason).toBe("expired");
    });
  });

  describe("Step 5: Local Override", () => {
    it("should resolve simple local override", () => {
      const res = evaluateFlag(baseFlag, {}, { localOverride: true });
      expect(res.value).toBe(true);
      expect(res.reason).toBe("override");
    });

    it("should resolve multivariate local override matching variant", () => {
      const flag: Flag = {
        ...baseFlag,
        type: "multivariate",
        variants: [
          { id: "v1", key: "treatment", value: "T1", weight: 100 },
        ],
      };
      const res = evaluateFlag(flag, {}, { localOverride: "treatment" });
      expect(res.value).toBe("T1");
      expect(res.variant).toBe("treatment");
      expect(res.reason).toBe("override");
    });

    it("should fallback to raw value for multivariate local override if no variant matches", () => {
      const flag: Flag = {
        ...baseFlag,
        type: "multivariate",
        variants: [
          { id: "v1", key: "treatment", value: "T1", weight: 100 },
        ],
      };
      const res = evaluateFlag(flag, {}, { localOverride: "unknown-variant" });
      expect(res.value).toBe("unknown-variant");
      expect(res.variant).toBeNull();
    });
  });

  describe("Step 6: Sticky User Assignment", () => {
    it("should resolve simple sticky assignment", () => {
      const res = evaluateFlag(baseFlag, {}, { userAssignment: "yes" });
      expect(res.value).toBe("yes");
      expect(res.reason).toBe("assignment");
    });

    it("should resolve multivariate sticky assignment matching variant", () => {
      const flag: Flag = {
        ...baseFlag,
        type: "multivariate",
        variants: [
          { id: "v1", key: "treatment", value: "T1", weight: 100 },
        ],
      };
      const res = evaluateFlag(flag, {}, { userAssignment: "treatment" });
      expect(res.value).toBe("T1");
      expect(res.variant).toBe("treatment");
      expect(res.reason).toBe("assignment");
    });
  });

  describe("Step 7: Targeting Rules and Operator Evaluation", () => {
    const makeRuleFlag = (conditions: any, ruleVal: any = true, isHoldout: boolean = false, variantId?: string): { flag: Flag; rules: FlagRule[] } => {
      const flag = { ...baseFlag };
      const rule: FlagRule = {
        id: "rule-123",
        flagKey: flag.key,
        priority: 1,
        value: ruleVal,
        enabled: true,
        conditions,
        isHoldout,
        variantId,
      };
      return { flag, rules: [rule] };
    };

    it("should skip disabled rules", () => {
      const { flag, rules } = makeRuleFlag({ all: [{ dimension: "userId", op: "eq", value: "alice" }] });
      rules[0].enabled = false;
      const res = evaluateFlag(flag, { userId: "alice" }, { rules });
      expect(res.reason).toBe("default");
    });

    it("should support rule sorting by priority", () => {
      const flag = { ...baseFlag };
      const rules: FlagRule[] = [
        {
          id: "high-priority",
          flagKey: flag.key,
          priority: 1,
          value: "high",
          enabled: true,
          conditions: { any: [{ dimension: "userId", op: "eq", value: "alice" }] },
        },
        {
          id: "low-priority",
          flagKey: flag.key,
          priority: 2,
          value: "low",
          enabled: true,
          conditions: { any: [{ dimension: "userId", op: "eq", value: "alice" }] },
        },
      ];
      const res = evaluateFlag(flag, { userId: "alice" }, { rules });
      expect(res.value).toBe("high");
    });

    it("should evaluate isHoldout rule as returning defaultValue", () => {
      const { flag, rules } = makeRuleFlag({ any: [{ dimension: "userId", op: "eq", value: "alice" }] }, "custom-value", true);
      const res = evaluateFlag(flag, { userId: "alice" }, { rules });
      expect(res.value).toBe(false); // defaultValue of baseFlag
      expect(res.reason).toBe("rule_match");
    });

    it("should evaluate multivariate rule matching variantId", () => {
      const flag: Flag = {
        ...baseFlag,
        type: "multivariate",
        variants: [{ id: "var-abc", key: "treatment", value: "T1", weight: 100 }],
      };
      const rule: FlagRule = {
        id: "rule-1",
        flagKey: flag.key,
        priority: 1,
        value: "should-not-return-this",
        enabled: true,
        conditions: { any: [{ dimension: "userId", op: "eq", value: "alice" }] },
        variantId: "var-abc",
      };
      const res = evaluateFlag(flag, { userId: "alice" }, { rules: [rule] });
      expect(res.value).toBe("T1");
      expect(res.variant).toBe("treatment");
    });

    it("should evaluate rules with rolloutPct", () => {
      const { flag, rules } = makeRuleFlag({ any: [{ dimension: "userId", op: "eq", value: "alice" }] });
      rules[0].rolloutPct = 0; // 0% rollout means user falls through
      const res = evaluateFlag(flag, { userId: "alice" }, { rules });
      expect(res.reason).toBe("default");

      rules[0].rolloutPct = 100; // 100% rollout matches
      const res2 = evaluateFlag(flag, { userId: "alice" }, { rules });
      expect(res2.reason).toBe("rule_match");
    });

    it("should resolve various dimensions: environment, userType, region, device, channel, unknown fallback", () => {
      const dimensions = ["environment", "userType", "region", "device", "channel", "custom_attr"];
      for (const dim of dimensions) {
        const { flag, rules } = makeRuleFlag({ any: [{ dimension: dim, op: "eq", value: "test-val" }] });
        const context = {
          userId: "123",
          environment: dim === "environment" ? "test-val" : undefined,
          userType: dim === "userType" ? "test-val" : undefined,
          region: dim === "region" ? "test-val" : undefined,
          attributes: {
            device: dim === "device" ? "test-val" : undefined,
            channel: dim === "channel" ? "test-val" : undefined,
            custom_attr: dim === "custom_attr" ? "test-val" : undefined,
          },
        };
        const res = evaluateFlag(flag, context, { rules });
        expect(res.value).toBe(true);
      }
    });

    it("should resolve special attribute leaf matching", () => {
      const { flag, rules } = makeRuleFlag({
        any: [
          {
            dimension: "attribute",
            op: "eq",
            value: { key: "role", match: "admin" },
          },
        ],
      });
      const res = evaluateFlag(flag, { attributes: { role: "admin" } }, { rules });
      expect(res.value).toBe(true);
    });

    it("should resolve special segment leaf matching", () => {
      const { flag, rules } = makeRuleFlag({
        any: [
          {
            dimension: "segment",
            op: "in",
            value: ["beta-testers"],
          },
        ],
      });
      const res = evaluateFlag(flag, { segments: ["beta-testers"] }, { rules });
      expect(res.value).toBe(true);
    });

    it("should evaluate operators: neq, nin, gt, gte, lt, lte, contains, startsWith, endsWith, regex, exists, dateAfter, dateBefore", () => {
      const ops = [
        { op: "neq", actual: "a", expected: "b", result: true },
        { op: "neq", actual: "a", expected: "a", result: false },
        { op: "neq", actual: undefined, expected: "a", result: true },
        { op: "in", actual: "a", expected: ["a", "b"], result: true },
        { op: "in", actual: ["a"], expected: ["a", "b"], result: true },
        { op: "in", actual: "c", expected: ["a", "b"], result: false },
        { op: "in", actual: "a", expected: "not-array", result: false },
        { op: "nin", actual: "c", expected: ["a", "b"], result: true },
        { op: "nin", actual: ["c"], expected: ["a", "b"], result: true },
        { op: "nin", actual: "a", expected: ["a", "b"], result: false },
        { op: "nin", actual: undefined, expected: ["a"], result: true },
        { op: "nin", actual: "a", expected: "not-array", result: true },
        { op: "gt", actual: 10, expected: 5, result: true },
        { op: "gt", actual: 5, expected: 10, result: false },
        { op: "gte", actual: 5, expected: 5, result: true },
        { op: "lt", actual: 3, expected: 5, result: true },
        { op: "lte", actual: 5, expected: 5, result: true },
        { op: "contains", actual: "hello world", expected: "world", result: true },
        { op: "contains", actual: "hello world", expected: "xyz", result: false },
        { op: "startsWith", actual: "hello", expected: "he", result: true },
        { op: "endsWith", actual: "hello", expected: "lo", result: true },
        { op: "regex", actual: "hello", expected: "^he.*o$", result: true },
        { op: "regex", actual: "hello", expected: "[invalid regex", result: false },
        { op: "exists", actual: "val", expected: true, result: true },
        { op: "exists", actual: undefined, expected: true, result: false },
        { op: "exists", actual: undefined, expected: false, result: true },
        { op: "exists", actual: "val", expected: false, result: false },
        { op: "dateAfter", actual: "2026-05-27", expected: "2026-05-26", result: true },
        { op: "dateAfter", actual: "invalid-date", expected: "2026-05-26", result: false },
        { op: "dateBefore", actual: "2026-05-25", expected: "2026-05-26", result: true },
        { op: "dateBefore", actual: "invalid-date", expected: "2026-05-26", result: false },
        { op: "unknown-op", actual: "a", expected: "b", result: false },
      ];

      for (const item of ops) {
        const { flag, rules } = makeRuleFlag({
          any: [{ dimension: "custom", op: item.op, value: item.expected }],
        });
        const res = evaluateFlag(flag, { attributes: { custom: item.actual } }, { rules });
        expect(res.value, `Failed for op: ${item.op} with actual: ${item.actual}, expected: ${item.expected}`).toBe(item.result);
      }
    });

    it("should reject unsafe regex patterns before execution", () => {
      const { flag, rules } = makeRuleFlag({
        any: [{ dimension: "custom", op: "regex", value: "(a+)+$" }],
      });

      const res = evaluateFlag(flag, { attributes: { custom: "aaaa" } }, { rules });
      expect(res.value).toBe(false);
      expect(res.reason).toBe("default");
    });

    it("should evaluate semverGte and semverLte including invalid semvers", () => {
      const cases = [
        { op: "semverGte", actual: "v2.3.0-beta", expected: "2.2.0", result: true },
        { op: "semverGte", actual: "1.0", expected: "1.0.0", result: true }, // padded
        { op: "semverGte", actual: "invalid-semver", expected: "1.0.0", result: false },
        { op: "semverGte", actual: "2.0.0", expected: "invalid-semver", result: false },
        { op: "semverLte", actual: "1.5.0", expected: "2.0.0", result: true },
      ];

      for (const item of cases) {
        const { flag, rules } = makeRuleFlag({
          any: [{ dimension: "version", op: item.op, value: item.expected }],
        });
        const res = evaluateFlag(flag, { version: item.actual }, { rules });
        expect(res.value, `Failed semver: ${item.op} actual: ${item.actual} expected: ${item.expected}`).toBe(item.result);
      }
    });

    it("should support condition groups nesting (all, any, none)", () => {
      // none with mismatch
      const { flag: flag1, rules: rules1 } = makeRuleFlag({
        none: [{ dimension: "userId", op: "eq", value: "bob" }],
      });
      expect(evaluateFlag(flag1, { userId: "alice" }, { rules: rules1 }).value).toBe(true);
      expect(evaluateFlag(flag1, { userId: "bob" }, { rules: rules1 }).value).toBe(false);

      // nested group inside all
      const { flag: flag2, rules: rules2 } = makeRuleFlag({
        all: [
          { dimension: "userId", op: "eq", value: "alice" },
          {
            any: [
              { dimension: "region", op: "eq", value: "us" },
              { dimension: "region", op: "eq", value: "eu" },
            ],
          },
        ],
      });
      expect(evaluateFlag(flag2, { userId: "alice", region: "us" }, { rules: rules2 }).value).toBe(true);
      expect(evaluateFlag(flag2, { userId: "alice", region: "apac" }, { rules: rules2 }).value).toBe(false);
    });
  });

  describe("Step 8-9: Percentage Rollout and Weighted Random", () => {
    it("should evaluate ramp schedule in rolloutConfig", () => {
      const flag: Flag = {
        ...baseFlag,
        rollout: {
          percentage: 10,
          sticky: true,
          hashKey: "userId",
          rampSchedule: [
            { at: "2026-05-27T00:00:00Z", percentage: 50 },
            { at: "2026-05-28T00:00:00Z", percentage: 100 },
          ],
        },
      };

      // Now is before ramp
      const res1 = evaluateFlag(flag, { userId: "user-999" }, { now: new Date("2026-05-26T00:00:00Z") });
      // should use base percentage (10%)
      expect(res1.reason).toBeDefined();

      // Now is in first ramp step
      const res2 = evaluateFlag(flag, { userId: "user-999" }, { now: new Date("2026-05-27T12:00:00Z") });
      expect(res2.reason).toBeDefined();

      // Now is after second ramp step
      const res3 = evaluateFlag(flag, { userId: "user-999" }, { now: new Date("2026-05-29T00:00:00Z") });
      // 100% rollout ensures true
      expect(res3.value).toBe(true);
      expect(res3.reason).toBe("percentage");
    });

    it("should evaluate multivariate rollout config distributing by weight", () => {
      const flag: Flag = {
        ...baseFlag,
        type: "multivariate",
        variants: [
          { id: "v1", key: "control", value: "A", weight: 30 },
          { id: "v2", key: "treatment", value: "B", weight: 70 },
        ],
        rollout: {
          percentage: 100,
          sticky: true,
          hashKey: "userId",
        },
      };

      const res = evaluateFlag(flag, { userId: "user-abc" });
      expect(["A", "B"]).toContain(res.value);
      expect(res.reason).toBe("weighted_random");
    });

    it("should evaluate multivariate flag without rollout using weighted random if variants exist", () => {
      const flag: Flag = {
        ...baseFlag,
        type: "multivariate",
        variants: [
          { id: "v1", key: "control", value: "A", weight: 50 },
          { id: "v2", key: "treatment", value: "B", weight: 50 },
        ],
      };
      const res = evaluateFlag(flag, { userId: "user-abc" });
      expect(["A", "B"]).toContain(res.value);
      expect(res.reason).toBe("weighted_random");
    });
  });

  describe("variantId safety", () => {
    it("warns and returns defaultValue when rule references a missing variantId", () => {
      const flag: Flag = {
        ...baseFlag,
        type: "multivariate",
        defaultValue: "safe-default",
        variants: [{ id: "v1", key: "treatment", value: "T1", weight: 100 }],
      };
      const rule: FlagRule = {
        id: "rule-1",
        flagKey: flag.key,
        priority: 1,
        value: "rule-value-should-not-be-used",
        enabled: true,
        conditions: { any: [{ dimension: "userId", op: "eq", value: "alice" }] },
        variantId: "v-deleted",
      };

      const warnings: string[] = [];
      const res = evaluateFlag(
        flag,
        { userId: "alice" },
        { rules: [rule], onWarning: (msg) => warnings.push(msg) }
      );

      expect(res.value).toBe("safe-default");
      expect(res.reason).toBe("rule_match");
      expect(res.ruleId).toBe("rule-1");
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/missing variantId/i);
    });
  });

  describe("multivariate single-path consolidation", () => {
    it("uses rollout.hashKey when set for variant distribution", () => {
      const flag: Flag = {
        ...baseFlag,
        type: "multivariate",
        variants: [
          { id: "v1", key: "control", value: "A", weight: 50 },
          { id: "v2", key: "treatment", value: "B", weight: 50 },
        ],
        rollout: {
          percentage: 100,
          sticky: true,
          hashKey: "tenantId",
        },
      };

      // Different userIds with the same tenantId must land in the same bucket
      // because hashKey is tenantId, not userId.
      const r1 = evaluateFlag(flag, { userId: "u-1", tenantId: "acme" });
      const r2 = evaluateFlag(flag, { userId: "u-2", tenantId: "acme" });
      expect(r1.value).toBe(r2.value);
      expect(r1.variant).toBe(r2.variant);
      expect(r1.reason).toBe("weighted_random");
    });
  });

  describe("Evaluation trace", () => {
    it("trace is absent when not requested", () => {
      const res = evaluateFlag(baseFlag, {});
      expect(res.trace).toBeUndefined();
    });

    it("trace is present and has steps when trace: true", () => {
      const res = evaluateFlag(baseFlag, {}, { trace: true });
      expect(res.trace).toBeDefined();
      expect(Array.isArray(res.trace!.steps)).toBe(true);
      expect(res.trace!.steps.length).toBeGreaterThan(0);
    });

    it("kill_switch: step 2 matched=true, only 1 step recorded", () => {
      const flag = { ...baseFlag, status: "killed" as const };
      const res = evaluateFlag(flag, {}, { trace: true });
      expect(res.reason).toBe("kill_switch");
      expect(res.trace!.steps).toHaveLength(1);
      expect(res.trace!.steps[0]).toMatchObject({ step: 2, name: "kill_switch", matched: true });
    });

    it("disabled: steps 2 (false) + 3 (true)", () => {
      const flag = { ...baseFlag, status: "archived" as const };
      const res = evaluateFlag(flag, {}, { trace: true });
      expect(res.reason).toBe("disabled");
      expect(res.trace!.steps[0]).toMatchObject({ step: 2, matched: false });
      expect(res.trace!.steps[1]).toMatchObject({ step: 3, name: "disabled", matched: true });
    });

    it("not_scheduled: step 4 matched=true with detail", () => {
      const flag = { ...baseFlag, scheduledAt: new Date(Date.now() + 10_000).toISOString() };
      const res = evaluateFlag(flag, {}, { trace: true });
      expect(res.reason).toBe("not_scheduled");
      const step4 = res.trace!.steps.find((s) => s.step === 4);
      expect(step4).toMatchObject({ matched: true, name: "date_window" });
      expect(step4!.detail).toMatch(/not_scheduled/);
    });

    it("local_override: step 7 matched=true with override detail", () => {
      const res = evaluateFlag(baseFlag, {}, { trace: true, localOverride: true });
      expect(res.reason).toBe("override");
      const step7 = res.trace!.steps.find((s) => s.name === "local_override");
      expect(step7).toMatchObject({ matched: true });
      expect(step7!.detail).toMatch(/override value/);
    });

    it("sticky_assignment: step 8 matched=true", () => {
      const res = evaluateFlag(baseFlag, {}, { trace: true, userAssignment: "treatment" });
      expect(res.reason).toBe("assignment");
      const step8 = res.trace!.steps.find((s) => s.name === "sticky_assignment");
      expect(step8).toMatchObject({ matched: true });
    });

    it("targeting_rules: step 9 matched=true records ruleId", () => {
      const rule: FlagRule = {
        id: "r1",
        flagKey: baseFlag.key,
        priority: 1,
        value: true,
        enabled: true,
        conditions: { any: [{ dimension: "userId", op: "eq", value: "alice" }] },
      };
      const res = evaluateFlag(baseFlag, { userId: "alice" }, { trace: true, rules: [rule] });
      expect(res.reason).toBe("rule_match");
      const step9 = res.trace!.steps.find((s) => s.name === "targeting_rules");
      expect(step9).toMatchObject({ matched: true });
      expect(res.trace!.matchedRuleId).toBe("r1");
    });

    it("targeting_rules: no match, step 9 matched=false with checked count in detail", () => {
      const rule: FlagRule = {
        id: "r-miss",
        flagKey: baseFlag.key,
        priority: 1,
        value: true,
        enabled: true,
        conditions: { any: [{ dimension: "userId", op: "eq", value: "bob" }] },
      };
      const res = evaluateFlag(baseFlag, { userId: "alice" }, { trace: true, rules: [rule] });
      const step9 = res.trace!.steps.find((s) => s.name === "targeting_rules");
      expect(step9).toMatchObject({ matched: false });
      expect(step9!.detail).toMatch(/1 rule/);
    });

    it("percentage rollout: step 10 matched=true with bucket detail", () => {
      // 100% rollout guarantees entry
      const flag: Flag = {
        ...baseFlag,
        rollout: { percentage: 100, sticky: true, hashKey: "userId" },
      };
      const res = evaluateFlag(flag, { userId: "user-abc" }, { trace: true });
      expect(res.reason).toBe("percentage");
      const step10 = res.trace!.steps.find((s) => s.step === 10);
      expect(step10).toMatchObject({ matched: true, name: "rollout" });
    });

    it("default: all steps pass through, last step matched=true", () => {
      const res = evaluateFlag(baseFlag, { userId: "nobody" }, { trace: true });
      expect(res.reason).toBe("default");
      const lastStep = res.trace!.steps[res.trace!.steps.length - 1];
      expect(lastStep).toMatchObject({ matched: true, name: "default" });
      // Verify all prior steps were not matched (they were bypassed)
      const priorSteps = res.trace!.steps.slice(0, -1);
      expect(priorSteps.every((s) => !s.matched)).toBe(true);
    });

    it("trace includes matchedVariantId for rule_match with variant", () => {
      const flag: Flag = {
        ...baseFlag,
        type: "multivariate",
        variants: [{ id: "v1", key: "treatment", value: "T", weight: 100 }],
      };
      const rule: FlagRule = {
        id: "r-variant",
        flagKey: flag.key,
        priority: 1,
        value: "T",
        enabled: true,
        conditions: { any: [{ dimension: "userId", op: "eq", value: "alice" }] },
        variantId: "v1",
      };
      const res = evaluateFlag(flag, { userId: "alice" }, { trace: true, rules: [rule] });
      expect(res.reason).toBe("rule_match");
      expect(res.trace!.matchedVariantId).toBe("treatment");
      expect(res.trace!.matchedRuleId).toBe("r-variant");
    });

    it("weighted_random: step 10 matched=true, matchedVariantId set", () => {
      const flag: Flag = {
        ...baseFlag,
        type: "multivariate",
        variants: [
          { id: "v1", key: "control", value: "A", weight: 100 },
        ],
      };
      const res = evaluateFlag(flag, { userId: "u-test" }, { trace: true });
      expect(res.reason).toBe("weighted_random");
      expect(res.trace!.matchedVariantId).toBe("control");
      const step10 = res.trace!.steps.find((s) => s.step === 10);
      expect(step10).toMatchObject({ matched: true, name: "rollout" });
    });
  });
});
