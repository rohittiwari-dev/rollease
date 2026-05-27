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

  it("should enforce locked flags logic via setLock()", async () => {
    const db = new MemoryDbAdapter();
    const manager = new FlagManager({ db });

    await manager.create({ key: "feature.locked", type: "boolean", defaultValue: false });

    // Locks must go through setLock() — patching `locked` via update() is silently
    // stripped so the audit path is always explicit.
    await manager.setLock("feature.locked", { locked: true, reason: "maintenance" });

    // Verify the explicit lock attempt was recorded in history.
    const history = await manager.getHistory("feature.locked");
    expect(history.some((h) => h.action === "flag.locked")).toBe(true);

    await expect(manager.update("feature.locked", { defaultValue: true })).rejects.toThrow(FlagLockedError);
    await expect(manager.addRule("feature.locked", { priority: 1, value: true, conditions: {} })).rejects.toThrow(FlagLockedError);
    await expect(manager.updateRule("feature.locked", "rule-id", {})).rejects.toThrow(FlagLockedError);
    await expect(manager.removeRule("feature.locked", "rule-id")).rejects.toThrow(FlagLockedError);
    await expect(manager.reorderRules("feature.locked", [])).rejects.toThrow(FlagLockedError);
    await expect(manager.setRollout("feature.locked", { percentage: 50 })).rejects.toThrow(FlagLockedError);
  });

  it("update() silently strips `locked` field — cannot unlock via update", async () => {
    const db = new MemoryDbAdapter();
    const manager = new FlagManager({ db });

    await manager.create({ key: "feature.locked2", type: "boolean", defaultValue: false });
    await manager.setLock("feature.locked2", { locked: true, reason: "audit" });

    // Sneaky attempt to unlock through update() must fail loudly because the
    // flag is currently locked.
    await expect(
      manager.update("feature.locked2", { locked: false })
    ).rejects.toThrow(FlagLockedError);

    // Even when not locked, update() must not honor `locked` from patch.
    await manager.setLock("feature.locked2", { locked: false });
    await manager.update("feature.locked2", {
      locked: true,
      description: "still unlocked",
    });
    const flag = await manager.get("feature.locked2");
    expect(flag.locked).toBe(false);
    expect(flag.description).toBe("still unlocked");
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

    // create() emits "created", each update() emits "updated" → 3 events total
    expect(events.length).toBe(3);
    expect(events[0].action).toBe("created"); // from create
    expect(events[1].action).toBe("updated"); // from update
    expect(events[2].action).toBe("updated"); // from update (second call)

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

  it("caches flag reads in L1 so repeated evaluations hit the cache, not the DB", async () => {
    const db = new MemoryDbAdapter();
    await db.createFlag({ key: "cached", type: "boolean", defaultValue: false });

    const getFlagSpy = vi.spyOn(db, "getFlag");
    const listRulesSpy = vi.spyOn(db, "listRules");

    const manager = new FlagManager({ db, l1TtlMs: 10_000 });

    // First call should populate cache.
    await manager.isEnabled("cached", { userId: "u1" });
    const dbCallsAfterFirst = getFlagSpy.mock.calls.length;
    const rulesCallsAfterFirst = listRulesSpy.mock.calls.length;
    expect(dbCallsAfterFirst).toBeGreaterThan(0);

    // Many subsequent reads must NOT re-hit the DB.
    for (let i = 0; i < 25; i++) {
      await manager.isEnabled("cached", { userId: "u1" });
    }
    expect(getFlagSpy.mock.calls.length).toBe(dbCallsAfterFirst);
    expect(listRulesSpy.mock.calls.length).toBe(rulesCallsAfterFirst);

    // Mutations bust the cache → next read goes to DB again.
    await manager.update("cached", { description: "touched" });
    await manager.isEnabled("cached", { userId: "u1" });
    expect(getFlagSpy.mock.calls.length).toBeGreaterThan(dbCallsAfterFirst);
  });

  it("invokes hooks: onBeforeMutation can deny, onBeforeEvaluation runs, onEvaluate fires", async () => {
    const events: string[] = [];
    const db = new MemoryDbAdapter();
    const manager = new FlagManager({
      db,
      hooks: {
        onBeforeMutation: ({ action, flagKey }) => {
          events.push(`mut:${action}:${flagKey ?? ""}`);
          if (action === "flag.deleted") throw new Error("denied by RBAC");
        },
        onBeforeEvaluation: ({ flagKey }) => {
          events.push(`eval:${flagKey}`);
        },
        onEvaluate: (result) => {
          events.push(`done:${result.key}:${result.reason}`);
        },
      },
    });

    await manager.create({ key: "feat.a", type: "boolean", defaultValue: false });
    await manager.isEnabled("feat.a", { userId: "u1" });

    expect(events).toContain("mut:flag.created:feat.a");
    expect(events).toContain("eval:feat.a");
    // onEvaluate is fire-and-forget — give the microtask queue a tick.
    await new Promise((r) => setTimeout(r, 5));
    expect(events.some((e) => e.startsWith("done:feat.a:"))).toBe(true);

    // RBAC denial: delete throws because hook threw.
    await expect(manager.delete("feat.a", { confirm: true })).rejects.toThrow(
      "denied by RBAC"
    );
    // Flag still exists.
    expect(await manager.get("feat.a")).toBeDefined();
  });

  it("records impressions on evaluate (fire-and-forget, only when userId present)", async () => {
    const db = new MemoryDbAdapter();
    const impressionSpy = vi.spyOn(db, "trackImpression");
    const manager = new FlagManager({ db });

    await manager.create({ key: "tracked", type: "boolean", defaultValue: false });

    // No userId → no impression.
    await manager.isEnabled("tracked", {});
    await new Promise((r) => setTimeout(r, 5));
    expect(impressionSpy).not.toHaveBeenCalled();

    // userId present → impression recorded.
    await manager.isEnabled("tracked", { userId: "alice" });
    await new Promise((r) => setTimeout(r, 5));
    expect(impressionSpy).toHaveBeenCalledTimes(1);
    expect(impressionSpy.mock.calls[0][0]).toMatchObject({
      flagKey: "tracked",
      userId: "alice",
    });
  });

  it("does NOT record impressions for kill_switch / disabled / expired / not_scheduled", async () => {
    const db = new MemoryDbAdapter();
    const impressionSpy = vi.spyOn(db, "trackImpression");
    const manager = new FlagManager({ db });

    await manager.create({ key: "killed-flag", type: "boolean", defaultValue: false });
    await manager.kill("killed-flag");

    await manager.isEnabled("killed-flag", { userId: "alice" });
    await new Promise((r) => setTimeout(r, 5));
    // kill_switch reason should be skipped.
    expect(impressionSpy).not.toHaveBeenCalled();
  });

  it("logs listener errors through configured logger (does not crash)", async () => {
    const logs: { level: string; message: string }[] = [];
    const db = new MemoryDbAdapter();
    const { createLogger } = await import("../src/core/logger");
    const logger = createLogger({
      level: "warn",
      sink: (level, message) => logs.push({ level, message }),
    });

    const manager = new FlagManager({ db, logger });

    manager.onChange(() => {
      throw new Error("listener boom");
    });

    await manager.create({ key: "f", type: "boolean", defaultValue: false });
    await manager.update("f", { description: "hi" });

    expect(logs.some((l) => l.message.includes("change listener threw"))).toBe(true);
  });
});
