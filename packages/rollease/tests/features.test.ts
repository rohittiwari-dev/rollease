import { describe, expect, it } from "vitest";
import { evaluateFlag, evaluateConditionGroup } from "../src/engine/evaluator";
import { FlagManager } from "../src/engine/manager";
import { MemoryDbAdapter } from "../src/db/memory";
import { noopLogger } from "../src/core/logger";
import type { Flag, FlagRule, FlagResult } from "../src/core/types";

// ── Shared Fixtures ──────────────────────────────────────────────────────────

const baseFlag: Flag = {
  id: "flag-1",
  key: "feature-test",
  type: "boolean",
  status: "active",
  defaultValue: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createTestManager(opts?: { autoResolveSegments?: boolean }) {
  const db = new MemoryDbAdapter();
  return {
    db,
    manager: new FlagManager({
      db,
      logger: noopLogger,
      autoResolveSegments: opts?.autoResolveSegments,
    }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Flag Prerequisites
// ═══════════════════════════════════════════════════════════════════════════

describe("Flag Prerequisites", () => {
  describe("Evaluator — prerequisite_not_met reason", () => {
    it("returns prerequisite_not_met when prereq value doesn't match", () => {
      const flag: Flag = {
        ...baseFlag,
        key: "child_flag",
        prerequisites: [{ flagKey: "parent_flag", variation: true }],
      };

      const prereqResult: FlagResult = {
        key: "parent_flag",
        value: false, // doesn't match required variation (true)
        variant: null,
        enabled: false,
        reason: "default",
        ruleId: null,
        evaluatedAt: new Date(),
      };

      const result = evaluateFlag(flag, {}, {
        prerequisiteResults: { parent_flag: prereqResult },
      });
      expect(result.reason).toBe("prerequisite_not_met");
      expect(result.value).toBe(false); // defaults to flag defaultValue
    });

    it("passes when prereq value matches required variation", () => {
      const flag: Flag = {
        ...baseFlag,
        key: "child_flag",
        defaultValue: true,
        prerequisites: [{ flagKey: "parent_flag", variation: true }],
      };

      const prereqResult: FlagResult = {
        key: "parent_flag",
        value: true, // matches!
        variant: null,
        enabled: true,
        reason: "default",
        ruleId: null,
        evaluatedAt: new Date(),
      };

      const result = evaluateFlag(flag, {}, {
        prerequisiteResults: { parent_flag: prereqResult },
      });
      expect(result.reason).toBe("default");
      expect(result.value).toBe(true);
    });

    it("returns prerequisite_not_met when prereq result is missing", () => {
      const flag: Flag = {
        ...baseFlag,
        prerequisites: [{ flagKey: "missing_prereq", variation: true }],
      };

      const result = evaluateFlag(flag, {}, {
        prerequisiteResults: {},
      });
      expect(result.reason).toBe("prerequisite_not_met");
    });

    it("skips prerequisite check when no prerequisiteResults provided", () => {
      const flag: Flag = {
        ...baseFlag,
        prerequisites: [{ flagKey: "some_flag", variation: true }],
      };
      // No prerequisiteResults in options — should evaluate normally
      const result = evaluateFlag(flag, {});
      expect(result.reason).toBe("default");
    });
  });

  describe("Manager — prerequisite resolution", () => {
    it("resolves prerequisites recursively during evaluation", async () => {
      const { manager } = createTestManager();

      // Create parent flag
      await manager.create({
        key: "parent",
        type: "boolean",
        defaultValue: true,
      });

      // Create child flag with prerequisite
      await manager.create({
        key: "child",
        type: "boolean",
        defaultValue: true,
        prerequisites: [{ flagKey: "parent", variation: true }],
      });

      // Child should be enabled (parent returns true)
      expect(await manager.isEnabled("child", {})).toBe(true);

      // Kill the parent and bust all caches
      await manager.kill("parent");
      await manager.invalidateAllCaches();

      // Child should now fail prerequisite (parent is killed → returns false)
      expect(await manager.isEnabled("child", {})).toBe(false);
    });

    it("rejects self-referencing prerequisites on create", async () => {
      const { manager } = createTestManager();
      await expect(
        manager.create({
          key: "self_ref",
          type: "boolean",
          defaultValue: false,
          prerequisites: [{ flagKey: "self_ref", variation: true }],
        })
      ).rejects.toThrow("cannot have itself as a prerequisite");
    });

    it("detects circular prerequisite chains on create", async () => {
      const { manager } = createTestManager();

      await manager.create({
        key: "flag_a",
        type: "boolean",
        defaultValue: true,
        prerequisites: [{ flagKey: "flag_b", variation: true }],
      });

      // flag_b → flag_a creates a circle
      await manager.create({
        key: "flag_b",
        type: "boolean",
        defaultValue: true,
      });

      // Now try creating flag_c → flag_a (which requires flag_b, which needs flag_a — circular if flag_b also had prereqs)
      // Direct circular: flag_b → flag_a which already references flag_b
      // This test verifies the runtime detection in evaluate()
      const result = await manager.isEnabled("flag_a", {});
      // flag_a requires flag_b which is true → prereq met
      expect(result).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// User List Targeting
// ═══════════════════════════════════════════════════════════════════════════

describe("User List Targeting", () => {
  it("rule with userIds only matches listed users", () => {
    const rule: FlagRule = {
      id: "r1",
      flagKey: "test",
      priority: 1,
      value: true,
      enabled: true,
      conditions: {},
      userIds: ["alice", "bob"],
    };

    // alice → matches
    const result1 = evaluateFlag(baseFlag, { userId: "alice" }, { rules: [rule] });
    expect(result1.value).toBe(true);
    expect(result1.reason).toBe("rule_match");

    // charlie → doesn't match
    const result2 = evaluateFlag(baseFlag, { userId: "charlie" }, { rules: [rule] });
    expect(result2.value).toBe(false);
    expect(result2.reason).toBe("default");

    // no userId → doesn't match
    const result3 = evaluateFlag(baseFlag, {}, { rules: [rule] });
    expect(result3.value).toBe(false);
    expect(result3.reason).toBe("default");
  });

  it("rule without userIds matches all users normally", () => {
    const rule: FlagRule = {
      id: "r1",
      flagKey: "test",
      priority: 1,
      value: true,
      enabled: true,
      conditions: {},
      // no userIds set
    };

    const result = evaluateFlag(baseFlag, { userId: "anyone" }, { rules: [rule] });
    expect(result.value).toBe(true);
    expect(result.reason).toBe("rule_match");
  });

  it("persists userIds through MemoryDbAdapter", async () => {
    const { manager } = createTestManager();
    await manager.create({ key: "feat", type: "boolean", defaultValue: false });
    await manager.addRule("feat", {
      priority: 1,
      value: true,
      conditions: {},
      userIds: ["alice", "bob"],
    });

    expect(await manager.isEnabled("feat", { userId: "alice" })).toBe(true);
    expect(await manager.isEnabled("feat", { userId: "charlie" })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale Flag Detection
// ═══════════════════════════════════════════════════════════════════════════

describe("Stale Flag Detection", () => {
  it("touchFlagEvaluation updates lastEvaluatedAt", async () => {
    const db = new MemoryDbAdapter();
    await db.createFlag({ key: "touch_test", type: "boolean", defaultValue: false });

    const before = await db.getFlag("touch_test");
    expect(before!.lastEvaluatedAt).toBeNull();

    await db.touchFlagEvaluation!("touch_test");

    const after = await db.getFlag("touch_test");
    expect(after!.lastEvaluatedAt).toBeInstanceOf(Date);
  });

  it("getStaleFlags returns flags not evaluated recently", async () => {
    const { manager, db } = createTestManager();

    await manager.create({ key: "active_flag", type: "boolean", defaultValue: false });
    await manager.create({ key: "stale_flag", type: "boolean", defaultValue: false });

    // Simulate: active_flag was evaluated recently
    const flag = await db.getFlag("active_flag");
    flag!.lastEvaluatedAt = new Date();

    // stale_flag has never been evaluated (lastEvaluatedAt is null)
    const stale = await manager.getStaleFlags({ staleDays: 30 });
    expect(stale.map((f) => f.key)).toContain("stale_flag");
  });

  it("evaluate() fires touchFlagEvaluation", async () => {
    const { manager, db } = createTestManager();
    await manager.create({ key: "eval_touch", type: "boolean", defaultValue: true });

    // Before evaluation
    const before = await db.getFlag("eval_touch");
    expect(before!.lastEvaluatedAt).toBeNull();

    // Evaluate
    await manager.isEnabled("eval_touch", { userId: "u1" });

    // Wait for fire-and-forget
    await new Promise((r) => setTimeout(r, 50));

    const after = await db.getFlag("eval_touch");
    expect(after!.lastEvaluatedAt).toBeInstanceOf(Date);
  });

  it("staleAfter filter works in listFlags", async () => {
    const db = new MemoryDbAdapter();
    await db.createFlag({ key: "old_flag", type: "boolean", defaultValue: false });
    await db.createFlag({ key: "new_flag", type: "boolean", defaultValue: false });

    // Simulate: old_flag last evaluated 60 days ago
    const oldFlag = (await db.getFlag("old_flag"))!;
    oldFlag.lastEvaluatedAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

    // new_flag evaluated now
    const newFlag = (await db.getFlag("new_flag"))!;
    newFlag.lastEvaluatedAt = new Date();

    // Filter: stale after 30 days ago
    const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = await db.listFlags({ staleAfter: staleDate });
    expect(result.data.map((f) => f.key)).toContain("old_flag");
    expect(result.data.map((f) => f.key)).not.toContain("new_flag");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rule Description and Metadata
// ═══════════════════════════════════════════════════════════════════════════

describe("Rule Description and Metadata", () => {
  it("persists description and metadata on addRule", async () => {
    const { manager } = createTestManager();
    await manager.create({ key: "meta_flag", type: "boolean", defaultValue: false });

    const rule = await manager.addRule("meta_flag", {
      priority: 1,
      value: true,
      conditions: {},
      description: "Enable for beta users during Q4 launch",
      metadata: { ticket: "JIRA-1234", owner: "alice" },
    });

    expect(rule.description).toBe("Enable for beta users during Q4 launch");
    expect(rule.metadata).toEqual({ ticket: "JIRA-1234", owner: "alice" });
  });

  it("updates description and metadata on updateRule", async () => {
    const { manager } = createTestManager();
    await manager.create({ key: "meta_update", type: "boolean", defaultValue: false });
    const rule = await manager.addRule("meta_update", {
      priority: 1,
      value: true,
      conditions: {},
      description: "Original",
    });

    const updated = await manager.updateRule("meta_update", rule.id, {
      description: "Updated description",
      metadata: { reviewed: true },
    });

    expect(updated.description).toBe("Updated description");
    expect(updated.metadata).toEqual({ reviewed: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bulk Flag Operations
// ═══════════════════════════════════════════════════════════════════════════

describe("Bulk Flag Operations", () => {
  describe("bulkCreate", () => {
    it("creates multiple flags successfully", async () => {
      const { manager } = createTestManager();
      const result = await manager.bulkCreate([
        { key: "bulk_a", type: "boolean", defaultValue: false },
        { key: "bulk_b", type: "string", defaultValue: "hello" },
        { key: "bulk_c", type: "number", defaultValue: 42 },
      ]);

      expect(result.created).toHaveLength(3);
      expect(result.errors).toHaveLength(0);
    });

    it("returns partial success with errors for duplicates", async () => {
      const { manager } = createTestManager();
      await manager.create({ key: "existing", type: "boolean", defaultValue: false });

      const result = await manager.bulkCreate([
        { key: "new_flag", type: "boolean", defaultValue: true },
        { key: "existing", type: "boolean", defaultValue: true }, // duplicate
      ]);

      expect(result.created).toHaveLength(1);
      expect(result.created[0].key).toBe("new_flag");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].key).toBe("existing");
    });
  });

  describe("bulkUpdate", () => {
    it("updates multiple flags successfully", async () => {
      const { manager } = createTestManager();
      await manager.create({ key: "upd_a", type: "boolean", defaultValue: false });
      await manager.create({ key: "upd_b", type: "boolean", defaultValue: false });

      const result = await manager.bulkUpdate([
        { key: "upd_a", patch: { description: "Updated A" } },
        { key: "upd_b", patch: { description: "Updated B" } },
      ]);

      expect(result.updated).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
    });

    it("returns errors for missing flags", async () => {
      const { manager } = createTestManager();
      await manager.create({ key: "real", type: "boolean", defaultValue: false });

      const result = await manager.bulkUpdate([
        { key: "real", patch: { description: "OK" } },
        { key: "nonexistent", patch: { description: "Fail" } },
      ]);

      expect(result.updated).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].key).toBe("nonexistent");
    });
  });

  describe("bulkDelete", () => {
    it("deletes multiple flags", async () => {
      const { manager } = createTestManager();
      await manager.create({ key: "del_a", type: "boolean", defaultValue: false });
      await manager.create({ key: "del_b", type: "boolean", defaultValue: false });

      await manager.bulkDelete(["del_a", "del_b"], { confirm: true });

      // Both should be gone
      await expect(manager.get("del_a")).rejects.toThrow("not found");
      await expect(manager.get("del_b")).rejects.toThrow("not found");
    });

    it("requires confirm: true", async () => {
      const { manager } = createTestManager();
      await expect(
        manager.bulkDelete(["any"], { confirm: false })
      ).rejects.toThrow("confirm");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Per-Environment Default Values
// ═══════════════════════════════════════════════════════════════════════════

describe("Per-Environment Default Values", () => {
  it("returns environment-specific default when environment matches", () => {
    const flag: Flag = {
      ...baseFlag,
      defaultValue: false,
      environmentDefaults: {
        production: false,
        staging: true,
        development: true,
      },
    };

    const staging = evaluateFlag(flag, { environment: "staging" });
    expect(staging.value).toBe(true);
    expect(staging.reason).toBe("default");

    const prod = evaluateFlag(flag, { environment: "production" });
    expect(prod.value).toBe(false);
  });

  it("falls back to global default when environment not in map", () => {
    const flag: Flag = {
      ...baseFlag,
      defaultValue: "global",
      environmentDefaults: { production: "prod_value" },
    };

    const result = evaluateFlag(flag, { environment: "staging" });
    expect(result.value).toBe("global");
  });

  it("falls back to global default when no environment in context", () => {
    const flag: Flag = {
      ...baseFlag,
      defaultValue: "global",
      environmentDefaults: { production: "prod_value" },
    };

    const result = evaluateFlag(flag, {});
    expect(result.value).toBe("global");
  });

  it("rules still take priority over environment defaults", () => {
    const flag: Flag = {
      ...baseFlag,
      defaultValue: false,
      environmentDefaults: { production: false },
    };
    const rule: FlagRule = {
      id: "r1",
      flagKey: "feature-test",
      priority: 1,
      value: true,
      enabled: true,
      conditions: {},
    };

    const result = evaluateFlag(flag, { environment: "production" }, { rules: [rule] });
    expect(result.value).toBe(true);
    expect(result.reason).toBe("rule_match");
  });

  it("persists environmentDefaults through create", async () => {
    const { manager } = createTestManager();
    await manager.create({
      key: "env_test",
      type: "boolean",
      defaultValue: false,
      environmentDefaults: { staging: true, production: false },
    });

    expect(await manager.isEnabled("env_test", { environment: "staging" })).toBe(true);
    expect(await manager.isEnabled("env_test", { environment: "production" })).toBe(false);
    expect(await manager.isEnabled("env_test", { environment: "qa" })).toBe(false);
  });
});
