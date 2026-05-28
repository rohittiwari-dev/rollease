# Rollease SDK Deep-Dive Audit

Date: 2026-05-28  
Scope: `report.md` and `packages/rollease/src` at pre-audit commit `d295729`, plus the implementation pass that followed this audit  
Method: source review, package dry-run, implementation verification, and comparison against feature-management, API security, observability, privacy, and supply-chain standards.

**Last updated: 2026-05-28 — Phase 4-6 implementation review added (sections 12-15)**

## Implementation Update

Since the original audit snapshot, four high-impact gaps have been implemented:

- Cross-process invalidation: `InvalidationBus`, `MemoryInvalidationBus`, `RedisInvalidationBus`, and manager cache/SSE invalidation publishing.
- Public browser trust controls: handler `clientKeys`, `clientVisible` flags, browser `clientKey` support, explicit flag allowlists, and server-owned context merge.
- Resilience: retry and circuit breaker wrappers around evaluation DB reads, plus health reporting for circuit state and L2 cache probes.
- Event tracking path: `TrackEventInput`, `TrackingEvent`, `FlagManager.trackEvent()`, MemoryDbAdapter storage, batch `/events`, browser batching, and `flush()`.

Since the last update, Phases 4-6 features have shipped: typed flag keys, Vue/Svelte/Angular/NestJS/React Native integrations, exposure deduplication, Prometheus metrics adapter, Cloudflare KV adapter, multi-tenant storage adapter, RBAC system, read-replica routing, import/export migrations, and CI pipeline. This review covers the correctness of those new implementations.

## Executive Verdict

Rollease has moved beyond a prototype. The core evaluation engine, in-memory adapter, release model, browser client, Next/React integrations, HTTP handler, OpenFeature wrapper, telemetry adapter, PII scrubbing, webhook signing, scheduled release executor, rollback support, cross-process invalidation, public client key scoping, custom event tracking, and DB resilience controls create a credible alpha SDK.

It is still not production-grade for B2B multi-tenant or experimentation-heavy deployments. The largest remaining gaps are:

1. **RBAC wiring is broken at the HTTP layer** — the handler never extracts actor from requests, so `onBeforeMutation` receives `actor = undefined` and the RBAC hook denies everything.
2. **Metrics adapter is dead code** — `MetricsAdapter`/`PrometheusAdapter` are standalone utilities not wired into `FlagManager` or `RolleaseConfig`.
3. **PII scrubbing misses top-level `FlagContext` fields** — `scrubContext()` only redacts `ctx.attributes`, not `userId`, `region`, `tenantId`, or `ip`.
4. **Multi-tenant adapter missing 6 optional DbAdapter methods** — batch assignments, stale-flag touch, scheduled release queries, and approval/rejection are all broken for tenant-scoped deployments.

---

## Standards And Industry Baselines Used

- OpenFeature specification: evaluation hooks, provider behavior, and tracking API.
- OpenTelemetry semantic conventions, including feature flag semantic conventions.
- OWASP API Security Top 10 2023.
- OWASP Logging and Secrets Management Cheat Sheets.
- LaunchDarkly SDK model: separate server-side and client-side trust boundaries.
- Statsig client SDK model: cached initialization, exposure logging, periodic event flush.
- SLSA and npm trusted publishing provenance.

---

## Top Findings

| Priority | Finding | Evidence | Impact |
|---|---|---|---|
| Mitigated | Distributed invalidation now has a bus | `FlagManager` can publish invalidation messages through `InvalidationBus`. | Without `config.invalidation`, local L1 TTL still bounds staleness. |
| Mitigated | Public browser trust boundary now has client key scoping | Handler `clientKeys` require `X-Rollease-Client-Key`, filter to `clientVisible`. | Still needs rate limiting and signed context hardening. |
| P0 | Multi-tenancy adapter missing 6 optional methods | `createTenantAdapter` at `tenant.ts:91` does not forward `getUserAssignments`, `touchFlagEvaluation`, `listScheduledReleases`, `approveRelease`, `rejectRelease`, or `getGlobalHistory`. | Batch assignment queries fall back to N round-trips; stale flag detection, scheduled releases, and approval workflows are silently broken for tenant-scoped deployments. |
| P0 | RBAC wiring is broken at the HTTP layer | `handler.ts:408`: `manager.create(body)` — actor never extracted. `runMutationHook` receives `actor = undefined`. RBAC hook denies actor-less calls. | With `createRBACHook` wired, ALL admin HTTP operations fail. |
| P0 | `createRelease` fires wrong mutation action | `manager.ts:918`: fires `"release.deployed"` not `"release.created"`. Requires `release.deploy` permission. Editors have `release.create` not `release.deploy`. | Editors cannot create releases through the RBAC system. |
| P0 | MetricsAdapter not wired into FlagManager | `RolleaseConfig` has no `metrics` field. `FlagManager` constructor takes no metrics. All `createPrometheusAdapter()` metric registrations are never populated. | Prometheus metrics are dead code. No `/metrics` route in handler. |
| P1 | PII scrubbing misses top-level FlagContext fields | `manager.ts:1827-1833`: `scrubContext()` only iterates `ctx.attributes`. | `userId`, `region`, `tenantId`, `ip` are never scrubbed even when listed in `privateAttributes`. GDPR/PII risk. |
| P1 | `onBeforeEvaluation` receives unscrubbbed context | Hook called at `evaluateInternal` before `scrubContext()`. | PII visible to all hook handlers, including third-party audit logging hooks. |
| P1 | `rejectRelease` not in ACTION_PERMISSION_MAP | `rbac.ts:116-140`: `"release.rejected"` absent. Hook returns early: everyone can reject. | Anyone can reject any release regardless of role. |
| P1 | Exposure dedup not wired into manager | `createExposureTracker()` is standalone. Manager impression tracking ignores it. | Every evaluation records an impression; dedup only works if users manually wire `hooks.onEvaluate`. |
| P2 | `createRBACAdminAuth` gates with `flag.read` | `rbac.ts:258-260`: `policy.check(actor, "flag.read")` for all admin ops. | Viewers pass the admin auth gate. Security depends entirely on mutation hook (which is broken due to missing actor). |
| P2 | `evaluateAllDetailed` does not support trace option | `evaluate(key, ctx, { trace: true })` works; `evaluateAllDetailed` has no trace option. | Bulk trace impossible for debugging. |
| P2 | Environment filter inconsistency | `evaluateAll/evaluateAllDetailed` filter by `flag.environments[]`; single `evaluate` does not. | Production-scoped flags evaluate in non-production contexts via single-flag path. |
| P2 | Handler admin routes incomplete | No rule CRUD, rollout, or release workflow routes. | Flag rules and rollouts unmanageable via HTTP without custom wrapper. |
| P3 | `GET /health` is public | `handler.ts:271`: no auth gate. Returns latency, eval counts, cache hit rate, circuit state. | Ops intelligence visible to anyone. |
| P3 | Handler error responses expose internal messages | `errMsg(e)` passed to client on 400/500 responses. | DB errors, validation details can leak. |

---

## Detailed Audit

### 1. Evaluation Engine

Strengths:

- The evaluator is pure and deterministic. Bucketing is isolated in `bucket.ts`, and tests include 10k-user bucket distribution checks.
- Evaluation trace is implemented with step-level detail and covered by tests in `packages/rollease/tests/evaluator.test.ts`.
- Rule safety checks reject unsafe regexes and excessive condition complexity through `core/security.ts`.
- Prerequisites are resolved recursively with cycle/depth protection in `FlagManager.evaluateInternal()`.

Gaps:

- `fallbackOnError` now returns an `error_fallback` result with `null` value. Still does not return last-known-good values.
- `evaluateAllDetailed()` does not support `{ trace: true }` — only single-flag `evaluate` does.
- Segment auto-resolution scans all segments with `db.listSegments()` during evaluation. Needs indexed or cached segment lookup before scale claims.
- Single `evaluate()` does not filter by `flag.environments[]`. `evaluateAll/evaluateAllDetailed` does. Inconsistent.

---

### 2. Browser SDK And Public Evaluation

Strengths:

- The browser client is dependency-light, supports localStorage hydration, has `identify()`, `refetch()`, listeners, SSE, and polling fallback.
- SSE context now encoded in request body/header, not query string (confirmed for normal fetches; SSE stream still uses query param).

Gaps:

- SSE path encodes context into a query parameter (`client/index.ts:245`). Query strings are captured by logs, proxies, analytics, and browser history. PII risk for user attributes.
- Client-supplied context is base64 JSON — no authentication or integrity protection. See `handler.ts:133-163`.
- Anonymous bucketing missing — no stable device ID when `userId` is absent.
- No rate limiting or abuse controls on `/flags`, `/flags/stream`, `/events`.

---

### 3. Distributed Runtime And Caching

Strengths:

- L1 memory cache and optional L2 cache are wired.
- Mutations call cache busting methods consistently.
- Redis invalidation bus exists and is separate from the cache adapter.

Gaps:

- Invalidation bus is opt-in via `config.invalidation`. Without it, staleness is bounded by L1 TTL.
- No ETag/revision protocol for browser polling, no versioned flag payload.
- Tenant adapter doesn't bust cache with tenant-namespaced keys — cache keys in manager are global (`rollease:flag:${key}`), not tenant-scoped.

---

### 4. Multi-Tenancy

Strengths:

- `createTenantAdapter(innerDb, { tenantId })` wraps all flag/rule/segment/history CRUD operations with tenant-namespaced keys.
- Segment `listSegments()` is filtered to the tenant prefix.
- Release changes have their `flagKey` namespaced.

Gaps (Critical):

The following `DbAdapter` optional methods are NOT forwarded by `TenantAdapter` (`tenant.ts:255-280`):

| Missing method | Impact |
|---|---|
| `getUserAssignments(flagKeys, userId)` | Falls back to N individual `getUserAssignment` calls — N×latency on `evaluateAll` |
| `touchFlagEvaluation(key)` | Stale flag detection (`getStaleFlags`) always treats tenant flags as stale |
| `listScheduledReleases()` | `runScheduledReleases()` queries no scheduled releases for tenant |
| `approveRelease(id, approverId)` | Approval workflow broken silently |
| `rejectRelease(id, rejectorId)` | Rejection workflow broken silently |
| `getGlobalHistory(opts)` | Global history queries return all tenants' history |

Manager cache keys are global — `rollease:flag:${key}`, `rollease:rules:${key}` — not tenant-namespaced. If two tenants have the same flag key, their L1/L2 caches collide.

---

### 5. Security And Privacy

Strengths:

- Prototype-pollution keys rejected; override path traversal guarded; regex safety limits exist.
- Webhook signatures use Web Crypto with replay checks.
- `privacy.privateAttributes` scrubs evaluation context before impressions and hooks.
- INTERNAL_SECRET symbol — invisible to JSON.stringify.

Gaps:

**PII Scrubbing is incomplete (P0/GDPR risk):**
```typescript
// manager.ts:1827-1833
private scrubContext(ctx: FlagContext): FlagContext {
  if (!this.privacy.privateAttributes?.length) return ctx;
  const attrs = { ...(ctx.attributes ?? {}) };
  for (const k of this.privacy.privateAttributes) {
    if (k in attrs) attrs[k] = "[REDACTED]"; // Only scrubs attrs!
  }
  return { ...ctx, attributes: attrs };
}
```
`privateAttributes: ["userId"]` does NOT redact `ctx.userId`. Only `ctx.attributes.userId` is scrubbed. All top-level FlagContext fields (`userId`, `region`, `tenantId`, `ip`, `userType`, `version`) are exempt.

**Fix:**
```typescript
private scrubContext(ctx: FlagContext): FlagContext {
  if (!this.privacy.privateAttributes?.length) return ctx;
  const scrubbed: FlagContext = { ...ctx };
  const attrs = { ...(ctx.attributes ?? {}) };
  for (const k of this.privacy.privateAttributes) {
    if (k in attrs) attrs[k] = "[REDACTED]";
    // Also scrub top-level fields
    if (k in scrubbed) (scrubbed as Record<string, unknown>)[k] = "[REDACTED]";
  }
  return { ...scrubbed, attributes: attrs };
}
```

**`onBeforeEvaluation` hook called with unscrubbbed context:**
- `evaluateInternal` calls `runBeforeEvaluation(key, context)` at line 1367 before scrubContext is used.
- PII in context attributes is visible to all before-evaluation hook handlers.
- Fix: scrub before calling the hook, or document that hooks always receive raw context.

**Other gaps:**
- `__rollease.secret` still on the public client object (marked deprecated). Will leak if serialized.
- No SDK key rotation model.
- `GET /health` is unauthenticated.
- Handler raw error messages leaked to clients.

---

### 6. Permissions & RBAC System (NEW — Phase 6)

#### What is implemented:

- `RolleaseRole`: `"viewer" | "editor" | "admin" | "owner"` (4 built-in roles) — `rbac.ts:26`
- `RolleasePermission`: 17 permissions covering flag CRUD, rules, rollout, segments, releases, webhooks, tags — `rbac.ts:28-45`
- `DEFAULT_PERMISSIONS` matrix (hardcoded, hierarchical) — `rbac.ts:49-101`
- `ACTION_PERMISSION_MAP`: maps `HistoryAction` strings to required permissions — `rbac.ts:116-140`
- `createDefaultRBACPolicy(roleMap, opts)` factory with custom permission matrix support — `rbac.ts:155-209`
- `createRBACHook(policy)` → produces `onBeforeMutation` callback — `rbac.ts:222-241`
- `createRBACAdminAuth(policy, extractActor)` → produces `adminAuth` for handler — `rbac.ts:252-261`
- Manager calls `runMutationHook(action, flagKey, actor)` on every write operation — wired in 30+ places

#### Bugs:

**Bug 1 (Critical): Handler never extracts actor from requests**

`handler.ts` calls manager methods without an actor:
```typescript
// handler.ts:408
const flag = await manager.create(body); // no actor!
// handler.ts:420
const flag = await manager.update(key, body); // no actor!
```

`runMutationHook` passes `actor = undefined` to the RBAC hook, which returns `false` for all undefined actors (unless `defaultRole` is set). All admin operations fail when `createRBACHook` is used.

**Fix:** Extract actor from `Authorization` header or body, pass it to each manager call:
```typescript
// In handler admin routes, extract actor from request
const actorHeader = req.headers.get("x-rollease-actor");
const actor = actorHeader ? JSON.parse(atob(actorHeader)) : undefined;
const flag = await manager.create({ ...body, actor });
```

**Bug 2 (Critical): `createRelease` fires `"release.deployed"` action, not `"release.created"`**

```typescript
// manager.ts:914-918
// history-action `release.created` doesn't exist yet — we use the
// closest-fit `release.deployed` for hook context so RBAC can gate
await this.runMutationHook("release.deployed", undefined, input.actor);
```

`ACTION_PERMISSION_MAP["release.deployed"]` = `"release.deploy"`. Editor has `"release.create"` but NOT `"release.deploy"`. Editors can never create releases.

The dead entry `"release.created": "release.create"` in `ACTION_PERMISSION_MAP` is never triggered.

**Fix:** Add `"release.created"` to `HistoryAction` type and fire it from `createRelease`.

**Bug 3 (High): `rejectRelease` not in ACTION_PERMISSION_MAP**

```typescript
// manager.ts:1019
await this.runMutationHook("release.rejected", undefined, opts?.actor);
```
`"release.rejected"` is NOT in `ACTION_PERMISSION_MAP`. The hook at `rbac.ts:226` returns early: `if (!permission) return;`. Everyone can reject releases.

**Fix:** Add `"release.rejected": "release.approve"` (same gate as approve), or add a new `"release.reject"` permission.

**Bug 4 (High): `createRBACAdminAuth` gates all admin ops with `flag.read`**

```typescript
// rbac.ts:258-260
return policy.check(actor, "flag.read") as boolean | Promise<boolean> as Promise<boolean>;
```

A viewer (who has only `flag.read`) passes the admin auth gate. Security relies entirely on `onBeforeMutation`, which is broken due to Bug 1.

**Fix:** Change to require `flag.create` or better — check the operation-specific permission per route.

**Bug 5 (Medium): Segment mutations hook fires without `flagKey`**

```typescript
// manager.ts:790
await this.runMutationHook("segment.created", undefined, input.actor);
```

Resource (`flagKey`) is always `undefined` for segment operations. Per-flag RBAC policies cannot apply to segment mutations. This is acceptable if segment management is global, but should be documented.

**Gap 6 (Medium): No `release.reject` permission type**

`RolleasePermission` has `"release.approve"` but no `"release.reject"`. Both approval and rejection should have distinct permissions for audit trail.

**Gap 7 (Low): Dead entries in ACTION_PERMISSION_MAP**

- `"release.created"` → `"release.create"` — never fired (createRelease fires `"release.deployed"`)
- Fix: either remove or wire correctly after Bug 2 is resolved.

---

### 7. Roles Management (NEW — Phase 6)

#### What is implemented:

- 4 built-in roles with hierarchical permission sets (viewer ⊂ editor ⊂ admin ⊂ owner)
- `admin.full` wildcard permission bypasses all individual checks
- Multi-role actors via `actor.roles[]`
- Role lookup by actor ID via `roleMap`
- Custom permission extension via `opts.permissions`

#### Bugs & Gaps:

**Gap 1: Permission matrix is additive only — can't restrict built-in roles**

`opts.permissions` only adds permissions via `existing.add(perm)`. There is no way to REMOVE permissions from a built-in role set. Cannot express "editor can do everything EXCEPT flag.delete."

**Gap 2: No resource-level (per-flag/per-namespace) role restrictions**

`RolleaseRBACPolicy.check(actor, permission, resource?)` accepts a `resource` parameter but `createDefaultRBACPolicy` ignores `resource.flagKey` and `resource.environment`. Cannot express "editor can manage staging flags but not production flags."

**Gap 3: No role persistence**

`createDefaultRBACPolicy(roleMap)` accepts a static in-memory map. Dynamic role changes require restarting the process. No `DbAdapter` integration for role assignment storage.

**Gap 4: `createRBACAdminAuth` uses wrong permission check**

Gates ALL admin operations with `flag.read`. See Permissions Bug 4 above.

---

### 8. Attributes Management

#### What is implemented:

- `FlagContext.attributes: Record<string, unknown>` for arbitrary targeting — `types.ts:264`
- Operators work against attribute values: `eq`, `neq`, `in`, `nin`, `gt/gte/lt/lte`, `contains`, `startsWith`, `endsWith`, `regex`, `semverGte/Lte`, `exists`, `dateAfter/dateBefore`
- Dimension fallback: any unknown string dimension name falls back to `context.attributes?.[dimension]` — `evaluator.ts:83`
- `privacy.privateAttributes` list scrubs from `ctx.attributes` before impressions

#### Bugs:

**Bug 1 (P0): Top-level FlagContext fields are never scrubbed**

See Security section above. `userId`, `region`, `tenantId`, `ip`, `userType`, `version` in FlagContext are never scrubbed even if listed in `privacy.privateAttributes`.

**Bug 2 (P1): `onBeforeEvaluation` receives unscrubbbed context**

Hook receives original context. PII attributes visible to all before-evaluation handlers.

**Bug 3 (P2): `attribute` dimension dual-path is undocumented**

Two syntaxes exist:
- `{ dimension: "attribute", op: "eq", value: { key: "plan", match: "pro" } }` — structured lookup
- `{ dimension: "plan", op: "eq", value: "pro" }` — implicit attributes fallback

The second form works but is undocumented. `FlagDimensionKey` is typed as `string` so both forms are accepted silently.

**Gap 4 (P2): No attribute type coercion**

Numeric operators (`gt`, `gte`, `lt`, `lte`) compare `context.attributes?.[dim]` directly. If the attribute value is a string `"95"` and the rule value is number `90`, the comparison uses JavaScript's `>` which coerces correctly in many cases but fails on non-numeric strings silently.

**Gap 5 (P3): No attribute schema or rule validation**

`addRule/updateRule` don't validate that condition dimension names reference known context fields. Typos silently produce non-matching rules.

---

### 9. Features Management (NEW — Phases 4-6)

#### What is implemented:

- Typed flag keys (`flag-types.ts`) with module augmentation and codegen support ✅
- `createTenantAdapter` for multi-tenant namespacing ✅ (with gaps above)
- `createRBACHook` and `createRBACAdminAuth` ✅ (with wiring bugs above)
- `createExposureTracker` for impression deduplication ✅ (standalone only — not wired)
- `PrometheusAdapter` and `createPrometheusAdapter()` ✅ (standalone only — not wired)
- Vue/Svelte/Angular/NestJS/React Native framework integrations ✅
- Cloudflare KV adapter ✅
- Import from LaunchDarkly, Statsig, Unleash ✅
- Read-replica routing via `replica.ts` ✅
- Bulk operations (bulkCreate, bulkUpdate, bulkDelete) ✅
- Stale flag detection (getStaleFlags, listFlags staleAfter) ✅
- Multi-context evaluation (evaluateMultiContext) ✅
- Local event listeners (manager.on/off with wildcard "*") ✅

#### Bugs:

**Bug 1 (P0): MetricsAdapter is not wired into FlagManager or RolleaseConfig**

`createPrometheusAdapter()` registers 11 metric descriptions (`rollease_evaluations_total`, `rollease_cache_hits_total`, etc.) but NONE are ever populated:

- `RolleaseConfig` has NO `metrics` field
- `FlagManager` constructor accepts NO `MetricsAdapter`
- No `GET /metrics` route in `handler.ts`
- The metrics system is entirely standalone/manual

To use it, users must manually call `metrics.increment("rollease_evaluations_total")` themselves in hooks.

**Fix:** Add `metrics?: MetricsAdapter` to `RolleaseConfig`, pass to `FlagManager`, wire `increment/histogram` calls on evaluate, cache hits, errors. Add `GET /metrics` route calling `metrics.serialize()`.

**Bug 2 (P1): Exposure dedup (`createExposureTracker`) not wired into manager**

Manager's built-in impression tracking at `manager.ts:1799-1824` uses `impressions.sampleRate` but does NOT use `createExposureTracker`. Every evaluation with `impressions.enabled: true` records an impression regardless of duplicate suppression.

Users must manually wire dedup via:
```typescript
const tracker = createExposureTracker({ windowMs: 60_000 })
createRollease({
  hooks: {
    onEvaluate: (result, ctx) => {
      if (!tracker.shouldTrack(result, ctx)) return;
      // custom impression storage...
    },
  },
})
```
But this BYPASSES the built-in `db.trackImpression()` call — they cannot both be used.

**Fix:** Wire `ExposureTracker` into `FlagManager`. Add `impressions.dedupe?: ExposureTrackerConfig` to `ImpressionConfig`. When configured, check `shouldTrack()` before calling `db.trackImpression()`.

**Bug 3 (P1): `evaluateAllDetailed` does not support `{ trace: true }`**

```typescript
// Public API gap:
evaluate(key, ctx, { trace: true })       // ✅ supported
evaluateAllDetailed(ctx)                  // ❌ no options parameter
```

Cannot bulk-trace all flags simultaneously. Requires N individual `evaluate` calls.

**Bug 4 (P2): Environment filter inconsistency**

```typescript
// evaluateAllDetailed:  filters flags where flag.environments includes config.environment
// evaluate:             NO filter — any flag evaluates in any environment
```

A flag with `environments: ["production"]` blocks evaluation via `evaluateAllDetailed` in staging, but evaluates normally via single `evaluate` call. This creates an inconsistent security boundary.

**Bug 5 (P2): Handler admin routes are incomplete**

Missing HTTP endpoints:
- `GET /admin/flags/:key` — get single flag details
- `GET /admin/flags/:key/rules` — list rules
- `POST /admin/flags/:key/rules` — add rule
- `PATCH /admin/flags/:key/rules/:ruleId` — update rule
- `DELETE /admin/flags/:key/rules/:ruleId` — remove rule
- `POST /admin/flags/:key/rollout` — set rollout
- `POST /admin/flags/:key/lock` — set lock
- `GET /admin/releases` — list releases
- `POST /admin/releases` — create release
- `POST /admin/releases/:id/deploy` — deploy release
- `POST /admin/releases/:id/rollback` — rollback release
- `POST /admin/releases/:id/approve` — approve release
- `GET /metrics` — Prometheus metrics

**Bug 6 (P2): Handler raw error message leakage**

```typescript
// handler.ts:399, 410, 420
return err(errMsg(e), 400);
```

Internal DB errors, Prisma/Sequelize stack details, and validation messages leak to HTTP clients. Should map to stable error codes with internal details logged only.

**Bug 7 (P3): `GET /health` is unauthenticated**

Returns latency, eval count, cache hit rate, circuit state, uptime. No auth gate. Ops intelligence visible to public callers.

---

### 10. Observability And Operations

Strengths:

- `createOtelAdapter()` avoids a hard OpenTelemetry dependency.
- Every public `evaluate()` call starts a span when telemetry is configured.
- Health includes DB probe latency and cache/evaluation counters.

Gaps:

- Span attributes are not aligned with OpenTelemetry feature flag semantic conventions.
- `evaluateAllDetailed()` does not start a span or a bulk span.
- Health probes L2 cache availability and circuit state but no invalidation lag, stream subscriber count, or event queue length.
- No Prometheus endpoint wired into handler (see Features Bug 1).

---

### 11. Adapter Layer And Data Model

Strengths:

- Memory, Prisma, Drizzle, Sequelize, Repository, and Redis cache adapters.
- Cloudflare KV adapter added.
- Read-replica routing (`replica.ts`) allows separate reader/writer adapters.
- `createTenantAdapter` wraps any DbAdapter with namespacing.

Gaps:

- Tenant adapter missing 6 optional methods (see Multi-Tenancy above).
- Tenant adapter cache keys are global — collisions between tenants with same flag keys.
- Bulk write transactions not part of adapter contract.
- `forgetUser()` is optional and not enforced.

---

### 12. RBAC Integration Checklist

| Check | Status |
|---|---|
| Role definitions (`viewer`/`editor`/`admin`/`owner`) | ✅ Correct |
| 17 permission types | ✅ Correct |
| Default permission matrix | ✅ Correct |
| `createDefaultRBACPolicy` factory | ✅ Correct |
| `createRBACHook` for mutations | ✅ Correct logic, see wiring bug |
| Handler extracts actor from requests | ❌ Never extracted |
| `createRelease` uses correct RBAC action | ❌ Fires `release.deployed` not `release.created` |
| `rejectRelease` in ACTION_PERMISSION_MAP | ❌ Missing |
| `createRBACAdminAuth` uses correct permission | ❌ Uses `flag.read` (too permissive) |
| Segment operations have `flagKey` context | ❌ Always `undefined` |
| Role persistence via DbAdapter | ❌ Static in-memory only |
| Per-resource (per-flag) role restrictions | ❌ Policy ignores resource |

---

### 13. Attributes Integration Checklist

| Check | Status |
|---|---|
| `ctx.attributes` targeting in rules | ✅ Correct |
| All 17 operators work against attributes | ✅ Correct |
| Custom dimension string fallback to attributes | ✅ Works (undocumented) |
| `scrubContext()` redacts `ctx.attributes[k]` | ✅ Correct |
| `scrubContext()` redacts top-level `ctx.userId`, etc. | ❌ Missing |
| `onBeforeEvaluation` receives scrubbed context | ❌ Receives raw context |
| Attribute type coercion for numeric operators | ❌ No coercion |
| Rule attribute validation on create/update | ❌ No validation |

---

### 14. Features Management Checklist

| Feature | Status |
|---|---|
| Flag CRUD (create/update/delete/kill/restore/clone) | ✅ |
| Rule management (add/update/remove/reorder) | ✅ |
| Rollout management | ✅ |
| Segment management | ✅ |
| Release workflow (create/deploy/rollback/approve/reject) | ✅ |
| Exclusion layers | ✅ |
| Bulk operations (bulkCreate/bulkUpdate/bulkDelete) | ✅ |
| Stale flag detection | ✅ |
| Multi-context evaluation | ✅ |
| Local event listeners (`on`/`off`) | ✅ |
| Typed flag keys + module augmentation | ✅ |
| Codegen for flag types | ✅ |
| Vue/Svelte/Angular/NestJS/React Native | ✅ |
| Cloudflare KV adapter | ✅ |
| Import from LD/Statsig/Unleash | ✅ |
| Read-replica routing | ✅ |
| Multi-tenant adapter | ✅ (6 methods missing) |
| RBAC system | ✅ (wiring broken) |
| Exposure dedup (`createExposureTracker`) | ✅ (not wired into manager) |
| Metrics adapter (`PrometheusAdapter`) | ✅ (not wired into manager/handler) |
| `evaluateAllDetailed` trace support | ❌ |
| Environment filter consistency | ❌ |
| Complete handler admin routes | ❌ (7+ routes missing) |
| GET /metrics handler route | ❌ |
| Actor extraction in handler | ❌ |

---

### 15. Build, Release, And Supply Chain

Strengths:

- `tsup` emits CJS, ESM, and declaration files.
- Optional peers are marked.
- `npm pack --dry-run` succeeds.

Gaps:

- No CI matrix for Node 18/20/22, Bun, edge runtime.
- No semantic release or changesets.
- No coverage gate in CI.
- No npm trusted publishing/provenance.

---

## Prioritized Remediation Plan

### Tier 1 — Correctness Blockers (Fix before any production use)

1. **Fix `scrubContext()` to scrub top-level FlagContext fields** — 5-line fix in `manager.ts:1827`.
2. **Fix handler to extract actor from requests** — add `X-Rollease-Actor` header parsing; pass actor into each manager write call.
3. **Fix `createRelease` to fire `"release.created"` action** — add to `HistoryAction`, add to `ACTION_PERMISSION_MAP`, fix manager hook call.
4. **Add `"release.rejected"` to `ACTION_PERMISSION_MAP`** — map to `"release.approve"` or new `"release.reject"` permission.
5. **Fix tenant adapter to forward 6 missing optional methods** — `getUserAssignments`, `touchFlagEvaluation`, `listScheduledReleases`, `approveRelease`, `rejectRelease`.

### Tier 2 — Integration Wiring (Fix before marketing these features)

6. **Wire `MetricsAdapter` into `FlagManager`** — add `metrics?: MetricsAdapter` to `RolleaseConfig` and `FlagManager` constructor; emit counters on evaluate/cache/error; add `GET /metrics` handler route.
7. **Wire `ExposureTracker` into manager impression tracking** — add `impressions.dedupe?: ExposureTrackerConfig`; check `shouldTrack()` before `db.trackImpression()`.
8. **Fix `onBeforeEvaluation` to receive scrubbed context** — run `scrubContext` before calling the hook.
9. **Fix `createRBACAdminAuth` to use operation-specific permission** — require minimum `flag.create` for admin routes.

### Tier 3 — Feature Completeness (Address before v1.0)

10. **Add `evaluateAllDetailed` trace option** — thread `{ trace: true }` into `evaluateAllDetailed` options.
11. **Fix environment filter consistency** — single `evaluate` should filter by `flag.environments` when `config.environment` is set.
12. **Add missing admin HTTP routes** — rule CRUD, rollout, lock, release workflow endpoints.
13. **Add per-resource role restrictions** to `createDefaultRBACPolicy`.
14. **Add role persistence hooks** to `DbAdapter`.
15. **Tenant adapter cache key namespacing** — prefix L1/L2 cache keys with tenant ID.

---

## Risk Register

| Risk | Likelihood | Impact | Current Control | Needed Control |
|---|---:|---:|---|---|
| PII leaks via top-level FlagContext fields | High | High | `scrubContext` only scrubs attributes | Fix scrubContext to include top-level fields |
| RBAC hook denies all admin HTTP ops | High if RBAC configured | High | None | Handler must extract and pass actor |
| Editors cannot create releases | High if RBAC configured | Medium | None | Fix createRelease mutation action |
| Anyone can reject releases | High | Medium | None | Add to ACTION_PERMISSION_MAP |
| Tenant metric/evaluation data collision | Medium | High | Tenant adapter namespaces keys | Cache keys not namespaced |
| Metrics never collected | High | Low | standalone adapter | Wire into FlagManager |

## Final Recommendation

Do not enable RBAC hooks in production until the handler actor extraction bug is fixed — doing so will silently deny all admin HTTP operations. Do not rely on `privacy.privateAttributes` for top-level FlagContext PII until `scrubContext` is patched. The metrics and exposure dedup systems should be clearly documented as opt-in manual wiring, not automatic.

The technical foundation is solid. All the data structures and algorithms are correct. The gaps are integration-layer wiring issues, not design flaws.
