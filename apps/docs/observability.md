# Rollease SDK — Observability

Three integration points cover the typical stack:

| Concern | Module | Output |
|---------|--------|--------|
| **Metrics** | `rollease` (built-in) | Prometheus text format |
| **Tracing** | `rollease/telemetry` | OpenTelemetry spans |
| **Audit log** | `config.audit` | Structured event sink |
| **Health probe** | `rl.health()` | JSON status |

---

## 1. Prometheus metrics

```ts
import { createRollease, createPrometheusAdapter } from "rollease";

const rl = createRollease({
  db: createMemoryAdapter(),
  secret: process.env.ROLLEASE_SECRET!,
  metrics: createPrometheusAdapter(),
});
```

### Built-in metrics

Auto-emitted on every evaluation, cache hit/miss, error, and impression:

```
rollease_evaluations_total{flag="checkout_v2"}             counter
rollease_evaluation_duration_seconds{flag="checkout_v2"}   histogram
rollease_cache_hits_total{tier="l1",flag="checkout_v2"}    counter
rollease_cache_hits_total{tier="l2",flag="checkout_v2"}    counter
rollease_cache_misses_total{flag="checkout_v2"}            counter
rollease_impressions_total{flag="checkout_v2",reason="rule_match"}  counter
rollease_errors_total{flag="checkout_v2",operation="evaluate"}      counter
```

### Expose `/metrics`

The built-in handler exposes a Prometheus scrape endpoint at `GET /api/rollease/metrics`. It requires admin auth (or IP allowlist):

```ts
const handler = rl.createHandler({
  adminAuth: (req) => req.headers.get("authorization") === `Bearer ${PROM_TOKEN}`,
});
```

Then in your Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: rollease
    bearer_token: ${PROM_TOKEN}
    static_configs:
      - targets: ["api.example.com"]
    metrics_path: /api/rollease/metrics
```

### Custom metrics adapter

Implement `MetricsAdapter` to plug into Datadog / StatsD / Cloudwatch instead:

The `MetricsAdapter` interface has four methods — `increment(name, tags?, value?)`, `histogram(name, value, tags?)`, `gauge(name, value, tags?)`, and `serialize()`. Implement all four:

```ts
import type { MetricsAdapter } from "rollease";

const datadogAdapter: MetricsAdapter = {
  increment(name, tags, value = 1) {
    statsd.increment(name, value, tagsToList(tags));
  },
  histogram(name, value, tags) {
    statsd.histogram(name, value, tagsToList(tags));
  },
  gauge(name, value, tags) {
    statsd.gauge(name, value, tagsToList(tags));
  },
  serialize() { return ""; }, // only used by the Prometheus /metrics endpoint
};

const rl = createRollease({ /* ... */ metrics: datadogAdapter });
```

---

## 2. OpenTelemetry tracing

Every `evaluate()` call becomes a span with attributes for `flag.key`, `flag.value`, `flag.reason`, `flag.variant`.

```ts
import { trace } from "@opentelemetry/api";
import { createOtelAdapter } from "rollease/telemetry";

const tracer = trace.getTracer("rollease");

const rl = createRollease({
  db: createMemoryAdapter(),
  secret: process.env.ROLLEASE_SECRET!,
  telemetry: createOtelAdapter(tracer),
});

// Now every evaluate() emits a span:
//   rollease.evaluate { flag.key, flag.value, flag.reason, flag.variant }
```

### Console adapter (dev)

Print spans to stdout for local debugging:

```ts
import { createConsoleAdapter } from "rollease/telemetry";

const rl = createRollease({
  /* ... */
  telemetry: createConsoleAdapter(),
});
```

### Manually instrumenting your own spans

`createOtelAdapter` returns an adapter that uses the **active** tracer context, so spans nest correctly inside whatever your app's already tracing:

```ts
const span = tracer.startSpan("checkout.submit");
await context.with(trace.setSpan(context.active(), span), async () => {
  const enabled = await rl.flags.isEnabled("new_checkout", { userId });
  // The rollease.evaluate span is a child of checkout.submit.
});
span.end();
```

---

## 3. Audit log

The audit sink receives a structured `AuditEvent` for every mutation:

```ts
import { createRollease } from "rollease";
import type { AuditSink, AuditEvent } from "rollease";

const myAuditSink: AuditSink = {
  async write(event: AuditEvent) {
    await db.insert(schema.auditLog).values({
      id: event.id,
      eventType: event.eventType,
      actorId: event.actorId,
      resource: event.resource,
      action: event.action,
      outcome: event.outcome,
      metadata: event.metadata,
      createdAt: event.createdAt,
    });
  },
};

const rl = createRollease({
  db: ...,
  secret: ...,
  audit: { enabled: true, sink: myAuditSink },
});
```

### Sink choices

| Sink | Use case |
|------|----------|
| `"db"` | Default — writes to `rl_history` via the adapter |
| `"stdout"` | Pipes structured JSON to your logger (good for Loki / Cloudwatch) |
| Custom `AuditSink` | Anywhere — Splunk, Datadog Logs, S3, etc. |

### Audit event shape

```ts
interface AuditEvent {
  id: string;
  eventType: string;          // "flag.created" | "release.deployed" | ...
  actorId?: string;
  resource?: string;          // flag key or release id
  action: string;             // same as eventType for compatibility
  outcome: "success" | "failure";
  metadata?: Record<string, unknown>;  // { actorName, actorType, ... }
  createdAt: Date;
}
```

---

## 4. Health probe

`rl.health()` returns a structured health report. The handler exposes it at `GET /api/rollease/health` (public by default; gate with `healthAuth`).

```ts
const health = await rl.health();

{
  status: "healthy",         // "healthy" | "degraded" | "unhealthy"
  db: "ok",                  // "ok" | "error"
  cache: "ok",               // "ok" | "error" | "disabled"
  circuit: "closed",         // "closed" | "open" | "half_open" | "disabled"
  latencyMs: 12,
  evalCount: 145789,
  cacheHits: 142001,
  cacheMisses: 3788,
  cacheHitRate: 0.974,
  uptimeMs: 86400000,
  ts: 1764312345678,
}
```

The HTTP endpoint returns 503 when `status === "unhealthy"`, so it pairs cleanly with k8s liveness/readiness probes:

```yaml
livenessProbe:
  httpGet:
    path: /api/rollease/health
    port: 3000
  periodSeconds: 30
  failureThreshold: 3
```

### Gated health

```ts
const handler = rl.createHandler({
  healthAuth: (req) => req.headers.get("x-internal-token") === HEALTH_TOKEN,
});
```

---

## 5. Change listeners (event-driven)

`onChange` fires on every mutation (in-process). Useful for cache invalidation, search index updates, or feeding a UI dashboard.

```ts
const unsubscribe = rl.flags.onChange((event) => {
  console.log(`${event.action} on ${event.flagKey}`);
});

// later
unsubscribe();
```

For **cross-process** invalidation (multi-server deployments), configure `config.invalidation` with `RedisInvalidationBus` — the publisher's `onChange` events propagate to subscribers' caches automatically.

---

## 6. Change-log webhooks

Push events to external systems (Slack, PagerDuty, internal services):

```ts
const rl = createRollease({
  /* ... */
  webhooks: [
    {
      url: "https://hooks.slack.com/services/...",
      events: ["flag.killed", "release.deployed", "release.rolled_back"],
      secret: process.env.SLACK_WEBHOOK_SECRET,
      // Retry is a nested object, not top-level `retries`/`backoffMs`.
      retry: { attempts: 3, backoffMs: 1000, jitter: true },
    },
  ],
});
```

`dlq` (dead-letter queue) is configured **per webhook**, not at the top level. It's called with the payload and the last error after all retries are exhausted:

```ts
const rl = createRollease({
  /* ... */
  webhooks: [
    {
      url: "https://hooks.slack.com/services/...",
      events: ["flag.killed"],
      retry: { attempts: 3 },
      dlq: async (payload, error) => {
        await s3.putObject({
          Bucket: "rollease-dlq",
          // WebhookPayload fields: { event, flagKey, timestamp, data }
          Key: `${payload.event}-${Date.now()}.json`,
          Body: JSON.stringify({ payload, error: error.message }),
        });
      },
    },
  ],
});
```

Verify incoming webhook signatures on your side:

```ts
import { verifyWebhookSignature } from "rollease";

app.post("/webhooks/rollease", (req, res) => {
  const sig = req.headers["x-rollease-signature"] as string;
  if (!verifyWebhookSignature(req.body, sig, WEBHOOK_SECRET)) {
    return res.status(401).end();
  }
  // ... process event
  res.status(200).end();
});
```
