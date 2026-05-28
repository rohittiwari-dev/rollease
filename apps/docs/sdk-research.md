# Rollease SDK — Deep-Dive Research & Gap Analysis

**Generated:** 2026-05-28  
**Scope:** Comparison against LaunchDarkly, Statsig, Unleash, GrowthBook, ConfigCat, OpenFeature, PostHog across 24 categories with a prioritized implementation roadmap.

---

## TL;DR Priority Table

| Priority | Category | Gap Severity | Effort |
|----------|----------|--------------|--------|
| P0 | OpenFeature provider | Critical | Low |
| P0 | Server-Sent Events / real-time push | Critical | Medium |
| P0 | Bootstrapping / zero-flicker | Critical | Low |
| P0 | Typed flag keys (codegen) | Critical | Low |
| P1 | Health probe + diagnostic API | High | Low |
| P1 | Dry-run evaluation + trace | High | Medium |
| P1 | Stale-flag CLI + GH Action | High | Medium |
| P1 | A/B metric ingestion (basic) | High | High |
| P1 | Per-environment SDK keys | High | Medium |
| P2 | Retry / backoff / circuit breaker | Medium | Low |
| P2 | OpenTelemetry spans | Medium | Low |
| P2 | GeoIP dimension | Medium | Medium |
| P2 | Streaming bulk export | Medium | Medium |
| P2 | Client-side JS SDK (browser bundle) | Medium | High |
| P3 | Admin REST helper | Low | Medium |
| P3 | Scheduled flag changes (cron) | Low | Low |
| P3 | Rule priority drag-and-drop schema | Low | Low |

---

## Category 1 — OpenFeature Compliance

**What the leaders do:**  
LaunchDarkly, Unleash, and GrowthBook all publish OpenFeature providers. OpenFeature is a CNCF standard defining a `Client` interface with `getBooleanValue`, `getStringValue`, `getNumberValue`, `getObjectValue`, and `EvaluationDetails`. Any SDK that wraps it can be swapped at zero cost.

**Rollease gap:**  
Rollease has its own `evaluate<T>(key, ctx)` surface. There is no OpenFeature `Provider` class, no `EvaluationDetails` shape, and no registration with `@openfeature/server-sdk`.

**Recommendation:**  
Ship a thin adapter in `packages/rollease/src/frameworks/openfeature.ts`:

```ts
import type { Provider, ResolutionDetails, EvaluationContext } from '@openfeature/core'

export class RolleaseOpenFeatureProvider implements Provider {
  readonly metadata = { name: 'Rollease' }
  constructor(private rl: RolleaseClient) {}

  async resolveBooleanValue(flagKey, defaultValue, ctx): Promise<ResolutionDetails<boolean>> {
    const result = await this.rl.evaluate<boolean>(flagKey, toRolleaseCtx(ctx))
    return { value: result.value ?? defaultValue, reason: result.reason, variant: result.variant }
  }
  // same for resolveStringValue, resolveNumberValue, resolveObjectValue
}
```

**Effort:** ~100 lines. No breaking changes. Add `@openfeature/core` as optional peer.

---

## Category 2 — Real-Time Push (SSE / WebSocket)

**What the leaders do:**  
- LaunchDarkly: streaming connection per client, flags update in <200ms of a change.  
- Unleash: SSE endpoint `/api/client/stream` — the client reconnects with `Last-Event-ID`.  
- GrowthBook: polling (30s default) + optional SSE via GrowthBook Cloud.  
- Statsig: WebSocket connection, pushes gate/config diffs.

**Rollease gap:**  
`RolleaseProvider` does HTTP polling (`refreshInterval`, default none). There is no server push. A flag change takes up to `refreshInterval` seconds to reach clients — with no default, most users never poll at all.

**Recommendation:**

Server side — add to `rolleaseMiddleware` or a new `rolleaseStream` handler:

```ts
// GET /api/__rollease/stream
export function rolleaseStream(rl: RolleaseClient): (req: Request) => Response {
  return (req) => {
    const stream = new ReadableStream({
      start(controller) {
        const unsub = rl.onChange(() => {
          const flags = rl.getAllFlagsDetailed(ctxFromReq(req))
          controller.enqueue(`data: ${JSON.stringify(flags)}\n\n`)
        })
        req.signal.addEventListener('abort', unsub)
      }
    })
    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
    })
  }
}
```

Client side — add `streaming?: boolean` to `RolleaseProvider`:

```ts
if (config.streaming) {
  const es = new EventSource(config.flagsUrl.replace('/flags', '/stream'))
  es.onmessage = (e) => setFlags(JSON.parse(e.data))
}
```

**Effort:** ~150 lines server + ~30 lines client. Requires `rl.onChange()` (listeners already exist in `FlagManager`).

---

## Category 3 — Zero-Flicker Bootstrapping

**What the leaders do:**  
LaunchDarkly `bootstrap: 'localStorage'` — serialize evaluated flags to localStorage on first load, hydrate synchronously, update in background. Statsig `initializeAsync()` with pre-evaluated values in the HTML response. GrowthBook `featuresEndpoint` returns cached features with `staleWhileRevalidate`.

**Rollease gap:**  
`RolleaseProvider` starts with `isLoading: true` and shows nothing (or a fallback) until the first fetch resolves. For SSR/RSC apps this is fine — but for pure client-side or hybrid apps it causes a flicker.

**Recommendation:**

Add `bootstrapFlags?: FlagMap | DetailedFlagMap` to `RolleaseProviderConfig`:

```ts
<RolleaseProvider bootstrapFlags={window.__ROLLEASE_FLAGS__}>
```

When `bootstrapFlags` is set, initialize state synchronously and skip the initial fetch. In Next.js, inject the value via a `<script>` tag in the layout:

```tsx
// app/layout.tsx
const flags = await rl.evaluateAllDetailed(ctx)
return (
  <>
    <script
      id="__rollease_bootstrap"
      dangerouslySetInnerHTML={{
        __html: `window.__ROLLEASE_FLAGS__=${JSON.stringify(flags)}`
      }}
    />
    <RolleaseProvider bootstrapFlags={flags}>{children}</RolleaseProvider>
  </>
)
```

**Effort:** ~20 lines in `react.ts`. Add a `getBootstrapScript(rl, ctx)` helper in `next.ts`.

---

## Category 4 — Typed Flag Keys (Codegen)

**What the leaders do:**  
ConfigCat has a code reference scanner. LaunchDarkly has `ld-find-code-refs`. Statsig generates typed wrappers (`Statsig.checkGate('my_gate')` typed as `boolean`, not `unknown`). GrowthBook has a Typescript SDK with codegen from the API.

**Rollease gap:**  
`evaluate<T>(key, ctx)` accepts `string` — no compile-time guarantee the key exists or that `T` matches the flag's type. Renaming a flag in the DB does not surface as a TypeScript error.

**Recommendation:**

Add a codegen script `packages/rollease/cli/generate-types.ts`:

```ts
// Reads all flags from the DB (or an exported JSON snapshot)
// Generates:
export interface RolleaseFlags {
  'checkout-v2': boolean
  'theme': 'dark' | 'light' | 'system'
  'max-items': number
}

// Typed client:
declare module 'rollease' {
  interface FlagRegistry extends RolleaseFlags {}
}
```

Then `evaluate<FlagRegistry['checkout-v2']>('checkout-v2', ctx)` becomes `evaluate('checkout-v2', ctx)` with the type inferred.

Also add a VS Code extension snippet (or Zed/Cursor rule) that autocompletes flag keys from the generated registry.

**Effort:** ~200 lines for codegen script + ~50 lines for typed `evaluate` overload.

---

## Category 5 — Health Probe + Diagnostic API

**What the leaders do:**  
Unleash `/api/health` returns `{ health: "GOOD" | "BAD", version, db }`. LaunchDarkly SDK exposes `initialized()` and a `dataSourceStatus` stream. Statsig `initializeSafe()` never throws — it degrades gracefully.

**Rollease gap:**  
`FlagManager` has no `status()`, `initialized()`, or `diagnostics()` surface. If the DB is unreachable, `evaluate()` throws instead of returning defaults.

**Recommendation:**

```ts
interface RolleaseHealth {
  status: 'healthy' | 'degraded' | 'unhealthy'
  dbReachable: boolean
  cacheHits: number
  cacheMisses: number
  lastFlagSync: Date | null
  flagCount: number
  evaluationCount: number
  uptime: number
}

// On FlagManager:
async health(): Promise<RolleaseHealth>
diagnostics(): { config: Partial<RolleaseConfig>; adapterType: string }
```

Also add `evaluate()` never-throw mode: if `config.resilience?.fallbackOnError` is true, catch DB errors and return `{ value: defaultValue, reason: 'error_fallback' }` with a warning log.

**Effort:** ~80 lines. Mostly plumbing counters already implied by L1/L2 cache tracking.

---

## Category 6 — Dry-Run Evaluation + Trace

**What the leaders do:**  
LaunchDarkly "evaluation reasons" (`LD_REASON=true` env or `withReasonsClient()`). Statsig exposure logging with `Statsig.logLayerParameterExposure()`. GrowthBook `debug: true` — evaluation trace in the result.

**Rollease gap:**  
`evaluate()` returns `{ value, reason, variant }` — reason is present but the trace (which rule matched, which condition, at what step) is not. Debugging a targeting rule requires reading logs.

**Recommendation:**

Add `EvaluationTrace` to `EvalResult`:

```ts
interface EvaluationTrace {
  steps: Array<{
    step: number
    name: string         // 'kill_switch' | 'date_window' | 'rule_match' | ...
    matched: boolean
    detail?: string      // e.g. 'rule id=abc, condition email endsWith @acme.com'
  }>
  matchedRuleId?: string
  matchedVariantId?: string
  prerequisiteResults?: Record<string, boolean>
}
```

Add `evaluate(key, ctx, { trace: true })` option — evaluator accumulates steps into the trace array (no-op when `trace: false` to avoid overhead).

**Effort:** ~100 lines in `evaluator.ts`. Zero overhead on production paths.

---

## Category 7 — Stale Flag Detection + CLI

**What the leaders do:**  
LaunchDarkly Code References CLI scans source and marks flags with no code references as stale after N days. ConfigCat has a "Usage statistics" dashboard. Unleash has `lastSeenAt` per environment.

**Rollease gap:**  
`touchFlagEvaluation()` sets `lastEvaluatedAt` — this is the data foundation. But there is no:
- CLI command to list flags not seen in 30+ days
- API method `listStaleFlags(olderThan: Date)`
- GitHub Action / CI step to fail if stale flags exceed a threshold

**Recommendation:**

Add to `FlagManager`:

```ts
async listStaleFlags(options: { olderThan: Date; includePermanent?: boolean }): Promise<Flag[]>
```

Add CLI (`packages/rollease/cli/stale.ts`):

```
rollease stale --older-than 30d --format json
rollease stale --older-than 30d --fail-on-count 10
```

Add GitHub Action `.github/actions/rollease-stale/action.yml` that runs the CLI and annotates the PR.

**Effort:** ~50 lines for `listStaleFlags` + ~150 lines for CLI + ~30 lines for GH Action YAML.

---

## Category 8 — A/B Metric Ingestion

**What the leaders do:**  
Statsig: `logEvent('purchase', { value: 99.99 })` — events correlated with gate exposures server-side for statistical significance. LaunchDarkly Experimentation: custom metrics, Bayesian stats engine. GrowthBook: SQL-based metric definitions queried by the stats engine separately.

**Rollease gap:**  
`trackImpression()` exists. There is no `trackEvent()`, no metric definitions, no stats engine, no experiment result dashboard.

**Recommendation (minimal viable):**

Phase A — event ingestion only:

```ts
interface RolleaseEvent {
  userId: string
  event: string
  value?: number
  properties?: Record<string, unknown>
  timestamp?: Date
}

// DbAdapter:
trackEvent?(event: RolleaseEvent): Promise<void>

// FlagManager:
async trackEvent(event: RolleaseEvent): Promise<void>
```

Phase B — correlated export:

```ts
// New table: rollease_events (userId, event, value, properties, flagKey, variant, timestamp)
// Expose: db.getExperimentResults(flagKey, metric, { start, end })
```

Phase C — ship stats engine or integrate GrowthBook's open-source stats engine.

**Effort:** Phase A ~100 lines (schema + adapter + manager). Phase B ~300 lines. Phase C: large — use GrowthBook's `@growthbook/growthbook` stats module as a library.

---

## Category 9 — Per-Environment SDK Keys

**What the leaders do:**  
LaunchDarkly, Unleash, and ConfigCat scope every flag state to an environment (dev/staging/prod) via separate SDK keys. A flag can be ON in staging and OFF in prod — completely isolated state, not just a string field.

**Rollease gap:**  
`RolleaseConfig.environment` is a string label used in `evaluateMultiContext` and `environmentDefaults`. There are no separate DB rows per environment — the same flag row is shared. `environmentDefaults` on `Flag` is a partial override but the source of truth is a single record.

**Recommendation:**

Option A (additive, no schema break): Add `FlagEnvironment` table:

```ts
interface FlagEnvironment {
  flagKey: string
  environment: string
  enabled: boolean
  rollout?: Rollout
  rules?: FlagRule[]   // overrides global rules
}
```

`evaluate()` checks `FlagEnvironment` for the current environment first, falls back to the global `Flag`.

Option B (simpler): Current `environmentDefaults` map on `Flag` can store per-env `{ enabled, rollout, defaultValue }`. Evaluation engine already uses it (step 9). Extend it to also carry `rules` overrides. Schema: `environmentDefaults: Record<string, { enabled?, rollout?, defaultValue?, rules? }>`.

Option B is backwards-compatible and requires ~50 lines of evaluator changes.

**Effort (Option B):** ~100 lines.

---

## Category 10 — Retry / Backoff / Circuit Breaker

**What the leaders do:**  
LaunchDarkly SDK: exponential backoff on streaming reconnect (max 30s). Unleash SDK: configurable `backoffMultiplier`. All SDKs: serve from cache when DB is unreachable.

**Rollease gap:**  
`db.getFlag()` fails → `evaluate()` throws → caller gets an unhandled rejection. No backoff on polling in `RolleaseProvider`. No circuit breaker.

**Recommendation:**

Add `resilience` to `RolleaseConfig`:

```ts
interface ResilienceConfig {
  retry?: { attempts: number; backoff: 'linear' | 'exponential'; maxDelayMs: number }
  circuitBreaker?: { threshold: number; resetAfterMs: number }
  fallbackOnError?: boolean   // return defaultValue instead of throwing
}
```

Implement a tiny `withRetry(fn, opts)` and `CircuitBreaker` class in `core/resilience.ts`. Wrap all `db.*` calls in `FlagManager` with these.

**Effort:** ~120 lines. High value, low risk.

---

## Category 11 — OpenTelemetry Spans

**What the leaders do:**  
LaunchDarkly's Go SDK emits OTel spans for `evaluate`. Statsig has an OTel integration guide. GrowthBook Cloud shows p95 evaluation latency.

**Rollease gap:**  
No OTel instrumentation. The `logging.sink` hook gets warnings but not structured spans.

**Recommendation:**

Instrument `evaluate()` with optional OTel:

```ts
// core/telemetry.ts
export interface TelemetryAdapter {
  startSpan(name: string, attrs?: Record<string, unknown>): { end(status?: 'ok'|'error'): void }
}

// RolleaseConfig:
telemetry?: TelemetryAdapter

// Usage in manager.ts:
const span = this.telemetry?.startSpan('rollease.evaluate', { 'flag.key': key })
try { ... span?.end('ok') } catch (e) { span?.end('error'); throw e }
```

Ship a `createOtelAdapter(tracer: Tracer): TelemetryAdapter` helper. Users bring their own `@opentelemetry/api`.

**Effort:** ~60 lines. Zero overhead when `telemetry` is undefined.

---

## Category 12 — GeoIP Dimension

**What the leaders do:**  
LaunchDarkly supports `country` as a built-in attribute on `LDContext`. Unleash has a `LocationStrategy`. ConfigCat has a `countryCode` condition. GrowthBook supports `country` as a filter.

**Rollease gap:**  
`FlagContext` has arbitrary `attributes: Record<string, unknown>` — users can pass `country` manually. But there is no built-in middleware enrichment that automatically resolves IP → country and injects it into context.

**Recommendation:**

Add `geoip` to `rolleaseMiddleware` options:

```ts
interface GeoIPProvider {
  lookup(ip: string): Promise<{ country?: string; region?: string; city?: string }>
}

rolleaseMiddleware(rl, { geoip: myGeoIPProvider })
// → automatically adds { country, region, city } to FlagContext from request IP
```

Ship a Vercel Edge adapter: `import { createVercelGeoIPProvider } from 'rollease/next'` that reads from `request.geo` (already populated by Vercel's Edge Network).

**Effort:** ~80 lines. GeoIP provider is user-supplied (no hard dependency on MaxMind or similar).

---

## Category 13 — Streaming Bulk Export

**What the leaders do:**  
LaunchDarkly Data Export — flag evaluations streamed to Kinesis/PubSub/Azure Event Hubs. Unleash metrics export. Statsig Pulse — metrics pipeline.

**Rollease gap:**  
Impressions are tracked per-evaluation but there is no bulk export or streaming sink.

**Recommendation:**

Add `export` to `RolleaseConfig`:

```ts
interface ExportConfig {
  sink: (batch: ImpressionBatch) => Promise<void>
  batchSize?: number      // default 100
  flushIntervalMs?: number  // default 5000
}
```

`FlagManager` buffers impressions and flushes the batch to `sink` on size threshold or interval. Users plug in Kinesis, BigQuery, a Postgres `COPY`, or a simple HTTP endpoint.

**Effort:** ~100 lines. No external dependencies.

---

## Category 14 — Client-Side Browser SDK

**What the leaders do:**  
Every major SDK ships a separate browser bundle with a tiny footprint:
- LaunchDarkly JS Browser: 28KB gzip, evaluates against a cached flag state, streams updates.
- Statsig JS Browser: 35KB, gate checks are synchronous after `initializeAsync()`.
- GrowthBook JS: 4KB gzip (evaluates in-browser from serialized feature definitions).

**Rollease gap:**  
`rollease/react` is a React hooks wrapper that fetches from the Next.js middleware endpoint — not a standalone browser SDK. It cannot be used outside React, and it requires a Rollease-aware server to produce the signed payload.

**Recommendation:**

Phase A — decouple `RolleaseProvider` from signed payloads: accept a plain `FlagMap` / `DetailedFlagMap` from any source (already partially supported via `bootstrapFlags`).

Phase B — ship `packages/rollease-browser` (or `rollease/browser` export):

```ts
// ~5KB gzip target
export class RolleaseClient {
  constructor(config: { clientKey: string; endpoint: string; context: FlagContext })
  async initialize(): Promise<void>
  getFlag<T>(key: string, defaultValue: T): T
  getAllFlags(): FlagMap
  onChange(listener: () => void): () => void
  identify(newContext: FlagContext): Promise<void>
}
```

This mirrors LaunchDarkly's `initialize()` pattern. The client hits a read-only `/api/sdk/client-flags` endpoint (signed response optional).

**Effort:** Phase A ~20 lines. Phase B ~300 lines (new package).

---

## Category 15 — Admin REST Helper

**What the leaders do:**  
LaunchDarkly REST API: full CRUD for flags, segments, environments, members. Unleash Admin API: same. ConfigCat Management API: full CRUD.

**Rollease gap:**  
`FlagManager` IS the admin surface, but it's embedded in the app process. There is no standalone REST API, no Postman collection, no generated OpenAPI spec.

**Recommendation:**

Ship a `rolleaseAdminRouter(rl)` that returns a framework-agnostic `fetch`-based handler:

```ts
// Works with Next.js route handlers, Hono, Fastify, Express
import { rolleaseAdminRouter } from 'rollease/admin'

// Next.js:
export const { GET, POST, PUT, DELETE } = rolleaseAdminRouter(rl, { secret: process.env.ADMIN_SECRET })
```

Routes: `GET /flags`, `POST /flags`, `PUT /flags/:key`, `DELETE /flags/:key`, `GET /flags/:key/history`, etc.

Generate OpenAPI spec via `rollease generate openapi > openapi.yaml`.

**Effort:** ~400 lines + OpenAPI generation script.

---

## Category 16 — Scheduled Flag Changes (Cron)

**What the leaders do:**  
LaunchDarkly Scheduled Workflow — turn a flag on/off at a specific UTC time. ConfigCat Targeting URL with time-window. Unleash Strategy Constraints with `DATE_BEFORE`/`DATE_AFTER`.

**Rollease gap:**  
`Flag.startDate` and `Flag.endDate` implement a time-window at evaluation time (step 2 of the pipeline). But there is no server-side scheduled mutation — the flag stays in whatever state it's in; the time-window only affects evaluation.

**Recommendation:**

Add `ScheduledChange` table:

```ts
interface ScheduledChange {
  id: string
  flagKey: string
  action: 'enable' | 'disable' | 'setRollout' | 'archive'
  payload?: Record<string, unknown>
  scheduledAt: Date
  executedAt?: Date
  status: 'pending' | 'executed' | 'failed' | 'cancelled'
}
```

Add a `processScheduledChanges()` method that runs pending changes where `scheduledAt <= now`. Hook into a cron: `setInterval(() => rl.processScheduledChanges(), 60_000)` or expose as a Vercel Cron / AWS EventBridge handler.

**Effort:** ~200 lines (schema + adapter + manager method + cron hook).

---

## Category 17 — Mutual Exclusion Layers (Status)

**Current implementation:** `ExclusionLayer` with `allocations: { flagKey, bucketStart, bucketEnd }[]`. Bucket ranges validated (0–100, non-overlapping). Evaluator checks step 4.6.

**What's still missing vs. Statsig:**  
- Statsig layers support "parameter forwarding" — a user in layer `checkout-experiments` who hits experiment A sees `checkout-v2=true`; the same user will never be in experiment B. Rollease allocates by bucket but doesn't enforce that the same user gets the same experiment across evaluations in a session.
- No layer-level metrics rollup (all experiments in a layer feed into one analysis).

**Recommendation:**  
Add `LayerAssignment` table — once a user is assigned to an experiment within a layer, record `{ userId, layerKey, flagKey, variant }`. On subsequent evaluations, read the sticky assignment first (supersedes bucket). This makes the exclusion layer truly sticky, not just bucket-ranged.

**Effort:** ~150 lines (schema + memory + repository + evaluator step change).

---

## Category 18 — Prerequisites (Status)

**Current implementation:** `Flag.prerequisites: FlagPrerequisite[]`, cycle detection (DFS, depth 10), resolved in `evaluateAllDetailed`. Evaluator step 4.5.

**What's missing vs. LaunchDarkly:**  
LaunchDarkly prerequisite semantics: if a prerequisite flag is OFF (serves default), the dependent flag also serves its default. Rollease checks `prerequisite.requiredValue` — this is correct. But:  
- No breadcrumb in the evaluation trace (which prereq failed).
- `evaluateMultiContext` doesn't resolve prerequisites through the same multi-context merge — it evaluates prerequisites with only the primary context.

**Recommendation:**  
Pass the full `MultiContext` through prerequisite resolution. Add `prerequisiteChain: string[]` to the trace. Low effort (~30 lines).

---

## Category 19 — Rule Priority and Ordering

**What the leaders do:**  
LaunchDarkly rules are evaluated top-to-bottom, draggable in the UI. Unleash strategy priority is a numeric field. GrowthBook rule order is explicit.

**Rollease gap:**  
`FlagRule.priority` exists. Evaluator sorts rules by `priority` (ascending). The issue is that `addRule()` does not auto-assign a priority, and `updateRule()` doesn't validate for priority collisions (two rules with the same priority → undefined order).

**Recommendation:**  
Auto-assign `priority = max(existing priorities) + 10` in `addRule()` (gap-based like CSS z-index). Expose `reorderRules(flagKey, ruleIds: string[])` that reassigns priorities 10, 20, 30... in the given order. ~60 lines.

---

## Category 20 — Bulk Operations

**Current implementation:** `bulkCreate()`, `bulkUpdate()` exist on `FlagManager`. Each calls the individual path in a loop.

**What's missing:**  
- No transaction wrapping — if the 5th create fails, the first 4 are committed. Other SDKs either transact or roll back.
- No `bulkEvaluate(keys[], ctx)` — forces `evaluateAllDetailed` even when you need only 3 flags.
- No `bulkArchive(keys[])`.

**Recommendation:**  
Wrap `bulkCreate`/`bulkUpdate` in a DB transaction when the adapter supports it (add optional `transaction()` to `DbAdapter`). Add `bulkEvaluate(keys: string[], ctx: FlagContext)` that short-circuits `evaluateAllDetailed`. ~100 lines.

---

## Category 21 — SDK Initialization Patterns

**What the leaders do:**  
Statsig: `await Statsig.initialize(key, options)` — global singleton, all calls typed.  
LaunchDarkly: `init(key, user)` returns a client; `client.waitForInitialization()`.  
GrowthBook: `new GrowthBook({ features })` — synchronous hydration from pre-fetched features.

**Rollease gap:**  
`createRollease(config)` returns immediately — it does not wait for DB connection or cache warm-up. The first `evaluate()` call may be slow (cold DB query). There is no `waitForReady()`.

**Recommendation:**  
Add `async warmUp(preloadKeys?: string[]): Promise<void>` to `FlagManager`. When called, it fetches all (or specified) flags into L1 cache. The returned `RolleaseClient` from `createRollease` exposes `warmUp()`. Document the pattern:

```ts
const rl = createRollease(config)
await rl.warmUp()   // pre-warms cache in serverless cold start
```

**Effort:** ~30 lines.

---

## Category 22 — Testing & Mock Helpers

**What the leaders do:**  
LaunchDarkly: `TestData` flag builder for unit tests — no DB, no network. Statsig: `StatsigServerSDK.overrideGate('my_gate', true)` in tests. Unleash: `UnleashMock`.

**Rollease gap:**  
The Memory adapter (`createInMemoryAdapter()`) works as a test double, but users have to wire it up manually every time. There is no one-liner mock helper.

**Recommendation:**

Ship `rollease/testing` export:

```ts
import { createMockRollease, mockFlag, mockSegment } from 'rollease/testing'

const rl = createMockRollease({
  flags: [
    mockFlag('checkout-v2', { enabled: true, defaultValue: true }),
    mockFlag('theme', { enabled: true, defaultValue: 'dark', variants: ['dark','light','system'] }),
  ]
})
```

`createMockRollease` returns a fully typed `RolleaseClient` backed by the Memory adapter with pre-seeded flags. ~80 lines.

---

## Category 23 — Flag Lifecycle Governance

**What the leaders do:**  
LaunchDarkly: flag types (permanent vs. temporary), flag status (new/active/launched/inactive), required approvals for production changes. ConfigCat: targeting rules are version-controlled per-config. Unleash: change request workflow.

**Rollease gap:**  
- `Flag.isPermanent` field is missing (affects stale detection — permanent flags are never stale).  
- Approval workflow is partially implemented (`approveRelease`/`rejectRelease`) but there is no way to require approval before a flag is enabled (pre-enable approval).  
- No concept of flag "owners" or "teams" (ABAC prerequisite).

**Recommendation:**  
Add `Flag.isPermanent: boolean`, `Flag.ownerId?: string`, `Flag.teamId?: string`. Add `RolleaseConfig.requireApprovalFor?: ('enable'|'release'|'archive')[]`. When `requireApprovalFor` includes `'enable'`, `update({ enabled: true })` creates a pending `ApprovalRequest` instead of applying immediately. ~200 lines (schema + manager).

---

## Category 24 — Documentation and DX

**What the leaders do:**  
LaunchDarkly Docs: exhaustive, per-SDK code examples, interactive playground. GrowthBook Docs: decision trees, migration guides. Statsig: console.statsig.com interactive flag creator.

**Rollease gap (DX only — docs are separate):**  
- No `rollease init` CLI that scaffolds the DB schema, seeds example flags, and generates the typed registry in one command.  
- No VS Code extension for flag key autocomplete.  
- No `rollease doctor` command that validates the config, DB connection, cache, and reports issues.

**Recommendation:**  

```bash
# Scaffolds schema, creates .rolleaserc.json, generates types
npx rollease init

# Validates everything and prints a health report
npx rollease doctor

# Regenerates typed flag registry
npx rollease generate types
```

**Effort:** ~500 lines for CLI. High DX value. Builds on the codegen work from Category 4.

---

## Competitor Feature Matrix

| Feature | Rollease (current) | LaunchDarkly | Statsig | Unleash | GrowthBook | ConfigCat | PostHog |
|---------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Boolean flags | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Multivariate/string flags | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Percentage rollout | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sticky assignments | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Segments | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Prerequisites | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| Mutual exclusion layers | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Scheduled changes | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Release approvals | ✅ (partial) | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Rollback (snapshot) | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Kill switch | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Audit log | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Webhooks | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Real-time push (SSE) | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bootstrap / zero-flicker | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Typed flag keys (codegen) | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ |
| OpenFeature provider | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ |
| A/B metric ingestion | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ |
| Health probe | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Evaluation trace | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| OTel spans | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| GeoIP dimension | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ |
| Stale flag CLI | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Admin REST API | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Browser SDK | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Retry / circuit breaker | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Mock/test helper | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Init CLI (scaffold) | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ |
| Per-environment SDK keys | Partial | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Permanent flag type | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| RBAC / flag owners | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## Implementation Roadmap

### Sprint 1 — Foundation Gaps (1–2 weeks, low effort, high impact)

1. **OpenFeature provider** — `src/frameworks/openfeature.ts` (~100 lines)
2. **Zero-flicker bootstrapping** — `bootstrapFlags` prop + `getBootstrapScript()` (~50 lines)
3. **Typed flag keys codegen** — `cli/generate-types.ts` + typed `evaluate` overload (~250 lines)
4. **Health probe** — `FlagManager.health()` + `diagnostics()` (~80 lines)
5. **Warm-up** — `FlagManager.warmUp(keys?)` (~30 lines)
6. **Rule auto-priority + `reorderRules()`** — (~60 lines)
7. **Mock test helper** — `rollease/testing` export (~80 lines)

### Sprint 2 — Real-Time and Resilience (2–3 weeks, medium effort)

8. **SSE push** — `rolleaseStream()` server handler + `streaming` prop on provider (~200 lines)
9. **Retry / backoff / circuit breaker** — `core/resilience.ts` (~120 lines)
10. **Dry-run evaluation + trace** — `EvaluationTrace` + `evaluate(key, ctx, { trace })` (~100 lines)
11. **Stale flag CLI** — `cli/stale.ts` + `listStaleFlags()` + GitHub Action (~200 lines)
12. **Scheduled flag changes** — `ScheduledChange` table + `processScheduledChanges()` (~200 lines)

### Sprint 3 — Ecosystem (3–4 weeks, medium–high effort)

13. **Admin REST helper** — `rolleaseAdminRouter()` + OpenAPI spec (~400 lines)
14. **GeoIP middleware enrichment** — `GeoIPProvider` interface + Vercel adapter (~80 lines)
15. **OTel spans** — `TelemetryAdapter` interface + `createOtelAdapter()` (~60 lines)
16. **Per-env SDK keys (Option B)** — extended `environmentDefaults` with rule overrides (~100 lines)
17. **Streaming bulk export** — `ExportConfig` + impression batcher (~100 lines)

### Sprint 4 — A/B and Browser (ongoing)

18. **A/B event ingestion (Phase A)** — `trackEvent()` + schema (~100 lines)
19. **A/B correlated export (Phase B)** — `getExperimentResults()` (~300 lines)
20. **Browser SDK** — `packages/rollease-browser` or `rollease/browser` export (~300 lines)
21. **Init CLI** — `rollease init` + `rollease doctor` + `rollease generate types` (~500 lines)
22. **RBAC full implementation** — flag owners, team scoping, policy enforcement (large)

---

## Sources and References

- LaunchDarkly SDK docs: https://docs.launchdarkly.com/sdk
- LaunchDarkly OpenFeature provider: https://docs.launchdarkly.com/sdk/features/openfeature
- Statsig docs: https://docs.statsig.com/server/nodejsServerSDK
- Statsig layers (mutual exclusion): https://docs.statsig.com/layers
- Unleash SDK docs: https://docs.getunleash.io/reference/sdks
- Unleash OpenFeature provider: https://docs.getunleash.io/reference/sdks/openfeature
- GrowthBook SDK: https://docs.growthbook.io/lib/js
- GrowthBook codegen: https://docs.growthbook.io/tools/cli
- ConfigCat SDK: https://configcat.com/docs/sdk-reference/node
- OpenFeature spec (CNCF): https://openfeature.dev/specification
- PostHog feature flags: https://posthog.com/docs/feature-flags
- Web Crypto API (Edge): https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto
