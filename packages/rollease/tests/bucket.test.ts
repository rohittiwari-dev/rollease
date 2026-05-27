import { describe, expect, it } from "vitest";
import { murmurhash3_32, getBucket } from "../src/bucket";

describe("MurmurHash3 & Bucketing", () => {
  it("should cover all remainder branches in murmurhash3_32", () => {
    // Key lengths:
    // Length 0 -> remainder 0
    expect(murmurhash3_32("")).toBe(0);

    // Length 1 -> remainder 1
    expect(murmurhash3_32("a")).toBeDefined();

    // Length 2 -> remainder 2
    expect(murmurhash3_32("ab")).toBeDefined();

    // Length 3 -> remainder 3
    expect(murmurhash3_32("abc")).toBeDefined();

    // Length 4 -> remainder 0, loop executed
    expect(murmurhash3_32("abcd")).toBeDefined();

    // With a different seed
    expect(murmurhash3_32("abc", 123)).toBeDefined();
  });

  it("should consistent bucket users", () => {
    const b1 = getBucket("user1", "flag1");
    const b2 = getBucket("user1", "flag1");
    expect(b1).toBe(b2);
    expect(b1).toBeGreaterThanOrEqual(0);
    expect(b1).toBeLessThan(100);

    const b3 = getBucket("user1", "flag1", "salt");
    expect(b3).toBeGreaterThanOrEqual(0);
    expect(b3).toBeLessThan(100);
  });
});
