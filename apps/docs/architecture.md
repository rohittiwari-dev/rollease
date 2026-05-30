# Rollease SDK — Architecture Deep Dive

> **Package:** `rollease`  
> **Last updated:** 2026-05-27

This document covers the internal architecture, design decisions, and implementation details of the Rollease SDK for contributors and advanced users.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Module Architecture](#2-module-architecture)
3. [The Evaluation Engine](#3-the-evaluation-engine)
4. [Cache Architecture](#4-cache-architecture)
5. [Database Adapter Pattern](#5-database-adapter-pattern)
6. [Secret Management & Signed Transport](#6-secret-management--signed-transport)
7. [Edge Runtime Safety](#7-edge-runtime-safety)
8. [Event System](#8-event-system)
9. [Hook System](#9-hook-system)
10. [Impression Tracking](#10-impression-tracking)
11. [Bucketing Algorithm](#11-bucketing-algorithm)
12. [Security Internals](#12-security-internals)
13. [Build System](#13-build-system)
14. [Design Decisions & Tradeoffs](#14-design-decisions--tradeoffs)

---

## 1. Design Philosophy

Rollease is built on four core principles:

### Server-first evaluation

Flag evaluation always happens on the server. The browser receives pre-evaluated values — never raw flag definitions, rules, or database connections. This eliminates:
- Client-side DB exposure
- Network latency for flag reads
- Secret leakage to the browser
- Flash-of-wrong-content (FOWC)

### Pure evaluation core

The `evaluateFlag()` function is a **pure function** — no side effects, no DB calls, no I/O. It takes a `Flag`, a `FlagContext`, and optional `EvaluateOptions`, and returns a deterministic `FlagResult`. This makes it:
- Testable without mocks
- Safe for any runtime (Node, Edge, browser, Cloudflare Workers)
- Predictable and debuggable

### Bring your own database

Rollease doesn't own your database schema. It defines a `DbAdapter` interface and provides adapters for popular ORMs (Prisma, Drizzle, Sequelize) plus an in-memory adapter for testing. You can implement a custom adapter for any storage backend.

### Edge-safe by design

The entire SDK works in Edge runtimes (Vercel Edge Functions, Cloudflare Workers). Node-specific modules (`fs`, `path`) are lazy-loaded behind runtime guards. The evaluation pipeline has zero Node.js dependencies.

---

## 2. Module Architecture

```
src/
├── index.ts                    ← Factory (createRollease), all public exports
├── bucket.ts                   ← MurmurHash3 + getBucket (percentage rollouts)
├── overrides.ts                ← .rolleaserc.json reader (Edge-safe)
│
├── core/
│   ├── types.ts                ← All TypeScript type definitions (589 lines)
│   ├── errors.ts               ← Error class hierarchy (9 error types)
│   ├── security.ts             ← Regex safety, condition validation, key validation
│   ├── logger.ts               ← Leveled logger with pluggable sink
│   └── internal.ts             ← Symbol-keyed internal constants
│
├── engine/
│   ├── evaluator.ts            ← Pure evaluation function (9-step pipeline)
│   └── manager.ts              ← FlagManager (orchestration, caching, events)
│
├── db/
│   ├── adapter.ts              ← DbAdapter + CacheAdapter interfaces
│   ├── memory.ts               ← In-memory adapter (dev/test)
│   ├── redis.ts                ← Redis cache adapter
│   ├── prisma.ts               ← Prisma ORM adapter
│   ├── drizzle.ts              ← Drizzle ORM adapter
│   ├── sequelize.ts            ← Sequelize ORM adapter
│   └── repository.ts           ← Generic repository abstraction
│
└── frameworks/
    ├── react.ts                ← Provider, hooks, FeatureGate
    └── next.ts                 ← Middleware, RSC helpers, signed transport
```

### Dependency flow

```
createRollease() ──→ FlagManager
                         │
                         ├── DbAdapter (user's ORM adapter)
                         │     └── Memory / Prisma / Drizzle / Sequelize
                         │
                         ├── CacheAdapter (L1: always MemoryCache, L2: optional)
                         │     └── MemoryCacheAdapter / RedisCacheAdapter
                         │
                         ├── evaluateFlag() ← pure, zero dependencies
                         │     └── getBucket() ← MurmurHash3
                         │     └── safeRegexTest() ← ReDoS prevention
                         │
                         ├── loadLocalOverrides() ← lazy fs, Edge-safe
                         │
                         └── RolleaseLogger ← leveled, pluggable sink
```

### Key constraint: no circular dependencies

The dependency graph is strictly acyclic:
- `core/*` depends on nothing
- `engine/evaluator` depends only on `core/*` and `bucket`
- `engine/manager` depends on everything except `frameworks/*`
- `frameworks/*` depends on `core/*` and (for Next.js) `engine/manager`
- `index.ts` re-exports everything

---

## 3. The Evaluation Engine

### Pipeline (evaluator.ts)

The 9-step pipeline runs in `evaluateFlag()`:

```
┌─────────────────────────────────────────────────┐
│ Input: Flag, FlagContext, EvaluateOptions        │
├─────────────────────────────────────────────────┤
│                                                  │
│  Step 2: Kill switch?                            │
│  ├── status === 'killed' → return false          │
│  │   reason: kill_switch                         │
│  │                                               │
│  Step 3: Archived?                               │
│  ├── status === 'archived' → return defaultValue │
│  │   reason: disabled                            │
│  │                                               │
│  Step 4: Date window?                            │
│  ├── scheduledAt > now → not_scheduled           │
│  ├── expiresAt < now → expired                   │
│  │                                               │
│  Step 5: Local override?                         │
│  ├── .rolleaserc.json has value → override       │
│  │                                               │
│  Step 6: Sticky assignment?                      │
│  ├── getUserAssignment() stored → assignment     │
│  │                                               │
│  Step 7: Targeting rules?                        │
│  ├── rules sorted by priority (lowest first)     │
│  ├── for each rule:                              │
│  │   ├── evaluateConditionGroup(conditions)      │
│  │   ├── per-rule rolloutPct check               │
│  │   ├── holdout? → return defaultValue          │
│  │   ├── variantId? → resolve variant            │
│  │   └── match → return rule.value               │
│  │   reason: rule_match                          │
│  │                                               │
│  Step 8: Rollout / Variant distribution?         │
│  ├── multivariate? → weighted random by bucket   │
│  │   reason: weighted_random                     │
│  ├── rollout? → bucket < effectivePct?           │
│  │   reason: percentage                          │
│  │                                               │
│  Step 9: Default                                 │
│  └── return defaultValue                         │
│      reason: default                             │
│                                                  │
├─────────────────────────────────────────────────┤
│ Output: FlagResult<T>                            │
│   { key, value, variant, enabled, reason,        │
│     ruleId, evaluatedAt }                        │
└─────────────────────────────────────────────────┘
```

### Condition evaluation (recursive)

```ts
evaluateConditionGroup(group, context):
  if group.all  → every child must match (AND)
  if group.any  → at least one child must match (OR)
  if group.none → no child must match (NOT)

evaluateConditionLeaf(leaf, context):
  resolve dimension → get actual value from context
  apply operator → compare actual vs expected
```

### Operator table

| Operator | Semantics | Edge cases |
|----------|-----------|------------|
| `eq` / `neq` | Strict `===` / `!==` | `neq` returns `true` when actual is `undefined` |
| `in` / `nin` | Array membership | Arrays: checks intersection. String expected + array actual: checks if array contains string. |
| `gt/gte/lt/lte` | Numeric `Number()` coercion | Non-numeric → coerced via `Number()` |
| `contains/startsWith/endsWith` | String methods | Only if `actual` is a string |
| `regex` | `safeRegexTest()` | ReDoS-safe. Patterns >128 chars rejected |
| `semverGte/semverLte` | Semver comparison | Strips `v` prefix, pads missing parts (e.g. `1.0` → `1.0.0`). Invalid versions → `false` (fail closed) |
| `exists` | Null/undefined check | `expected: true` → value must exist. `expected: false` → value must NOT exist (returns `true` for null/undefined) |
| `dateAfter/dateBefore` | ISO date comparison | Compared via `Date.getTime()`. Invalid dates → `false` |

### Dimension resolution

```ts
resolveDimension(dimension, context):
  'environment' → context.environment
  'userId'      → context.userId
  'userType'    → context.userType
  'region'      → context.region
  'version'     → context.version
  'ip'          → context.ip
  'tenantId'    → context.tenantId
  'segment'     → context.segments (array)
  'device'      → context.attributes?.device
  'channel'     → context.attributes?.channel
  'attribute'   → special handling (key/match pair)
  default       → context.attributes?.[dimension]
```

### The `enabled` field semantics

`enabled` is derived from the evaluation result:

| Reason | enabled |
|--------|---------|
| `kill_switch` | `false` |
| `disabled` | `false` |
| `expired` | `false` |
| `not_scheduled` | `false` |
| `default` (boolean flag) | `value === true` |
| `default` (non-boolean) | `true` |
| All other reasons | `true` |

---

## 4. Cache Architecture

### Two-tier cache

```
Request
  │
  ▼
L1 Cache (MemoryCacheAdapter) ── always active, per-FlagManager instance
  │ TTL: 5s (configurable via l1TtlMs)
  │ Storage: in-process Map<string, { value, expiresAt }>
  │ Capacity: unbounded (LRU eviction planned)
  │
  ▼ (miss)
L2 Cache (optional) ── shared across processes
  │ TTL: 60s (configurable via cache.ttl)
  │ Backends: MemoryCacheAdapter | RedisCacheAdapter
  │
  ▼ (miss)
Database (DbAdapter)
  │ Source of truth
  │
  ▲ (populate on read)
```

### Cache invalidation

All write operations automatically invalidate both L1 and L2:

```ts
// Inside FlagManager after any mutation:
this.l1Cache.delete(`rollease:flag:${key}`)
this.l1Cache.delete(`rollease:rules:${key}`)
if (this.l2Cache) {
  await this.l2Cache.delete(`rollease:flag:${key}`)
  await this.l2Cache.delete(`rollease:rules:${key}`)
}
```

Mutations that trigger invalidation: `update`, `kill`, `restore`, `archive`, `delete`, `addRule`, `updateRule`, `removeRule`, `reorderRules`, `setRollout`, `deployRelease`, `rollbackRelease`, `setLock`, `addTags`, `removeTags`.

### Cache key schema

| Key pattern | Contents |
|-------------|----------|
| `rollease:flag:<key>` | Serialized `Flag` JSON |
| `rollease:rules:<key>` | Serialized `FlagRule[]` JSON |

---

## 5. Database Adapter Pattern

### DbAdapter interface

The `DbAdapter` interface defines ~25 async methods covering 7 logical tables:

```ts
interface DbAdapter {
  // Flags
  createFlag(input: CreateFlagInput): Promise<Flag>
  getFlag(key: string): Promise<Flag | null>
  updateFlag(key: string, patch: UpdateFlagInput): Promise<Flag>
  deleteFlag(key: string): Promise<void>
  listFlags(input?: ListFlagsInput): Promise<ListFlagsResult>
  getAllActiveFlags(opts?: { keys?: string[]; namespace?: string; tags?: string[]; limit?: number; offset?: number }): Promise<Flag[]>

  // Rules
  addRule(flagKey: string, input: AddRuleInput): Promise<FlagRule>
  listRules(flagKey: string): Promise<FlagRule[]>
  updateRule(flagKey: string, ruleId: string, patch: UpdateRuleInput): Promise<FlagRule>
  removeRule(flagKey: string, ruleId: string): Promise<void>
  reorderRules(flagKey: string, orderings: RuleOrdering[]): Promise<void>

  // Segments
  createSegment(input: CreateSegmentInput): Promise<Segment>
  listSegments(): Promise<Segment[]>
  updateSegment(key: string, patch: UpdateSegmentInput): Promise<Segment>
  deleteSegment(key: string): Promise<void>
  getSegmentUsage(key: string): Promise<SegmentUsage[]>

  // Releases
  createRelease(input: CreateReleaseInput): Promise<Release>
  listReleases(filters?: { environment?: string; status?: string; limit?: number }): Promise<Release[]>
  getRelease(id: string): Promise<Release | null>
  deployRelease(id: string, deployedBy?: string): Promise<void>
  rollbackRelease(id: string, rolledBackBy?: string, reason?: string): Promise<void>
  previewRelease(id: string): Promise<ReleasePreview[]>

  // Assignments
  getUserAssignment(flagKey: string, userId: string): Promise<string | null>
  setUserAssignment(flagKey: string, userId: string, variantKey: string): Promise<void>

  // History
  addHistory(entry: HistoryEntry): Promise<void>
  getHistory(flagKey: string, opts?: { limit?: number }): Promise<HistoryEntry[]>

  // Impressions (optional)
  trackImpression?(impression: ImpressionData): Promise<void>

  // Lifecycle (optional)
  close?(): Promise<void>
}
```

### Adapter implementations

| Adapter | Module | Storage | Use case |
|---------|--------|---------|----------|
| `MemoryDbAdapter` | `rollease/db/memory` | In-process `Map` | Development, tests |
| `PrismaDbAdapter` | `rollease/db/prisma` | Any Prisma-supported DB | Production (Postgres, MySQL, SQLite) |
| `DrizzleDbAdapter` | `rollease/db/drizzle` | Any Drizzle-supported DB | Production |
| `SequelizeDbAdapter` | `rollease/db/sequelize` | Any Sequelize dialect | Production (legacy apps) |

### Validation layers

Each ORM adapter validates that the user's schema has the required fields:

- **Prisma:** `validatePrismaModelFields()` — checks Prisma runtime metadata
- **Drizzle:** `validateDrizzleTables()` — checks table column definitions
- **Sequelize:** `validateSequelizeAdapterModels()` — checks `getAttributes()` / `rawAttributes`

---

## 6. Secret Management & Signed Transport

### The secret lifecycle

```
createRollease({ secret: '...' })
  │
  ├── Validates: length >= 16 characters
  │
  ├── Stores in closure (NOT on the returned object)
  │
  └── Exposes via non-enumerable Symbol-keyed property:
      Object.defineProperty(client, INTERNAL_SECRET, {
        value: () => secret,
        enumerable: false,     ← invisible to Object.keys()
        configurable: false,   ← cannot be deleted
        writable: false,       ← cannot be overwritten
      })
```

The secret is used by:
1. `rolleaseMiddleware()` — to sign flag payloads in the middleware
2. `getFlag()` / `getAllFlags()` — to verify signatures in Server Components

### Signed envelope format (v2)

```
v2.<base64url-encoded payload>.<hmac-sha256 signature>
```

**Payload structure:**

```json
{
  "v": 2,
  "ts": 1717000000000,
  "flags": {
    "new_checkout": {
      "key": "new_checkout",
      "value": true,
      "variant": null,
      "enabled": true,
      "reason": "rule_match",
      "ruleId": "rule_abc",
      "evaluatedAt": "2026-05-27T12:00:00.000Z"
    }
  }
}
```

**Signature verification:**

```
HMAC-SHA256(base64url_payload, secret) === signature
```

**Expiry:** Envelope is rejected if `Date.now() - ts > maxAgeMs` (default: 5 minutes).

### Transport channels

The middleware injects the signed envelope via:
1. **`x-rollease-flags` header** — primary channel, read by `getFlag()` / `getAllFlags()`
2. **`rollease-flags` cookie** — fallback for scenarios where headers are stripped

---

## 7. Edge Runtime Safety

### The problem

Edge runtimes (Vercel Edge Functions, Cloudflare Workers, Deno Deploy) don't have access to Node.js built-in modules like `fs`, `path`, or `crypto`. The SDK must work in these environments without throwing.

### The solution

**Strategy 1: Lazy loading with runtime guards**

```ts
// overrides.ts
function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && typeof process.versions?.node === 'string'
}

function loadFs(): NodeFsModule | null {
  if (!isNodeRuntime()) return null
  try {
    const req = (0, eval)('require') as NodeRequire
    return req('fs') as NodeFsModule
  } catch {
    // ESM fallback: pass module-scoped require via Function constructor
    const tryReq = new Function('r', 'return typeof r === "function" ? r("fs") : null')
    return tryReq(typeof require !== 'undefined' ? require : undefined)
  }
}
```

**Strategy 2: Dynamic import with type casting**

```ts
// next.ts
const { NextResponse } = await import('next/server' as string)
```

The `as string` cast prevents TypeScript's DTS emitter from resolving the optional peer dependency during build, which would fail when `next` isn't installed.

**Strategy 3: Interface duplication**

For types from optional peer dependencies (`next/server`, `next/headers`), the SDK defines local interface copies rather than importing them:

```ts
// Instead of: import type { NextRequest } from 'next/server'
interface NextRequestLike {
  cookies: { get(name: string): { value: string } | undefined }
  headers: { get(name: string): string | null }
  url: string
  geo?: { country?: string; region?: string }
}
```

---

## 8. Event System

### Change listeners

`FlagManager` maintains an internal array of change listeners:

```ts
private changeListeners: Array<(event: ChangeEvent) => void> = []

onChange(listener): () => void {
  this.changeListeners.push(listener)
  return () => {
    this.changeListeners = this.changeListeners.filter(l => l !== listener)
  }
}
```

### Emission

Every write operation emits a change event after the mutation succeeds:

```ts
private emit(event: ChangeEvent): void {
  for (const listener of this.changeListeners) {
    try {
      listener(event)
    } catch (err) {
      this.logger.warn('change listener threw', { error: errMessage(err) })
    }
  }
}
```

**Key design choice:** Listener errors are caught and logged — they never propagate. This prevents a buggy monitoring callback from breaking flag management operations.

---

## 9. Hook System

### Hook types

| Hook | When | Can block? | Use case |
|------|------|-----------|----------|
| `onBeforeMutation` | Before any write | ✅ (throw to deny) | RBAC, audit, rate limiting |
| `onBeforeEvaluation` | Before each flag eval | ✅ (throw to deny) | Tenant isolation, permission checks |
| `onEvaluate` | After each flag eval | ❌ (fire-and-forget) | Metrics, analytics, A/B tracking |

### Execution model

- `onBeforeMutation` runs **synchronously** before the DB write. If it throws, the entire operation is aborted.
- `onBeforeEvaluation` runs **synchronously** before evaluation. If it throws, evaluation returns a missing-flag result.
- `onEvaluate` runs **asynchronously** (fire-and-forget). Errors are logged but never propagated.

---

## 10. Impression Tracking

### Flow

```
evaluate(key, context)
  │
  ├── evaluateFlag() ← pure evaluation
  │
  ├── Check: userId present?
  │   └── No → skip tracking
  │
  ├── Check: reason in NON_TRACKED_REASONS?
  │   └── Yes (kill_switch, disabled, not_scheduled, expired) → skip
  │
  ├── Check: impressions.enabled !== false?
  │
  ├── Check: Math.random() < impressions.sampleRate?
  │
  └── Fire-and-forget: db.trackImpression({
        flagKey, userId, value, variant, reason
      }).catch(logger.warn)
```

### Non-tracked reasons

These evaluation reasons don't generate impressions (the user didn't actually "see" the feature):
- `kill_switch` — flag is killed globally
- `disabled` — flag is archived
- `not_scheduled` — flag hasn't activated yet
- `expired` — flag has expired

### Sampling

Use `impressions.sampleRate` (0.0 to 1.0) to reduce tracking volume:

```ts
createRollease({
  db, secret,
  impressions: {
    sampleRate: 0.1,  // Track only 10% of evaluations
  },
})
```

---

## 11. Bucketing Algorithm

### MurmurHash3 (32-bit)

The SDK uses a TypeScript implementation of MurmurHash3 for consistent user bucketing:

```ts
murmurhash3_32(key: string, seed: number = 0): number
```

**Properties:**
- Deterministic: same input → same output
- Uniform distribution: buckets are evenly distributed across 0–99
- Avalanche effect: small input changes produce large output changes
- Fast: O(n) where n is the key length

### Bucket calculation

```ts
getBucket(userId, flagId, salt = ''): number {
  const hash = murmurhash3_32(`${userId}:${flagId}:${salt}`)
  return hash % 100  // 0–99
}
```

**Why MurmurHash3?** It's fast, has excellent distribution, doesn't require crypto, and is available in all runtimes (no `crypto.subtle` needed for Edge).

---

## 12. Security Internals

### Regex safety (ReDoS prevention)

User-supplied regex patterns in targeting conditions are validated to prevent catastrophic backtracking:

| Check | Pattern | Rejects |
|-------|---------|---------|
| Length | `pattern.length > 128` | Long patterns |
| Backreferences | `\1`, `\k<name>` | Back-referencing |
| Lookaround | `(?=...)`, `(?!...)`, `(?<=...)`, `(?<!...)` | Lookahead/lookbehind |
| Nested quantifiers | `(a+)+`, `(a*)*`, `(a{2,}){3}` | ReDoS vectors |
| Quantified alternation | `(a|b)+`, `(foo|bar)*` | Alternation with quantifiers |
| Large range quantifiers | `a{1001,}`, `a{1,2000}` | Ranges > 1000 |

### Condition depth limits

| Limit | Value | Purpose |
|-------|-------|---------|
| Max nesting depth | 12 | Prevent stack overflow from deeply nested groups |
| Max condition nodes | 100 | Prevent DoS from huge condition trees |

### Key validation

Flag and segment keys are validated to prevent:
- **Prototype pollution:** `__proto__`, `constructor`, `prototype` are forbidden
- **Object key collision:** `toString`, `hasOwnProperty`, etc. are forbidden
- **Injection:** Only `a-z0-9._-` characters allowed

### Override path traversal

`validateOverridePath()` prevents reading files outside the project directory:

```ts
validateOverridePath('../../../etc/passwd', cwd)  // → throws ValidationError
validateOverridePath('/etc/passwd', cwd)           // → throws ValidationError
```

---

## 13. Build System

### tsup configuration

The SDK builds three output formats simultaneously:

| Format | Output | Use case |
|--------|--------|----------|
| CJS | `dist/*.js` | Node.js `require()`, legacy bundlers |
| ESM | `dist/*.mjs` | Modern bundlers, `import` statements |
| DTS | `dist/*.d.ts` + `dist/*.d.mts` | TypeScript type checking |

### Entry points

The package exposes multiple entry points via `package.json` exports:

```json
{
  "exports": {
    ".": { "require": "./dist/index.js", "import": "./dist/index.mjs", "types": "./dist/index.d.ts" },
    "./react": { "...": "./dist/react.*" },
    "./next": { "...": "./dist/next.*" },
    "./db/memory": { "...": "./dist/db/memory.*" },
    "./db/prisma": { "...": "./dist/db/prisma.*" },
    "./db/drizzle": { "...": "./dist/db/drizzle.*" },
    "./db/sequelize": { "...": "./dist/db/sequelize.*" },
    "./db/redis": { "...": "./dist/db/redis.*" },
    "./db/adapter": { "...": "./dist/db/adapter.*" },
    "./core/types": { "...": "./dist/core/types.*" },
    "./core/errors": { "...": "./dist/core/errors.*" },
    "./core/security": { "...": "./dist/core/security.*" },
    "./core/logger": { "...": "./dist/core/logger.*" },
    "./engine/evaluator": { "...": "./dist/engine/evaluator.*" },
    "./engine/manager": { "...": "./dist/engine/manager.*" }
  }
}
```

### Tree-shaking

Each sub-module is a separate entry point, so bundlers can tree-shake unused adapters. An app using only Prisma won't bundle the Sequelize or Drizzle adapter code.

---

## 14. Design Decisions & Tradeoffs

### Why not client-side evaluation?

Most feature flag SDKs (LaunchDarkly, Unleash) have a client-side evaluation mode. Rollease deliberately avoids this because:

1. **Security:** Client-side evaluation requires sending the entire ruleset to the browser, which leaks targeting logic and internal segmentation
2. **Consistency:** Server-side evaluation ensures all users see the same result for the same context, regardless of client-side state
3. **Simplicity:** One evaluation path is easier to debug than two

The tradeoff: SPAs without SSR need an API endpoint to fetch pre-evaluated flags.

### Why pure evaluation?

Separating `evaluateFlag()` from `FlagManager` enables:
- Testing evaluation logic without database setup
- Running evaluation in Web Workers or Edge runtimes
- Replacing the evaluation algorithm without changing the orchestration layer

### Why MurmurHash3 instead of SHA-256?

- MurmurHash3 is ~10x faster than SHA-256
- No `crypto` dependency (works in all runtimes)
- We only need distribution uniformity, not cryptographic strength
- 32-bit output is sufficient for 100-bucket distribution

### Why Symbol-keyed secret storage?

The secret was originally stored as `client.__rollease.secret`. Problems:
- Visible via `Object.keys()` and `JSON.stringify()`
- Could leak if the client object was accidentally serialized
- Could leak if imported in a client bundle

Symbol-keyed properties are invisible to enumeration and JSON serialization, providing defense-in-depth without breaking the API.

### Why deduplicate release snapshots per flagKey?

A release with `[{ action: 'setValue', value: 'v2' }, { action: 'setRollout', rollout: { percentage: 100 } }]` for the same flag previously captured two snapshots. The second snapshot captured the state *after* the first mutation, losing the original value. By deduplicating, we ensure only the first (pre-mutation) state is captured.

### Why fire-and-forget impressions?

Impression tracking should never block or fail flag evaluation. The `trackImpression()` call uses `.catch()` to swallow errors silently. The tradeoff: impressions may be lost during DB outages, but flag evaluation is never impacted.
