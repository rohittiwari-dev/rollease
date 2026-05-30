# Rollease SDK — Statistics Engine

> **Module:** `rollease/stats`
> **Purpose:** Analyze A/B test outcomes in your own code without shipping data to Statsig/GrowthBook.

The stats module is a pure-math library — no flags, no DB, no I/O. Feed it counts and means; it returns p-values, confidence intervals, sample-size requirements, and bandit scores.

---

## When to use what

| You have… | Use |
|-----------|-----|
| Two conversion-rate samples (clicks / opens / signups) | `twoProportionTest` |
| Two continuous-metric samples (revenue, latency, time-on-page) | `welchTTest` |
| One conversion rate, want a CI | `wilsonInterval` |
| Need to know "how many users do I need?" | `sampleSizeForProportion` / `sampleSizeForMean` |
| A pre-experiment covariate (e.g. last week's metric) | `applyCUPED` |
| Want to peek at results before the experiment ends | `mSPRT` (always-valid p-values) |
| Running a multi-arm bandit | `thompsonSample` / `ucb1` / `epsilonGreedy` |

---

## Two-Proportion Test (Conversion Rates)

```ts
import { twoProportionTest } from "rollease/stats";

const result = twoProportionTest({
  controlConversions: 100,
  controlTotal: 1000,
  treatmentConversions: 130,
  treatmentTotal: 1000,
  alpha: 0.05,                    // optional, default 0.05
  alternative: "two-sided",       // "two-sided" | "greater" | "less"
});

result.zStatistic        // 2.103
result.pValue            // 0.0354
result.lift              // 0.03  (absolute)
result.liftRelative      // 0.30  (30% relative lift)
result.confidenceInterval // { lower: 0.002, upper: 0.058 }
result.significant       // true
result.power             // 0.567 — post-hoc power for the observed effect
```

The test uses **pooled variance** for the z-statistic (most powerful under H0) and **unpooled variance** for the confidence interval (Newcombe 1998 — more accurate when rates diverge).

### Wiring into your evaluation loop

```ts
import { twoProportionTest } from "rollease/stats";

async function analyzeExperiment(flagKey: string) {
  const control = await db.impressions.aggregateByVariant(flagKey, "control");
  const treatment = await db.impressions.aggregateByVariant(flagKey, "treatment");

  const r = twoProportionTest({
    controlConversions: control.conversions,
    controlTotal: control.exposures,
    treatmentConversions: treatment.conversions,
    treatmentTotal: treatment.exposures,
  });

  if (r.significant && r.lift > 0) {
    await notifySlack(`#growth`, `${flagKey} winning: +${(r.liftRelative * 100).toFixed(1)}% (p=${r.pValue.toFixed(4)})`);
  }
}
```

---

## Welch's t-test (Continuous Metrics)

For revenue, latency, time-on-page — anything continuous. Uses **Welch's** variant (does *not* assume equal variances) and Welch-Satterthwaite df.

```ts
import { welchTTest } from "rollease/stats";

const r = welchTTest({
  control:   { mean: 24.50, variance: 12.3, n: 1500 },
  treatment: { mean: 26.10, variance: 13.1, n: 1500 },
});

r.meanDiff             // 1.60
r.tStatistic           // 3.92
r.degreesOfFreedom     // 2997.4
r.pValue               // 0.00009
r.confidenceInterval   // { lower: 0.80, upper: 2.40 }
r.significant          // true
```

> **Variance must be the *sample* variance** — i.e. `Σ(x - x̄)² / (n - 1)`, not `1/n`. Most aggregation queries return this by default (`VAR_SAMP` in Postgres).

### From raw observations

If you have raw values rather than summary stats:

```ts
function summary(xs: number[]) {
  const n = xs.length;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return { mean, variance, n };
}

const r = welchTTest({
  control: summary(controlValues),
  treatment: summary(treatmentValues),
});
```

---

## Confidence Intervals

### Wilson interval (proportions)

More accurate than Wald, especially for small N or extreme rates. Always in `[0, 1]`.

```ts
import { wilsonInterval } from "rollease/stats";

wilsonInterval(50, 100);            // { lower: 0.404, upper: 0.596, midpoint: 0.500 }
wilsonInterval(100, 100, 0.01);     // 99% CI: { lower: 0.964, upper: 1.000, ... }
wilsonInterval(0, 50);              // { lower: 0, upper: 0.071, midpoint: 0.036 }
```

### Normal-approximation interval (any quantity with known SE)

```ts
import { normalInterval } from "rollease/stats";

normalInterval(10.0, 0.5);          // 95% CI: { lower: 9.02, upper: 10.98 }
normalInterval(10.0, 0.5, 0.01);    // 99% CI: { lower: 8.71, upper: 11.29 }
```

---

## Sample Size Calculation

Answer the pre-experiment question: "How long must this test run?"

### For conversion rates

```ts
import { sampleSizeForProportion } from "rollease/stats";

// "We have a 10% baseline. We want to detect a +2 percentage point lift
//  with 80% power at α=0.05."
const { perGroup, total } = sampleSizeForProportion({
  baselineRate: 0.10,
  minimumDetectableEffect: 0.02,
  effectType: "absolute",
  alpha: 0.05,
  power: 0.80,
});
// perGroup ≈ 3833, total ≈ 7666
```

Use `effectType: "relative"` to express the MDE as a percentage of baseline:

```ts
// "Detect a 20% lift relative to baseline" (= 10% → 12%)
sampleSizeForProportion({
  baselineRate: 0.10,
  minimumDetectableEffect: 0.20,
  effectType: "relative",
});
// Same result as MDE 0.02 absolute.
```

### For continuous metrics

```ts
import { sampleSizeForMean } from "rollease/stats";

// "Detect a $0.50 lift on revenue per user, σ=$2.00"
sampleSizeForMean({
  stdDev: 2.0,
  minimumDetectableEffect: 0.50,
});
// perGroup ≈ 252
```

---

## CUPED (Variance Reduction)

CUPED uses a *pre-experiment* covariate (e.g. the same metric measured in the week before the test) to shrink variance, reducing required sample size by 30-50% for sticky metrics.

```ts
import { applyCUPED, welchTTest } from "rollease/stats";

// One observation per user: pre-period metric (X) + experiment metric (Y).
const obs = users.map((u) => ({
  x: u.preExperimentRevenue,
  y: u.experimentRevenue,
}));

const cuped = applyCUPED(obs);
cuped.theta              // 0.85 — optimal coefficient
cuped.varianceReduction  // 0.42 — 42% variance reduction
cuped.adjustedValues     // Y - θ·(X - mean(X))

// Now run Welch's t-test on the *adjusted* values.
const controlAdj = cuped.adjustedValues.slice(0, 1500);
const treatmentAdj = cuped.adjustedValues.slice(1500);

function summary(xs: number[]) { /* ... */ }
const r = welchTTest({
  control: summary(controlAdj),
  treatment: summary(treatmentAdj),
});
```

> CUPED only works when the covariate is measured **before** the experiment starts. Using a post-treatment variable invalidates the test.

---

## Sequential Testing (Peeking Allowed)

Traditional fixed-horizon tests break when you peek at p-values before the planned sample size — your Type I error inflates massively. **mSPRT** (mixture Sequential Probability Ratio Test) gives you *always-valid* p-values: stop whenever you want, no penalty.

```ts
import { createMSPRTState, updateMSPRT, mSPRTPValue } from "rollease/stats";

// tau2 encodes the expected scale of the true effect.
//   Rule of thumb: tau = (your MDE) / 3 → ~99% prior mass within ±MDE.
// sigma2 is the per-observation noise variance.
let state = createMSPRTState({ tau2: 0.01, sigma2: 1.0 });

for await (const event of impressionStream(flagKey)) {
  const diff = event.treatmentValue - event.controlValue;
  state = updateMSPRT(state, { diff });

  const p = mSPRTPValue(state);
  if (p < 0.05) {
    console.log(`Significant at n=${state.n}, stopping`);
    await rampUpFlag(flagKey);
    break;
  }
}
```

mSPRT trades some power for the "stop anytime" guarantee. If you can commit to a fixed sample size up front, use `twoProportionTest` or `welchTTest` instead — they have more power.

---

## Multi-Armed Bandit

For "explore-then-exploit" rollouts where you want traffic to gradually shift toward the winner.

### Thompson sampling (Beta-Bernoulli)

Pure Bayesian — samples from each arm's posterior, picks the highest. Self-balancing.

```ts
import { pickArmThompson } from "rollease/stats";

// Each arm's running totals from your impressions table.
const arms = [
  { arm: "blue_button",   successes: 145, failures: 855  },
  { arm: "orange_button", successes: 168, failures: 832  },
  { arm: "green_button",  successes: 132, failures: 868  },
];

// On every new visitor, ask which arm to serve:
const variant = pickArmThompson(arms);

// Persist the chosen arm so the evaluator returns it stickily on the next
// evaluate() (reason: "assignment"). setUserAssignment is a DbAdapter method
// — call it on the adapter you passed as `config.db`, not on rl.flags.
await db.setUserAssignment("button_color_exp", visitorId, variant);
```

Or get raw scores for custom logic:

```ts
import { thompsonSample } from "rollease/stats";

const scored = thompsonSample(arms);
// [{ arm: 'blue_button', score: 0.143 }, { arm: 'orange_button', score: 0.181 }, ...]
```

### UCB1

Deterministic alternative — picks the arm with the highest **upper confidence bound** on its mean. Unpulled arms score `Infinity` so they're always tried first.

```ts
import { ucb1 } from "rollease/stats";

const scored = ucb1([
  { arm: "A", mean: 0.12, pulls: 500 },
  { arm: "B", mean: 0.15, pulls: 400 },
  { arm: "C", mean: 0.10, pulls: 100 },
]);
const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
```

### ε-greedy

Simplest baseline. With probability `ε`, pull a random arm; otherwise pull the empirical leader.

```ts
import { epsilonGreedy } from "rollease/stats";

const arm = epsilonGreedy(
  [
    { arm: "A", mean: 0.12 },
    { arm: "B", mean: 0.15 },
  ],
  0.1  // 10% exploration
);
```

---

## Distributions (low-level)

Exposed for custom analyses:

```ts
import { normalCdf, normalInv, studentTCdf, studentTInv } from "rollease/stats";

normalCdf(1.96)        // 0.9750
normalInv(0.975)       // 1.9600
studentTCdf(2.228, 10) // 0.9750 (df=10)
studentTInv(0.975, 30) // 2.0423
```

---

## Wiring into the experiment hook layer

The stats engine pairs naturally with `createExperimentHooks` for live analysis:

```ts
import { createRollease, createMemoryAdapter } from "rollease";
import { createExperimentHooks } from "rollease";
import { twoProportionTest } from "rollease/stats";

const exposures = new Map<string, { conversions: number; total: number }>();

const rl = createRollease({
  db: createMemoryAdapter(),
  secret: process.env.ROLLEASE_SECRET!,
  hooks: createExperimentHooks({
    onExpose: (result, ctx) => {
      const key = `${result.key}:${result.variant}`;
      const e = exposures.get(key) ?? { conversions: 0, total: 0 };
      e.total++;
      exposures.set(key, e);
    },
    onConvert: (eventName, ctx, details) => {
      const key = `${details.flagKey}:${details.variant}`;
      const e = exposures.get(key);
      if (e) e.conversions++;
    },
  }),
});

// Periodic analysis:
setInterval(() => {
  const ctl = exposures.get("checkout_v2:control")!;
  const trt = exposures.get("checkout_v2:treatment")!;
  const r = twoProportionTest({
    controlConversions: ctl.conversions, controlTotal: ctl.total,
    treatmentConversions: trt.conversions, treatmentTotal: trt.total,
  });
  console.log(`p=${r.pValue}, lift=${(r.liftRelative * 100).toFixed(1)}%`);
}, 60_000);
```

---

## References

- Newcombe (1998) — *Interval estimation for the difference between independent proportions* (CI methodology)
- Welch (1947) — *The generalization of "Student's" problem when several different population variances are involved*
- Deng et al. (2013) — *Improving the sensitivity of online controlled experiments by utilizing pre-experiment data* (CUPED)
- Johari et al. (2017) — *Peeking at A/B Tests: Why it matters, and what to do about it* (mSPRT)
- Auer (2002) — *Finite-time analysis of the multiarmed bandit problem* (UCB1)
- Thompson (1933) — *On the likelihood that one unknown probability exceeds another in view of the evidence of two samples* (Thompson sampling)
