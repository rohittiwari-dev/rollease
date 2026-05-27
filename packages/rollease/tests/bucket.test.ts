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

  it("distributes 10k users across 100 buckets roughly evenly (chi-squared)", () => {
    const counts = new Array(100).fill(0);
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      counts[getBucket(`user-${i}`, "rollout-flag")]++;
    }

    // Every bucket must be hit at least once and no bucket dominates.
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    expect(min).toBeGreaterThan(0);
    expect(max).toBeLessThan(N / 100 * 3); // no bucket >3x expected

    // Chi-squared goodness-of-fit. df = 99, critical value ~134 at p=0.01.
    // A healthy distribution should score well under this.
    const expected = N / 100;
    let chi = 0;
    for (const c of counts) {
      const diff = c - expected;
      chi += (diff * diff) / expected;
    }
    expect(chi).toBeLessThan(134);
  });

  it("produces different bucket distributions for different flags (no global skew)", () => {
    // Same user, different flag → independent buckets. Guards against bug
    // where the flag dimension is ignored in the hash.
    const ids = Array.from({ length: 50 }, (_, i) => `u-${i}`);
    const flagA = ids.map((id) => getBucket(id, "flag-A"));
    const flagB = ids.map((id) => getBucket(id, "flag-B"));
    const sameCount = flagA.filter((b, i) => b === flagB[i]).length;
    // With 50 users and 100 buckets, expected collisions ~ 0.5. >5 is suspicious.
    expect(sameCount).toBeLessThan(5);
  });
});
