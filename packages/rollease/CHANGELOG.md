# Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

### Added

#### Universal HTTP Handler
- `rl.createHandler(options)` returns a fetch-compatible `(Request) => Response` handler that mounts all Rollease routes at a single catch-all path. Works in Next.js App Router, Hono, Bun.serve, Fastify, and Cloudflare Workers.
- `toNextHandlers(handler)` helper returns `{ GET, POST, PATCH, DELETE, OPTIONS }` for direct use as Next.js App Router route exports.
- Routes: `GET /flags`, `GET /flags/:key`, `GET /flags/stream` (SSE), `POST /flags`, `PATCH /flags/:key`, `DELETE /flags/:key`, `POST /flags/:key/kill`, `GET /health`.

#### Browser Client (`rollease/client`)
- `createRolleaseClient(config)` — zero Node-dependency browser SDK.
- SSE streaming via `EventSource` for real-time flag updates (`streaming: true`).
- `localStorage` zero-flicker caching — flags are available synchronously on page load before the first fetch completes.
- `client.ready()` — promise that resolves after the initial fetch.
- `client.flag(key, defaultValue)` — synchronous flag read.
- `client.flagDetails()` — full `DetailedFlagMap` (value + variant + reason).
- `client.identify(context)` — switch user context and reconnect SSE.
- `client.track(event, props)` — fire-and-forget analytics event.
- `client.onChange(listener)` / `client.onFlagChange(key, listener)` — subscribe to flag changes.

#### Evaluation Trace API
- `rl.flags.evaluate(key, context, { trace: true })` now populates `FlagResult.trace` with a step-by-step breakdown of the 9-stage evaluation pipeline.
- Each `EvaluationTraceStep` records the step number, name, whether it terminated the pipeline (`matched`), and an optional `detail` string with context (rule ID, bucket number, variant key, etc.).
- `EvaluationTrace.matchedRuleId` and `matchedVariantId` are populated when a rule or variant determined the result.
- Zero overhead when `trace` is not requested — `FlagResult.trace` remains `undefined`.
- 13 regression tests covering all pipeline branches.

#### Telemetry (`rollease/telemetry`)
- `createOtelAdapter(tracer)` — integrates with `@opentelemetry/api` via structural typing (no hard dep). Wraps every `evaluate()` call in a span with `flag.key` attribute.
- `createConsoleAdapter(prefix?)` — lightweight debug adapter that logs span start/end with timing.
- `noopSpan` — exported no-op span for testing.
- New `telemetry` field in `RolleaseConfig` wires the adapter into `FlagManager`.

#### Health Probe
- `rl.health()` returns `RolleaseHealthResult`: `{ status, db, cache, latencyMs, evalCount, cacheHits, cacheMisses, cacheHitRate, uptimeMs, ts }`.
- `GET /api/rollease/health` returns 200 (healthy) or 503 (unhealthy) with the same JSON body.

#### Resilience & Graceful Degradation
- `resilience.fallbackOnError: true` catches DB errors in `evaluate()` and returns `{ value: null, reason: 'error_fallback' }` instead of throwing.
- `resilience.retry` — configurable retry with exponential backoff and jitter.
- `resilience.circuitBreaker` — type-safe config for threshold/window/reset parameters (wiring in progress).

#### Privacy & PII Scrubbing
- `privacy.privateAttributes` — list of context attribute keys replaced with `'[REDACTED]'` before impression tracking, audit history, and evaluation hooks.
- `privacy.impressionRetentionDays` / `privacy.auditRetentionDays` — retention policy config.

#### GDPR Data Erasure
- `rl.flags.forgetUser(userId, scope?)` — deletes impressions, assignments, and audit history for a given user. Implemented in all three adapters (Memory, Prisma/Repository, Sequelize).

#### Scheduled Release Executor
- `rl.flags.runScheduledReleases()` — queries `db.listScheduledReleases()`, deploys each, and returns `{ deployed, failed }`. Call from a cron job or queue worker.

#### Testing Utilities (`rollease/testing`)
- `createMockRollease(options)` — zero-config mock client backed by the real `MemoryDbAdapter`. L1 cache TTL set to 0 so test mutations are immediately visible.
- `setFlag(key, value)`, `resetFlag(key)`, `resetAll()` — DB-level flag mutation for per-test setup.
- `overrideFlag(key, value)` / `clearOverride(key)` / `clearAllOverrides()` — fast in-test overrides via the local-override mechanism (no DB write).
- `MockFlagDefinition` interface for full flag configuration in seed data.
- `mockFlag(key, def)` — convenience builder.

#### OpenFeature Provider (`rollease/openfeature`)
- `createRolleaseProvider(flagManager)` — wraps `FlagManager` as a CNCF OpenFeature Provider.
- Implements `resolveBooleanEvaluation`, `resolveStringEvaluation`, `resolveNumberEvaluation`, `resolveObjectEvaluation`.
- Maps OpenFeature `targetingKey` → Rollease `userId`. Translates all OpenFeature evaluation context fields to `FlagContext`.
- Maps all Rollease `EvalReason` values to OpenFeature reason codes.
- Structural typing — no hard dependency on `@openfeature/core`.

#### Security Hardening (Phase 1)
- **Segment usage scanner** — recursive condition-tree walk replaces `JSON.stringify().includes()` false-positive check.
- **Override path traversal guard** — `validateOverridePath()` rejects `localOverridesFile` values that escape `process.cwd()`.
- **Prototype-pollution key rejection** — `isSafeFlagKey()` blocks `__proto__`, `constructor`, `prototype`, `toString`, `hasOwnProperty` as flag or segment keys.
- **Locked flag guard** — `update()` strips `locked`/`lockedReason` from patches when the flag is locked; use `setLock()` for explicit lock/unlock with audit trail.
- **Secret isolation** — signing secret held in closure, not on `rl` object; `JSON.stringify(rl)` never leaks it.
- **Lazy `next/server` import** — `import 'rollease/next'` works in plain Node, Vitest, and CLI tools without pulling in Next.js.
- **Edge-safe `fs`** — `loadLocalOverrides` returns `{}` silently when `process.versions.node` is absent.

#### RBAC / Audit Scaffolding
- `AuditActor` type (`id`, `type`, `name`, `metadata`) accepted as optional `actor` on all write methods.
- `RolleaseHooks` — `onBeforeMutation`, `onBeforeEvaluation`, `onEvaluate` hooks. Throwing in a before-hook aborts the operation.
- `LoggingConfig` — `level` + `sink` replace direct `console.*` calls throughout the SDK.
- `setLock(key, { locked, reason, actor })` — dedicated lock/unlock method with audit history.

#### Cache Improvements
- L1/L2 cache now populated on read (not just on write). Cache keys: `rollease:flag:<key>`, `rollease:rules:<key>`.
- Both keys busted together on any write via `bustCache()`.
- Impression tracking fires after evaluation (fire-and-forget) with configurable sample rate.
- Batched `getUserAssignments(flagKeys, userId)` added to `DbAdapter` and all three adapters.

#### Snapshot-based Rollback
- `deployRelease()` captures before-state (`{ flagKey, beforeValue, beforeStatus, beforeRollout }`) as `release.snapshots`.
- `rollbackRelease()` reads snapshots and restores exact prior state. Falls back to reverse-action logic for pre-snapshot releases with a `console.warn`.

#### Next.js Transport v2
- Middleware now sends `DetailedFlagMap` in the signed envelope (v2 format: `{ v: 2, ts, flags }` instead of `{ flags }`).
- `getFlag()` and `getAllFlags()` return actual `variant`/`reason` from the payload.
- v1 envelope accepted with a deprecation warning for one release cycle.

#### Evaluator Improvements
- Single multivariate distribution path — one weighted-distribution block for both rollout-aware and rollout-less cases.
- `onWarning` callback emitted (not `console.warn`) when a rule's `variantId` doesn't match any variant.
- Per-environment defaults checked before global default (Step 9).

#### Package
- `pg` moved from `dependencies` to `peerDependencies` (optional) — not bundled, only needed when using the Sequelize adapter.
- New entry points: `rollease/client`, `rollease/testing`, `rollease/openfeature`, `rollease/telemetry`.

### Fixed
- Module-level `cachedOverrides`/`lastReadAt` in `overrides.ts` caused state leakage between multiple `createRollease()` instances in the same process. Cache is now per-`FlagManager` instance.
- Listener errors swallowed silently — now logged via `logging.sink`.
- `evaluateAll()` was issuing N individual DB calls for user assignments — replaced with a single batched `getUserAssignments()` call.
- `getAllActiveFlags()` now paginated (default 1000 per page) to avoid OOM on large flag tables.

---

## [0.0.0-alpha.0] - 2026-05-27

### Added
- Initial alpha release of the Rollease feature flag SDK.
- Layered cache cascade architecture: L1 in-process memory + L2 Redis + L3 DB.
- Multi-database adapter layer: in-memory, Sequelize (PostgreSQL), Prisma, Drizzle.
- 9-step evaluation pipeline: kill switches, date windows, local overrides, sticky assignments, targeting rules, percentage rollout, multivariate weighted distribution, environment defaults, global default.
- Rule operator suite: `eq`, `neq`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `contains`, `startsWith`, `endsWith`, `regex`, `semverGte`, `semverLte`, `exists`, `dateAfter`, `dateBefore`.
- ReDoS prevention via `safeRegexTest()`.
- Condition group depth and node-count limits via `assertSafeConditionGroup()`.
- React: `RolleaseProvider`, `useFlag`, `useVariant`, `useFlags`, `useFlagDetails`, `FeatureGate`.
- Next.js: signed Edge middleware transport + RSC `getFlag()`/`getAllFlags()` helpers.
