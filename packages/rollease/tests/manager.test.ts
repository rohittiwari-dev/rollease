import { describe, expect, it, vi } from "vitest";
import { FlagManager } from "../src/engine/manager";
import { MemoryDbAdapter, MemoryCacheAdapter } from "../src/db/memory";
import {
  FlagNotFoundError,
  FlagLockedError,
  ValidationError,
} from "../src/core/errors";

describe("Flag Manager API", () => {
  it("should validate flag key during creation", async () => {
    const db = new MemoryDbAdapter();
    const manager = new FlagManager({ db });

    await expect(manager.create({ key: "", type: "boolean", defaultValue: false })).rejects.toThrow(ValidationError);
    await expect(manager.create({ key: "UPPERCASE", type: "boolean", defaultValue: false })).rejects.toThrow(ValidationError);
    await expect(manager.create({ key: "spaced key", type: "boolean", defaultValue: false })).rejects.toThrow(ValidationError);
  });

  it("should throw FlagNotFoundError when fetching missing flag", async () => {
    const db = new MemoryDbAdapter();
    const manager = new FlagManager({ db });

    await expect(manager.get("missing")).rejects.toThrow(FlagNotFoundError);
  });

  it("should enforce locked flags logic", async () => {
    const db = new MemoryDbAdapter();
    const manager = new FlagManager({ db });

    const flag = await manager.create({ key: "feature.locked", type: "boolean", defaultValue: false });

    // Lock the flag
    await manager.update("feature.locked", { locked: true, lockedReason: "maintenance" });

    // Try modifying and expect FlagLockedError
    await expect(manager.update("feature.locked", { defaultValue: true })).rejects.toThrow(FlagLockedError);
    await expect(manager.addRule("feature.locked", { priority: 1, value: true, conditions: {} })).rejects.toThrow(FlagLockedError);
    await expect(manager.updateRule("feature.locked", "rule-id", {})).rejects.toThrow(FlagLockedError);
    await expect(manager.removeRule("feature.locked", "rule-id")).rejects.toThrow(FlagLockedError);
    await expect(manager.reorderRules("feature.locked", [])).rejects.toThrow(FlagLockedError);
    await expect(manager.setRollout("feature.locked", { percentage: 50 })).rejects.toThrow(FlagLockedError);
  });

  it("should reject unsafe regex conditions in manager APIs", async () => {
    const db = new MemoryDbAdapter();
    const manager = new FlagManager({ db });
    await manager.create({ key: "flag", type: "boolean", defaultValue: false });

    await expect(
      manager.addRule("flag", {
        priority: 1,
        value: true,
        conditions: { any: [{ dimension: "email", op: "regex", value: "(a+)+$" }] },
      })
    ).rejects.toThrow(ValidationError);

    await expect(
      manager.createSegment({
        key: "unsafe-segment",
        rules: { any: [{ dimension: "email", op: "regex", value: "(a+)+$" }] },
      })
    ).rejects.toThrow(ValidationError);
  });

  it("should emit change events and handle listener errors gracefully", async () => {
    const db = new MemoryDbAdapter();
    const manager = new FlagManager({ db });

    const events: any[] = [];
    const unsubscribe = manager.onChange((e) => {
      events.push(e);
      if (events.length === 1) {
        throw new Error("listener error"); // should be caught and not crash
      }
    });

    await manager.create({ key: "flag", type: "boolean", defaultValue: false });
    await manager.update("flag", { description: "updated" });
    await manager.update("flag", { description: "updated again" });

    expect(events.length).toBe(2);
    expect(events[0].action).toBe("updated"); // from update
    expect(events[1].action).toBe("updated"); // from update (second call)

    unsubscribe();
  });

  it("should delegate CRUD operations for rules, segments, releases, tags, and history", async () => {
    const db = new MemoryDbAdapter();
    const manager = new FlagManager({ db });

    // CRUD flag
    await manager.create({ key: "flag", type: "boolean", defaultValue: false });
    expect((await manager.list()).data.length).toBe(1);
    expect(await manager.get("flag")).toBeDefined();

    // clone
    await manager.clone("flag", { newKey: "flag.cloned" });
    expect(await manager.get("flag.cloned")).toBeDefined();

    // delete throws if confirm not passed
    await expect(manager.delete("flag")).rejects.toThrow(ValidationError);
    await manager.delete("flag", { confirm: true });
    await expect(manager.get("flag")).rejects.toThrow(FlagNotFoundError);

    // rules
    const r = await manager.addRule("flag.cloned", { priority: 1, value: true, conditions: {} });
    expect((await manager.listRules("flag.cloned")).length).toBe(1);
    await manager.updateRule("flag.cloned", r.id, { value: false });
    await manager.removeRule("flag.cloned", r.id);

    // segments
    await manager.createSegment({ key: "seg", rules: {} });
    expect((await manager.listSegments()).length).toBe(1);
    await manager.updateSegment("seg", { description: "desc" });
    expect((await manager.getSegmentUsage("seg")).length).toBe(0);
    await manager.deleteSegment("seg");

    // releases
    const rel = await manager.createRelease({
      name: "r",
      changes: [{ flagKey: "flag.cloned", action: "kill" }],
    });
    expect((await manager.listReleases()).length).toBe(1);
    const preview = await manager.previewRelease(rel.id);
    expect(preview.length).toBe(1);
    await manager.deployRelease(rel.id);
    expect((await manager.get("flag.cloned")).status).toBe("killed");
    await manager.rollbackRelease(rel.id);
    expect((await manager.get("flag.cloned")).status).toBe("active");

    // tags
    await manager.addTags("flag.cloned", ["t1"]);
    await manager.removeTags("flag.cloned", ["t1"]);

    // history
    expect(await manager.getHistory("flag.cloned")).toBeDefined();
  });

  it("should manage kill switch methods (kill, killAll, restoreAll)", async () => {
    const db = new MemoryDbAdapter();
    const manager = new FlagManager({ db });

    await manager.create({ key: "f1", type: "boolean", defaultValue: false });
    await manager.create({ key: "f2", type: "boolean", defaultValue: false });

    // kill one
    await manager.kill("f1");
    expect((await manager.get("f1")).status).toBe("killed");

    await expect(manager.kill("unknown")).rejects.toThrow(FlagNotFoundError);

    // killAll
    await manager.killAll({});
    expect((await manager.get("f2")).status).toBe("killed");

    // restoreAll
    await manager.restoreAll({});
    expect((await manager.get("f1")).status).toBe("active");
    expect((await manager.get("f2")).status).toBe("active");
  });

  it("should evaluate single values, variants, and bulk evaluate maps", async () => {
    const db = new MemoryDbAdapter();
    const manager = new FlagManager({ db });

    await manager.create({ key: "flag", type: "boolean", defaultValue: false });

    // isEnabled
    expect(await manager.isEnabled("flag", {})).toBe(false);
    expect(await manager.isEnabled("unknown", {})).toBe(false);

    // getValue
    expect(await manager.getValue("flag", {})).toBe(false);

    // getVariant
    const v = await manager.getVariant("flag", {});
    expect(v.key).toBe("default");
    expect(v.value).toBe(false);

    // evaluateAll & detailed
    const all = await manager.evaluateAll({});
    expect(all["flag"]).toBe(false);

    const detailed = await manager.evaluateAllDetailed({});
    expect(detailed["flag"].value).toBe(false);
  });

  it("should support L2 caching and invalidation delegation", async () => {
    const db = new MemoryDbAdapter();
    const l2Cache = new MemoryCacheAdapter();
    const manager = new FlagManager({ db, l2Cache });

    await manager.create({ key: "flag", type: "boolean", defaultValue: false });

    // Invalidations
    await manager.invalidateCache("flag");
    await manager.invalidateAllCaches();
  });

  it("should support getLocalOverride handling errors", async () => {
    const db = new MemoryDbAdapter();
    const manager = new FlagManager({ db, useLocalOverrides: true, localOverridesFile: "non-existent.json" });
    await manager.create({ key: "flag", type: "boolean", defaultValue: false });

    // Should return undefined gracefully instead of throwing
    expect(await manager.isEnabled("flag", {})).toBe(false);
  });
});
