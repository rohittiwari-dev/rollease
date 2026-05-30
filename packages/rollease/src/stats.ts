// ============================================================================
// Rollease SDK — Statistics Engine
// ----------------------------------------------------------------------------
// Frequentist + Bayesian primitives for A/B test analysis.
//
//   • Distributions:  normal & Student-t CDF / inverse
//   • Hypothesis tests: two-proportion z-test, Welch's t-test
//   • Confidence intervals: Wilson (proportions), t-based (means)
//   • Sample size: required N for a target power and minimum detectable effect
//   • Variance reduction: CUPED
//   • Sequential testing: mSPRT (always-valid p-values)
//   • Multi-armed bandit: Thompson sampling, UCB1, ε-greedy
//
// References:
//   Abramowitz & Stegun §7.1.26 (erf), §26.2 (normal CDF)
//   Beasley & Springer (1977) "Algorithm AS 111" — inverse normal CDF
//   Numerical Recipes 3e §6.4 (incomplete beta via Lentz's method)
//   Lanczos (1964) — log gamma
//   Deng et al. (2013) "Improving the sensitivity of online controlled experiments
//     by utilizing pre-experiment data" — CUPED
//   Johari et al. (2017) "Peeking at A/B Tests: Why it matters, and what to do
//     about it" — mSPRT for always-valid inference
//   Auer (2002) — UCB1
//   Thompson (1933) — Bayesian arm selection
// ============================================================================

// ── Distributions ───────────────────────────────────────────────────────────

/**
 * Standard normal CDF Φ(z) using Abramowitz & Stegun 7.1.26 (max error 1.5e-7).
 * Symmetric: `normalCdf(-z) === 1 - normalCdf(z)`.
 */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  // erf approximation
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const erf =
    1 -
    (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

/**
 * Inverse standard normal CDF (quantile). Beasley-Springer-Moro algorithm.
 * Accurate to ~1e-9 over the full open interval.
 */
export function normalInv(p: number): number {
  if (p <= 0 || p >= 1) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  // Beasley-Springer-Moro
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];

  const plow = 0.02425;
  const phigh = 1 - plow;

  let q: number, r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  q = p - 0.5;
  r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/**
 * Student's t-distribution CDF. Two-tailed via symmetry.
 * Uses the regularized incomplete beta function for arbitrary df > 0.
 *
 *   P(T ≤ t) = 1 - 0.5 * I_x(df/2, 1/2)   where x = df / (df + t²)   for t ≥ 0
 *   P(T ≤ t) = 0.5 * I_x(df/2, 1/2)       where x = df / (df + t²)   for t < 0
 */
export function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return NaN;
  if (t === 0) return 0.5;
  const x = df / (df + t * t);
  const ib = regularizedIncompleteBeta(x, df / 2, 0.5);
  return t > 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

/**
 * Inverse Student's t (quantile). Bisection on `studentTCdf` — adequate for
 * SDK use; not the fastest possible.
 */
export function studentTInv(p: number, df: number): number {
  if (p <= 0 || p >= 1 || df <= 0) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  // Bracket via normal quantile (good initial guess for moderate df).
  let lo = -1e6;
  let hi = 1e6;
  const target = p;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const v = studentTCdf(mid, df);
    if (Math.abs(v - target) < 1e-10) return mid;
    if (v < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── Two-Proportion Z-Test ────────────────────────────────────────────────────

export interface ProportionTestInput {
  controlConversions: number;
  controlTotal: number;
  treatmentConversions: number;
  treatmentTotal: number;
  /** Significance level (default 0.05). */
  alpha?: number;
  /** Alternative hypothesis (default "two-sided"). */
  alternative?: "two-sided" | "greater" | "less";
}

export interface ProportionTestResult {
  controlRate: number;
  treatmentRate: number;
  /** Absolute lift = treatmentRate - controlRate. */
  lift: number;
  /** Relative lift = (treatment - control) / control. NaN when control is 0. */
  liftRelative: number;
  zStatistic: number;
  pValue: number;
  /** Two-sided CI for the absolute lift at level 1-α. */
  confidenceInterval: { lower: number; upper: number };
  significant: boolean;
  /** Post-hoc power: P(reject H0 | observed effect is true). */
  power: number;
}

/**
 * Two-proportion z-test for the difference between conversion rates. Uses the
 * pooled-variance estimator for the test statistic and unpooled variance for
 * the confidence interval (Newcombe 1998 recommends this combination).
 */
export function twoProportionTest(
  input: ProportionTestInput
): ProportionTestResult {
  const { controlConversions: xC, controlTotal: nC } = input;
  const { treatmentConversions: xT, treatmentTotal: nT } = input;
  const alpha = input.alpha ?? 0.05;
  const alt = input.alternative ?? "two-sided";

  validateCount(xC, nC, "control");
  validateCount(xT, nT, "treatment");

  const pC = nC === 0 ? 0 : xC / nC;
  const pT = nT === 0 ? 0 : xT / nT;
  const lift = pT - pC;
  const liftRelative = pC === 0 ? NaN : lift / pC;

  // Pooled variance for the z statistic.
  const pPool = (xC + xT) / (nC + nT);
  const sePool = Math.sqrt(pPool * (1 - pPool) * (1 / nC + 1 / nT));
  const z = sePool === 0 ? 0 : lift / sePool;

  // Two-sided p-value via symmetry; one-sided handled by alternative.
  const pValue =
    alt === "two-sided"
      ? 2 * (1 - normalCdf(Math.abs(z)))
      : alt === "greater"
        ? 1 - normalCdf(z)
        : normalCdf(z);

  // Unpooled SE for the CI of the difference (more accurate when rates differ).
  const seDiff = Math.sqrt(
    (pC * (1 - pC)) / nC + (pT * (1 - pT)) / nT
  );
  const zCrit = normalInv(1 - alpha / 2);
  const confidenceInterval = {
    lower: lift - zCrit * seDiff,
    upper: lift + zCrit * seDiff,
  };

  const significant = pValue < alpha;

  // Post-hoc power for observed effect at the same α.
  const power = proportionPower({
    p1: pC,
    p2: pT,
    n1: nC,
    n2: nT,
    alpha,
    alternative: alt,
  });

  return {
    controlRate: pC,
    treatmentRate: pT,
    lift,
    liftRelative,
    zStatistic: z,
    pValue,
    confidenceInterval,
    significant,
    power,
  };
}

function proportionPower(opts: {
  p1: number;
  p2: number;
  n1: number;
  n2: number;
  alpha: number;
  alternative: "two-sided" | "greater" | "less";
}): number {
  const { p1, p2, n1, n2, alpha, alternative } = opts;
  if (n1 === 0 || n2 === 0) return 0;
  const seAlt = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  if (seAlt === 0) return p1 === p2 ? alpha : 1;
  const zAlpha = alternative === "two-sided" ? normalInv(1 - alpha / 2) : normalInv(1 - alpha);
  const effect = Math.abs(p2 - p1) / seAlt;
  return 1 - normalCdf(zAlpha - effect);
}

// ── Welch's t-test (Continuous Means) ────────────────────────────────────────

export interface WelchTTestInput {
  control: { mean: number; variance: number; n: number };
  treatment: { mean: number; variance: number; n: number };
  alpha?: number;
  alternative?: "two-sided" | "greater" | "less";
}

export interface WelchTTestResult {
  meanDiff: number;
  tStatistic: number;
  degreesOfFreedom: number;
  pValue: number;
  confidenceInterval: { lower: number; upper: number };
  significant: boolean;
}

/**
 * Welch's two-sample t-test — does NOT assume equal variances. Use for
 * comparing means of any continuous metric (revenue, latency, time-on-page).
 *
 * Variance must be the *sample* variance (Σ(x - x̄)² / (n - 1)).
 */
export function welchTTest(input: WelchTTestInput): WelchTTestResult {
  const { control: c, treatment: t } = input;
  const alpha = input.alpha ?? 0.05;
  const alt = input.alternative ?? "two-sided";

  if (c.n < 2 || t.n < 2) {
    throw new Error("welchTTest requires n >= 2 in each group");
  }
  if (c.variance < 0 || t.variance < 0) {
    throw new Error("welchTTest variances must be non-negative");
  }

  const meanDiff = t.mean - c.mean;
  const seC2 = c.variance / c.n;
  const seT2 = t.variance / t.n;
  const se = Math.sqrt(seC2 + seT2);
  const tStat = se === 0 ? 0 : meanDiff / se;

  // Welch-Satterthwaite degrees of freedom.
  const numerator = (seC2 + seT2) ** 2;
  const denominator =
    (seC2 * seC2) / (c.n - 1) + (seT2 * seT2) / (t.n - 1);
  const df = denominator === 0 ? c.n + t.n - 2 : numerator / denominator;

  const pValue =
    alt === "two-sided"
      ? 2 * (1 - studentTCdf(Math.abs(tStat), df))
      : alt === "greater"
        ? 1 - studentTCdf(tStat, df)
        : studentTCdf(tStat, df);

  const tCrit = studentTInv(1 - alpha / 2, df);
  const confidenceInterval = {
    lower: meanDiff - tCrit * se,
    upper: meanDiff + tCrit * se,
  };

  return {
    meanDiff,
    tStatistic: tStat,
    degreesOfFreedom: df,
    pValue,
    confidenceInterval,
    significant: pValue < alpha,
  };
}

// ── Confidence Intervals ─────────────────────────────────────────────────────

/**
 * Wilson score interval for a binomial proportion. More accurate than the
 * Wald interval, especially for small n or extreme p̂. Always within [0, 1].
 */
export function wilsonInterval(
  successes: number,
  total: number,
  alpha = 0.05
): { lower: number; upper: number; midpoint: number } {
  validateCount(successes, total, "wilsonInterval");
  if (total === 0) return { lower: 0, upper: 1, midpoint: 0.5 };
  const z = normalInv(1 - alpha / 2);
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const half =
    (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return {
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
    midpoint: center,
  };
}

/** Normal-approximation CI for a quantity with known SE. */
export function normalInterval(
  estimate: number,
  stdError: number,
  alpha = 0.05
): { lower: number; upper: number } {
  const z = normalInv(1 - alpha / 2);
  return { lower: estimate - z * stdError, upper: estimate + z * stdError };
}

// ── Sample Size Calculators ──────────────────────────────────────────────────

export interface ProportionSampleSizeInput {
  baselineRate: number;
  /** Minimum effect we want to detect. */
  minimumDetectableEffect: number;
  /** Whether MDE is absolute (e.g. 0.02) or relative to baseline (e.g. 0.05). */
  effectType?: "absolute" | "relative";
  alpha?: number;
  power?: number;
  alternative?: "two-sided" | "one-sided";
}

/**
 * Required sample size per group for a two-proportion test at the given
 * power and significance level.
 *
 *   n_per_group = (z_{α/2} + z_β)² * (p_C(1-p_C) + p_T(1-p_T)) / (p_T - p_C)²
 */
export function sampleSizeForProportion(
  input: ProportionSampleSizeInput
): { perGroup: number; total: number } {
  const baseline = input.baselineRate;
  const alpha = input.alpha ?? 0.05;
  const power = input.power ?? 0.8;
  const effectType = input.effectType ?? "absolute";
  const alt = input.alternative ?? "two-sided";

  if (baseline < 0 || baseline > 1) {
    throw new Error("baselineRate must be in [0, 1]");
  }
  if (input.minimumDetectableEffect === 0) {
    throw new Error("minimumDetectableEffect must be non-zero");
  }

  const absoluteEffect =
    effectType === "absolute"
      ? input.minimumDetectableEffect
      : baseline * input.minimumDetectableEffect;
  const treatmentRate = baseline + absoluteEffect;
  if (treatmentRate < 0 || treatmentRate > 1) {
    throw new Error(
      `Implied treatmentRate ${treatmentRate} falls outside [0, 1]`
    );
  }

  const zAlpha = alt === "two-sided" ? normalInv(1 - alpha / 2) : normalInv(1 - alpha);
  const zBeta = normalInv(power);
  const pVar = baseline * (1 - baseline) + treatmentRate * (1 - treatmentRate);
  const perGroup = Math.ceil(
    ((zAlpha + zBeta) ** 2 * pVar) / (absoluteEffect ** 2)
  );
  return { perGroup, total: perGroup * 2 };
}

export interface MeanSampleSizeInput {
  /** Expected baseline mean (informational, not used in formula). */
  baselineMean?: number;
  /** Population (or pooled) standard deviation. */
  stdDev: number;
  /** Minimum detectable mean difference (treatment - control). */
  minimumDetectableEffect: number;
  alpha?: number;
  power?: number;
  alternative?: "two-sided" | "one-sided";
}

/**
 * Required sample size per group for a two-sample t-test on continuous means.
 *
 *   n_per_group = 2 * σ² * (z_{α/2} + z_β)² / δ²
 *
 * Uses the normal approximation for the critical value — refine with the t
 * inverse for very small samples if you need stricter calibration.
 */
export function sampleSizeForMean(
  input: MeanSampleSizeInput
): { perGroup: number; total: number } {
  if (input.stdDev <= 0) throw new Error("stdDev must be positive");
  if (input.minimumDetectableEffect === 0)
    throw new Error("minimumDetectableEffect must be non-zero");
  const alpha = input.alpha ?? 0.05;
  const power = input.power ?? 0.8;
  const alt = input.alternative ?? "two-sided";
  const zAlpha = alt === "two-sided" ? normalInv(1 - alpha / 2) : normalInv(1 - alpha);
  const zBeta = normalInv(power);
  const delta = Math.abs(input.minimumDetectableEffect);
  const perGroup = Math.ceil(
    (2 * input.stdDev ** 2 * (zAlpha + zBeta) ** 2) / (delta ** 2)
  );
  return { perGroup, total: perGroup * 2 };
}

// ── CUPED (Controlled-experiment Using Pre-Experiment Data) ──────────────────

export interface CUPEDObservation {
  /** Pre-experiment covariate (e.g. user's metric value during pre-period). */
  x: number;
  /** Experiment metric value. */
  y: number;
}

export interface CUPEDResult {
  /** Optimal coefficient: Cov(X, Y) / Var(X). */
  theta: number;
  /** Adjusted Y values: Y - θ * (X - mean(X)). */
  adjustedValues: number[];
  /** Variance reduction proportion: 1 - Var(Y_adj) / Var(Y). */
  varianceReduction: number;
  adjustedMean: number;
  adjustedVariance: number;
  originalMean: number;
  originalVariance: number;
}

/**
 * Apply CUPED variance reduction. Returns adjusted metric values whose mean
 * estimates the same population mean as Y but with reduced variance —
 * shrinking required sample size proportionally.
 *
 * The covariate X must be measured BEFORE the experiment (so it can't be
 * affected by treatment assignment).
 */
export function applyCUPED(observations: CUPEDObservation[]): CUPEDResult {
  const n = observations.length;
  if (n < 2) {
    throw new Error("applyCUPED requires at least 2 observations");
  }
  const xs = observations.map((o) => o.x);
  const ys = observations.map((o) => o.y);
  const xMean = mean(xs);
  const yMean = mean(ys);
  const xVar = sampleVariance(xs, xMean);
  const yVar = sampleVariance(ys, yMean);
  const cov = sampleCovariance(xs, ys, xMean, yMean);
  const theta = xVar === 0 ? 0 : cov / xVar;

  const adjustedValues = observations.map((o) => o.y - theta * (o.x - xMean));
  const adjMean = mean(adjustedValues);
  const adjVar = sampleVariance(adjustedValues, adjMean);
  const varianceReduction = yVar === 0 ? 0 : 1 - adjVar / yVar;

  return {
    theta,
    adjustedValues,
    varianceReduction,
    adjustedMean: adjMean,
    adjustedVariance: adjVar,
    originalMean: yMean,
    originalVariance: yVar,
  };
}

// ── Sequential Testing — mSPRT ───────────────────────────────────────────────

export interface MSPRTState {
  /** Cumulative log-likelihood ratio under H1 vs H0. */
  cumLogLR: number;
  /** Observations accumulated. */
  n: number;
  /** Mixing variance τ² of the prior on the effect size. */
  tau2: number;
  /** Assumed noise variance per observation (σ² in the formulae). */
  sigma2: number;
  /** Running sum of (treatment - control) per observation. */
  sumDiff: number;
}

export interface MSPRTUpdateInput {
  /** Per-observation difference (treatment_i - control_i). */
  diff: number;
}

/**
 * Create an initial mSPRT state. Pick `tau2` to encode the *expected* scale
 * of the true effect (e.g. tau = MDE / 3 puts ~99% mass within ±MDE). Pick
 * `sigma2` from your population's per-observation variance.
 */
export function createMSPRTState(opts: {
  tau2: number;
  sigma2: number;
}): MSPRTState {
  if (opts.tau2 <= 0 || opts.sigma2 <= 0) {
    throw new Error("mSPRT requires positive tau2 and sigma2");
  }
  return { cumLogLR: 0, n: 0, sumDiff: 0, tau2: opts.tau2, sigma2: opts.sigma2 };
}

/**
 * Add one observation to the mSPRT state. The `diff` is treatment_i -
 * control_i for paired data, or x_i - μ_0 for one-sample tests.
 *
 * Recomputes the cumulative log-LR using the mixture-Gaussian prior.
 */
export function updateMSPRT(
  state: MSPRTState,
  input: MSPRTUpdateInput
): MSPRTState {
  const n = state.n + 1;
  const sumDiff = state.sumDiff + input.diff;
  const v = state.sigma2 / n; // variance of the sample mean
  const tau2 = state.tau2;
  // Closed-form mSPRT log-LR for normal observations with normal mixing prior:
  //   log Λ_n = 0.5 * log(v / (v + tau2)) + 0.5 * (sumDiff/n)² * tau2 / (v * (v + tau2)) * n
  // Equivalently, with x̄ = sumDiff / n:
  //   = 0.5 * [log(v/(v+tau2)) + x̄² * tau2 / (v * (v + tau2)) * n]
  const xbar = sumDiff / n;
  // Conjugate-normal mSPRT (Robbins 1970). With σ² = sigma2, τ² = tau2,
  // v = σ²/n (variance of the sample mean):
  //   log Λ_n = 0.5·log(v / (v + τ²)) + 0.5·τ²·x̄² / (v·(v + τ²))
  // The second term has *no* extra n factor — easy to mis-derive.
  const cumLogLR =
    0.5 * Math.log(v / (v + tau2)) +
    (0.5 * xbar * xbar * tau2) / (v * (v + tau2));
  return { ...state, n, sumDiff, cumLogLR };
}

/**
 * Always-valid p-value derived from the mSPRT log-LR. Bounded by 1.
 * Reject H0 (no effect) when this drops below α — and unlike a fixed-horizon
 * z-test, this controls Type I error under arbitrary stopping rules.
 */
export function mSPRTPValue(state: MSPRTState): number {
  if (state.n === 0) return 1;
  return Math.min(1, Math.exp(-state.cumLogLR));
}

// ── Multi-Armed Bandit ───────────────────────────────────────────────────────

export interface BanditArmStats {
  arm: string;
  successes: number;
  failures: number;
}

export interface BanditScoredArm {
  arm: string;
  score: number;
}

/**
 * Thompson sampling for a Beta-Bernoulli bandit. Returns one posterior sample
 * per arm — the highest score is the recommended action. With default
 * Beta(1, 1) priors the first pull is uniform random.
 */
export function thompsonSample(
  arms: BanditArmStats[],
  opts?: { prior?: { alpha: number; beta: number }; rng?: () => number }
): BanditScoredArm[] {
  const prior = opts?.prior ?? { alpha: 1, beta: 1 };
  const rng = opts?.rng ?? Math.random;
  return arms.map((a) => ({
    arm: a.arm,
    score: sampleBeta(prior.alpha + a.successes, prior.beta + a.failures, rng),
  }));
}

/**
 * Pick the highest-scoring arm. Convenience wrapper around `thompsonSample`.
 */
export function pickArmThompson(
  arms: BanditArmStats[],
  opts?: { prior?: { alpha: number; beta: number }; rng?: () => number }
): string {
  const scored = thompsonSample(arms, opts);
  return scored.reduce((a, b) => (b.score > a.score ? b : a)).arm;
}

export interface UCBArmStats {
  arm: string;
  mean: number;
  pulls: number;
}

/**
 * UCB1 (Auer 2002). Returns a score per arm; pick the highest.
 *   score_i = μ̂_i + √(2 * ln(N) / n_i)
 *
 * Unpulled arms (n_i = 0) receive +Infinity so they're always tried first.
 */
export function ucb1(
  arms: UCBArmStats[],
  totalPulls?: number
): BanditScoredArm[] {
  const N = totalPulls ?? arms.reduce((s, a) => s + a.pulls, 0);
  return arms.map((a) => {
    if (a.pulls === 0) return { arm: a.arm, score: Infinity };
    return {
      arm: a.arm,
      score: a.mean + Math.sqrt((2 * Math.log(Math.max(1, N))) / a.pulls),
    };
  });
}

/**
 * ε-greedy: with probability ε pull a uniformly random arm; otherwise pull
 * the empirical leader. Simple, surprisingly effective.
 */
export function epsilonGreedy(
  arms: Array<{ arm: string; mean: number }>,
  epsilon: number,
  rng: () => number = Math.random
): string {
  if (arms.length === 0) throw new Error("epsilonGreedy requires at least one arm");
  if (rng() < epsilon) {
    return arms[Math.floor(rng() * arms.length)].arm;
  }
  return arms.reduce((best, a) => (a.mean > best.mean ? a : best)).arm;
}

// ── Math Helpers (internal) ──────────────────────────────────────────────────

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function sampleVariance(xs: number[], mu?: number): number {
  if (xs.length < 2) return 0;
  const m = mu ?? mean(xs);
  let s = 0;
  for (const x of xs) {
    const d = x - m;
    s += d * d;
  }
  return s / (xs.length - 1);
}

function sampleCovariance(xs: number[], ys: number[], mx?: number, my?: number): number {
  if (xs.length !== ys.length) throw new Error("sampleCovariance: length mismatch");
  if (xs.length < 2) return 0;
  const ax = mx ?? mean(xs);
  const ay = my ?? mean(ys);
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    s += (xs[i] - ax) * (ys[i] - ay);
  }
  return s / (xs.length - 1);
}

function validateCount(x: number, n: number, label: string): void {
  if (!Number.isFinite(x) || !Number.isFinite(n)) {
    throw new Error(`${label}: x and n must be finite numbers`);
  }
  if (x < 0 || n < 0) {
    throw new Error(`${label}: x and n must be non-negative`);
  }
  if (x > n) {
    throw new Error(`${label}: successes (${x}) cannot exceed total (${n})`);
  }
}

// ── Special Functions ────────────────────────────────────────────────────────

/**
 * Lanczos approximation for log Γ(z). Accurate to ~1e-15 for z > 0.
 */
function logGamma(z: number): number {
  if (z < 0.5) {
    // Reflection formula
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Regularized incomplete beta I_x(a, b). Uses the continued fraction
 * recommended in Numerical Recipes (Lentz's method) with the symmetry
 * I_x(a, b) = 1 - I_{1-x}(b, a) to keep convergence fast.
 */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x < 0 || x > 1) return NaN;
  if (x === 0) return 0;
  if (x === 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaCF(x, a, b)) / a;
  }
  return 1 - (bt * betaCF(1 - x, b, a)) / b;
}

function betaCF(x: number, a: number, b: number): number {
  const MAXIT = 200;
  const EPS = 3e-15;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) return h;
  }
  return h;
}

/**
 * Sample from Beta(α, β). Uses gamma-ratio when both shape parameters ≥ 1,
 * Johnk's algorithm otherwise — robust over the full parameter space.
 */
function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  if (alpha <= 0 || beta <= 0) {
    throw new Error(`sampleBeta: alpha=${alpha}, beta=${beta} must be > 0`);
  }
  if (alpha >= 1 && beta >= 1) {
    const x = sampleGamma(alpha, rng);
    const y = sampleGamma(beta, rng);
    return x / (x + y);
  }
  // Johnk for small shapes — rejection until U^(1/α) + V^(1/β) ≤ 1.
  for (let i = 0; i < 1000; i++) {
    const u = Math.pow(rng(), 1 / alpha);
    const v = Math.pow(rng(), 1 / beta);
    if (u + v <= 1 && u + v > 0) return u / (u + v);
  }
  // Fallback (extremely unlikely): mean
  return alpha / (alpha + beta);
}

/**
 * Sample from Gamma(k, 1). Marsaglia & Tsang (2000) for k ≥ 1; boost for k < 1
 * via Γ(k) = Γ(k+1) / U^(1/k).
 */
function sampleGamma(k: number, rng: () => number): number {
  if (k < 1) {
    const g = sampleGamma(k + 1, rng);
    return g * Math.pow(rng(), 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = randNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Box-Muller standard normal sample. */
function randNormal(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
