Rollease SDK — Status Report (updated 2026-05-28, eval-trace shipped)

▎ Original audit: compared Rollease against LaunchDarkly Server-SDK 9.x, Statsig 6.x, Unleash 5.x, GrowthBook 1.x, ConfigCat 9.x, OpenFeature 0.7, PostHog across 24 categories.
▎ This update: reflects what has actually been implemented since the original audit.
▎ Build: clean (tsup --dts). Tests: 216 passing across 18 test files.

---

## Status Legend

✅ Done — shipped and tested
⚠️  Partial — type/stub exists but behaviour not fully wired
❌ Not done — gap from original audit still open

---

1. Executive Summary

### Now strong (new since audit)

- ✅ Universal HTTP handler (`rl.createHandler()`) — mounts at a single catch-all route in Next.js, Hono, Bun, Cloudflare Workers. Replaces the "admin REST router" gap.
- ✅ Browser/SPA client (`rollease/client`) — zero Node deps, SSE + localStorage zero-flicker, `identify()`, `refetch()`, `onChange()`.
- ✅ React provider updated to accept browser client — SSE-driven, no URL polling required.
- ✅ Next.js App Router handler (`toNextHandlers`) — one-line `export const { GET, POST, PATCH, DELETE, OPTIONS } = ...`.
- ✅ Test mock client (`rollease/testing`) — `createMockRollease()` backed by real MemoryDbAdapter. `setFlag()`, `overrideFlag()`, `resetAll()`.
- ✅ OpenFeature provider (`rollease/openfeature`) — structural typing, no hard dep, reason mapping, `targetingKey → userId`.
- ✅ Telemetry (`rollease/telemetry`) — `createOtelAdapter(tracer)`, `createConsoleAdapter()`, `noopSpan`. Spans on every `evaluate()`.
- ✅ Health probe — `rl.health()` returns `{ status, db, cache, latencyMs, evalCount, cacheHits, cacheMisses, cacheHitRate, uptimeMs }`. Wired into `GET /health` (returns 503 when unhealthy).
- ✅ Graceful degradation — `resilience.fallbackOnError: true` catches DB errors and returns `{ value: null, reason: 'error_fallback' }` instead of throwing.
- ✅ PII scrubbing — `privacy.privateAttributes` redacts keys to `'[REDACTED]'` before impression tracking and evaluation hooks.
- ✅ GDPR `forgetUser()` — `rl.flags.forgetUser(userId, scope?)` deletes impressions, assignments, and history. Implemented in all three adapters.
- ✅ Scheduled-release executor — `rl.flags.runScheduledReleases()` queries `db.listScheduledReleases()`, deploys each, returns `{ deployed, failed }`. Call from your own cron/job queue.
- ✅ Webhook retry + DLQ — exponential backoff (configurable attempts, backoffMs, jitter). After all retries: calls `config.dlq(payload, lastError)`.
- ✅ SSE streaming endpoint — `GET /flags/stream` pushes `DetailedFlagMap` on flag change. Browser client subscribes via `EventSource`.
- ✅ Snapshot-based rollback — all three adapters (Memory, Prisma/Repository, Sequelize) capture before-state on deploy, restore on rollback.
- ✅ Security hardening — segment usage scanner (no JSON.stringify false-positives), override path traversal guard, prototype-pollution key rejection, locked-flag update guard, secret in closure (not on client object), lazy `next/server` import, Edge-safe `fs`.
- ✅ Example Next.js app — `apps/example/` with middleware, RSC `getFlag`, client `useFlag`, SSE live updates, `/api/rollease/*` handler.

### Gaps that remain open (ranked by impact)

1. ❌ Redis pub/sub cache invalidation — multi-replica deployments still have up to `l1TtlMs` (5s) stale window per instance.
2. ✅ Eval-trace API — `evaluate(key, ctx, { trace: true })` populates `FlagResult.trace` with step-by-step pipeline trace including matched/bypassed status and detail strings. 13 regression tests.
3. ❌ Typed flag keys + codegen — no compile-time enforcement; typos in flag keys are runtime errors.
4. ❌ Circuit breaker — `ResilienceConfig.circuitBreaker` type exists; not wired.
5. ❌ Cloudflare KV / Vercel KV / Deno KV adapters — still no edge-native DB.
6. ❌ CLI (`npx rollease`) — no scaffolding, export/import, or kill-switch tooling.
7. ❌ Conversion/metric tracking — no `rl.track()`, no event batching.
8. ❌ Multi-tenant storage namespacing.
9. ❌ Statistical analysis engine.
10. ❌ Vue, Svelte, React Native, mobile integrations.

---

2. SDK Initialization & Identity (P1)

┌─────────────────────────────────────────────────────┬────────────────────────────┬───────────────────────────────────────────────┐
│ Feature                                             │ Industry                   │ Rollease                                      │
├─────────────────────────────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────┤
│ Server SDK key                                      │ LD ✓, Statsig ✓, Unleash ✓ │ only secret (signing key, not access key)     │
├─────────────────────────────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────┤
│ Client-side SDK key (read-only, public)             │ LD, Statsig, ConfigCat     │ ❌ (browser client uses basePath convention)  │
├─────────────────────────────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────┤
│ SDK key rotation                                    │ LD, Statsig                │ ❌                                            │
├─────────────────────────────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────┤
│ Per-environment keys                                │ LD, Statsig, GrowthBook    │ ❌ (only config.environment filter)           │
├─────────────────────────────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────┤
│ SDK metadata (name/version) auto-attached to events │ LD, Statsig                │ ❌                                            │
├─────────────────────────────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────┤
│ Anonymous bucketing keys                            │ LD, GrowthBook             │ ❌ (no fallback to device-id when userId missing)│
└─────────────────────────────────────────────────────┴────────────────────────────┴───────────────────────────────────────────────┘

---

3. Streaming / Real-time Update Channel (P0)

┌──────────────────────────────────────────────┬───────────────────────────────────────┬──────────────────────────────────────────────────────────┐
│ Feature                                      │ Industry                              │ Rollease                                                 │
├──────────────────────────────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────────────────────┤
│ SSE endpoint                                 │ LD, Unleash, Statsig                  │ ✅ GET /flags/stream — pushes DetailedFlagMap on change   │
├──────────────────────────────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────────────────────┤
│ Browser client SSE subscription              │ LD, Statsig                           │ ✅ EventSource + onChange() in rollease/client            │
├──────────────────────────────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────────────────────┤
│ Polling with conditional GET (ETag)          │ LD, GrowthBook                        │ ❌                                                       │
├──────────────────────────────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────────────────────┤
│ Offline / disk-persisted cache               │ LD, Statsig                           │ ⚠️  localStorage in browser client; no server-side disk  │
├──────────────────────────────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────────────────────┤
│ Cross-process invalidation via Redis pub/sub │ LD Redis store                        │ ❌ (multi-replica L1 stale window = l1TtlMs = 5s)        │
└──────────────────────────────────────────────┴───────────────────────────────────────┴──────────────────────────────────────────────────────────┘

Impact: SSE propagation within a single process is now instant. Across replicas the 5s L1 stale window still applies until Redis pub/sub is added.

---

4. Client-side SDKs (P0)

┌─────────────────────────────┬──────────────────────┬──────────────────────────────────────────────────────────────────────┐
│ Target                      │ Industry             │ Rollease                                                             │
├─────────────────────────────┼──────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Browser (vanilla, no React) │ LD, Statsig, PostHog │ ✅ createRolleaseClient() in rollease/client                         │
├─────────────────────────────┼──────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ React (without Next.js)     │ LD, Statsig          │ ✅ RolleaseProvider + useFlag (accepts browser client prop)          │
├─────────────────────────────┼──────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Next.js App Router          │ LD, Statsig          │ ✅ rolleaseMiddleware + getFlag RSC + toNextHandlers                  │
├─────────────────────────────┼──────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ React Native                │ LD, Statsig          │ ❌                                                                   │
├─────────────────────────────┼──────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Vue                         │ LD, Unleash          │ ❌                                                                   │
├─────────────────────────────┼──────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Svelte                      │ community            │ ❌                                                                   │
├─────────────────────────────┼──────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Mobile (iOS/Android)        │ LD, Statsig          │ ❌                                                                   │
└─────────────────────────────┴──────────────────────┴──────────────────────────────────────────────────────────────────────┘

Note: the browser SDK works with any SPA (Vite, CRA, etc.) — no Next.js required. It posts context as a base64 header and subscribes to SSE for live updates.

---

5. Evaluation Engine (P1)

Present (industry parity): percentage rollout, ramp schedule, multivariate weighted, segments, prerequisites (with cycle detection), mutual exclusion layers, holdouts, sticky assignments, multi-context, environment scoping, local developer overrides.

┌────────────────────────────────────────────────────────────────┬───────────────────────────────┬─────────────────────────────────────────────────────────────────┐
│ Feature                                                        │ Industry                      │ Rollease                                                        │
├────────────────────────────────────────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────────────────────────────┤
│ Configurable bucketing salt per flag                           │ LD, Statsig                   │ ❌ (hardcoded flag.key — can't reshuffle without re-keying)       │
├────────────────────────────────────────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────────────────────────────┤
│ Private/PII attributes (redacted from events)                  │ LD privateAttributes           │ ✅ privacy.privateAttributes + scrubContext() wired               │
├────────────────────────────────────────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────────────────────────────┤
│ Anonymous user bucketing                                       │ LD, GrowthBook                │ ❌ no fallback to device-id when userId absent                    │
├────────────────────────────────────────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────────────────────────────┤
│ Eval-trace ("why did user X get value Y?")                     │ Statsig, GrowthBook           │ ✅ evaluate(key, ctx, { trace: true }) → FlagResult.trace with      │
│                                                                │                               │    per-step matched/detail breakdown. 13 regression tests.      │
├────────────────────────────────────────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────────────────────────────┤
│ Pre-flag evaluation hooks (can mutate context)                 │ OpenFeature before hooks      │ ❌ onBeforeEvaluation exists but cannot mutate context            │
└────────────────────────────────────────────────────────────────┴───────────────────────────────┴─────────────────────────────────────────────────────────────────┘

---

6. Analytics & Experiment Tracking (P0 for experimentation)

┌──────────────────────────────────────────────────────────────────┬──────────────────────┬────────────────────────────────────────────────┐
│ Feature                                                          │ Industry             │ Rollease                                       │
├──────────────────────────────────────────────────────────────────┼──────────────────────┼────────────────────────────────────────────────┤
│ Impression / exposure events                                     │ LD ✓, Statsig ✓      │ ✅ fire-and-forget, configurable sampleRate     │
├──────────────────────────────────────────────────────────────────┼──────────────────────┼────────────────────────────────────────────────┤
│ Exposure deduplication                                           │ LD, Statsig          │ ❌ records every eval                          │
├──────────────────────────────────────────────────────────────────┼──────────────────────┼────────────────────────────────────────────────┤
│ Conversion / metric tracking (track())                           │ LD, Statsig, PostHog │ ❌                                             │
├──────────────────────────────────────────────────────────────────┼──────────────────────┼────────────────────────────────────────────────┤
│ Event batching + flush on interval/size                          │ LD, Statsig          │ ❌ (sync per-eval)                             │
├──────────────────────────────────────────────────────────────────┼──────────────────────┼────────────────────────────────────────────────┤
│ SRM detection, A/A diagnostics, sequential testing              │ Statsig, GrowthBook  │ ❌                                             │
├──────────────────────────────────────────────────────────────────┼──────────────────────┼────────────────────────────────────────────────┤
│ Custom analytics sink (Segment, Mixpanel)                        │ LD via integrations  │ ❌                                             │
└──────────────────────────────────────────────────────────────────┴──────────────────────┴────────────────────────────────────────────────┘

---

7. Admin / Management API (P1)

┌──────────────────────────────────────────────────────────────┬───────────────────────────────────┬──────────────────────────────────────────────────────────────────┐
│ Feature                                                      │ Industry                          │ Rollease                                                         │
├──────────────────────────────────────────────────────────────┼───────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ REST API for flag CRUD                                       │ LD, Statsig, Unleash, ConfigCat   │ ✅ createRolleaseHandler() / rl.createHandler() — universal fetch  │
│                                                              │                                   │    handler, mounts in Next.js / Hono / Bun.serve / CF Workers     │
├──────────────────────────────────────────────────────────────┼───────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ Admin auth gate                                              │ LD, Statsig                       │ ✅ adminAuth: async (req) => boolean option                       │
├──────────────────────────────────────────────────────────────┼───────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ Webhook receiver helper                                      │ LD, Statsig                       │ ✅ verifyWebhookSignature() + WebhookDispatcher.on/off            │
├──────────────────────────────────────────────────────────────┼───────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ GraphQL                                                      │ LD partial                        │ ❌                                                               │
├──────────────────────────────────────────────────────────────┼───────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ CLI                                                          │ LD ldcli, Unleash, ConfigCat      │ ❌                                                               │
├──────────────────────────────────────────────────────────────┼───────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ GitOps (sync from YAML in repo)                              │ Unleash flagsmith-cli, GrowthBook │ ❌                                                               │
├──────────────────────────────────────────────────────────────┼───────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ OpenAPI / Postman collection                                 │ LD, Statsig                       │ ❌                                                               │
└──────────────────────────────────────────────────────────────┴───────────────────────────────────┴──────────────────────────────────────────────────────────────────┘

Routes exposed by the universal handler:
  GET    /health                   — health probe (db + cache + metrics)
  GET    /flags                    — evaluate all flags for caller context
  GET    /flags/stream             — SSE stream of DetailedFlagMap on change
  GET    /flags/:key               — evaluate single flag
  POST   /events                   — client-side impression sink
  GET    /admin/flags              — list all flags (requires adminAuth)
  POST   /admin/flags              — create flag
  PATCH  /admin/flags/:key         — update flag
  DELETE /admin/flags/:key         — delete flag
  POST   /admin/flags/:key/kill    — kill switch
  GET    /admin/flags/:key/history — audit history
  GET    /admin/segments           — list segments
  POST   /admin/segments           — create segment

---

8. Observability (P1)

┌──────────────────────────────────────────────────┬─────────────────────────────────┬─────────────────────────────────────────────────────────────┐
│ Feature                                          │ Industry                        │ Rollease                                                    │
├──────────────────────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ Health probe (/health, /ready)                   │ LD, Statsig                     │ ✅ rl.health() + GET /health (503 when db: 'error')         │
├──────────────────────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ OpenTelemetry spans on every evaluation          │ LD, OpenFeature ecosystem       │ ✅ createOtelAdapter(tracer) in rollease/telemetry           │
│                                                  │                                 │    Span wraps every evaluate() call with ok/error status    │
├──────────────────────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ Console tracing adapter                          │ LD                              │ ✅ createConsoleAdapter() — debug without OTel setup         │
├──────────────────────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ Cache hit-rate + eval count metrics              │ LD, Statsig                     │ ✅ in rl.health(): evalCount, cacheHits, cacheHitRate        │
├──────────────────────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ Eval-trace API ("why did user X get value Y?")   │ Statsig, GrowthBook             │ ✅ evaluate(key, ctx, { trace: true }) — full step trace      │
├──────────────────────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ Prometheus / OpenMetrics endpoint                │ LD, Statsig                     │ ❌                                                          │
├──────────────────────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ Eval latency p50/p95/p99                         │ LD, Statsig                     │ ❌ (only latencyMs for DB ping in health())                  │
├──────────────────────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ Custom log/audit exporters (Datadog, Splunk, S3) │ LD, Statsig                     │ ⚠️  AuditSink type exists, logging.sink wired, not exported  │
└──────────────────────────────────────────────────┴─────────────────────────────────┴─────────────────────────────────────────────────────────────┘

---

9. Release Orchestration (P1)

┌──────────────────────────────────────────────────────┬─────────────────────────────────────────────────┬────────────────────────────────────────────────────────────────┐
│ Feature                                              │ Industry                                        │ Rollease                                                       │
├──────────────────────────────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┤
│ Atomic releases with snapshot-based rollback         │ LD partial                                      │ ✅ all 3 adapters capture before-state, restore on rollback     │
├──────────────────────────────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┤
│ Approval workflow                                    │ LD, ConfigCat                                   │ ✅ approveRelease / rejectRelease                              │
├──────────────────────────────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┤
│ Scheduled release (store + execute)                  │ LD                                              │ ✅ stored + rl.flags.runScheduledReleases() executor            │
│                                                      │                                                 │    (caller must wire into cron/BullMQ/Inngest)                 │
├──────────────────────────────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┤
│ Gradual rollout with auto-pause on metric regression │ Statsig "Auto-Scenarios", LD "Guarded Releases" │ ❌                                                             │
├──────────────────────────────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┤
│ Auto-rollback on error budget breach                 │ Statsig, LD                                     │ ❌                                                             │
├──────────────────────────────────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┤
│ Multi-env promotion (dev → staging → prod)           │ LD, Unleash                                     │ ❌                                                             │
└──────────────────────────────────────────────────────┴─────────────────────────────────────────────────┴────────────────────────────────────────────────────────────────┘

---

10. Security / Compliance (P0 for enterprise)

┌───────────────────────────────────────────────────────────────────────────┬───────────────────────┬──────────────────────────────────────────────────────────────┐
│ Feature                                                                   │ Industry              │ Rollease                                                     │
├───────────────────────────────────────────────────────────────────────────┼───────────────────────┼──────────────────────────────────────────────────────────────┤
│ HMAC-signed transport (v2 DetailedFlagMap envelope + v1 compat)           │ LD ✓                  │ ✅                                                           │
├───────────────────────────────────────────────────────────────────────────┼───────────────────────┼──────────────────────────────────────────────────────────────┤
│ Replay protection (timestamp window + clock-skew guard)                   │ LD                    │ ✅                                                           │
├───────────────────────────────────────────────────────────────────────────┼───────────────────────┼──────────────────────────────────────────────────────────────┤
│ Edge-safe (Web Crypto, lazy fs)                                           │ LD, Statsig           │ ✅                                                           │
├───────────────────────────────────────────────────────────────────────────┼───────────────────────┼──────────────────────────────────────────────────────────────┤
│ Audit trail                                                               │ LD, Statsig           │ ✅                                                           │
├───────────────────────────────────────────────────────────────────────────┼───────────────────────┼──────────────────────────────────────────────────────────────┤
│ Prototype-pollution key rejection (__proto__, constructor, …)             │ LD, Statsig           │ ✅ assertSafeFlagKey / assertSafeSegmentKey                   │
├───────────────────────────────────────────────────────────────────────────┼───────────────────────┼──────────────────────────────────────────────────────────────┤
│ Override path traversal guard                                             │ —                     │ ✅ validateOverridePath rejects ../                           │
├───────────────────────────────────────────────────────────────────────────┼───────────────────────┼──────────────────────────────────────────────────────────────┤
│ Secret in closure (not on client object)                                  │ LD                    │ ✅ INTERNAL_SECRET symbol — invisible to JSON.stringify       │
├───────────────────────────────────────────────────────────────────────────┼───────────────────────┼──────────────────────────────────────────────────────────────┤
│ PII scrubbing in impressions + hooks                                      │ LD privateAttributes  │ ✅ privacy.privateAttributes wired via scrubContext()         │
├───────────────────────────────────────────────────────────────────────────┼───────────────────────┼──────────────────────────────────────────────────────────────┤
│ GDPR delete-user-data API                                                 │ LD "remove user data" │ ✅ rl.flags.forgetUser(userId, scope?) — all 3 adapters       │
├───────────────────────────────────────────────────────────────────────────┼───────────────────────┼──────────────────────────────────────────────────────────────┤
│ Audit retention / archive policy                                          │ LD, Statsig           │ ⚠️  privacy.auditRetentionDays type exists; enforcement ❌   │
├───────────────────────────────────────────────────────────────────────────┼───────────────────────┼──────────────────────────────────────────────────────────────┤
│ Built-in RBAC (not just hooks)                                            │ LD, Statsig, Unleash  │ ❌ (hooks-only — RBAC is caller's responsibility)             │
├───────────────────────────────────────────────────────────────────────────┼───────────────────────┼──────────────────────────────────────────────────────────────┤
│ Right-to-explanation (per-user exposure list)                             │ LD                    │ ❌ history has flagKey, no efficient per-user query            │
├───────────────────────────────────────────────────────────────────────────┼───────────────────────┼──────────────────────────────────────────────────────────────┤
│ IP allowlist for admin API                                                │ LD                    │ ❌                                                           │
└───────────────────────────────────────────────────────────────────────────┴───────────────────────┴──────────────────────────────────────────────────────────────┘

---

11. Developer Experience (P0 for adoption)

┌────────────────────────────────────────────────────────────────┬───────────────────────────────────────────┬───────────────────────────────────────────────────────────┐
│ Feature                                                        │ Industry                                  │ Rollease                                                  │
├────────────────────────────────────────────────────────────────┼───────────────────────────────────────────┼───────────────────────────────────────────────────────────┤
│ Test mock client                                               │ LD TestData, Statsig LocalEvaluation      │ ✅ createMockRollease() in rollease/testing                │
│                                                                │                                           │    setFlag, resetFlag, resetAll, overrideFlag (in-memory) │
├────────────────────────────────────────────────────────────────┼───────────────────────────────────────────┼───────────────────────────────────────────────────────────┤
│ Local override file                                            │ ✓ .rolleaserc.json                        │ ✅ Edge-safe lazy fs, instance-scoped cache                │
├────────────────────────────────────────────────────────────────┼───────────────────────────────────────────┼───────────────────────────────────────────────────────────┤
│ Example app (Next.js)                                          │ most SDKs ship examples                   │ ✅ apps/example/ — middleware, RSC, browser SSE client    │
├────────────────────────────────────────────────────────────────┼───────────────────────────────────────────┼───────────────────────────────────────────────────────────┤
│ OpenFeature provider                                           │ OpenFeature ecosystem                     │ ✅ createRolleaseProvider() in rollease/openfeature        │
├────────────────────────────────────────────────────────────────┼───────────────────────────────────────────┼───────────────────────────────────────────────────────────┤
│ Typed flag keys (compile-time enforcement)                     │ LD via codegen, Statsig Type-Safe Flags   │ ❌                                                        │
├────────────────────────────────────────────────────────────────┼───────────────────────────────────────────┼───────────────────────────────────────────────────────────┤
│ Type generation from flag schema                               │ Statsig, GrowthBook                       │ ❌                                                        │
├────────────────────────────────────────────────────────────────┼───────────────────────────────────────────┼───────────────────────────────────────────────────────────┤
│ VS Code extension (flag key autocomplete)                      │ LD, Statsig                               │ ❌                                                        │
├────────────────────────────────────────────────────────────────┼───────────────────────────────────────────┼───────────────────────────────────────────────────────────┤
│ React DevTools panel / Storybook decorator                     │ LD                                        │ ❌                                                        │
├────────────────────────────────────────────────────────────────┼───────────────────────────────────────────┼───────────────────────────────────────────────────────────┤
│ Init wizard (npx create-rollease)                              │ Statsig, ConfigCat                        │ ❌                                                        │
└────────────────────────────────────────────────────────────────┴───────────────────────────────────────────┴───────────────────────────────────────────────────────────┘

---

12. Framework Integrations (P2)

✅ Next.js App Router (middleware + RSC + client)
✅ React (RolleaseProvider + useFlag + useFlagVariant)
✅ Universal fetch handler (Hono, Bun.serve, Cloudflare Workers — no adapter needed)
❌ React Native
❌ Vue / Pinia
❌ Svelte / SvelteKit
❌ Solid
❌ Remix loaders
❌ Astro server islands
❌ tRPC / GraphQL resolver helpers

---

13. Edge & Runtime Support (P2)

┌───────────────────────────────┬────────────────────────────────────────────────────────────────────┐
│ Runtime                       │ Status                                                             │
├───────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ Node 18+                      │ ✅                                                                 │
├───────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ Bun                           │ ✅                                                                 │
├───────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ Cloudflare Workers            │ ✅ source compatible, lazy fs guard confirmed by edge-runtime tests │
├───────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ Vercel Edge                   │ ✅ source compatible, no Vercel KV adapter                         │
├───────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ Deno                          │ ✅ source compatible, no Deno KV adapter                           │
├───────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ Browser (vanilla)             │ ✅ rollease/client — zero Node deps                                │
├───────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ Cloudflare D1                 │ ❌ adapter missing                                                 │
├───────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ Vercel KV / Deno KV           │ ❌ adapters missing                                                │
└───────────────────────────────┴────────────────────────────────────────────────────────────────────┘

---

14. Data Layer (P2)

Present: Memory, Prisma, Drizzle, Sequelize, Redis cache (L1 in-process + L2 Redis).

✅ L1/L2 cache with per-key bust, negative-cache, and rules-key invalidation
✅ Batched getUserAssignments (all 3 adapters — single query instead of N round-trips)
✅ Paginated getAllActiveFlags (limit/offset streaming in manager.evaluateAll)
✅ Snapshot-aware rollback (all 3 adapters)
❌ Redis pub/sub cache invalidation across replicas
❌ Bulk write transactions (deployRelease does N sequential updates)
❌ Read replica routing (dbReader vs dbWriter config)
❌ Migrations CLI (schema changes between SDK versions break silently)
❌ Cloudflare KV, Vercel KV, Deno KV, DynamoDB, MongoDB, FaunaDB adapters

---

15. Rollout / Experimentation Statistics (P2)

❌ All statistical features (sample-size calculator, p-values, confidence intervals, CUPED, sequential testing, multi-arm bandit). Recommendation unchanged: ship hooks/exports so users plug in their own stats backend; don't build Statsig.

---

16. Configuration Management (P1)

✅ Hot-reload — L1/L2 cache TTL + SSE stream on flag change
⚠️  Cache invalidation hot-path still limited by l1TtlMs across replicas (see Redis pub/sub gap)
❌ Config diff (between environments)
❌ Promote config env-to-env
❌ Dry-run mutation (only previewRelease for releases)
❌ GitOps source-of-truth

---

17. Performance & Caching (P2)

✅ L1 in-process + L2 (Redis/Memory), per-key bust, negative-cache for missing keys
✅ Paginated evaluateAll (1000-flag page size, configurable)
✅ localStorage zero-flicker in browser client
✅ Cache hit-rate metrics tracked and exposed in rl.health()
❌ Redis pub/sub invalidation across replicas
❌ Service Worker cache for browser client
❌ Precomputed evaluation tables
❌ CDN-cacheable evaluation responses

---

18. Error Handling & Resilience (P0)

┌───────────────────────────────────────┬──────────────────────────────┬───────────────────────────────────────────────────────────────────────┐
│ Feature                               │ Industry                     │ Rollease                                                              │
├───────────────────────────────────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ Typed errors with codes               │ LD, Statsig                  │ ✅                                                                    │
├───────────────────────────────────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ Graceful degradation on DB outage     │ LD ("offline mode"), Statsig │ ✅ resilience.fallbackOnError: true → returns error_fallback result   │
├───────────────────────────────────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ Webhook retry + exponential backoff   │ LD, Svix-style               │ ✅ configurable attempts, backoffMs, jitter                           │
├───────────────────────────────────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ Webhook dead-letter queue (DLQ)       │ LD                           │ ✅ config.dlq(payload, error) — caller routes to SQS/log/etc.         │
├───────────────────────────────────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ Circuit breaker                       │ LD                           │ ⚠️  ResilienceConfig.circuitBreaker type exists; not wired            │
├───────────────────────────────────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ DB-level retry with backoff           │ LD, Statsig                  │ ⚠️  ResilienceConfig.retry type exists; not wired into DB calls       │
├───────────────────────────────────────┼──────────────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ Bulkhead per-tenant                   │ LD                           │ ❌                                                                    │
└───────────────────────────────────────┴──────────────────────────────┴───────────────────────────────────────────────────────────────────────┘

---

19. Multi-Tenancy (P1 for B2B SaaS)

❌ All items from the original audit still open: tenant-namespaced storage, per-tenant overrides, cross-tenant analytics, per-tenant rate limiting. The `context.tenantId` field exists but is not load-bearing in DB adapters.

---

20. Testing (P1)

┌──────────────────────────────────────────┬────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────────┐
│ Feature                                  │ Industry                                   │ Rollease                                                             │
├──────────────────────────────────────────┼────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Mock/test client                         │ LD TestData, Statsig StatsigUser for local │ ✅ createMockRollease() — real MemoryDbAdapter, zero TTL cache        │
├──────────────────────────────────────────┼────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Deterministic bucketing in tests         │ LD seed override                           │ ✅ getBucket is pure; overrideFlag() bypasses DB for test speed       │
├──────────────────────────────────────────┼────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Edge-runtime smoke test                  │ —                                          │ ✅ tests/edge-runtime.test.ts — confirms no fs ReferenceError          │
├──────────────────────────────────────────┼────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Bucket fairness test                     │ —                                          │ ✅ χ² test on 10k users across 100 buckets (p < 0.05)                 │
├──────────────────────────────────────────┼────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Snapshot test of full flag config        │ LD via config diff                         │ ❌                                                                   │
├──────────────────────────────────────────┼────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ Browser/E2E helpers (Playwright/Cypress) │ LD plugin                                  │ ❌                                                                   │
└──────────────────────────────────────────┴────────────────────────────────────────────┴──────────────────────────────────────────────────────────────────────┘

Current test suite: 203 tests, 18 test files, all passing. Build: clean (tsup --dts, CJS + ESM + types).
Coverage: security.ts 94.7% lines, overrides.ts 93.8% lines (plan target was ≥ 90%).

---

21. Migration / Vendor Lock-in Story (P2)

❌ All items from original audit still open: import from LD/Statsig/Unleash, export to JSON/YAML, OpenFeature export format.

Note: the OpenFeature provider (`rollease/openfeature`) means any team already on OpenFeature can switch Rollease in without rewriting evaluation call sites.

---

22. OpenFeature Conformance (P2)

✅ Provider wrapper: `createRolleaseProvider(manager)` implementing `OpenFeatureProvider` interface
✅ Reason mapping: kill_switch → DISABLED, rule_match → TARGETING_MATCH, percentage/weighted_random → SPLIT, override → STATIC, errors → ERROR
✅ Context mapping: targetingKey → userId
✅ Structural typing: no hard dep on @openfeature/core — compatible when installed, works without it
❌ Hook lifecycle ordering (OpenFeature: before → error → after → finally vs Rollease: onBefore → onEvaluate)

---

23. Documentation / API Spec (P0)

Present: developer-guide.md, adapter examples, README, apps/example/ Next.js demo app.

❌ API reference auto-generated from JSDoc (TypeDoc)
❌ Interactive playground (CodeSandbox or in-docs REPL)
❌ Architecture diagrams
❌ OpenAPI spec for the handler routes
❌ Changelog with breaking-change callouts

---

24. Build / Release Pipeline (P3)

Current: tsup builds CJS + ESM + DTS, 203 vitest tests, build is clean.

❌ GitHub Actions CI matrix (Node 18/20/22, Bun, Edge runtime)
❌ Semantic-release / changesets
❌ Coverage gate thresholds enforced in CI
❌ E2E test against real Postgres
❌ Bundle-size budget enforcement
❌ Publish provenance / SLSA attestation

---

## Updated Prioritized Roadmap

### Phase 3 — v0.1 (DX & Trust) — ✅ COMPLETE

1. ✅ Test mock client (rollease/testing)
2. ✅ Health check API (rl.health())
3. ✅ Graceful degradation (resilience.fallbackOnError)
4. ✅ PII scrubbing wired into impressions + hooks
5. ✅ Webhook retry with DLQ
6. ✅ GDPR forgetUser API
7. ✅ Browser/SPA client (rollease/client)
8. ✅ Universal HTTP handler (rl.createHandler())
9. ✅ OpenFeature provider (rollease/openfeature)
10. ✅ OpenTelemetry adapter (rollease/telemetry)
11. ✅ Scheduled-release executor (runScheduledReleases())
12. ✅ SSE streaming endpoint

All Phase 1 security/wiring bugs also fixed:
✅ Segment usage scanner (no JSON.stringify false-positives)
✅ Override path traversal guard
✅ Prototype-pollution key rejection
✅ Locked-flag update guard
✅ Secret in closure (INTERNAL_SECRET symbol)
✅ Lazy next/server import
✅ Edge-safe lazy fs
✅ L1/L2 cache wired on read + rules cache
✅ Batched getUserAssignments in all adapters
✅ Paginated getAllActiveFlags
✅ Snapshot-based rollback in all adapters
✅ Listener errors logged
✅ Override cache instance-scoped (no module-level global)
✅ Multivariate path consolidated in evaluator
✅ pg moved to optional peerDependency

---

### Phase 4 — v0.2 (Real-time & Operations) — NEXT

Priority order:

1. ❌ Redis pub/sub cache invalidation (highest impact — closes the multi-replica stale window)
2. ✅ Eval-trace API — shipped (evaluate with { trace: true }, 13 tests)
3. ❌ Typed flag keys via module augmentation + codegen (biggest day-one DX win)
4. ❌ Circuit breaker + DB-level retry (ResilienceConfig types exist, wire them)
5. ❌ Cloudflare KV adapter, Vercel KV adapter
6. ❌ CLI (npx rollease flags list, kill, export, import)

---

### Phase 5 — v0.3 (Reach) — LATER

7. ❌ React Native client
8. ❌ Vue + Svelte integrations
9. ❌ Express / Fastify / Hono typed middleware wrappers
10. ❌ Conversion/metric tracking (rl.track())
11. ❌ Exposure deduplication + event batching
12. ❌ Prometheus metrics endpoint

---

### Phase 6 — v1.0 (Enterprise) — FUTURE

13. ❌ Multi-tenant storage namespacing
14. ❌ Built-in RBAC (beyond hooks)
15. ❌ Bulk-write transactions in adapters
16. ❌ Read-replica routing
17. ❌ Import from LaunchDarkly / Statsig / Unleash
18. ❌ Documentation site + TypeDoc API reference + playground
19. ❌ GitHub Actions CI + coverage gates + SLSA attestation

---

## TL;DR — Current State

| Area                    | Was (audit)       | Now               |
|-------------------------|-------------------|-------------------|
| Browser client          | ❌                | ✅                |
| SSE streaming           | ❌                | ✅                |
| Admin HTTP handler      | ❌                | ✅                |
| Test mock client        | ❌                | ✅                |
| OpenFeature provider    | ❌                | ✅                |
| OpenTelemetry           | ❌                | ✅                |
| Health probe            | ❌                | ✅                |
| Graceful degradation    | ❌                | ✅                |
| PII scrubbing           | type only         | ✅ wired          |
| Webhook retry + DLQ     | ❌                | ✅                |
| GDPR forgetUser         | ❌                | ✅                |
| Scheduled exec          | stored only       | ✅ executor wired |
| Snapshot rollback       | ✅                | ✅                |
| Security hardening      | several gaps      | ✅ all Phase 1 done|
| Eval-trace API          | ❌                | ✅ shipped        |
| Redis pub/sub           | ❌                | ❌                |
| Typed flag keys         | ❌                | ❌                |
| Circuit breaker         | ❌                | ⚠️ type only      |
| Vue / Svelte / RN       | ❌                | ❌                |
| CLI                     | ❌                | ❌                |
| Multi-tenancy           | ❌                | ❌                |
| Stats engine            | ❌                | ❌                |
