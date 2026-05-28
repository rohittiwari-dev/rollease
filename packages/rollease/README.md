# Rollease SDK

A production-grade, database-backed feature flag SDK for Node.js, React, and Next.js. Framework-agnostic core with first-class adapters for Sequelize, Prisma, and Drizzle. Runs on Node, Bun, Edge runtimes, and in the browser.

---

## Table of Contents

1. [Installation](#installation)
2. [Quickstart](#quickstart)
3. [Core Config Reference](#core-config-reference)
4. [Flag Evaluation API](#flag-evaluation-api)
5. [Evaluation Trace](#evaluation-trace)
6. [Universal HTTP Handler](#universal-http-handler)
7. [Browser Client](#browser-client)
8. [React Integration](#react-integration)
9. [Next.js Integration](#nextjs-integration)
10. [Telemetry](#telemetry)
11. [Health Probe](#health-probe)
12. [Resilience & Graceful Degradation](#resilience--graceful-degradation)
13. [Privacy & PII Scrubbing](#privacy--pii-scrubbing)
14. [Lifecycle Hooks & RBAC](#lifecycle-hooks--rbac)
15. [Testing Utilities](#testing-utilities)
16. [OpenFeature Provider](#openfeature-provider)
17. [Security Features](#security-features)
18. [Database Adapters](#database-adapters)
19. [Database Schema](#database-schema)
20. [Webhook Notifications](#webhook-notifications)
21. [Scheduled Releases](#scheduled-releases)
22. [GDPR / Data Erasure](#gdpr--data-erasure)

---

## Installation

```bash
# Core SDK
npm install rollease

# Optional: durable database adapters
npm install sequelize pg          # Sequelize/PostgreSQL
npm install @prisma/client        # Prisma
npm install drizzle-orm           # Drizzle

# Optional: shared cache
npm install redis

# Bun / pnpm
bun add rollease
pnpm add rollease
```

`pg` is an optional peer dependency — it is not bundled and only needed when using the Sequelize adapter.

---

## Quickstart

In-memory adapters are the fastest way to get started. They are also the recommended default for tests.

```typescript
import { createRollease } from "rollease";
import { createMemoryAdapter } from "rollease/db/memory";

const rl = createRollease({
  db: createMemoryAdapter(),
  secret: process.env.ROLLEASE_SECRET ?? "dev-secret-change-me-32chars",
});

// Create a flag
await rl.flags.create({
  key: "new-checkout",
  type: "boolean",
  defaultValue: false,
  rollout: { percentage: 50, sticky: true, hashKey: "userId" },
});

// Evaluate
const enabled = await rl.flags.isEnabled("new-checkout", { userId: "user-123" });
console.log(enabled); // true or false, consistently hashed
```

---

## Core Config Reference

```typescript
const rl = createRollease({
  // Required
  db:     createSequelizeAdapter({ sequelize, sync: false }),
  secret: process.env.ROLLEASE_SECRET!,  // min 16 chars

  // Cache
  cache:     { driver: "redis", redis: { url: process.env.REDIS_URL! }, ttl: 60 },
  l1TtlMs:   5_000,       // in-process L1 TTL (default 5s)

  // Environment scoping (filters all operations to this env)
  environment: "production",

  // Evaluation
  autoResolveSegments: true,   // auto-evaluate segment definitions
  evaluateAllPageSize: 1000,   // page size for evaluateAll()
  impressions: { enabled: true, sampleRate: 1.0 },

  // Developer experience
  localOverrides:     process.env.NODE_ENV === "development",
  localOverridesFile: ".rolleaserc.json",

  // Resilience
  resilience: {
    fallbackOnError: true,  // return null instead of throwing on DB error
    retry:          { attempts: 3, backoffMs: 100, jitter: true },
    circuitBreaker: { threshold: 5, windowMs: 10_000, resetAfterMs: 30_000 },
  },

  // Privacy
  privacy: {
    privateAttributes:       ["email", "phone", "ssn"],
    impressionRetentionDays: 90,
    auditRetentionDays:      365,
  },

  // Telemetry
  telemetry: createOtelAdapter(trace.getTracer("rollease")),

  // Logging
  logging: {
    level: "warn",
    sink: (level, msg, meta) => logger[level](msg, meta),
  },

  // Webhooks
  webhooks: [
    {
      url:      "https://your-app.example/hooks/flags",
      events:   ["flag.update", "flag.kill"],
      headers:  { "x-webhook-token": process.env.WEBHOOK_SECRET! },
      retry:    { attempts: 3, backoffMs: 200 },
      dlq:      (payload, err) => recordFailedWebhook(payload, err),
    },
  ],

  // Lifecycle hooks
  hooks: {
    onBeforeMutation:  async ({ action, flagKey, actor }) => { /* RBAC check */ },
    onBeforeEvaluation: async ({ flagKey, context }) => { /* tenant check */ },
    onEvaluate:        (result, context) => { /* analytics */ },
  },
});
```

---

## Flag Evaluation API

All evaluation methods live on `rl.flags`.

```typescript
// Boolean gate — returns true/false
const enabled = await rl.flags.isEnabled("new-checkout", { userId: "u1" });

// Typed value
const maxItems = await rl.flags.getValue<number>("max-items", { userId: "u1" });

// Variant key + display value
const variant = await rl.flags.getVariant("pricing-experiment", { userId: "u1" });
console.log(variant.key);   // "control" | "treatment_a" | "treatment_b"
console.log(variant.value); // the variant's configured value

// Full result (value + variant + reason + ruleId + evaluatedAt)
const result = await rl.flags.evaluate("new-checkout", { userId: "u1" });
console.log(result.value);       // true | false
console.log(result.reason);      // "rule_match" | "percentage" | "default" | ...
console.log(result.variant);     // "treatment" | null
console.log(result.ruleId);      // "rule-uuid" | null
console.log(result.evaluatedAt); // Date

// Bulk evaluation — returns a Record<flagKey, FlagResult>
const all = await rl.flags.evaluateAll({ userId: "u1" });
```

### FlagContext fields

```typescript
interface FlagContext {
  userId?:      string;
  userType?:    string;    // "internal" | "beta" | "standard"
  environment?: string;    // "production" | "staging"
  region?:      string;    // "US" | "EU" | "IN"
  version?:     string;    // app version for semver rules
  ip?:          string;
  tenantId?:    string;
  segments?:    string[];  // pre-computed segment keys (or use autoResolveSegments)
  attributes?:  Record<string, unknown>;  // custom dimensions
}
```

### EvalReason values

| Reason | When |
|--------|------|
| `kill_switch` | Flag status is `killed` |
| `disabled` | Flag status is `archived` |
| `not_scheduled` | `scheduledAt` is in the future |
| `expired` | `expiresAt` is in the past |
| `prerequisite_not_met` | A prerequisite flag's value doesn't match |
| `exclusion_group_miss` | User is outside the exclusion layer allocation |
| `override` | `.rolleaserc.json` local override active |
| `assignment` | Sticky user assignment exists |
| `rule_match` | A targeting rule matched |
| `percentage` | Passed the rollout percentage gate |
| `weighted_random` | Multivariate weighted distribution |
| `default` | No condition matched; using default value |
| `error_fallback` | DB error with `resilience.fallbackOnError: true` |

---

## Evaluation Trace

Pass `{ trace: true }` to get a step-by-step breakdown of the evaluation pipeline — invaluable for debugging "why did user X get value Y?".

```typescript
const result = await rl.flags.evaluate("pricing-experiment", { userId: "alice" }, { trace: true });

console.log(result.trace);
// {
//   steps: [
//     { step: 2,  name: "kill_switch",      matched: false },
//     { step: 3,  name: "disabled",         matched: false },
//     { step: 4,  name: "date_window",      matched: false },
//     { step: 5,  name: "prerequisites",    matched: false },
//     { step: 6,  name: "exclusion_layer",  matched: false },
//     { step: 7,  name: "local_override",   matched: false },
//     { step: 8,  name: "sticky_assignment",matched: false },
//     { step: 9,  name: "targeting_rules",  matched: true,  detail: "rule r-abc → variant treatment" },
//   ],
//   matchedRuleId:    "r-abc",
//   matchedVariantId: "treatment",
// }
```

- **`matched: false`** — step was evaluated but did not terminate the pipeline
- **`matched: true`** — step terminated the pipeline with the final result
- **`detail`** — human-readable context (rule ID, bucket number, variant key, etc.)
- Omitting `{ trace: true }` has zero overhead; `result.trace` is `undefined`

The trace interface:

```typescript
interface EvaluationTraceStep {
  step:     number;   // pipeline step number
  name:     string;   // step name
  matched:  boolean;  // true = this step determined the final result
  detail?:  string;   // additional context
}

interface EvaluationTrace {
  steps:             EvaluationTraceStep[];
  matchedRuleId?:    string;
  matchedVariantId?: string;
}

interface FlagResult<T = unknown> {
  // ...
  trace?: EvaluationTrace;  // only present when { trace: true }
}
```

---

## Universal HTTP Handler

`rl.createHandler()` returns a fetch-compatible `(Request) => Response` function. Mount it at a single catch-all route in any framework.

```typescript
// lib/rollease.ts
import { createRollease } from "rollease";
import { createMemoryAdapter } from "rollease/db/memory";

export const rl = createRollease({ db: createMemoryAdapter(), secret: "..." });
```

### Next.js App Router

```typescript
// app/api/rollease/[...path]/route.ts
import { rl } from "@/lib/rollease";

const handler = rl.createHandler({
  contextFromRequest: async (req) => ({ userId: await getUserIdFromSession(req) }),
  adminAuth:          async (req) => req.headers.get("x-admin-token") === process.env.ADMIN_TOKEN,
});

export const GET    = handler;
export const POST   = handler;
export const PATCH  = handler;
export const DELETE = handler;
export const OPTIONS = handler;
```

### Hono / Bun.serve / Cloudflare Workers

```typescript
import { rl } from "./lib/rollease";

const handler = rl.createHandler({
  contextFromRequest: (req) => ({ userId: req.headers.get("x-user-id") ?? undefined }),
  basePath: "/api/rollease",
});

// Hono
app.all("/api/rollease/*", (c) => handler(c.req.raw));

// Bun.serve
Bun.serve({ fetch: (req) => handler(req) });

// Cloudflare Workers
export default { fetch: handler };
```

### Available Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health probe (200 healthy, 503 unhealthy) |
| `GET` | `/flags` | Evaluate all flags for the caller's context |
| `GET` | `/flags/:key` | Evaluate a single flag |
| `GET` | `/flags/stream` | SSE stream of live flag changes |
| `POST` | `/flags` | Create a flag _(admin)_ |
| `PATCH` | `/flags/:key` | Update a flag _(admin)_ |
| `DELETE` | `/flags/:key` | Archive a flag _(admin)_ |
| `POST` | `/flags/:key/kill` | Kill-switch a flag _(admin)_ |

---

## Browser Client

`rollease/client` is a zero-Node-dependency browser SDK. It pairs with the server handler to deliver evaluated flag values, real-time updates via SSE, and localStorage zero-flicker caching.

```typescript
// lib/rollease-client.ts
import { createRolleaseClient } from "rollease/client";

export const rlClient = createRolleaseClient({
  baseUrl:   "/api/rollease",
  context:   { userId: "demo-user-123" },  // or a factory: () => getContext()
  streaming: true,        // subscribe to SSE for real-time updates
  localStorage: true,     // cache flags in localStorage (zero-flicker on reload)
});
```

### API

```typescript
// Resolve the initial fetch
await rlClient.ready();

// Read a flag synchronously (returns defaultValue before ready())
const enabled = rlClient.flag("new-checkout", false);

// All flag values (key → value)
const flags = rlClient.flags();

// All detailed results (key → { value, variant, reason, ... })
const details = rlClient.flagDetails();

// Force an immediate refetch
await rlClient.refetch();

// Switch user context (e.g. after sign-in) and refetch
await rlClient.identify({ userId: "user-456", userType: "beta" });

// Subscribe to any flag change
const unsub = rlClient.onChange(() => setFlags(rlClient.flags()));
// or target a specific key
const unsub2 = rlClient.onFlagChange("new-checkout", (value) => console.log(value));

// Send an analytics event (fire-and-forget)
rlClient.track("checkout_completed", { value: 49.99 });

// Teardown (call in component cleanup)
rlClient.destroy();
```

### Config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | required | Base path of the mounted handler |
| `context` | `FlagContext \| () => FlagContext` | `{}` | User context sent with requests |
| `streaming` | `boolean` | `false` | Enable SSE real-time updates |
| `refreshInterval` | `number` | `0` | Polling interval in ms (0 = off) |
| `localStorage` | `boolean` | `false` | Cache flags in localStorage |
| `localStorageKey` | `string` | `'rollease:flags'` | localStorage key |
| `headers` | `Record<string,string>` | `{}` | Extra request headers |
| `onFlagsChange` | `(flags) => void` | — | Called after every refresh |
| `onError` | `(err) => void` | — | Called on fetch/stream errors |

---

## React Integration

```tsx
import { RolleaseProvider, useFlag, useVariant, useFlags, FeatureGate } from "rollease/react";
import { rlClient } from "./lib/rollease-client";

// Option A: pass a browser client (SSE-driven, live updates)
export default function App() {
  return (
    <RolleaseProvider client={rlClient}>
      <Dashboard />
    </RolleaseProvider>
  );
}

// Option B: bootstrap from server-evaluated flags (zero-flicker SSR)
export default function App({ serverFlags }) {
  return (
    <RolleaseProvider initialFlags={serverFlags}>
      <Dashboard />
    </RolleaseProvider>
  );
}

// Hooks
function Dashboard() {
  const checkout = useFlag("new-checkout");    // FlagResult
  const price    = useVariant("pricing-exp"); // { key, value }
  const all      = useFlags();                // FlagMap

  return (
    <>
      {checkout.enabled && <NewCheckout />}
      <p>Variant: {price.key}</p>

      {/* Declarative gate */}
      <FeatureGate flag="beta-dashboard" fallback={<LegacyDash />}>
        <NewDash />
      </FeatureGate>
    </>
  );
}
```

---

## Next.js Integration

### Middleware

Evaluate flags at the Edge and inject a signed envelope into headers and cookies, so Server Components read flag values with zero latency.

```typescript
// middleware.ts
import { rolleaseMiddleware } from "rollease/next";
import { rl } from "@/lib/rollease";

export const middleware = rolleaseMiddleware(rl, {
  userIdExtractor: (req) => req.cookies.get("userId")?.value ?? "guest",
  flagContext:     (req) => ({
    environment: process.env.NODE_ENV,
    region:      req.geo?.country,
  }),
  flags: ["new-checkout", "pricing-experiment"],  // omit to evaluate all
});

export const config = {
  matcher: ["/checkout/:path*", "/dashboard/:path*"],
};
```

### Server Components (RSC)

```tsx
// app/checkout/page.tsx
import { getFlag, getAllFlags } from "rollease/next";

export default async function CheckoutPage() {
  // Reads from the signed middleware header — zero extra network call
  const newCheckout   = await getFlag<boolean>("new-checkout", false);
  const pricingVariant = await getFlag<string>("pricing-experiment", "control");

  return (
    <main>
      {newCheckout ? <NewCheckout /> : <LegacyCheckout />}
      <p>Pricing variant: {pricingVariant}</p>
    </main>
  );
}
```

### Client Components with SSE

```tsx
// app/checkout/checkout-section.tsx
"use client";
import { useEffect, useState } from "react";
import { createRolleaseClient } from "rollease/client";

const client = createRolleaseClient({
  baseUrl:      "/api/rollease",
  context:      { userId: "demo-user-123" },
  streaming:    true,
  localStorage: true,
});

export function CheckoutSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    const unsub = client.onChange(() => {
      setEnabled(Boolean(client.flag("new-checkout", false)));
    });
    client.ready().then(() =>
      setEnabled(Boolean(client.flag("new-checkout", false)))
    );
    return unsub;
  }, []);

  if (enabled === null) return <p>Loading…</p>;
  return enabled ? <NewCheckout /> : <LegacyCheckout />;
}
```

---

## Telemetry

`rollease/telemetry` provides a plug-in tracing adapter. Every `evaluate()` call is wrapped in a span automatically when a telemetry adapter is configured.

```typescript
import { createOtelAdapter, createConsoleAdapter } from "rollease/telemetry";
import { trace } from "@opentelemetry/api";

// OpenTelemetry (zero hard dep — structural typing)
const rl = createRollease({
  db, secret,
  telemetry: createOtelAdapter(trace.getTracer("rollease", "1.0")),
});

// Console logging (useful for debugging without OTel)
const rl = createRollease({
  db, secret,
  telemetry: createConsoleAdapter("[rl]"),
  // logs: [rl] → rollease.evaluate  { flag.key: 'checkout-v2' }
  //        [rl] ✓ rollease.evaluate (2ms)
});
```

Each span receives the attribute `flag.key`. Error spans include the error message.

---

## Health Probe

```typescript
const health = await rl.health();
// {
//   status:       "healthy" | "degraded" | "unhealthy",
//   db:           "ok" | "error",
//   cache:        "ok" | "error" | "disabled",
//   latencyMs:    4,
//   evalCount:    1024,
//   cacheHits:    980,
//   cacheMisses:  44,
//   cacheHitRate: 0.957,
//   uptimeMs:     86_400_000,
//   ts:           1716900000000,
// }
```

The HTTP handler exposes this at `GET /api/rollease/health`. Returns HTTP 200 when healthy, 503 when unhealthy.

---

## Resilience & Graceful Degradation

```typescript
const rl = createRollease({
  db, secret,
  resilience: {
    // Return { value: null, reason: 'error_fallback' } instead of throwing
    fallbackOnError: true,

    // Retry transient DB errors before failing
    retry: {
      attempts:  3,
      backoffMs: 100,   // base delay, doubles each attempt
      jitter:    true,  // adds ±50% random jitter
    },

    // Open the circuit after repeated failures
    circuitBreaker: {
      threshold:    5,        // consecutive failures to open
      windowMs:     10_000,   // failure tracking window
      resetAfterMs: 30_000,   // time before retrying
    },
  },
});

const result = await rl.flags.evaluate("checkout-v2", { userId: "u1" });
if (result.reason === "error_fallback") {
  // DB was unreachable; result.value is null
  console.warn("Flag evaluation degraded");
}
```

---

## Privacy & PII Scrubbing

```typescript
const rl = createRollease({
  db, secret,
  privacy: {
    // These attributes are replaced with '[REDACTED]' before impression
    // tracking, audit history, and evaluation hooks
    privateAttributes: ["email", "phone", "nationalId", "ipAddress"],

    // Auto-delete impression records after N days
    impressionRetentionDays: 90,

    // Auto-delete audit history after N days
    auditRetentionDays: 365,
  },
});
```

PII scrubbing applies transparently at the impression tracking and hook call-sites. The evaluation engine itself never sees the scrubbed values — only the impression/audit records are protected.

---

## Lifecycle Hooks & RBAC

Hooks run synchronously in the evaluation and mutation paths. Throwing inside `onBeforeMutation` or `onBeforeEvaluation` aborts the operation — use this to implement RBAC/ABAC denials.

```typescript
const rl = createRollease({
  db, secret,
  hooks: {
    // Called before any flag write operation
    onBeforeMutation: async ({ action, flagKey, actor }) => {
      if (action === "create" && !actor?.permissions?.includes("flags:create")) {
        throw new Error("Forbidden");
      }
    },

    // Called before each evaluation — throw to deny
    onBeforeEvaluation: async ({ flagKey, context }) => {
      if (context.tenantId !== "acme" && flagKey.startsWith("acme-")) {
        throw new Error("Cross-tenant evaluation denied");
      }
    },

    // Called after every evaluation (fire-and-forget)
    onEvaluate: (result, context) => {
      analytics.track("flag_evaluated", {
        key: result.key,
        reason: result.reason,
        userId: context.userId,
      });
    },
  },
});
```

### AuditActor

All mutation methods accept an optional `actor` parameter for attribution:

```typescript
await rl.flags.create(
  { key: "new-checkout", type: "boolean", defaultValue: false },
  { actor: { id: "admin-u1", type: "user", name: "Alice" } }
);

await rl.flags.kill("new-checkout", {
  reason: "Emergency rollback — production incident #4812",
  actor:  { id: "oncall-bot", type: "service" },
});
```

---

## Testing Utilities

`rollease/testing` provides a zero-config mock client backed by the real in-memory adapter. Evaluation semantics are identical to production — no stubs or simplified logic paths.

```typescript
import { createMockRollease } from "rollease/testing";

// Seed flags once per test suite
const rl = await createMockRollease({
  flags: {
    "new-checkout":        true,
    "max-items":           25,
    "theme":               "dark",
    "pricing-experiment": { value: "control", type: "string", enabled: true },
  },
});

// In tests
expect(await rl.flags.isEnabled("new-checkout", {})).toBe(true);
expect(await rl.flags.getValue<string>("theme", {})).toBe("dark");

// Mutate for a specific test
await rl.setFlag("new-checkout", false);
expect(await rl.flags.isEnabled("new-checkout", {})).toBe(false);

// Reset to seeded state
await rl.resetFlag("new-checkout");
await rl.resetAll();

// Fast in-test override (uses .rolleaserc.json mechanism, no DB write)
rl.overrideFlag("theme", "light");
rl.clearOverride("theme");
rl.clearAllOverrides();

// Cleanup
await rl.close();
```

Vitest example:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createMockRollease } from "rollease/testing";

describe("CheckoutService", () => {
  let rl: Awaited<ReturnType<typeof createMockRollease>>;

  beforeAll(async () => {
    rl = await createMockRollease({ flags: { "new-checkout": true } });
  });
  afterAll(() => rl.close());

  it("uses new checkout when flag is on", async () => {
    const enabled = await rl.flags.isEnabled("new-checkout", { userId: "u1" });
    expect(enabled).toBe(true);
  });
});
```

---

## OpenFeature Provider

`rollease/openfeature` wraps a Rollease FlagManager as a CNCF OpenFeature Provider. No hard dependency on `@openfeature/core` — the provider uses structural typing and is compatible with any OpenFeature SDK version.

```typescript
import { OpenFeature } from "@openfeature/server-sdk";
import { createRolleaseProvider } from "rollease/openfeature";
import { rl } from "@/lib/rollease";

// Register once at startup
OpenFeature.setProvider(createRolleaseProvider(rl.flags));

// Use anywhere via the standard OpenFeature client
const client = OpenFeature.getClient();

const enabled = await client.getBooleanValue("new-checkout", false, {
  targetingKey: userId,
});
const variant = await client.getStringValue("pricing-experiment", "control", {
  targetingKey: userId,
  country: "US",
});
```

The provider maps OpenFeature's `targetingKey` to Rollease's `userId`, and translates all OpenFeature evaluation contexts into `FlagContext`. All Rollease `EvalReason` values are mapped to their OpenFeature equivalents.

---

## Security Features

### Local override path traversal guard

```typescript
// Throws ValidationError if filePath escapes process.cwd()
const rl = createRollease({
  db, secret,
  localOverrides:     true,
  localOverridesFile: "../../etc/passwd",  // rejected
});
```

### Prototype-pollution key guard

```typescript
// Throws ValidationError for dangerous key names
await rl.flags.create({ key: "__proto__", ... });     // rejected
await rl.flags.create({ key: "constructor", ... });   // rejected
await rl.flags.createSegment({ key: "prototype", ... }); // rejected
```

### Condition group complexity limit

Every rule and segment's condition tree is validated for depth and node count before storage. Prevents pathological rule trees from causing DoS at evaluation time.

### Locked flags

```typescript
// Lock a flag — update() cannot change it while locked
await rl.flags.setLock("pricing-experiment", {
  locked: true,
  reason: "Freeze before launch",
  actor:  { id: "admin-u1", type: "user" },
});

// Only setLock() can unlock it
await rl.flags.setLock("pricing-experiment", { locked: false, actor: { ... } });
```

### Secret isolation

The signing secret is held in a closure and never exposed on the client object — `JSON.stringify(rl)` does not leak it. The middleware reads it via a `Symbol.for('rollease.internal')` accessor.

---

## Database Adapters

### In-Memory (development / testing)

```typescript
import { createMemoryAdapter } from "rollease/db/memory";
const db = createMemoryAdapter();
```

### Sequelize / PostgreSQL

```typescript
import { createSequelizeAdapter } from "rollease/db/sequelize";
import { Sequelize } from "sequelize";

const db = createSequelizeAdapter({
  sequelize: new Sequelize(process.env.DATABASE_URL!, { dialect: "postgres" }),
  tablePrefix: "rollease_",
  sync: false,
});
```

### Prisma

```typescript
import { createPrismaAdapter } from "rollease/db/prisma";
import { PrismaClient } from "@prisma/client";

const db = createPrismaAdapter({
  prisma:               new PrismaClient(),
  validateModelFields:  true,
  disconnectOnClose:    false,
});
```

Use `ROLLEASE_PRISMA_REQUIRED_FIELDS` to validate your Prisma schema at startup.

### Drizzle

```typescript
import { createDrizzleAdapter } from "rollease/db/drizzle";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "./db";
import * as tables from "./rollease-schema";

const dbAdapter = createDrizzleAdapter({
  db,
  tables: {
    Flag:       tables.rolleaseFlags,
    Rule:       tables.rolleaseRules,
    Segment:    tables.rolleaseSegments,
    Release:    tables.rolleaseReleases,
    Assignment: tables.rolleaseAssignments,
    History:    tables.rolleaseHistory,
    Impression: tables.rolleaseImpressions,
  },
  helpers: { eq, and, asc, desc },
});
```

### Redis Cache

```typescript
import { createRedisCache } from "rollease/db/redis";

const rl = createRollease({
  db,
  secret,
  cache: {
    driver: "redis",
    redis:  { url: process.env.REDIS_URL! },
    ttl:    60,
  },
});
```

---

## Database Schema

Run this SQL in your PostgreSQL database to create the required tables:

```sql
-- Feature flags
CREATE TABLE rollease_flags (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key             TEXT UNIQUE NOT NULL,
  type            TEXT NOT NULL,  -- 'boolean' | 'string' | 'number' | 'json' | 'multivariate'
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'killed' | 'archived'
  default_value   JSONB NOT NULL,
  description     TEXT,
  tags            TEXT[],
  namespace       TEXT,
  rollout         JSONB,
  variants        JSONB,
  prerequisites   JSONB,
  environment     TEXT,
  environment_defaults JSONB,
  scheduled_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  locked          BOOLEAN DEFAULT false,
  locked_reason   TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Targeting rules
CREATE TABLE rollease_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key    TEXT NOT NULL REFERENCES rollease_flags(key) ON DELETE CASCADE,
  priority    INTEGER NOT NULL DEFAULT 0,
  name        TEXT,
  conditions  JSONB NOT NULL,
  value       JSONB,
  variant_id  TEXT,
  is_holdout  BOOLEAN DEFAULT false,
  enabled     BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Segments (reusable user groups)
CREATE TABLE rollease_segments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT UNIQUE NOT NULL,
  name        TEXT,
  description TEXT,
  rules       JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Sticky user assignments
CREATE TABLE rollease_assignments (
  flag_key    TEXT NOT NULL REFERENCES rollease_flags(key) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  variant_key TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (flag_key, user_id)
);

-- Impression tracking
CREATE TABLE rollease_impressions (
  id          BIGSERIAL PRIMARY KEY,
  flag_key    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  value       JSONB,
  variant_key TEXT,
  reason      TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Audit history
CREATE TABLE rollease_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key    TEXT,
  action      TEXT NOT NULL,
  by          TEXT,
  reason      TEXT,
  diff        JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Releases (atomic multi-flag deployments)
CREATE TABLE rollease_releases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  environment TEXT,
  changes     JSONB NOT NULL,
  snapshots   JSONB,  -- before-state captured at deploy for snapshot rollback
  scheduled_at TIMESTAMPTZ,
  deployed_at  TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Exclusion layers (mutual exclusivity between experiments)
CREATE TABLE rollease_exclusion_layers (
  key         TEXT PRIMARY KEY,
  name        TEXT,
  allocations JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX ON rollease_rules(flag_key, priority);
CREATE INDEX ON rollease_assignments(flag_key, user_id);
CREATE INDEX ON rollease_impressions(flag_key, created_at);
CREATE INDEX ON rollease_history(flag_key, created_at);
```

---

## Webhook Notifications

Configure webhooks to be notified when flags change:

```typescript
const rl = createRollease({
  db, secret,
  webhooks: [
    {
      url:    "https://hooks.slack.com/services/xxx",
      events: ["flag.kill", "flag.restore"],
      headers: { "content-type": "application/json" },
      retry: {
        attempts:  5,
        backoffMs: 500,  // exponential backoff with jitter
      },
      // Called after all retries are exhausted
      dlq: async (payload, lastError) => {
        await db.insert("failed_webhooks", { payload, error: lastError.message });
      },
    },
  ],
});
```

Supported events: `flag.create`, `flag.update`, `flag.kill`, `flag.restore`, `flag.archive`, `rule.add`, `rule.update`, `rule.remove`, `release.deploy`, `release.rollback`.

---

## Scheduled Releases

```typescript
// Create a release that deploys at a future time
await rl.flags.createRelease({
  name:        "Spring launch",
  scheduledAt: new Date("2026-06-01T09:00:00Z"),
  changes: [
    { flagKey: "spring-promo", action: "set_status", value: "active" },
    { flagKey: "legacy-banner", action: "set_status", value: "archived" },
  ],
});

// Deploy pending scheduled releases (call from a cron job or queue worker)
const { deployed, failed } = await rl.flags.runScheduledReleases();
console.log(`Deployed: ${deployed.length}, Failed: ${failed.length}`);

// Rollback — restores exact before-state from snapshot
await rl.flags.rollbackRelease("release-uuid");
```

---

## GDPR / Data Erasure

```typescript
// Erase all data for a user (impressions + assignments + audit history)
await rl.flags.forgetUser("user-123");

// Scope the erasure (omit scope to erase all)
await rl.flags.forgetUser("user-123", {
  impressions: true,
  assignments: true,
  history:     false,
});
```
