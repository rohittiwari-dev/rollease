import { describe, expect, it } from "vitest";
import { MemoryDbAdapter, MemoryCacheAdapter, createMemoryAdapter } from "../src/db/memory";
import {
  FlagNotFoundError,
  FlagConflictError,
  RuleNotFoundError,
  SegmentNotFoundError,
  ReleaseNotFoundError,
  ValidationError,
} from "../src/core/errors";
import type { FlagConditionGroup } from "../src/core/types";

describe("Memory Database & Cache Adapters", () => {
  it("should create memory adapter via factory", () => {
    const db = createMemoryAdapter();
    expect(db).toBeInstanceOf(MemoryDbAdapter);
  });

  describe("MemoryDbAdapter Flag CRUD & Operations", () => {
    it("should manage flag lifecycle", async () => {
      const db = new MemoryDbAdapter();

      // Create
      const flag1 = await db.createFlag({
        key: "app.ui.theme",
        type: "string",
        defaultValue: "dark",
        namespace: "app",
        tags: ["ui", "frontend"],
        environments: ["production"],
      });
      expect(flag1.key).toBe("app.ui.theme");

      // Conflict
      await expect(
        db.createFlag({ key: "app.ui.theme", type: "boolean", defaultValue: false })
      ).rejects.toThrow(FlagConflictError);

      // Get
      const flagGet = await db.getFlag("app.ui.theme");
      expect(flagGet).toEqual(flag1);
      const flagGetNull = await db.getFlag("unknown");
      expect(flagGetNull).toBeNull();

      // Update
      const flagUpdated = await db.updateFlag("app.ui.theme", {
        description: "theme selector",
        tags: ["ui", "new-tag"],
      });
      expect(flagUpdated.description).toBe("theme selector");
      expect(flagUpdated.tags).toEqual(["ui", "new-tag"]);

      await expect(
        db.updateFlag("unknown", { description: "theme selector" })
      ).rejects.toThrow(FlagNotFoundError);

      // List Flags with filters
      const list1 = await db.listFlags({ status: "active" });
      expect(list1.data.length).toBe(1);

      const listStatusNull = await db.listFlags({ status: "archived" });
      expect(listStatusNull.data.length).toBe(0);

      const listNamespace = await db.listFlags({ namespace: "app" });
      expect(listNamespace.data.length).toBe(1);

      const listTags = await db.listFlags({ tags: ["ui"] });
      expect(listTags.data.length).toBe(1);

      const listTagsMiss = await db.listFlags({ tags: ["missing"] });
      expect(listTagsMiss.data.length).toBe(0);

      const listEnv = await db.listFlags({ environment: "production" });
      expect(listEnv.data.length).toBe(1);

      const listSearch = await db.listFlags({ search: "theme" });
      expect(listSearch.data.length).toBe(1);

      // Status
      await db.setFlagStatus("app.ui.theme", "killed");
      const killedFlag = await db.getFlag("app.ui.theme");
      expect(killedFlag?.status).toBe("killed");

      await expect(
        db.setFlagStatus("unknown", "active")
      ).rejects.toThrow(FlagNotFoundError);

      // Tags add/remove
      await db.addTags("app.ui.theme", ["extra-1", "extra-2"]);
      let tagFlag = await db.getFlag("app.ui.theme");
      expect(tagFlag?.tags).toContain("extra-1");

      await db.removeTags("app.ui.theme", ["extra-1"]);
      tagFlag = await db.getFlag("app.ui.theme");
      expect(tagFlag?.tags).not.toContain("extra-1");

      await expect(db.addTags("unknown", ["tag"])).rejects.toThrow(FlagNotFoundError);
      await expect(db.removeTags("unknown", ["tag"])).rejects.toThrow(FlagNotFoundError);

      // Delete
      await db.deleteFlag("app.ui.theme");
      const deletedGet = await db.getFlag("app.ui.theme");
      expect(deletedGet).toBeNull();

      await expect(db.deleteFlag("unknown")).rejects.toThrow(FlagNotFoundError);
    });

    it("should support cloneFlag", async () => {
      const db = new MemoryDbAdapter();

      await db.createFlag({
        key: "flag-source",
        type: "boolean",
        defaultValue: false,
        rollout: { percentage: 40, sticky: true, hashKey: "userId" },
      });

      await db.addRule("flag-source", {
        priority: 1,
        value: true,
        conditions: { any: [] },
      });

      // Successful clone
      const cloned = await db.cloneFlag("flag-source", "flag-cloned", true, true);
      expect(cloned.key).toBe("flag-cloned");
      expect(cloned.rollout?.percentage).toBe(40);
      const clonedRules = await db.listRules("flag-cloned");
      expect(clonedRules.length).toBe(1);

      // Clone without rules/rollout
      const cloned2 = await db.cloneFlag("flag-source", "flag-cloned-2", false, false);
      expect(cloned2.rollout).toBeUndefined();
      const clonedRules2 = await db.listRules("flag-cloned-2");
      expect(clonedRules2.length).toBe(0);

      // Conflict/NotFound clone
      await expect(
        db.cloneFlag("unknown", "dest", true, true)
      ).rejects.toThrow(FlagNotFoundError);

      await expect(
        db.cloneFlag("flag-source", "flag-cloned", true, true)
      ).rejects.toThrow(FlagConflictError);
    });

    it("should support rules management (add, update, remove, list, reorder)", async () => {
      const db = new MemoryDbAdapter();
      await db.createFlag({ key: "flag", type: "boolean", defaultValue: false });

      // Add
      const rule1 = await db.addRule("flag", { priority: 2, value: true, conditions: {} });
      const rule2 = await db.addRule("flag", { priority: 1, value: false, conditions: {} });

      // Must be sorted by priority
      const list = await db.listRules("flag");
      expect(list[0].id).toBe(rule2.id); // priority 1
      expect(list[1].id).toBe(rule1.id); // priority 2

      // AddRule throw
      await expect(db.addRule("unknown", { priority: 1, value: true, conditions: {} })).rejects.toThrow(FlagNotFoundError);
      await expect(
        db.addRule("flag", {
          priority: 1,
          value: true,
          conditions: { any: [{ dimension: "email", op: "regex", value: "(a+)+$" }] },
        })
      ).rejects.toThrow(ValidationError);

      // Update
      const ruleUpdated = await db.updateRule("flag", rule1.id, { priority: 0 });
      const listSorted = await db.listRules("flag");
      expect(listSorted[0].id).toBe(ruleUpdated.id); // now priority 0 is first

      // Update Rule throws
      await expect(db.updateRule("unknown", rule1.id, {})).rejects.toThrow(FlagNotFoundError);
      await expect(db.updateRule("flag", "unknown-rule", {})).rejects.toThrow(RuleNotFoundError);

      // Reorder
      await db.reorderRules("flag", [
        { ruleId: ruleUpdated.id, priority: 10 },
        { ruleId: rule2.id, priority: 5 },
      ]);
      const listReordered = await db.listRules("flag");
      expect(listReordered[0].id).toBe(rule2.id); // priority 5
      expect(listReordered[1].id).toBe(ruleUpdated.id); // priority 10

      await expect(db.reorderRules("unknown", [])).rejects.toThrow(FlagNotFoundError);

      // Remove
      await db.removeRule("flag", rule2.id);
      const listFinal = await db.listRules("flag");
      expect(listFinal.length).toBe(1);

      await expect(db.removeRule("unknown", rule2.id)).rejects.toThrow(FlagNotFoundError);
      await expect(db.removeRule("flag", "unknown-rule")).rejects.toThrow(RuleNotFoundError);
    });

    it("should support segment lifecycle & usage", async () => {
      const db = new MemoryDbAdapter();

      // Create
      const seg = await db.createSegment({
        key: "power-users",
        description: "high activity users",
        rules: { any: [] },
      });
      expect(seg.key).toBe("power-users");

      await expect(
        db.createSegment({ key: "power-users", rules: {} })
      ).rejects.toThrow(FlagConflictError);

      // Get
      expect(await db.getSegment("power-users")).toEqual(seg);
      expect(await db.getSegment("unknown")).toBeNull();

      // Update
      const updated = await db.updateSegment("power-users", { description: "modified desc" });
      expect(updated.description).toBe("modified desc");
      await expect(db.updateSegment("unknown", {})).rejects.toThrow(SegmentNotFoundError);

      // List
      const list = await db.listSegments();
      expect(list.length).toBe(1);

      // Usage scan
      await db.createFlag({ key: "flag-x", type: "boolean", defaultValue: false });
      const rule = await db.addRule("flag-x", {
        priority: 1,
        value: true,
        conditions: {
          any: [
            { dimension: "segment", op: "in", value: "power-users" },
          ],
        },
      });

      const usage = await db.getSegmentUsage("power-users");
      expect(usage).toEqual([{ flagKey: "flag-x", ruleId: rule.id }]);

      // Delete
      await db.deleteSegment("power-users");
      await expect(db.deleteSegment("power-users")).rejects.toThrow(SegmentNotFoundError);
    });

    it("should support release lifecycle (create, list, deploy, rollback)", async () => {
      const db = new MemoryDbAdapter();

      await db.createFlag({ key: "flag-1", type: "boolean", defaultValue: false });
      await db.createFlag({ key: "flag-2", type: "string", defaultValue: "old" });

      // Create release
      const rel1 = await db.createRelease({
        name: "Sprint release",
        environment: "staging",
        changes: [
          { flagKey: "flag-1", action: "enable", value: true },
          { flagKey: "flag-2", action: "setValue", value: "new" },
          { flagKey: "flag-missing", action: "setValue", value: "bypass" }, // skipped in resolution
        ],
      });
      expect(rel1.status).toBe("pending");

      // List releases
      const list = await db.listReleases({ environment: "staging", limit: 5 });
      expect(list[0].id).toBe(rel1.id);

      // Deploy
      await db.deployRelease(rel1.id, "alice");
      expect(rel1.status).toBe("deployed");
      expect((await db.getFlag("flag-1"))?.defaultValue).toBe(true);
      expect((await db.getFlag("flag-2"))?.defaultValue).toBe("new");

      await expect(db.deployRelease("unknown-rel")).rejects.toThrow(ReleaseNotFoundError);

      // Rollback
      await db.rollbackRelease(rel1.id, "bob", "critical bugs");
      expect(rel1.status).toBe("rolled_back");
      expect((await db.getFlag("flag-1"))?.defaultValue).toBe(false); // enable reversed to false

      await expect(db.rollbackRelease("unknown-rel")).rejects.toThrow(ReleaseNotFoundError);
    });

    it("should test all other deploy and rollback change actions", async () => {
      const db = new MemoryDbAdapter();
      await db.createFlag({ key: "flag", type: "boolean", defaultValue: false });

      const relDeploy = await db.createRelease({
        name: "Advanced release",
        changes: [
          { flagKey: "flag", action: "disable", value: false },
          { flagKey: "flag", action: "setRollout", rollout: { percentage: 20 } },
          { flagKey: "flag", action: "kill" },
        ],
      });
      await db.deployRelease(relDeploy.id);
      let flag = await db.getFlag("flag");
      expect(flag?.status).toBe("killed");
      expect(flag?.rollout?.percentage).toBe(20);

      const relDeploy2 = await db.createRelease({
        name: "Restore release",
        changes: [{ flagKey: "flag", action: "restore" }],
      });
      await db.deployRelease(relDeploy2.id);
      flag = await db.getFlag("flag");
      expect(flag?.status).toBe("active");

      // Snapshot-based rollback restores EXACT prior state (defaultValue,
      // status, rollout). Capture state before relRollback runs so we can
      // assert it gets restored.
      const before = await db.getFlag("flag");

      const relRollback = await db.createRelease({
        name: "Rollback config",
        changes: [
          { flagKey: "flag", action: "disable" },
          { flagKey: "flag", action: "kill" },
          { flagKey: "flag", action: "restore" },
        ],
      });
      await db.deployRelease(relRollback.id);
      await db.rollbackRelease(relRollback.id);
      flag = await db.getFlag("flag");
      expect(flag?.defaultValue).toBe(before?.defaultValue);
      expect(flag?.status).toBe(before?.status);
      expect(flag?.rollout?.percentage).toBe(before?.rollout?.percentage);
    });

    it("snapshot rollback restores setValue and setRollout changes exactly", async () => {
      const db = new MemoryDbAdapter();
      await db.createFlag({
        key: "flag",
        type: "string",
        defaultValue: "v1-original",
        rollout: { percentage: 25, sticky: true, hashKey: "userId" },
      });

      const rel = await db.createRelease({
        name: "Major reconfigure",
        changes: [
          { flagKey: "flag", action: "setValue", value: "v2-new" },
          { flagKey: "flag", action: "setRollout", rollout: { percentage: 100 } },
        ],
      });

      await db.deployRelease(rel.id, "alice");
      const deployed = await db.getFlag("flag");
      expect(deployed?.defaultValue).toBe("v2-new");
      expect(deployed?.rollout?.percentage).toBe(100);

      // The snapshot must remember the original values (one per unique flag).
      const release = await db.getRelease(rel.id);
      expect(release?.snapshots?.length).toBe(1);

      await db.rollbackRelease(rel.id, "bob", "regression");
      const restored = await db.getFlag("flag");
      expect(restored?.defaultValue).toBe("v1-original");
      expect(restored?.rollout?.percentage).toBe(25);
    });

    it("getSegmentUsage does not false-positive on segment key appearing in unrelated string values", async () => {
      const db = new MemoryDbAdapter();
      await db.createFlag({ key: "flag-a", type: "boolean", defaultValue: false });
      await db.createFlag({ key: "flag-b", type: "boolean", defaultValue: false });

      // flag-a references the segment "user" via a userType value — NOT as
      // a segment-dimension leaf. Should NOT show up in segment usage.
      await db.addRule("flag-a", {
        priority: 1,
        value: true,
        conditions: {
          any: [{ dimension: "userType", op: "eq", value: "user" }],
        },
      });

      // flag-b actually uses the segment.
      const ruleB = await db.addRule("flag-b", {
        priority: 1,
        value: true,
        conditions: {
          any: [{ dimension: "segment", op: "in", value: "user" }],
        },
      });

      const usage = await db.getSegmentUsage("user");
      expect(usage).toEqual([{ flagKey: "flag-b", ruleId: ruleB.id }]);
    });

    it("getUserAssignments returns a batched map in one round-trip", async () => {
      const db = new MemoryDbAdapter();
      await db.createFlag({ key: "f1", type: "boolean", defaultValue: false });
      await db.createFlag({ key: "f2", type: "boolean", defaultValue: false });
      await db.createFlag({ key: "f3", type: "boolean", defaultValue: false });

      await db.setUserAssignment("f1", "alice", "variant-a");
      await db.setUserAssignment("f3", "alice", "variant-c");

      const batched = await db.getUserAssignments(["f1", "f2", "f3"], "alice");
      expect(batched).toEqual({ f1: "variant-a", f3: "variant-c" });

      // Empty input shortcuts.
      expect(await db.getUserAssignments([], "alice")).toEqual({});
    });

    it("getAllActiveFlags supports limit/offset pagination", async () => {
      const db = new MemoryDbAdapter();
      for (let i = 0; i < 5; i++) {
        await db.createFlag({
          key: `flag-${i}`,
          type: "boolean",
          defaultValue: false,
        });
      }

      const page1 = await db.getAllActiveFlags({ limit: 2, offset: 0 });
      const page2 = await db.getAllActiveFlags({ limit: 2, offset: 2 });
      const page3 = await db.getAllActiveFlags({ limit: 2, offset: 4 });

      expect(page1.length).toBe(2);
      expect(page2.length).toBe(2);
      expect(page3.length).toBe(1);

      // Keys should not overlap across pages.
      const allKeys = [...page1, ...page2, ...page3].map((f) => f.key);
      expect(new Set(allKeys).size).toBe(5);
    });

    it("should manage user assignments, impressions, history, and active flags resolution", async () => {
      const db = new MemoryDbAdapter();

      await db.createFlag({ key: "flag1", type: "boolean", defaultValue: false, tags: ["t1"] });
      await db.createFlag({ key: "flag2", type: "boolean", defaultValue: false, tags: ["t2"], namespace: "ns" });

      // Active flags filtering
      expect((await db.getAllActiveFlags({ namespace: "ns" })).length).toBe(1);
      expect((await db.getAllActiveFlags({ tags: ["t1"] })).length).toBe(1);
      expect((await db.getAllActiveFlags({ keys: ["flag1"] })).length).toBe(1);

      // User Assignments
      await db.setUserAssignment("flag1", "user-1", "treatment-a");
      expect(await db.getUserAssignment("flag1", "user-1")).toBe("treatment-a");
      expect(await db.getUserAssignment("flag1", "user-2")).toBeNull();

      // History
      const hist = await db.getHistory("flag1", { limit: 2 });
      expect(hist.length).toBeGreaterThan(0);

      // Impression
      await db.trackImpression({
        flagKey: "flag1",
        userId: "user-1",
        value: true,
        variant: "treatment-a",
        reason: "override",
      });
    });

    it("should support setRollout on database layer", async () => {
      const db = new MemoryDbAdapter();
      await db.createFlag({ key: "flag", type: "boolean", defaultValue: false });

      await db.setRollout("flag", { percentage: 80, sticky: false, hashKey: "device" });
      const flag = await db.getFlag("flag");
      expect(flag?.rollout?.percentage).toBe(80);
      expect(flag?.rollout?.sticky).toBe(false);
      expect(flag?.rollout?.hashKey).toBe("device");

      await expect(db.setRollout("unknown", {})).rejects.toThrow(FlagNotFoundError);
    });
  });

  describe("MemoryCacheAdapter Operations & Expiration", () => {
    it("should support get, set, del, delPattern", async () => {
      const cache = new MemoryCacheAdapter();

      await cache.set("k1", "v1", 1000);
      expect(await cache.get("k1")).toBe("v1");

      await cache.del("k1");
      expect(await cache.get("k1")).toBeNull();

      // Expiration
      await cache.set("k2", "v2", -10); // already expired
      expect(await cache.get("k2")).toBeNull();

      // delPattern matching glob patterns
      await cache.set("prefix:abc", "1", 10000);
      await cache.set("prefix:def", "2", 10000);
      await cache.set("other:key", "3", 10000);

      await cache.delPattern("prefix:*");
      expect(await cache.get("prefix:abc")).toBeNull();
      expect(await cache.get("prefix:def")).toBeNull();
      expect(await cache.get("other:key")).toBe("3");
    });
  });
});
