import { describe, expect, it } from "vitest";
import {
  normalCdf,
  normalInv,
  studentTCdf,
  studentTInv,
  twoProportionTest,
  welchTTest,
  wilsonInterval,
  normalInterval,
  sampleSizeForProportion,
  sampleSizeForMean,
  applyCUPED,
  createMSPRTState,
  updateMSPRT,
  mSPRTPValue,
  thompsonSample,
  pickArmThompson,
  ucb1,
  epsilonGreedy,
} from "../src/stats";

// Tolerance for floating-point math comparisons against textbook values.
const EPS = 1e-3;
const TIGHT = 1e-6;

describe("normalCdf", () => {
  it("Φ(0) = 0.5", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
  });
  it("Φ(1.96) ≈ 0.975", () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });
  it("Φ(-1.96) ≈ 0.025", () => {
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
  it("Φ(2.576) ≈ 0.995", () => {
    expect(normalCdf(2.576)).toBeCloseTo(0.995, 3);
  });
  it("symmetric: Φ(-z) + Φ(z) = 1", () => {
    for (const z of [0.5, 1, 1.5, 2, 2.5, 3]) {
      expect(normalCdf(-z) + normalCdf(z)).toBeCloseTo(1, 6);
    }
  });
});

describe("normalInv", () => {
  it("normalInv(0.5) = 0", () => {
    expect(normalInv(0.5)).toBeCloseTo(0, 6);
  });
  it("normalInv(0.975) ≈ 1.96", () => {
    expect(normalInv(0.975)).toBeCloseTo(1.96, 2);
  });
  it("normalInv(0.995) ≈ 2.576", () => {
    expect(normalInv(0.995)).toBeCloseTo(2.576, 2);
  });
  it("inverse of normalCdf", () => {
    for (const p of [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9]) {
      const z = normalInv(p);
      expect(normalCdf(z)).toBeCloseTo(p, 6);
    }
  });
});

describe("studentTCdf", () => {
  it("t=0 at any df gives 0.5", () => {
    for (const df of [1, 5, 30, 100]) {
      expect(studentTCdf(0, df)).toBeCloseTo(0.5, 6);
    }
  });
  it("matches normal for large df", () => {
    for (const t of [-2, -1, 1, 2]) {
      expect(studentTCdf(t, 10000)).toBeCloseTo(normalCdf(t), 3);
    }
  });
  it("known value: P(T_10 ≤ 2.228) ≈ 0.975", () => {
    expect(studentTCdf(2.228, 10)).toBeCloseTo(0.975, 3);
  });
  it("known value: P(T_30 ≤ 2.042) ≈ 0.975", () => {
    expect(studentTCdf(2.042, 30)).toBeCloseTo(0.975, 3);
  });
});

describe("studentTInv", () => {
  it("studentTInv(0.5, df) = 0", () => {
    expect(studentTInv(0.5, 20)).toBeCloseTo(0, 5);
  });
  it("two-sided 95% critical value at df=10 ≈ 2.228", () => {
    expect(studentTInv(0.975, 10)).toBeCloseTo(2.228, 2);
  });
});

describe("twoProportionTest", () => {
  it("rejects when there is a real difference", () => {
    // 130/1000 vs 100/1000: p_pool=0.115, SE=√(0.115·0.885·0.002)=0.01427,
    // z=(0.13-0.10)/0.01427=2.103 (pooled-variance z-test).
    const r = twoProportionTest({
      controlConversions: 100,
      controlTotal: 1000,
      treatmentConversions: 130,
      treatmentTotal: 1000,
    });
    expect(r.zStatistic).toBeCloseTo(2.103, 2);
    expect(r.pValue).toBeLessThan(0.05);
    expect(r.significant).toBe(true);
    expect(r.lift).toBeCloseTo(0.03, 6);
    expect(r.liftRelative).toBeCloseTo(0.3, 4);
  });

  it("fails to reject when groups are identical", () => {
    const r = twoProportionTest({
      controlConversions: 100,
      controlTotal: 1000,
      treatmentConversions: 100,
      treatmentTotal: 1000,
    });
    expect(r.pValue).toBeCloseTo(1, 3);
    expect(r.significant).toBe(false);
  });

  it("one-sided alternative narrows p-value", () => {
    const ts = twoProportionTest({
      controlConversions: 100,
      controlTotal: 1000,
      treatmentConversions: 130,
      treatmentTotal: 1000,
      alternative: "two-sided",
    });
    const gt = twoProportionTest({
      controlConversions: 100,
      controlTotal: 1000,
      treatmentConversions: 130,
      treatmentTotal: 1000,
      alternative: "greater",
    });
    expect(gt.pValue).toBeCloseTo(ts.pValue / 2, 5);
  });

  it("confidence interval contains true lift in a well-powered case", () => {
    const r = twoProportionTest({
      controlConversions: 1000,
      controlTotal: 10000,
      treatmentConversions: 1100,
      treatmentTotal: 10000,
    });
    expect(r.confidenceInterval.lower).toBeLessThan(0.01);
    expect(r.confidenceInterval.upper).toBeGreaterThan(0.01);
  });

  it("post-hoc power is high for large effects", () => {
    const r = twoProportionTest({
      controlConversions: 100,
      controlTotal: 1000,
      treatmentConversions: 200,
      treatmentTotal: 1000,
    });
    expect(r.power).toBeGreaterThan(0.99);
  });
});

describe("welchTTest", () => {
  it("rejects clearly different means", () => {
    const r = welchTTest({
      control: { mean: 10, variance: 4, n: 100 },
      treatment: { mean: 11, variance: 4, n: 100 },
    });
    // SE = sqrt(4/100 + 4/100) = sqrt(0.08) ≈ 0.2828
    // t = 1 / 0.2828 ≈ 3.536, df ≈ 198, two-sided p ≈ 0.0005
    expect(r.tStatistic).toBeCloseTo(3.536, 2);
    expect(r.pValue).toBeLessThan(0.001);
    expect(r.significant).toBe(true);
  });

  it("does not reject identical means", () => {
    const r = welchTTest({
      control: { mean: 10, variance: 4, n: 50 },
      treatment: { mean: 10, variance: 4, n: 50 },
    });
    expect(r.pValue).toBeCloseTo(1, 5);
    expect(r.significant).toBe(false);
  });

  it("CI contains zero when treatment effect is null", () => {
    const r = welchTTest({
      control: { mean: 10, variance: 4, n: 50 },
      treatment: { mean: 10.01, variance: 4, n: 50 },
    });
    expect(r.confidenceInterval.lower).toBeLessThan(0);
    expect(r.confidenceInterval.upper).toBeGreaterThan(0);
  });

  it("throws when n < 2", () => {
    expect(() =>
      welchTTest({
        control: { mean: 10, variance: 4, n: 1 },
        treatment: { mean: 11, variance: 4, n: 100 },
      })
    ).toThrow(/n >= 2/);
  });
});

describe("wilsonInterval", () => {
  it("50/100 ≈ (0.404, 0.595)", () => {
    const ci = wilsonInterval(50, 100);
    expect(ci.lower).toBeCloseTo(0.404, 2);
    expect(ci.upper).toBeCloseTo(0.595, 2);
  });

  it("never returns out-of-range values", () => {
    const allSuccess = wilsonInterval(100, 100);
    expect(allSuccess.lower).toBeGreaterThanOrEqual(0);
    expect(allSuccess.upper).toBeLessThanOrEqual(1);
    const noSuccess = wilsonInterval(0, 100);
    expect(noSuccess.lower).toBeGreaterThanOrEqual(0);
    expect(noSuccess.upper).toBeLessThanOrEqual(1);
  });

  it("handles n=0 gracefully", () => {
    const ci = wilsonInterval(0, 0);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBe(1);
  });
});

describe("normalInterval", () => {
  it("± 1.96 * SE at α=0.05", () => {
    const ci = normalInterval(10, 1, 0.05);
    expect(ci.lower).toBeCloseTo(10 - 1.96, 2);
    expect(ci.upper).toBeCloseTo(10 + 1.96, 2);
  });
});

describe("sampleSizeForProportion", () => {
  it("textbook: baseline=0.10, MDE=0.02 absolute → ~3833 per group at 80% power, α=0.05", () => {
    const r = sampleSizeForProportion({
      baselineRate: 0.1,
      minimumDetectableEffect: 0.02,
      effectType: "absolute",
      alpha: 0.05,
      power: 0.8,
    });
    // Published value ~3833. Accept ±2% tolerance — formula slightly varies.
    expect(r.perGroup).toBeGreaterThan(3700);
    expect(r.perGroup).toBeLessThan(4000);
    expect(r.total).toBe(r.perGroup * 2);
  });

  it("relative MDE of 20% on baseline 0.10 = absolute 0.02", () => {
    const abs = sampleSizeForProportion({
      baselineRate: 0.1,
      minimumDetectableEffect: 0.02,
      effectType: "absolute",
    });
    const rel = sampleSizeForProportion({
      baselineRate: 0.1,
      minimumDetectableEffect: 0.2,
      effectType: "relative",
    });
    expect(rel.perGroup).toBe(abs.perGroup);
  });

  it("higher power requires larger N", () => {
    const p80 = sampleSizeForProportion({
      baselineRate: 0.1,
      minimumDetectableEffect: 0.02,
      power: 0.8,
    });
    const p95 = sampleSizeForProportion({
      baselineRate: 0.1,
      minimumDetectableEffect: 0.02,
      power: 0.95,
    });
    expect(p95.perGroup).toBeGreaterThan(p80.perGroup);
  });
});

describe("sampleSizeForMean", () => {
  it("standard formula: n = 2 σ² (z_{α/2} + z_β)² / δ²", () => {
    // σ=1, δ=0.5, α=0.05, power=0.8 → expected ≈ 63 per group
    const r = sampleSizeForMean({
      stdDev: 1,
      minimumDetectableEffect: 0.5,
    });
    expect(r.perGroup).toBeGreaterThanOrEqual(63);
    expect(r.perGroup).toBeLessThanOrEqual(64);
  });

  it("rejects nonsense input", () => {
    expect(() => sampleSizeForMean({ stdDev: -1, minimumDetectableEffect: 1 })).toThrow();
    expect(() => sampleSizeForMean({ stdDev: 1, minimumDetectableEffect: 0 })).toThrow();
  });
});

describe("applyCUPED", () => {
  it("zero correlation → no variance reduction, theta near 0", () => {
    const observations = Array.from({ length: 1000 }, (_, i) => ({
      x: Math.sin(i),
      y: Math.cos(i),
    }));
    const r = applyCUPED(observations);
    expect(Math.abs(r.theta)).toBeLessThan(0.1);
    expect(Math.abs(r.varianceReduction)).toBeLessThan(0.1);
  });

  it("perfect correlation (Y = 2X) → ~100% variance reduction, theta ≈ 2", () => {
    const observations = Array.from({ length: 100 }, (_, i) => ({
      x: i / 100,
      y: 2 * (i / 100),
    }));
    const r = applyCUPED(observations);
    expect(r.theta).toBeCloseTo(2, 4);
    expect(r.varianceReduction).toBeGreaterThan(0.999);
    expect(r.adjustedMean).toBeCloseTo(r.originalMean, 6);
  });

  it("partial correlation → partial variance reduction", () => {
    // Construct Y = X + ε with known correlation
    const observations = Array.from({ length: 5000 }, (_, i) => {
      const x = ((i * 1234567) % 1000) / 1000; // pseudo-random in [0,1)
      const noise = (((i * 7654321) % 1000) / 1000 - 0.5) * 0.5;
      return { x, y: x + noise };
    });
    const r = applyCUPED(observations);
    expect(r.varianceReduction).toBeGreaterThan(0.3);
    expect(r.varianceReduction).toBeLessThan(1);
  });

  it("throws on tiny inputs", () => {
    expect(() => applyCUPED([{ x: 1, y: 1 }])).toThrow();
  });
});

describe("mSPRT", () => {
  it("under H0 (no effect), p-value stays well above α with high probability", () => {
    const state0 = createMSPRTState({ tau2: 0.01, sigma2: 1 });
    let state = state0;
    // Simulate 1000 observations with zero true effect.
    let rng = 12345;
    const next = () => {
      rng = (rng * 16807) % 2147483647;
      return (rng / 2147483647 - 0.5) * 2; // uniform [-1, 1]; ~symmetric
    };
    for (let i = 0; i < 1000; i++) {
      state = updateMSPRT(state, { diff: next() });
    }
    expect(mSPRTPValue(state)).toBeGreaterThan(0.05);
  });

  it("under H1 (real effect), accumulates evidence", () => {
    let state = createMSPRTState({ tau2: 0.01, sigma2: 1 });
    for (let i = 0; i < 1000; i++) {
      state = updateMSPRT(state, { diff: 0.2 });
    }
    expect(mSPRTPValue(state)).toBeLessThan(0.01);
  });

  it("returns 1 before any observation", () => {
    const state = createMSPRTState({ tau2: 0.01, sigma2: 1 });
    expect(mSPRTPValue(state)).toBe(1);
  });
});

describe("Thompson sampling", () => {
  it("returns one score per arm in [0, 1]", () => {
    const samples = thompsonSample([
      { arm: "A", successes: 10, failures: 10 },
      { arm: "B", successes: 20, failures: 5 },
    ]);
    expect(samples.length).toBe(2);
    for (const s of samples) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
  });

  it("prefers higher-performing arm over many draws", () => {
    const arms = [
      { arm: "low", successes: 10, failures: 90 },
      { arm: "high", successes: 90, failures: 10 },
    ];
    const counts: Record<string, number> = { low: 0, high: 0 };
    for (let i = 0; i < 200; i++) {
      counts[pickArmThompson(arms)]++;
    }
    expect(counts.high).toBeGreaterThan(counts.low * 3);
  });
});

describe("UCB1", () => {
  it("unpulled arms always score Infinity (pure exploration)", () => {
    const scores = ucb1([
      { arm: "A", mean: 0.5, pulls: 10 },
      { arm: "B", mean: 0.5, pulls: 0 },
    ]);
    const B = scores.find((s) => s.arm === "B")!;
    expect(B.score).toBe(Infinity);
  });

  it("higher mean and lower pull count → higher score", () => {
    const scores = ucb1([
      { arm: "A", mean: 0.4, pulls: 100 },
      { arm: "B", mean: 0.5, pulls: 100 },
    ]);
    const A = scores.find((s) => s.arm === "A")!;
    const B = scores.find((s) => s.arm === "B")!;
    expect(B.score).toBeGreaterThan(A.score);
  });
});

describe("epsilonGreedy", () => {
  it("with ε=0, always picks the empirical leader", () => {
    const arm = epsilonGreedy(
      [
        { arm: "A", mean: 0.4 },
        { arm: "B", mean: 0.5 },
      ],
      0
    );
    expect(arm).toBe("B");
  });
  it("with ε=1, samples uniformly from arms", () => {
    const counts: Record<string, number> = { A: 0, B: 0 };
    for (let i = 0; i < 1000; i++) {
      counts[epsilonGreedy([{ arm: "A", mean: 0 }, { arm: "B", mean: 0 }], 1)]++;
    }
    // Within 3σ of 500/500
    expect(counts.A).toBeGreaterThan(400);
    expect(counts.A).toBeLessThan(600);
  });
});
