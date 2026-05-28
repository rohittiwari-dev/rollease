# Rollease SDK Deep-Dive Audit

Date: 2026-05-28  
Scope: `report.md` and `packages/rollease/src` at pre-audit commit `d295729`, plus the implementation pass that followed this audit  
Method: source review, package dry-run, implementation verification, and comparison against feature-management, API security, observability, privacy, and supply-chain standards.

## Implementation Update

Since the original audit snapshot, four high-impact gaps have been implemented:

- Cross-process invalidation: `InvalidationBus`, `MemoryInvalidationBus`, `RedisInvalidationBus`, and manager cache/SSE invalidation publishing.
- Public browser trust controls: handler `clientKeys`, `clientVisible` flags, browser `clientKey` support, explicit flag allowlists, and server-owned context merge.
- Resilience: retry and circuit breaker wrappers around evaluation DB reads, plus health reporting for circuit state and L2 cache probes.
- Event tracking path: `TrackEventInput`, `TrackingEvent`, `FlagManager.trackEvent()`, MemoryDbAdapter storage, batch `/events`, browser batching, and `flush()`.

Remaining high-risk gaps are tenant-namespaced storage, typed-key codegen, OpenFeature conformance/tracking, production event backends/statistics/exposure dedupe, API abuse hardening beyond client keys, and CI/provenance.

## Executive Verdict

Rollease has moved beyond a prototype. The core evaluation engine, in-memory adapter, release model, browser client, Next/React integrations, HTTP handler, OpenFeature wrapper, telemetry adapter, PII scrubbing, webhook signing, scheduled release executor, rollback support, cross-process invalidation, public client key scoping, custom event tracking, and DB resilience controls create a credible alpha SDK.

It is still not production-grade for B2B multi-tenant or experimentation-heavy deployments. The largest remaining gaps are tenant isolation, typed-key tooling, production event/metric backends, exposure dedupe, statistical analysis, and API abuse hardening. Those are industry baseline capabilities for modern feature flag systems, not polish items.

Recommended release posture:

- Single-process internal apps: usable with caution.
- Public browser SDK: usable only with `clientKeys` configured and server-owned context for sensitive claims; still needs rate limiting and signed/session context hardening.
- Multi-replica server deployments: usable only when `config.invalidation` is configured, typically with `RedisInvalidationBus`.
- B2B SaaS or shared infrastructure: not ready without tenant-namespaced storage and tests.
- Experimentation platform: not ready until exposure dedupe, durable production event backends, metric joins, and statistics exist.

## Standards And Industry Baselines Used

- OpenFeature specification: evaluation hooks, provider behavior, and tracking API.
  - https://openfeature.dev/specification/sections/hooks/
  - https://openfeature.dev/specification/sections/tracking/
- OpenTelemetry semantic conventions, including feature flag semantic conventions.
  - https://opentelemetry.io/docs/specs/semconv/
- OWASP API Security Top 10 2023, especially object authorization, authentication, authorization, resource consumption, and security misconfiguration.
  - https://owasp.org/API-Security/editions/2023/en/0x00-header/
- OWASP Logging and Secrets Management Cheat Sheets.
  - https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
  - https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
- LaunchDarkly SDK model: separate server-side and client-side trust boundaries, client-visible flag scoping, streaming/polling, persistent stores.
  - https://launchdarkly.com/docs/sdk/concepts/client-side-server-side
- Statsig client SDK model: cached initialization, exposure logging, periodic event flush, stable anonymous identity.
  - https://docs.statsig.com/client/introduction
- SLSA and npm trusted publishing provenance.
  - https://slsa.dev/spec/v1.2/provenance
  - https://docs.npmjs.com/trusted-publishers/

## Top Findings

| Priority | Finding | Evidence | Impact |
|---|---|---|---|
| Mitigated | Distributed invalidation now has a bus | `FlagManager` can publish invalidation messages through `InvalidationBus`; Redis and memory bus implementations are exported. | Multi-replica deployments must explicitly configure `config.invalidation`; without it, local L1 TTL still bounds staleness. |
| Mitigated | Public browser trust boundary now has client key scoping | Handler `clientKeys` require `X-Rollease-Client-Key` or `clientKey`, filter to `clientVisible` or allowlisted flags, and merge server-owned context. Browser client sends `clientKey`. | Still needs rate limiting, body-size limits, signed/session context options, and operational guidance to avoid trusting sensitive browser-supplied claims. |
| P0 | Multi-tenancy is not load-bearing | `FlagContext.tenantId` exists, but `DbAdapter` methods are keyed by global flag keys, segments, and releases. See `packages/rollease/src/core/types.ts:224` and `packages/rollease/src/db/adapter.ts:33`. | Cross-tenant flag, segment, assignment, and analytics leakage is possible unless every consumer writes custom hooks and storage policy. |
| Mitigated | Resilience config is now wired for DB reads | `withDbResilience()` wraps evaluation read paths with retry and circuit breaker behavior; `health()` reports circuit state. | Stale-while-revalidate and per-flag fallback policy are still open. |
| Partial | Event and conversion tracking has a first durable path | Browser `track()` batches and flushes events; `/events` accepts batches; `FlagManager.trackEvent()` persists through capable adapters; MemoryDbAdapter stores events. | Production adapters, exposure dedupe, metric joins, delivery retries, queue bounds, and statistical analysis remain open. |
| P1 | OpenFeature provider is not conformance-level | Provider implements value resolution and reason mapping only. See `packages/rollease/src/frameworks/openfeature.ts:113`. | Missing OpenFeature hook lifecycle, provider events, tracking, and conformance tests limit portability. |
| P1 | Admin/API hardening is incomplete | Handler defaults CORS to `*`; admin auth is caller-supplied only; there is no body-size limit, rate limit, CSRF guidance, OpenAPI contract, or structured error taxonomy. See `packages/rollease/src/handler.ts:57`, `:83`, `:148`. | Publicly mounted handlers can be misconfigured easily. OWASP API risks apply directly to flag mutation routes. |
| Mitigated | Health reporting probes cache and circuit state | `health()` performs an L2 set/get/delete probe and reports `circuit`. | Operators still need exported metrics for invalidation lag, SSE clients, event queue drops, and adapter latency. |
| P2 | Observability is useful but not standard-shaped | Current span is `rollease.evaluate` with `flag.key` only. See `packages/rollease/src/engine/manager.ts:1236` and `packages/rollease/src/core/telemetry.ts:57`. | Traces lack standard feature flag attributes, value/variant/reason, provider name, error taxonomy, cache status, and metrics. |
| P2 | Publish pipeline and package trust are not ready | `report.md` lists missing CI matrix, coverage gate, semantic release, and provenance. `npm pack --dry-run` produced a 957.3 kB package, 4.7 MB unpacked, with source maps included. | Consumers cannot verify build origin, and package size/sourcemap policy needs an explicit release decision. |

## Detailed Audit

### 1. Evaluation Engine

Strengths:

- The evaluator is pure and deterministic. Bucketing is isolated in `bucket.ts`, and tests include 10k-user bucket distribution checks.
- Evaluation trace is implemented with step-level detail and covered by tests in `packages/rollease/tests/evaluator.test.ts`.
- Rule safety checks reject unsafe regexes and excessive condition complexity through `core/security.ts`.
- Prerequisites are resolved recursively with cycle/depth protection in `FlagManager.evaluateInternal()` at `packages/rollease/src/engine/manager.ts:1294`.

Gaps:

- `fallbackOnError` now returns an `error_fallback` result with `null` value. It still does not return last-known-good values, stale cache values, or per-flag configured fallback.
- `evaluateAllDetailed()` can continue when an authorization hook denies a flag, but this relies on application hooks for tenant isolation. See `packages/rollease/src/engine/manager.ts:538`.
- Segment auto-resolution scans all segments with `db.listSegments()` during evaluation when enabled. See `packages/rollease/src/engine/manager.ts:1365`. This is acceptable for small deployments but needs indexed segment lookup, caching, or precomputation before scale claims.

Recommendation:

- Keep the evaluator pure.
- Add a resilience wrapper around DB/cache reads that supports retry, circuit breaker, stale-while-revalidate, and per-flag fallback policy.
- Add load tests for `evaluate()`, `evaluateAllDetailed()`, segment auto-resolution, and prerequisite-heavy graphs.

### 2. Browser SDK And Public Evaluation

Strengths:

- The browser client is dependency-light, supports localStorage hydration, has `identify()`, `refetch()`, listeners, SSE, and polling fallback.
- It sends context through a header for normal fetches and uses `EventSource` for streaming.

Gaps:

- The SSE path encodes context into a query parameter: `packages/rollease/src/client/index.ts:245`. Query strings are commonly captured by logs, proxies, analytics, and browser history. This is risky for user attributes.
- Public client key scoping now exists for `/flags`, `/flags/:key`, `/flags/stream`, and `/events`, including `clientVisible` filtering and explicit allowlists. The remaining gap is signed/session context hardening for sensitive claims.
- Client-supplied context is only base64 JSON. It is transport encoding, not authentication or integrity protection. See `packages/rollease/src/handler.ts:120`.
- Anonymous bucketing is still missing. The report calls out no fallback device ID when `userId` is absent. Statsig and LaunchDarkly both document stable client identity patterns for anonymous users.

Recommendation:

- Keep public client keys mandatory for browser routes and document required scoping patterns.
- Support signed or server-derived context claims for sensitive attributes. Do not trust arbitrary browser-provided role, plan, tenant, or entitlement fields.
- Move SSE context away from raw query payloads. Options: short-lived stream token, server session context, or POST-to-open-stream handshake through a server-owned session.
- Add anonymous stable ID generation with configurable storage and consent controls.
- Add rate limiting and abuse tests for `/flags`, `/flags/:key`, `/flags/stream`, and `/events`.

### 3. Distributed Runtime And Caching

Strengths:

- L1 memory cache and optional L2 cache are wired into flag, rule, and exclusion-layer reads.
- Mutations call cache busting methods consistently in the manager.
- Redis cache adapter supports `get`, `set`, `del`, `delPattern`, and `close`.

Gaps:

- Redis invalidation now exists through `RedisInvalidationBus`, separate from `RedisCacheAdapter`. It is opt-in via `config.invalidation`, so deployments that omit it still rely on L1 TTL.
- Mutation events can propagate across replicas through the invalidation bus; in-process listeners still handle local subscribers.
- L1 negative caching for missing flags is good for DB protection, but create/clone freshness across replicas depends on an invalidation bus being configured.
- There is no ETag/revision protocol for browser polling, no server-sent patch events, and no version watermark.

Recommendation:

- Keep `InvalidationBus` independent of `CacheAdapter`, and document Redis deployment requirements.
- Expand invalidation messages as release/event/version use cases grow.
- Include monotonic config versions or updated-at watermarks in evaluation responses.
- Add tests that instantiate two `FlagManager` instances over the same DB and verify cache/SSE coherence after mutation.

### 4. Multi-Tenancy

Strengths:

- `tenantId` exists on `FlagContext`, and hooks can deny evaluation before reads.
- The evaluator can use `tenantId` as a rule dimension.

Gaps:

- Storage contracts are global. `getFlag(key)`, `listRules(flagKey)`, `getUserAssignment(flagKey, userId)`, `listSegments()`, and release operations do not include tenant scope.
- Cache keys are global, for example `rollease:flag:${key}` and `rollease:rules:${key}`. See `packages/rollease/src/engine/manager.ts:1392`.
- Admin routes mutate global keys. There is no route-level tenant scoping.
- `forgetUser(userId)` can delete globally by user ID unless adapters scope it internally.

Recommendation:

- Decide whether Rollease is single-tenant per SDK instance or multi-tenant by design.
- If multi-tenant by design, add `tenantId` to storage schemas, adapter method signatures, cache keys, and unique constraints.
- Add tenant-scoped admin APIs and tests proving tenant A cannot list, evaluate, update, or delete tenant B data.
- Add migration guidance for existing single-tenant users.

### 5. Security And Privacy

Strengths:

- Prototype-pollution keys are rejected.
- Override path traversal is guarded.
- Regex safety and condition depth/node limits exist.
- Next.js signed envelope handling includes replay and future-date checks in tests.
- Webhook signatures use Web Crypto and include replay checks.
- `privacy.privateAttributes` scrubs evaluation context before impressions and hooks.

Gaps:

- No SDK key rotation model. `createRollease()` requires one secret and accepts no key ring. See `packages/rollease/src/index.ts:270`.
- Deprecated `__rollease.secret` remains on the public client object for compatibility. The comment explicitly says it can leak if serialized. See `packages/rollease/src/index.ts:246`.
- Handler error responses expose raw `errMsg(e)` for some 500s. See `packages/rollease/src/handler.ts:192` and `:247`.
- `GET /health` is public by default. It includes latency, eval counts, cache hit counts, uptime, and status. See `packages/rollease/src/handler.ts:177`.
- CORS defaults to `*` on all routes. See `packages/rollease/src/handler.ts:57`.

Recommendation:

- Add secret key-ring support with `kid`, active signing key, previous verification keys, and documented rotation procedure.
- Remove `__rollease.secret` in the next breaking release.
- Split public, admin, and health CORS/auth options.
- Return stable public error codes while logging internal details server-side.
- Add body-size limits, request timeouts, and rate-limit integration points.

### 6. Tracking, Analytics, And Experimentation

Strengths:

- The browser client exposes `track()`, batches events by size/interval, and exposes `flush()`.
- The handler accepts single or batched `/events` payloads and routes them through `FlagManager.trackEvent()`.
- `DbAdapter` has an optional tracking event capability, and MemoryDbAdapter stores scrubbed custom events for tests/local use.
- Impression tracking exists for evaluation and can be sampled.

Gaps:

- Repository/SQL and Sequelize adapters do not yet persist `TrackingEvent`; production users still need a durable event backend.
- Browser event delivery has batching and flush, but still needs retry policy, queue size bounds, pagehide/sendBeacon behavior, and failure telemetry.
- There is no exposure dedupe for impressions or custom events.
- No conversion attribution, metric definitions, experiment exposure join, sequential testing guardrails, CUPED, or statistical engine exists.

Recommendation:

- Add `trackEvent()` persistence to production adapters or provide a first-class event sink adapter.
- Use explicit event types: exposure, custom event, conversion, metric sample.
- Add client batching with max batch size, max interval, backoff, pagehide/visibility flush, and bounded memory.
- Implement exposure dedupe by `(userId or anonymousId, flagKey, variant, experimentId, session/window)`.
- Defer statistical analysis until raw event correctness is proven.

### 7. OpenFeature Compatibility

Strengths:

- Provider is dependency-free through structural typing.
- `targetingKey` maps to `userId`.
- Reasons are mapped to OpenFeature-style values.

Gaps:

- OpenFeature hook lifecycle is not implemented by the provider. The spec requires before, after, error, and finally stages, with defined ordering.
- OpenFeature tracking is missing even though the spec defines a track function.
- Provider events, initialization/close semantics, and conformance tests are absent.
- Context conversion puts all non-targeting fields into `attributes`, which may lose first-class Rollease fields such as `environment`, `tenantId`, `region`, and `segments` unless callers adapt manually.

Recommendation:

- Add explicit conformance tests against the OpenFeature JS/server provider expectations.
- Preserve known Rollease context fields during conversion.
- Implement provider tracking once event backend exists.
- Document supported and unsupported OpenFeature spec sections.

### 8. Observability And Operations

Strengths:

- `createOtelAdapter()` avoids a hard OpenTelemetry dependency.
- Every public `evaluate()` call starts a span when telemetry is configured.
- Health includes DB probe latency and cache/evaluation counters.

Gaps:

- Span attributes are not aligned with OpenTelemetry feature flag semantic conventions.
- `evaluateAllDetailed()` does not appear to start one span per flag or a bulk span with counts.
- Health now probes L2 cache availability and reports circuit state.
- No Prometheus endpoint or metrics adapter exists.
- No operator-facing diagnostics for cache invalidation lag, stream subscriber count, DLQ count, or event queue length.

Recommendation:

- Emit standard feature flag attributes: flag key, provider name, variant, reason, result type, error type, cache state, and environment.
- Add counters/histograms for evaluations, errors, cache hits/misses, DB latency, webhook attempts, event queue drops, SSE clients, and invalidation lag.
- Add optional bus probes and timeout budgets around health checks.
- Add `/metrics` through an adapter rather than a hard Prometheus dependency.

### 9. Adapter Layer And Data Model

Strengths:

- Memory, Prisma, Drizzle, Sequelize, Repository, and Redis cache adapters cover common server use cases.
- The repository adapter pattern gives teams a way to map existing persistence layers.
- Adapter tests validate required model/delegate shape.

Gaps:

- No edge-native durable adapters exist for Cloudflare KV/D1, Vercel KV, Deno KV, or Durable Objects.
- Bulk operations are implemented at manager level but not guaranteed transactional across adapters.
- Release deployment and rollback safety depends on adapter correctness; transaction support is not part of the adapter contract.
- `forgetUser()` is optional and not enforced for custom adapters.

Recommendation:

- Add optional adapter capability metadata, for example `{ transactions, forgetUser, batchReads, eventStore, tenantScoped }`.
- Add transaction hooks for release deploy/rollback and bulk mutations.
- Add edge adapter first for the platform most likely to host the browser-facing handler.
- Add contract tests all adapters must pass.

### 10. Developer Experience

Strengths:

- README is extensive.
- Example Next.js app exists.
- Test mock client exists and uses the real in-memory adapter.
- Subpath exports are broad.

Gaps:

- No typed flag key/codegen workflow.
- No CLI for scaffolding, export/import, kill switch, validation, or migrations.
- No TypeDoc API reference.
- No OpenAPI spec for the handler.
- `report.md` still contains encoding artifacts when read through the local shell, suggesting docs encoding should be normalized and checked in CI.

Recommendation:

- Implement `rollease codegen` that emits a typed flag registry from DB/exported JSON.
- Add module augmentation or generated `FlagDefinitions` for `flag("key")` type narrowing.
- Add `rollease validate`, `rollease export`, `rollease import`, `rollease kill`, and `rollease doctor`.
- Generate TypeDoc and OpenAPI on CI.

### 11. Build, Release, And Supply Chain

Strengths:

- `tsup` emits CJS, ESM, and declaration files.
- Optional peers are marked in package metadata.
- `npm pack --dry-run` succeeds.

Gaps:

- No CI matrix is shown for Node 18/20/22, Bun, edge runtime, and browser bundles.
- No semantic release or changesets.
- No coverage gate in CI.
- No npm trusted publishing/provenance.
- Source maps are included in the package. This may be intentional, but it should be an explicit decision.

Recommendation:

- Add GitHub Actions for lint, typecheck, tests, coverage, build, package smoke tests, and edge import tests.
- Add changesets or semantic-release.
- Publish via npm trusted publishing with provenance.
- Add `npm pack --dry-run` and import smoke tests to CI.
- Decide whether production source maps are part of the package contract.

## Prioritized Remediation Plan

### Phase A: Production Safety Gate

1. ✅ Add public/client key model with environment scope and client-visible flag allowlist.
2. Add signed or server-owned context for public browser evaluation.
3. ✅ Add Redis pub/sub invalidation bus and two-manager coherence tests.
4. Add tenant storage decision. If multi-tenant is supported, make tenant scope part of every storage/cache key.
5. Add body limits, rate-limit hooks, public/admin CORS separation, and safer error responses.

Exit criteria:

- A browser client cannot evaluate a flag that is not marked client-visible for its key/environment.
- A browser client cannot impersonate role, plan, or tenant through arbitrary JSON context.
- Two SDK instances connected to the same store and invalidation bus converge immediately after mutation.
- Tenant isolation has negative tests across evaluation, admin routes, assignments, impressions, history, and forget-user.

### Phase B: Experimentation And Standards

1. ⚠️ Implement durable `trackEvent()` across manager, handler, adapters, and browser batching. Manager, handler, browser, and MemoryDbAdapter are done; production adapters remain.
2. Add exposure dedupe, retry, bounded queues, and pagehide-safe flush/shutdown.
3. Implement OpenFeature tracking and context conversion improvements.
4. Add OpenFeature conformance-style tests and document unsupported sections.
5. Add OpenTelemetry semantic-convention attributes and metrics adapter.

Exit criteria:

- Exposure events and conversion events can be joined reliably.
- Client events are batched, retried, bounded, flushed on shutdown/pagehide, and privacy-scrubbed.
- OpenFeature users can rely on documented hook/tracking behavior.
- Traces and metrics can be queried by flag key, variant, reason, environment, and error state.

### Phase C: Enterprise And Release Readiness

1. ⚠️ Add retry, circuit breaker, stale fallback, and cache/bus health probes. Retry, circuit breaker, and cache probes are done; stale fallback and bus health remain.
2. Add TypeDoc, OpenAPI, and CLI.
3. Add codegen for typed flag keys and typed variations.
4. Add CI matrix, coverage gates, package smoke tests, changesets, and npm provenance.
5. Add edge-native adapters and adapter capability metadata.

Exit criteria:

- Failures degrade predictably and are visible in health/metrics.
- Published package has verifiable provenance.
- Consumers can generate type-safe flag accessors and validate config in CI.
- Edge deployment path is documented and tested.

## Risk Register

| Risk | Likelihood | Impact | Current Control | Needed Control |
|---|---:|---:|---|---|
| Stale flag after mutation in multi-replica deployment | Low if bus configured, High otherwise | High | L1/L2 delete plus optional `InvalidationBus` | Require RedisInvalidationBus in multi-replica deployment docs plus versioned evaluation payloads |
| Browser user self-asserts privileged context | Medium | High | Client keys, client-visible filters, explicit allowlists, server-owned context merge | Signed/session context for sensitive claims plus rate limits |
| Cross-tenant data leakage | Medium | Critical | Optional hook | Tenant-scoped storage contract and cache keys |
| DB outage causes cascading failures | Low/Medium | High | `fallbackOnError`, retry, circuit breaker, cache health probes | Stale fallback and per-flag fallback policy |
| Experiment results are inaccurate | High | High | Impression tracking, custom event path, browser batching | Exposure dedupe, production event store, metric joins |
| Admin route misconfiguration | Medium | High | `adminAuth` callback | Opinionated auth examples, CORS split, rate limit, OpenAPI, body limits |
| Supply-chain trust gap | Medium | Medium | Manual build/package | CI provenance, package smoke tests, release automation |

## Final Recommendation

Do not market Rollease as production-ready yet. Market it as an alpha SDK for controlled environments while prioritizing the Phase A safety gate. The technical foundation is strong enough to justify continued investment, but the remaining gaps are architectural. Fixing them later will be more expensive once consumers depend on the current public handler, storage contract, and browser context model.

The next best engineering move is to implement distributed invalidation and public-client trust boundaries before adding more framework integrations.
