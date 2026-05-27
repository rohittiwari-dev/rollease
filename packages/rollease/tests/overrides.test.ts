import { describe, expect, it, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { loadLocalOverrides, clearOverrideCache } from "../src/overrides";

describe("Local Developer Overrides", () => {
  const tempFile = path.resolve(process.cwd(), "temp_override.json");

  afterAll(() => {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  });

  it("should return empty object if file does not exist", () => {
    clearOverrideCache();
    const overrides = loadLocalOverrides("non_existent_file.json");
    expect(overrides).toEqual({});
  });

  it("should load overrides and cache them", () => {
    clearOverrideCache();
    fs.writeFileSync(tempFile, JSON.stringify({ flag1: true, flag2: "hello" }));

    const overrides1 = loadLocalOverrides("temp_override.json");
    expect(overrides1).toEqual({ flag1: true, flag2: "hello" });

    // Modifying file shouldn't be read immediately due to cache TTL
    fs.writeFileSync(tempFile, JSON.stringify({ flag1: false }));
    const overrides2 = loadLocalOverrides("temp_override.json");
    expect(overrides2).toEqual({ flag1: true, flag2: "hello" });

    // Clearing cache forces reread
    clearOverrideCache();
    const overrides3 = loadLocalOverrides("temp_override.json");
    expect(overrides3).toEqual({ flag1: false });
  });

  it("should return empty object and handle invalid JSON elegantly", () => {
    clearOverrideCache();
    fs.writeFileSync(tempFile, "{ invalid json }");
    const overrides = loadLocalOverrides("temp_override.json");
    expect(overrides).toEqual({});
  });
});
