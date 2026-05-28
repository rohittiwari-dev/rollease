import { describe, expect, it, afterAll, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { loadLocalOverrides, _resetOverridesRuntimeCache } from "../src/overrides";
import { FlagManager } from "../src/engine/manager";
import { MemoryDbAdapter } from "../src/db/memory";

describe("Local Developer Overrides", () => {
  const tempFile1 = path.resolve(process.cwd(), "temp_override_1.json");
  const tempFile2 = path.resolve(process.cwd(), "temp_override_2.json");

  beforeEach(() => {
    _resetOverridesRuntimeCache();
  });

  afterAll(() => {
    for (const f of [tempFile1, tempFile2]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("returns empty object if file does not exist", () => {
    const overrides = loadLocalOverrides("non_existent_file.json");
    expect(overrides).toEqual({});
  });

  it("loads overrides on every call (no module-level cache)", () => {
    fs.writeFileSync(tempFile1, JSON.stringify({ flag1: true }));
    expect(loadLocalOverrides("temp_override_1.json")).toEqual({ flag1: true });

    // Caching is now the caller's job — function reads disk every call.
    fs.writeFileSync(tempFile1, JSON.stringify({ flag1: false }));
    expect(loadLocalOverrides("temp_override_1.json")).toEqual({ flag1: false });
  });

  it("returns empty object on malformed JSON", () => {
    fs.writeFileSync(tempFile1, "{ not valid json");
    expect(loadLocalOverrides("temp_override_1.json")).toEqual({});
  });

  it("rejects path traversal silently (returns {})", () => {
    expect(loadLocalOverrides("../../../etc/passwd")).toEqual({});
  });

  it("returns {} when JSON is valid but not an object (array, number, null)", () => {
    // Covers the `return {}` branch after `!Array.isArray(parsed)` check.
    fs.writeFileSync(tempFile1, "[]");
    expect(loadLocalOverrides("temp_override_1.json")).toEqual({});

    fs.writeFileSync(tempFile1, "42");
    expect(loadLocalOverrides("temp_override_1.json")).toEqual({});

    fs.writeFileSync(tempFile1, "null");
    expect(loadLocalOverrides("temp_override_1.json")).toEqual({});
  });

  it("isolates state between FlagManager instances (no shared cache)", async () => {
    fs.writeFileSync(tempFile1, JSON.stringify({ shared_key: "from-file-1" }));
    fs.writeFileSync(tempFile2, JSON.stringify({ shared_key: "from-file-2" }));

    const dbA = new MemoryDbAdapter();
    const dbB = new MemoryDbAdapter();
    const mgrA = new FlagManager({
      db: dbA,
      useLocalOverrides: true,
      localOverridesFile: "temp_override_1.json",
    });
    const mgrB = new FlagManager({
      db: dbB,
      useLocalOverrides: true,
      localOverridesFile: "temp_override_2.json",
    });

    await mgrA.create({ key: "shared_key", type: "string", defaultValue: "default" });
    await mgrB.create({ key: "shared_key", type: "string", defaultValue: "default" });

    // Each manager reads from its own overrides file — no module-level
    // global cache to leak between instances.
    const valA = await mgrA.getValue("shared_key", {});
    const valB = await mgrB.getValue("shared_key", {});
    expect(valA).toBe("from-file-1");
    expect(valB).toBe("from-file-2");
  });
});
