// ============================================================================
// Rollease SDK — Metrics & Prometheus Adapter
// ============================================================================
//
// Pluggable metrics interface with an included Prometheus text exposition
// implementation. Wires into FlagManager for automatic instrumentation.
//
// Usage:
//
//   import { createPrometheusAdapter } from 'rollease/metrics'
//
//   const rl = createRollease({
//     ...,
//     metrics: createPrometheusAdapter(),
//   })
//
//   // Expose metrics endpoint
//   app.get('/metrics', (req, res) => {
//     res.set('Content-Type', 'text/plain; version=0.0.4')
//     res.send(rl.flags.getMetrics())
//   })
//
// ============================================================================

// ── Interface ──────────────────────────────────────────────────────────────

export interface MetricsAdapter {
  /** Increment a counter. */
  increment(name: string, tags?: Record<string, string>, value?: number): void;
  /** Record a histogram observation. */
  histogram(name: string, value: number, tags?: Record<string, string>): void;
  /** Set a gauge value. */
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  /** Render metrics in text exposition format. */
  serialize(): string;
}

// ── Prometheus Text Exposition ─────────────────────────────────────────────

interface CounterEntry {
  value: number;
}

interface HistogramEntry {
  count: number;
  sum: number;
  buckets: Map<number, number>;
}

interface GaugeEntry {
  value: number;
}

const DEFAULT_HISTOGRAM_BUCKETS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

function tagsToKey(tags?: Record<string, string>): string {
  if (!tags || Object.keys(tags).length === 0) return "";
  return Object.entries(tags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
}

function formatLabels(tags?: Record<string, string>, extra?: Record<string, string>): string {
  const merged = { ...tags, ...extra };
  const keys = Object.keys(merged);
  if (keys.length === 0) return "";
  return `{${keys.sort().map((k) => `${k}="${merged[k]}"`).join(",")}}`;
}

/**
 * In-process Prometheus metrics adapter.
 *
 * No dependency on `prom-client` — implements the text exposition format
 * directly. Suitable for lightweight deployments and edge runtimes.
 */
export class PrometheusAdapter implements MetricsAdapter {
  private counters = new Map<string, Map<string, CounterEntry>>();
  private histograms = new Map<string, Map<string, HistogramEntry>>();
  private gauges = new Map<string, Map<string, GaugeEntry>>();
  private descriptions = new Map<string, string>();
  private buckets: number[];

  constructor(opts?: { buckets?: number[] }) {
    this.buckets = opts?.buckets ?? DEFAULT_HISTOGRAM_BUCKETS;
  }

  /** Register a metric description (TYPE + HELP). Called once per metric name. */
  describe(name: string, help: string): void {
    this.descriptions.set(name, help);
  }

  increment(name: string, tags?: Record<string, string>, value = 1): void {
    const key = tagsToKey(tags);
    if (!this.counters.has(name)) this.counters.set(name, new Map());
    const series = this.counters.get(name)!;
    const entry = series.get(key) ?? { value: 0 };
    entry.value += value;
    series.set(key, entry);
  }

  histogram(name: string, value: number, tags?: Record<string, string>): void {
    const key = tagsToKey(tags);
    if (!this.histograms.has(name)) this.histograms.set(name, new Map());
    const series = this.histograms.get(name)!;
    let entry = series.get(key);
    if (!entry) {
      entry = {
        count: 0,
        sum: 0,
        buckets: new Map(this.buckets.map((b) => [b, 0])),
      };
      series.set(key, entry);
    }
    entry.count++;
    entry.sum += value;
    for (const bucket of this.buckets) {
      if (value <= bucket) {
        entry.buckets.set(bucket, (entry.buckets.get(bucket) ?? 0) + 1);
      }
    }
  }

  gauge(name: string, value: number, tags?: Record<string, string>): void {
    const key = tagsToKey(tags);
    if (!this.gauges.has(name)) this.gauges.set(name, new Map());
    const series = this.gauges.get(name)!;
    series.set(key, { value });
  }

  serialize(): string {
    const lines: string[] = [];

    // Counters
    for (const [name, series] of this.counters) {
      const help = this.descriptions.get(name);
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const [key, entry] of series) {
        const labels = key ? `{${key}}` : "";
        lines.push(`${name}${labels} ${entry.value}`);
      }
    }

    // Histograms
    for (const [name, series] of this.histograms) {
      const help = this.descriptions.get(name);
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const [key, entry] of series) {
        const baseTags = key
          ? Object.fromEntries(key.split(",").map((p) => {
              const [k, v] = p.split("=");
              return [k, v?.replace(/"/g, "") ?? ""];
            }))
          : {};
        let cumulative = 0;
        for (const bucket of this.buckets) {
          cumulative += entry.buckets.get(bucket) ?? 0;
          lines.push(
            `${name}_bucket${formatLabels(baseTags, { le: String(bucket) })} ${cumulative}`
          );
        }
        lines.push(
          `${name}_bucket${formatLabels(baseTags, { le: "+Inf" })} ${entry.count}`
        );
        const labels = key ? `{${key}}` : "";
        lines.push(`${name}_sum${labels} ${entry.sum}`);
        lines.push(`${name}_count${labels} ${entry.count}`);
      }
    }

    // Gauges
    for (const [name, series] of this.gauges) {
      const help = this.descriptions.get(name);
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      for (const [key, entry] of series) {
        const labels = key ? `{${key}}` : "";
        lines.push(`${name}${labels} ${entry.value}`);
      }
    }

    return lines.join("\n") + "\n";
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a Prometheus metrics adapter pre-configured with Rollease metric names.
 *
 * ```ts
 * const metrics = createPrometheusAdapter()
 * const rl = createRollease({ ..., metrics })
 * ```
 */
export function createPrometheusAdapter(
  opts?: { buckets?: number[] }
): PrometheusAdapter {
  const adapter = new PrometheusAdapter(opts);

  // Pre-register Rollease metric descriptions
  adapter.describe("rollease_evaluations_total", "Total number of flag evaluations");
  adapter.describe("rollease_evaluation_duration_seconds", "Flag evaluation duration");
  adapter.describe("rollease_cache_hits_total", "L1/L2 cache hit count");
  adapter.describe("rollease_cache_misses_total", "L1/L2 cache miss count");
  adapter.describe("rollease_errors_total", "Total evaluation errors");
  adapter.describe("rollease_db_latency_seconds", "Database operation latency");
  adapter.describe("rollease_webhook_dispatches_total", "Webhook dispatch count");
  adapter.describe("rollease_sse_clients", "Active SSE client connections");
  adapter.describe("rollease_circuit_state", "Circuit breaker state (0=closed, 1=open, 2=half_open)");
  adapter.describe("rollease_impressions_total", "Total impressions tracked");
  adapter.describe("rollease_events_total", "Total custom events tracked");

  return adapter;
}

/** No-op metrics adapter for testing and when metrics are disabled. */
export const noopMetrics: MetricsAdapter = {
  increment() {},
  histogram() {},
  gauge() {},
  serialize() { return ""; },
};
