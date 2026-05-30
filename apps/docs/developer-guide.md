# Rollease SDK — Developer Guide

> **Status:** Stable (`0.0.1`)  
> **Author:** Rohit Tiwari  
> **Last reviewed:** 2026-05-30

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Core Concepts](#2-core-concepts)
3. [Setup & Configuration](#3-setup--configuration)
4. [The Evaluation Pipeline](#4-the-evaluation-pipeline)
5. [Database Adapters](#5-database-adapters)
6. [Cache Layers](#6-cache-layers)
7. [Client-Server Communication Model](#7-client-server-communication-model)
8. [Next.js Full-Stack Integration](#8-nextjs-full-stack-integration)
9. [React Integration](#9-react-integration)
10. [Local Development Overrides](#10-local-development-overrides)
11. [Feature Flag Lifecycle](#11-feature-flag-lifecycle)
12. [Targeting Rules & Segments](#12-targeting-rules--segments)
13. [Rollouts & Releases](#13-rollouts--releases)
13b. [Flag Validation](#13b-flag-validation)
14. [Security Model](#14-security-model)
15. [Roadmap & Cross-References](#15-roadmap--cross-references)

---

## 1. Architecture Overview

Rollease is a single npm package (`rollease`) with no required cloud service. All evaluation logic runs in-process, on the same runtime as your application.

```
rollease/              ← main package (server SDK + client integrations)
├── index              ← createRollease() factory, all core exports
├── react              ← RolleaseProvider, hooks, FeatureGate
├── next               ← middleware + RSC helpers + signed transport
├── db/memory          ← in-process Map store (dev/test)
├── db/redis           ← Redis L2 cache
├── db/prisma          ← Prisma ORM adapter
├── db/drizzle         ← Drizzle ORM adapter
├── db/sequelize       ← Sequelize ORM adapter
├── db/adapter         ← DbAdapter + CacheAdapter interfaces
├── core/types         ← all TypeScript types
├── core/errors        ← error classes
├── core/security      ← regex safety, condition depth guards
├── engine/evaluator   ← pure evaluation function
└── engine/manager     ← FlagManager (the main API surface)
```

### Module dependency graph

```
createRollease()
    └── FlagManager
            ├── DbAdapter  (your ORM adapter)
            ├── CacheAdapter (L1 in-process always, L2 optional redis/memory)
            ├── evaluateFlag()   ← pure, no side effects
            └── loadLocalOverrides()  ← .rolleaserc.json (dev only)
```

### Package runtime boundaries

| Code | Runs where | Has DB access | Has secret |
|------|-----------|--------------|------------|
| `createRollease()` | Server only | Yes | Yes |
| `FlagManager` | Server only | Yes | No |
| `evaluateFlag()` | Anywhere (pure function) | No | No |
| `rolleaseMiddleware()` | Next.js Edge / Node middleware | Via client | Via client |
| `getFlag() / getAllFlags()` | Next.js RSC / Server Components | No (reads header/cookie) | Via env |
| `RolleaseProvider` | Client (browser) + Server (RSC) | No | No |
| `useFlag / useVariant / useFlags` | Client (browser) | No | No |

---

## 2. Core Concepts

### Flags

A flag (`Flag`) has:
- **key** — unique lowercase identifier (`new_checkout`, `billing.v2`, `exp.pricing`)
- **type** — `boolean | string | number | json | multivariate | percentage`
- **status** — `active | killed | archived`
- **defaultValue** — returned when no rule matches and no rollout applies
- **rollout** — optional percentage-based rollout config
- **variants** — for multivariate flags: weighted distribution buckets
- **scheduledAt / expiresAt** — automatic time-window activation

### FlagContext

The context passed to every evaluation. Pass what you have — all fields are optional.

```ts
interface FlagContext {
  userId?: string;        // user id for bucketing + user targeting
  environment?: string;   // 'dev' | 'staging' | 'production'
  version?: string;       // app semver: '2.1.0'
  region?: string;        // 'eu' | 'us' | 'apac'
  userType?: string;      // 'beta' | 'internal' | 'enterprise'
  segments?: string[];    // pre-resolved segment keys
  attributes?: Record<string, unknown>;  // arbitrary custom attrs
  ip?: string;            // for GeoIP resolution
  tenantId?: string;      // multi-tenant isolation
}
```

### FlagResult

Every evaluation returns a `FlagResult`:

```ts
interface FlagResult<T = unknown> {
  key: string;
  value: T;
  variant: string | null;   // set for multivariate flags
  enabled: boolean;
  reason: EvalReason;       // why this result was produced
  ruleId: string | null;    // which rule matched (if any)
  evaluatedAt: Date;
}
```

`reason` tells you exactly which step of the pipeline produced the result:
`kill_switch | disabled | expired | not_scheduled | prerequisite_not_met | exclusion_group_miss | exclusion_layer_not_found | override | assignment | rule_match | percentage | weighted_random | error_fallback | default`

---

## 3. Setup & Configuration

```ts
import { createRollease } from 'rollease'
import { createMemoryAdapter } from 'rollease/db/memory'

const rl = createRollease({
  db:     createMemoryAdapter(),       // required: DbAdapter
  secret: process.env.ROLLEASE_SECRET!, // required: min 16 chars, for signing transport
  cache: {
    driver: 'memory',  // or 'redis'
    ttl: 60,           // L2 TTL in seconds (default 60)
    redis: { url: process.env.REDIS_URL }, // only for driver: 'redis'
  },
  l1TtlMs: 5000,              // L1 in-process TTL ms (default 5000)
  localOverrides: true,       // auto-true in dev (NODE_ENV=development)
  localOverridesFile: '.rolleaserc.json',  // path relative to cwd
  audit: {
    enabled: true,
    sink: 'stdout',  // or 'db' or { write(event) { ... } }
  },
})

// Always close on shutdown
process.on('SIGTERM', () => rl.close())
```

### Config reference

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `db` | `DbAdapter` | required | Your ORM adapter |
| `secret` | `string` | required | Min 16 chars. Signs Next.js transport. |
| `cache.driver` | `'memory' \| 'redis'` | none | Omit to disable L2 cache |
| `cache.ttl` | `number` | `60` | L2 TTL in seconds |
| `l1TtlMs` | `number` | `5000` | L1 in-process TTL ms |
| `localOverrides` | `boolean` | `true` in dev | Enable `.rolleaserc.json` |
| `localOverridesFile` | `string` | `'.rolleaserc.json'` | Override file path |
| `autoResolveSegments` | `boolean` | `false` | Auto-evaluate segment definitions against context (see [Segments](#12-targeting-rules--segments)) |
| `evaluateAllPageSize` | `number` | `1000` | Page size for `evaluateAll` bulk queries |
| `impressions.enabled` | `boolean` | `true` | Track evaluation impressions |
| `impressions.sampleRate` | `number` | `1` | Sample rate for impressions (0–1) |
| `hooks` | `RolleaseHooks` | — | Lifecycle hooks for RBAC, audit, metrics |
| `logging` | `LoggingConfig` | — | Logging level + sink configuration |

---

## 4. The Evaluation Pipeline

`evaluateFlag()` is a pure function — no DB calls, no side effects. The `FlagManager.evaluate()` method loads flag + rules from the DB, then calls it.

The pipeline runs these 9 steps in order, returning on the first match:

```
Step 1: Flag exists?          → if not, return { enabled: false, reason: 'default' }
Step 2: Kill switch           → if status === 'killed', return false (kill_switch)
Step 3: Archived              → if status === 'archived', return defaultValue (disabled)
Step 4: Date window           → scheduledAt not yet? → not_scheduled
                              → expiresAt passed?    → expired
Step 5: Local override        → .rolleaserc.json has a value for this key? → override
Step 6: Sticky assignment     → getUserAssignment() has a stored variant? → assignment
Step 7: Targeting rules       → sorted by priority, first match wins → rule_match
Step 8: Percentage rollout    → bucket(userId, flagKey) < pct? → percentage / weighted_random
Step 9: Default               → return defaultValue
```

> **Prerequisites & exclusion layers.** Two additional gates run inside the pipeline. A flag with `prerequisites` short-circuits to `prerequisite_not_met` when any prerequisite flag isn't satisfied (`FlagManager` resolves prerequisites recursively and cycle-safe before calling `evaluateFlag`). A flag attached to an `exclusionLayer` returns `exclusion_group_miss` when the user's bucket falls outside the flag's allocation in that layer (`exclusion_layer_not_found` if the referenced layer is missing). `error_fallback` is returned when `resilience.fallbackOnError` is enabled and evaluation throws.

### Bucketing

Steps 7 (per-rule rollout) and 8 (global rollout) use MurmurHash3 for consistent bucketing:

```ts
getBucket(userId, flagKey, salt?) → 0..99
```

The same `userId` always gets the same bucket for the same `flagKey`, ensuring sticky behavior without needing to store assignments in DB (unless you explicitly use `setUserAssignment`).

---

## 5. Database Adapters

Choose one `DbAdapter`. All store the same 7 logical tables:

| Table | Stores |
|-------|--------|
| `Flag` | Flag definitions |
| `Rule` | Targeting rules per flag |
| `Segment` | Reusable audience segments |
| `Release` | Batches of atomic flag changes |
| `Assignment` | Sticky user→variant mappings |
| `History` | Audit trail |
| `Impression` | Evaluation events (optional) |

### Memory (dev/test)

```ts
import { createMemoryAdapter } from 'rollease/db/memory'
const db = createMemoryAdapter()
```

Data is lost on restart. Use only for development and unit tests.

### Prisma

```ts
import { PrismaClient } from '@prisma/client'
import { createPrismaAdapter } from 'rollease/db/prisma'

const prisma = new PrismaClient()
const db = createPrismaAdapter({ prisma, validateModelFields: true })
```

Your schema must have models named `RolleaseFlag`, `RolleaseRule`, `RolleaseSegment`, `RolleaseRelease`, `RolleaseAssignment`, `RolleaseHistory`. Custom model names are supported via the `delegates` and `modelNames` options.

### Drizzle

```ts
import { and, asc, desc, eq } from 'drizzle-orm'
import { createDrizzleAdapter } from 'rollease/db/drizzle'
import { db } from './db'
import { rolleaseFlags, rolleaseRules, rolleaseSegments,
         rolleaseReleases, rolleaseAssignments, rolleaseHistory } from './rollease-schema'

const adapter = createDrizzleAdapter({
  db,
  tables: { Flag: rolleaseFlags, Rule: rolleaseRules, Segment: rolleaseSegments,
            Release: rolleaseReleases, Assignment: rolleaseAssignments, History: rolleaseHistory },
  helpers: { eq, and, asc, desc },
})
```

### Sequelize

```ts
import { createSequelizeAdapter } from 'rollease/db/sequelize'
const db = createSequelizeAdapter({ models: { Flag: FlagModel, Rule: RuleModel, ... } })
```

### Writing a custom adapter

Implement the `DbAdapter` interface from `rollease/db/adapter`. All methods are async. The interface has ~20 methods covering CRUD for flags, rules, segments, releases, assignments, history, and tags.

---

## 6. Cache Layers

Rollease has a two-tier cache:

```
Request → L1 (in-process MemoryCache, TTL 5s default)
        → L2 (optional Redis or Memory cache, TTL 60s default)
        → DB
```

**L1** is always enabled — a `MemoryCacheAdapter` instance lives inside `FlagManager`.  
**L2** is optional — pass `cache: { driver: 'redis', ... }` or `cache: { driver: 'memory' }`.

Cache keys use `rollease:flag:<key>` for individual flags and `rollease:all` for bulk queries.

On any write operation (update, archive, kill, addRule, setRollout, deployRelease, etc.) the SDK busts the relevant cache keys automatically.

> **Read-through caching:** `evaluate()` reads through L1 → L2 → DB via `getFlagCached()` / `getRulesCached()`, populating each tier on a miss. A miss for a nonexistent key is briefly negative-cached to avoid hammering the DB. Writes bust the relevant keys (and broadcast over the optional `InvalidationBus` for multi-process coherence).

---

## 7. Client-Server Communication Model

This is the most important concept to understand for correct SDK usage.

> This section covers the **Next.js signed-transport** model (middleware → RSC). For the **browser client over the internal REST API** (`createRolleaseClient` ↔ `createHandler()`, with SSE and analytics) — the pattern for SPAs and live updates — see the dedicated **[Client & Server](client-server.md)** guide.

### The core boundary

```
┌──────────────────────────────────────────────────────────────────┐
│  SERVER (Node.js / Edge Runtime)                                 │
│                                                                  │
│  createRollease({ db, secret })  ←  only here                   │
│  rl.flags.isEnabled(...)         ←  only here                   │
│  rl.flags.evaluateAll(...)       ←  only here                   │
└──────────────────────────────────────────────────────────────────┘
             │  signed payload (header/cookie)
             ▼
┌──────────────────────────────────────────────────────────────────┐
│  CLIENT (Browser / React)                                        │
│                                                                  │
│  <RolleaseProvider initialFlags={flags}>                         │
│    useFlag('my_flag')            ←  only here                   │
│    useVariant('exp.pricing')     ←  only here                   │
│    <FeatureGate flag="new_ui">   ←  only here                   │
│  </RolleaseProvider>                                             │
└──────────────────────────────────────────────────────────────────┘
```

The SDK never makes DB calls from the browser. The browser receives pre-evaluated flag values from the server. This is the "deferred evaluation" pattern: evaluate once on the server, defer the results to the client as a static map.

### The three server patterns

**Pattern A: Direct server evaluation** (API routes, server functions, cron jobs)

```ts
// server-only code — has direct access to rl
const rl = createRollease({ db, secret })

const enabled = await rl.flags.isEnabled('new_checkout', {
  userId: user.id,
  environment: 'production',
})
```

**Pattern B: Next.js middleware + RSC** (full-stack Next.js apps)

Middleware evaluates flags once per request, signs them, and passes them down via headers/cookies. Server Components (RSC) read from headers. Client Components read from React context.

See [Section 8](#8-nextjs-full-stack-integration) for the complete setup.

**Pattern C: Bulk evaluation for client hydration** (any SSR framework)

```ts
// In your SSR render function
const flags = await rl.flags.evaluateAll(
  { userId: req.user?.id, environment: 'production' },
  { namespace: 'ui' }  // only send UI flags to client
)

// Pass to your React render
const html = renderToString(
  <RolleaseProvider initialFlags={flags}>
    <App />
  </RolleaseProvider>
)
```

### What the transport carries

The Next.js middleware signs a `DetailedFlagMap` (key → full `FlagResult`) using the v2 transport. This preserves variant keys, evaluation reasons, and rule IDs across the server-client boundary. The signed envelope format is:

```
v2.<base64url(JSON payload)>.<hmac-sha256 signature>
```

The payload contains `{ v: 2, ts: <unix ms>, flags: { key: { value, variant, enabled, reason, ruleId, evaluatedAt }, ... } }`. The signature uses HMAC-SHA256 with your `ROLLEASE_SECRET`. The envelope expires after 5 minutes (configurable via `maxAgeMs`).

> **Note:** The legacy v1 transport (`FlagMap` only) is still accepted for one release cycle to allow migration, but new middleware always produces v2 envelopes.

---

## 8. Next.js Full-Stack Integration

This is the canonical full-stack pattern. It covers App Router (recommended), but the same concepts apply to Pages Router.

### Setup (4 steps)

#### Step 1 — Create the server singleton

```ts
// lib/rollease.ts  ← server-only file (never imported by client code)
import { createRollease } from 'rollease'
import { createPrismaAdapter } from 'rollease/db/prisma'
import { prisma } from './prisma'

export const rl = createRollease({
  db: createPrismaAdapter({ prisma }),
  secret: process.env.ROLLEASE_SECRET!,
  cache: {
    driver: 'redis',
    ttl: 60,
    redis: { url: process.env.REDIS_URL! },
  },
})
```

Add `ROLLEASE_SECRET` (min 16 chars) and `REDIS_URL` to your `.env`.

#### Step 2 — Add the middleware

```ts
// middleware.ts  (project root)
import { rolleaseMiddleware } from 'rollease/next'
import { NextRequest } from 'next/server'
import { rl } from './lib/rollease'

export default rolleaseMiddleware(rl, {
  // Extract userId from your session/JWT
  userIdExtractor: (req: NextRequest) => {
    const sessionCookie = req.cookies.get('session')?.value
    if (!sessionCookie) return undefined
    // decode your JWT / session token here
    return decodeSession(sessionCookie)?.userId
  },

  // Add any extra context from the request
  flagContext: (req: NextRequest) => ({
    environment: process.env.NODE_ENV as string,
    region: req.geo?.country?.toLowerCase(),
  }),

  // Optional: only evaluate specific flags in middleware
  // Omit to evaluate all active flags
  flags: ['new_checkout', 'exp.pricing', 'billing.v2'],
})

// Protect all routes except static assets
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

The middleware evaluates flags, signs the result, and injects it as:
- `x-rollease-flags` header (available to Server Components via `headers()`)
- `rollease-flags` cookie (available as fallback)

#### Step 3 — Read in Server Components

```ts
// app/dashboard/page.tsx
import { getFlag, getAllFlags } from 'rollease/next'

export default async function DashboardPage() {
  // Read a single flag
  const checkout = await getFlag('new_checkout', false)

  // Or read all flags at once
  const flags = await getAllFlags()

  return (
    <RolleaseProvider initialFlags={flags}>
      <Dashboard />
    </RolleaseProvider>
  )
}
```

#### Step 4 — Use hooks in Client Components

```tsx
// app/dashboard/checkout-button.tsx
'use client'
import { useFlag, useVariant, FeatureGate } from 'rollease/react'

export function CheckoutButton() {
  const { enabled } = useFlag('new_checkout')
  const { variant } = useVariant('exp.pricing')

  return (
    <FeatureGate flag="new_checkout" fallback={<OldCheckout />}>
      <NewCheckout pricingVariant={variant?.key} />
    </FeatureGate>
  )
}
```

### Full data flow diagram

```
Browser request
    │
    ▼
Next.js Middleware (Edge)
    ├── calls rl.flags.evaluateAllDetailed(context)  ← DB + cache
    ├── signs result → "v2.<payload>.<sig>"
    ├── sets x-rollease-flags header
    └── sets rollease-flags cookie (httpOnly)
    │
    ▼
Server Component (RSC)
    ├── getFlag('key') or getAllFlags()
    │       └── reads x-rollease-flags header
    │       └── verifies HMAC signature
    │       └── checks timestamp (expires after 5 min)
    └── passes flags to <RolleaseProvider initialFlags={flags}>
    │
    ▼
Client Component (browser)
    └── useFlag() / useVariant() / FeatureGate
            └── reads from React context (no network call)
```

### Patterns for specific Next.js scenarios

#### API Route (Route Handler)

```ts
// app/api/checkout/route.ts
import { rl } from '@/lib/rollease'
import { getCurrentUser } from '@/lib/auth'

export async function POST(req: Request) {
  const user = await getCurrentUser(req)

  const enabled = await rl.flags.isEnabled('new_checkout', {
    userId: user.id,
    environment: process.env.NODE_ENV,
  })

  if (!enabled) return Response.json({ error: 'Not available' }, { status: 403 })
  // ...
}
```

#### Server Action

```ts
// app/actions/billing.ts
'use server'
import { rl } from '@/lib/rollease'
import { getServerSession } from 'next-auth'

export async function upgradePlan(planId: string) {
  const session = await getServerSession()

  const billingV2 = await rl.flags.isEnabled('billing.v2', {
    userId: session?.user?.id,
  })

  return billingV2 ? upgradeV2(planId) : upgradeV1(planId)
}
```

#### Middleware-free pattern (SSR only, no Edge)

If you don't want middleware (e.g., Pages Router `getServerSideProps`):

```ts
// pages/dashboard.tsx
import { GetServerSideProps } from 'next'
import { rl } from '../lib/rollease'
import { getSession } from '../lib/auth'

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSession(ctx)
  const flags = await rl.flags.evaluateAll({
    userId: session?.userId,
    environment: process.env.NODE_ENV,
  })

  return { props: { flags } }
}

export default function Dashboard({ flags }) {
  return (
    <RolleaseProvider initialFlags={flags}>
      <DashboardContent />
    </RolleaseProvider>
  )
}
```

---

## 9. React Integration

> Using **Vue, Svelte, or Angular**? Each has an equivalent client binding (plugin / store / signals) — see [Framework Integrations](frameworks.md). The rest of this section covers React.

### Provider

Wrap your app (or a subtree) with `RolleaseProvider`. Supply one of:
- `client` — a live `RolleaseBrowserClient` from `rollease/client` (real-time SSE/polling; preferred with `createHandler()` — see [Client & Server](client-server.md))
- `initialFlags` — a `FlagMap` from `evaluateAll()` or a `DetailedFlagMap` from `evaluateAllDetailed()` (static SSR hydration)
- `flagsUrl` (+ `refreshInterval`) — provider fetches and polls this URL

```tsx
import { RolleaseProvider } from 'rollease/react'

// Simple values
<RolleaseProvider initialFlags={{ new_checkout: true, exp.pricing: 'variant_b' }}>
  <App />
</RolleaseProvider>

// Full results (preserves reason, variant, ruleId)
const detailedFlags = await rl.flags.evaluateAllDetailed(context)
<RolleaseProvider initialFlags={detailedFlags}>
  <App />
</RolleaseProvider>
```

The provider auto-detects whether values are plain values or `FlagResult` objects.

### Hooks

```tsx
// Boolean flag
const { enabled } = useFlag('new_checkout')

// Multivariate flag variant
const { variant } = useVariant('exp.pricing')
// variant → { key: 'variant_b', value: { price: 49.99 }, reason: 'rule_match' }

// All flag values at once
const flags = useFlags()
// flags → { new_checkout: true, 'exp.pricing': { price: 49.99 } }

// Full evaluation details
const details = useFlagDetails('new_checkout')
// details → { key, value, variant, enabled, reason, ruleId, evaluatedAt }
```

### Declarative component

```tsx
<FeatureGate flag="new_invoice_list" fallback={<LegacyInvoiceList />}>
  <NewInvoiceList />
</FeatureGate>
```

---

## 10. Local Development Overrides

In development (`NODE_ENV=development`), create `.rolleaserc.json` in your project root:

```json
{
  "new_checkout": true,
  "exp.pricing": "variant_b",
  "billing.v2": false,
  "feature.dark_mode": { "theme": "dark" }
}
```

Overrides are re-read from disk every 5 seconds. They bypass all rules and rollout evaluation (Step 5 in the pipeline).

Add to `.gitignore`:
```
.rolleaserc.json
```

This file is for local developer use only. Never commit it or deploy it.

---

## 11. Feature Flag Lifecycle

```
create()  →  [active]
                │
                ├── kill()     →  [killed]   ← instant off switch, returns false
                │       └── restore()  →  [active]
                │
                └── archive()  →  [archived]  ← soft delete, returns defaultValue
                        └── restore()  →  [active]

delete({ confirm: true })  ←  permanent, can't be undone
```

### Kill switch (emergency off)

```ts
// Kill a single flag immediately
await rl.flags.kill('new_checkout', { killedBy: 'alice', reason: 'payment errors spike' })

// Kill ALL active flags (incident response)
await rl.flags.killAll({ reason: 'production incident', killedBy: 'alice' })

// Restore
await rl.flags.restore('new_checkout')
await rl.flags.restoreAll({})
```

### Flag locking

Lock a flag with `setLock()` to block edits to its definition, rules, and rollout. Passing `locked`/`lockedReason` to `update()` is **deprecated and silently stripped** — always go through `setLock()` so the lock change is authorized and audited.

```ts
await rl.flags.setLock('critical_flag', {
  locked: true,
  reason: 'audit requirement — contact compliance before changing',
  actor: { id: 'compliance-bot', type: 'service' },
})

// Edits to definition / rules / rollout now throw FlagLockedError (HTTP 423)
await rl.flags.addRule('critical_flag', rule)  // ← throws FlagLockedError

// Unlock
await rl.flags.setLock('critical_flag', { locked: false })
```

> `kill()`, `restore()`, `archive()`, `delete()`, and `clone()` are **not** blocked by a lock — locking guards configuration edits, not the emergency kill switch.

---

## 12. Targeting Rules & Segments

### Rules

Rules are evaluated in priority order (lowest number first). The first matching rule wins.

```ts
await rl.flags.addRule('new_checkout', {
  name: 'internal users',
  priority: 1,
  value: true,
  enabled: true,
  conditions: {
    all: [
      { dimension: 'userType', op: 'in', value: ['internal', 'beta'] },
      { dimension: 'environment', op: 'eq', value: 'production' },
    ],
  },
})
```

### Condition operators

| Operator | Works on | Notes |
|----------|----------|-------|
| `eq` / `neq` | any | Strict equality. `neq` returns `true` when actual is `undefined`. |
| `in` / `nin` | any, array | Arrays: checks intersection. String expected + array actual: checks if array contains the string. |
| `gt` / `gte` / `lt` / `lte` | numbers | Numeric comparison |
| `contains` / `startsWith` / `endsWith` | strings | String matching |
| `regex` | strings | Safe regex only (no ReDoS). Unsafe patterns are rejected pre-execution. |
| `semverGte` / `semverLte` | version strings | Semver comparison. Invalid versions return `false` (fail closed). Strips `v` prefix, pads missing parts (e.g. `1.0` → `1.0.0`). |
| `exists` | any | `expected: true` → value must exist. `expected: false` → value must NOT exist. |
| `dateAfter` / `dateBefore` | date strings | ISO date comparison. Invalid dates return `false`. |

### Condition groups (AND / OR / NOT)

```ts
conditions: {
  all: [                         // AND
    { dimension: 'environment', op: 'eq', value: 'production' },
    {
      any: [                     // OR nested in AND
        { dimension: 'region', op: 'in', value: ['us', 'ca'] },
        { dimension: 'userType', op: 'eq', value: 'enterprise' },
      ],
    },
    {
      none: [                    // NOT nested in AND
        { dimension: 'userType', op: 'eq', value: 'trial' },
      ],
    },
  ],
}
```

### Segments — Deep Dive

Segments are **reusable audience definitions** that decouple "who is this user?" from "what should they see?". A segment defines a set of conditions (e.g. "enterprise users in the US"), and rules reference segments by key instead of duplicating the conditions everywhere.

#### How segments flow through the system

```
                    ┌─────────────────────────┐
                    │  1. Define the segment   │
                    │  key: "power_users"       │
                    │  rules: { all: [...] }    │
                    └────────────┬──────────────┘
                                 │
                    ┌────────────▼──────────────┐
                    │  2. Reference in rules     │
                    │  dimension: "segment"       │
                    │  op: "in"                   │
                    │  value: "power_users"        │
                    └────────────┬──────────────┘
                                 │
                    ┌────────────▼──────────────┐
                    │  3. Resolve at eval time   │
                    │  Your code determines      │
                    │  which segments the user    │
                    │  belongs to                 │
                    └────────────┬──────────────┘
                                 │
                    ┌────────────▼──────────────┐
                    │  4. Pass in context         │
                    │  context.segments =         │
                    │    ["power_users", "beta"]   │
                    └────────────┬──────────────┘
                                 │
                    ┌────────────▼──────────────┐
                    │  5. Evaluator checks        │
                    │  Does context.segments      │
                    │  contain "power_users"?      │
                    │  → YES → rule matches       │
                    └─────────────────────────────┘
```

#### Step 1 — Create segments

A segment stores a `FlagConditionGroup` (the same AND/OR/NOT structure used in rules). Segments can be evaluated automatically (via `autoResolveSegments: true`) or manually by your code.

```ts
// Segment: enterprise-level users
await rl.flags.createSegment({
  key: 'enterprise_users',
  description: 'Users on enterprise or enterprise_plus plans',
  rules: {
    all: [
      { dimension: 'userType', op: 'in', value: ['enterprise', 'enterprise_plus'] },
    ],
  },
})

// Segment: beta testers in specific regions
await rl.flags.createSegment({
  key: 'beta_testers',
  description: 'Beta users in US or EU',
  rules: {
    all: [
      { dimension: 'userType', op: 'eq', value: 'beta' },
      {
        any: [
          { dimension: 'region', op: 'eq', value: 'us' },
          { dimension: 'region', op: 'eq', value: 'eu' },
        ],
      },
    ],
  },
})

// Segment: high-value users by attribute
await rl.flags.createSegment({
  key: 'high_value',
  description: 'Users who have spent > $1000',
  rules: {
    all: [
      { dimension: 'attribute', op: 'gt', value: { key: 'totalSpend', match: 1000 } },
    ],
  },
})
```

#### Step 2 — Reference segments in flag rules

Rules use `dimension: "segment"` to target users who belong to a segment. The evaluator checks if the segment key appears in `context.segments`.

```ts
// Enable premium feature for enterprise users
await rl.flags.addRule('premium_dashboard', {
  name: 'Enterprise access',
  priority: 1,
  value: true,
  conditions: {
    all: [{ dimension: 'segment', op: 'in', value: 'enterprise_users' }],
  },
})

// Enable experimental UI for beta testers AND high-value users
await rl.flags.addRule('experimental_ui', {
  name: 'Beta + high-value',
  priority: 1,
  value: true,
  conditions: {
    all: [
      { dimension: 'segment', op: 'in', value: 'beta_testers' },
      { dimension: 'segment', op: 'in', value: 'high_value' },
    ],
  },
})

// Enable for ANY of several segments
await rl.flags.addRule('new_checkout', {
  name: 'Early access groups',
  priority: 1,
  value: true,
  conditions: {
    any: [
      { dimension: 'segment', op: 'in', value: 'enterprise_users' },
      { dimension: 'segment', op: 'in', value: 'beta_testers' },
    ],
  },
})

// Exclude a segment (NOT)
await rl.flags.addRule('risky_feature', {
  name: 'Everyone except trial users',
  priority: 1,
  value: true,
  conditions: {
    all: [
      { dimension: 'segment', op: 'in', value: 'enterprise_users' },
    ],
    none: [
      { dimension: 'segment', op: 'in', value: 'trial_users' },
    ],
  },
})
```

#### Step 3 — Resolve user segments

Rollease offers two approaches to segment resolution:

**Option A — Automatic resolution (recommended for most use cases)**

Enable `autoResolveSegments: true` in your config. The SDK will automatically load segment definitions from the database and evaluate their rules against the user context to populate `context.segments`:

```ts
const rl = createRollease({
  db: createMemoryAdapter(),
  secret: 'my-secret-at-least-16-chars',
  autoResolveSegments: true,  // ← enables auto-resolution
})

// No need to pass segments — the SDK resolves them automatically
const enabled = await rl.flags.isEnabled('premium_dashboard', {
  userId: user.id,
  userType: user.plan,          // the segment rules will match against this
  region: user.region,
  environment: 'production',
})
```

Auto-resolution:
- Loads all segment definitions from DB via `db.listSegments()`
- Evaluates each segment's `rules` against the context using `evaluateConditionGroup()`
- Populates `context.segments` with matched segment keys
- **Skips** when the caller pre-populates `context.segments` (backward compatible)
- Errors are logged and never thrown — gracefully falls back to empty segments

> **Performance note:** Auto-resolution evaluates all segment definitions on every flag evaluation. For high-traffic applications with many segments, consider caching segment definitions or using manual resolution with pre-computed segments.

**Option B — Manual resolution (full control)**

If you need maximum performance or resolve segments from external systems (CRM, user service, etc.), pass pre-resolved segments in `context.segments`:

##### Pattern A — Manual resolution from user data

```ts
// Fetch user from your database
const user = await db.users.findUnique({ where: { id: userId } })

// Resolve segments based on user properties
function resolveSegments(user: User): string[] {
  const segments: string[] = []

  // Check each segment's conditions against user data
  if (['enterprise', 'enterprise_plus'].includes(user.plan)) {
    segments.push('enterprise_users')
  }
  if (user.role === 'beta' && ['us', 'eu'].includes(user.region)) {
    segments.push('beta_testers')
  }
  if (user.totalSpend > 1000) {
    segments.push('high_value')
  }
  if (user.plan === 'trial') {
    segments.push('trial_users')
  }

  return segments
}

// Pass resolved segments to evaluation
const userSegments = resolveSegments(user)
const enabled = await rl.flags.isEnabled('premium_dashboard', {
  userId: user.id,
  segments: userSegments,  // e.g. ['enterprise_users', 'high_value']
  environment: 'production',
})
```

##### Pattern B — Evaluate segment definitions from DB

You can load segment definitions from Rollease and evaluate them yourself using `evaluateConditionGroup`:

```ts
import { evaluateConditionGroup } from 'rollease'

async function resolveSegmentsFromDefinitions(
  userId: string,
  userContext: FlagContext
): Promise<string[]> {
  // Load all segment definitions from Rollease
  const allSegments = await rl.flags.listSegments()
  const matched: string[] = []

  for (const segment of allSegments) {
    // Use the evaluator's own condition matching logic
    if (evaluateConditionGroup(segment.rules, userContext)) {
      matched.push(segment.key)
    }
  }

  return matched
}

// Build a rich context from the user's data
const userContext: FlagContext = {
  userId: user.id,
  userType: user.plan,            // 'enterprise' | 'pro' | 'free' | 'beta'
  region: user.region,            // 'us' | 'eu' | 'apac'
  environment: 'production',
  version: req.headers.get('x-app-version') || undefined,
  attributes: {
    totalSpend: user.totalSpend,  // 1500
    company_size: user.company?.size, // 200
    device: req.headers.get('x-device-type'), // 'ios'
  },
}

// Resolve segments
const segments = await resolveSegmentsFromDefinitions(user.id, userContext)

// Now evaluate flags with resolved segments
const flags = await rl.flags.evaluateAll({
  ...userContext,
  segments,  // e.g. ['enterprise_users', 'beta_testers', 'high_value']
})
```

##### Pattern C — Middleware resolution (recommended for Next.js)

```ts
// middleware.ts
import { rolleaseMiddleware } from 'rollease/next'
import { rl } from './lib/rollease'

export default rolleaseMiddleware(rl, {
  userIdExtractor: (req) => decodeSession(req.cookies.get('session')?.value)?.userId,

  flagContext: async (req) => {
    const session = decodeSession(req.cookies.get('session')?.value)
    if (!session) return {}

    // Resolve segments for this user once per request
    const segments = await resolveUserSegments(session.userId)

    return {
      environment: process.env.NODE_ENV,
      region: req.geo?.country?.toLowerCase(),
      userType: session.userType,
      segments,  // Passed to every flag evaluation
      attributes: {
        plan: session.plan,
        totalSpend: session.totalSpend,
      },
    }
  },
})
```

#### Step 4 — How the evaluator resolves the `segment` dimension

When the evaluator encounters a condition leaf with `dimension: "segment"`, it follows a special code path in `evaluateConditionLeaf()`:

```ts
// In evaluator.ts — evaluateConditionLeaf()

// Special handling for "segment" dimension
if (leaf.dimension === "segment") {
  const userSegments = context.segments || []    // ← your resolved segments
  return evaluateOperator(leaf.op, userSegments, leaf.value)
}
```

This resolves as follows:

| Rule condition | Context | Evaluates to |
|----------------|---------|-------------|
| `{ dimension: "segment", op: "in", value: "enterprise_users" }` | `segments: ["enterprise_users", "beta"]` | `true` (array contains the value) |
| `{ dimension: "segment", op: "in", value: "enterprise_users" }` | `segments: ["free_tier"]` | `false` (not in array) |
| `{ dimension: "segment", op: "in", value: "enterprise_users" }` | `segments: undefined` | `false` (empty array `[]` checked) |
| `{ dimension: "segment", op: "eq", value: "enterprise_users" }` | `segments: ["enterprise_users"]` | `false` (strict `===` on array vs string) |
| `{ dimension: "segment", op: "in", value: ["enterprise_users", "pro_users"] }` | `segments: ["pro_users"]` | `true` (intersection check) |

> **Important:** Always use `op: "in"` for segment checks because `context.segments` is an array. The `in` operator checks if any element in the actual value (array) appears in the expected value, or if the expected value is a string, checks if the array contains that string. Using `eq` would fail because `["enterprise_users"] === "enterprise_users"` is `false`.

#### Step 5 — How the `enabled` field is determined

After a rule with a segment condition matches, the evaluation pipeline returns a `FlagResult`. The `enabled` field depends on the evaluation reason and flag type:

```
Rule matches with value: true, reason: "rule_match"
                    │
                    ▼
    ┌─────────────────────────────────────────────────┐
    │ makeResult() determines 'enabled':              │
    │                                                 │
    │ if reason is:                                   │
    │   kill_switch, disabled, expired, not_scheduled  │
    │   → enabled = false                             │
    │                                                 │
    │ if reason is 'default':                         │
    │   boolean flag → enabled = (value === true)     │
    │   non-boolean  → enabled = true                 │
    │                                                 │
    │ ALL other reasons (rule_match, assignment,       │
    │   override, percentage, weighted_random):         │
    │   → enabled = true                              │
    └─────────────────────────────────────────────────┘
```

So when a segment-based rule matches:

```ts
// Boolean flag — rule matched via segment
result.enabled = true       // because reason is "rule_match"
result.reason  = "rule_match"
result.value   = true       // the rule's value
result.ruleId  = "rule_abc" // which rule matched

// Boolean flag — no rules matched, no segment match
result.enabled = false      // because reason is "default" and defaultValue is false
result.reason  = "default"
result.value   = false      // the flag's defaultValue
```

##### Full worked example

```ts
// 1. Create flag
await rl.flags.create({
  key: 'advanced_analytics',
  type: 'boolean',
  defaultValue: false,  // disabled by default
})

// 2. Create segment
await rl.flags.createSegment({
  key: 'enterprise_users',
  rules: {
    all: [
      { dimension: 'userType', op: 'in', value: ['enterprise', 'enterprise_plus'] },
    ],
  },
})

// 3. Add rule targeting the segment
await rl.flags.addRule('advanced_analytics', {
  name: 'Enable for enterprise',
  priority: 1,
  value: true,
  conditions: {
    all: [
      { dimension: 'segment', op: 'in', value: 'enterprise_users' },
      { dimension: 'environment', op: 'eq', value: 'production' },
    ],
  },
})

// 4. Enterprise user evaluation
const result = await rl.flags.evaluate('advanced_analytics', {
  userId: 'u_alice',
  userType: 'enterprise',    // not used by evaluator directly for segments
  segments: ['enterprise_users'],  // ← this IS checked by the evaluator
  environment: 'production',
})
// result = {
//   key: 'advanced_analytics',
//   value: true,
//   enabled: true,          ← true because rule matched
//   reason: 'rule_match',   ← step 7 of the pipeline
//   variant: null,
//   ruleId: 'rule_xyz',     ← ID of the matching rule
//   evaluatedAt: Date,
// }

// 5. Free-tier user evaluation (no enterprise segment)
const result2 = await rl.flags.evaluate('advanced_analytics', {
  userId: 'u_bob',
  segments: ['free_tier'],   // not 'enterprise_users'
  environment: 'production',
})
// result2 = {
//   key: 'advanced_analytics',
//   value: false,
//   enabled: false,          ← false because defaultValue is false
//   reason: 'default',       ← no rules matched, fell to step 9
//   variant: null,
//   ruleId: null,
// }

// 6. Enterprise user but wrong environment
const result3 = await rl.flags.evaluate('advanced_analytics', {
  userId: 'u_alice',
  segments: ['enterprise_users'],
  environment: 'staging',   // rule requires 'production'
})
// result3 = {
//   enabled: false,
//   reason: 'default',      ← rule didn't match (environment condition failed)
// }
```

#### Tracking which rules use a segment (getSegmentUsage)

Before deleting or modifying a segment, check which flag rules reference it:

```ts
const usage = await rl.flags.getSegmentUsage('enterprise_users')
// Returns: [{ flagKey: 'advanced_analytics', ruleId: 'rule_xyz' }, ...]

if (usage.length > 0) {
  console.warn(`Segment is used by ${usage.length} rules:`)
  for (const u of usage) {
    console.warn(`  Flag: ${u.flagKey}, Rule: ${u.ruleId}`)
  }
}
```

The `getSegmentUsage()` implementation uses `conditionReferencesSegment()` which walks the condition tree and checks only `dimension: "segment"` leaves — it won't false-positive on a segment key that happens to appear in an unrelated string value.

#### Other dimensions the evaluator resolves

For comparison, here's how ALL dimensions are resolved from context — segments are just one of many:

| Dimension | Context field | Type | Example |
|-----------|--------------|------|---------|
| `environment` | `context.environment` | `string` | `'production'` |
| `userId` | `context.userId` | `string` | `'u_alice'` |
| `userType` | `context.userType` | `string` | `'enterprise'` |
| `region` | `context.region` | `string` | `'us'` |
| `version` | `context.version` | `string` (semver) | `'2.1.0'` |
| `ip` | `context.ip` | `string` | `'1.2.3.4'` |
| `tenantId` | `context.tenantId` | `string` | `'tenant_acme'` |
| `segment` | `context.segments` | `string[]` | `['enterprise_users', 'beta']` |
| `device` | `context.attributes?.device` | `string` | `'ios'` |
| `channel` | `context.attributes?.channel` | `string` | `'web'` |
| `attribute` | `context.attributes?.[key]` | `any` | custom values |
| _(custom)_ | `context.attributes?.[dimension]` | `any` | fallback lookup |

The key difference for segments: the evaluator checks against an **array** (`context.segments`), not a single value. That's why `op: "in"` is the correct operator — it checks array membership.

---

## 13. Rollouts & Releases

### Percentage rollout

```ts
await rl.flags.setRollout('new_checkout', {
  percentage: 25,    // 25% of users see it
  sticky: true,      // same user always gets same result
  hashKey: 'userId', // which context field to hash on
})

// Auto-ramp schedule
await rl.flags.setRollout('new_checkout', {
  percentage: 5,
  sticky: true,
  hashKey: 'userId',
  rampSchedule: [
    { at: '2026-06-01T00:00:00Z', percentage: 25 },
    { at: '2026-06-08T00:00:00Z', percentage: 50 },
    { at: '2026-06-15T00:00:00Z', percentage: 100 },
  ],
})
```

### Releases (atomic batches)

Bundle multiple flag changes into a single atomic operation:

```ts
// Create a release
const release = await rl.flags.createRelease({
  name: 'Checkout v2 Launch',
  environment: 'production',
  changes: [
    { flagKey: 'new_checkout', action: 'enable', value: true },
    { flagKey: 'old_checkout', action: 'kill' },
    { flagKey: 'checkout.animation', action: 'setValue', value: 'fade' },
    { flagKey: 'checkout.rollout', action: 'setRollout', rollout: { percentage: 100 } },
  ],
})

// Preview before deploying
const preview = await rl.flags.previewRelease(release.id)
// → [{ flagKey, before: { value, status }, after: { value, status } }, ...]

// Deploy (applies all changes atomically)
await rl.flags.deployRelease(release.id, { deployedBy: 'alice' })

// Rollback (reverses all changes)
await rl.flags.rollbackRelease(release.id, {
  rolledBackBy: 'alice',
  reason: 'error rate spike after deploy',
})
```

### Scheduled releases

```ts
const release = await rl.flags.createRelease({
  name: 'Feature launch at midnight',
  changes: [{ flagKey: 'new_feature', action: 'enable' }],
  scheduledAt: '2026-06-01T00:00:00Z',
})
// Release status → 'scheduled' (not yet deployed)
// At scheduledAt time, a cron job should call deployRelease()
```

---

## 13b. Flag Validation

The SDK validates flag configuration at creation time to prevent silent misconfiguration.

### Default value type validation

`create()` validates that `defaultValue` matches the flag `type`:

```ts
// ✅ Valid — boolean flag with boolean default
await rl.flags.create({ key: 'feature', type: 'boolean', defaultValue: false })

// ❌ Throws ValidationError — boolean flag with string default
await rl.flags.create({ key: 'feature', type: 'boolean', defaultValue: 'yes' })
// → "Boolean flag "feature" must have a boolean default value, got string"

// ❌ Throws ValidationError — number flag with string default
await rl.flags.create({ key: 'timeout', type: 'number', defaultValue: '30' })
// → "Number flag "timeout" must have a numeric default value, got string"
```

| Flag type | Required `defaultValue` type |
|-----------|---------------------------|
| `boolean` | `typeof defaultValue === "boolean"` |
| `number` | `typeof defaultValue === "number"` |
| `string` | `typeof defaultValue === "string"` |
| `json`, `multivariate`, `percentage` | Any (no type restriction) |

### Variant weight validation

Multivariate flags with variants must have weights summing to exactly 100:

```ts
// ✅ Valid — weights sum to 100
await rl.flags.create({
  key: 'experiment',
  type: 'multivariate',
  defaultValue: null,
  variants: [
    { key: 'control', value: 'A', weight: 30 },
    { key: 'treatment', value: 'B', weight: 70 },
  ],
})

// ❌ Throws ValidationError — weights sum to 90
await rl.flags.create({
  key: 'experiment',
  type: 'multivariate',
  defaultValue: null,
  variants: [
    { key: 'control', value: 'A', weight: 40 },
    { key: 'treatment', value: 'B', weight: 50 },
  ],
})
// → "Multivariate flag "experiment" variant weights must sum to 100, got 90"
```

---

## 14. Security Model

### Signed transport (Next.js)

The middleware signs the flag payload with HMAC-SHA256 using `ROLLEASE_SECRET`. The signature prevents tampering — a client cannot forge flag values. The envelope also has a timestamp and expires after 5 minutes to prevent replay attacks.

```
v2.<base64url({"v":2,"ts":1717000000000,"flags":{key:{value,variant,...},...}})>.<hmac-sha256>
```

The v2 envelope carries the full `DetailedFlagMap` (variant keys, reasons, rule IDs), unlike the legacy v1 format which only carried primitive values. Legacy v1 envelopes are still accepted for backwards compatibility.

### Regex safety

User-supplied regex patterns in targeting rules are validated before use:
- Length limit: 128 characters
- No backreferences (`\1`, `\k<name>`)
- No lookaheads/lookbehinds (`(?=...)`, `(?!...)`)
- No nested quantifiers (ReDoS prevention)
- No range quantifiers > 1000

### Condition safety

Condition groups are validated before storage:
- Maximum depth: 12 levels
- Maximum nodes: 100 total conditions

### Secret requirements

- `secret` must be at least 16 characters
- Store it in environment variables, never in code
- Rotate it by deploying a new value (existing signed envelopes expire within 5 minutes)

---

## 15. Roadmap & Cross-References

Several capabilities listed as "future work" in early drafts of this guide have since **shipped**. They each have a dedicated guide:

| Capability | Status | Where |
|------------|--------|-------|
| **Universal HTTP handler / Admin REST API** | ✅ Shipped | `rl.createHandler()` — see [HTTP API Reference](http-api.md) |
| **Browser client SDK (SPAs without SSR)** | ✅ Shipped | `createRolleaseClient()` (`rollease/client`) — see [Client & Server](client-server.md) |
| **Real-time updates (SSE)** | ✅ Shipped | `GET /api/rollease/flags/stream` + `rl.flags.onChange()` |
| **Cross-process cache invalidation (pub/sub)** | ✅ Shipped | `config.invalidation` with `RedisInvalidationBus` |
| **Impression tracking in the eval path** | ✅ Shipped | Automatic; configure via `config.impressions` |
| **OpenTelemetry tracing** | ✅ Shipped | `config.telemetry` + `createOtelAdapter()` — see [Observability](observability.md) |
| **Prometheus metrics** | ✅ Shipped | `config.metrics` + `createPrometheusAdapter()` — see [Observability](observability.md) |
| **RBAC for management APIs** | ✅ Shipped | `createDefaultRBACPolicy` / `createRBACHook` — see [RBAC](rbac.md) |
| **Per-environment default values** | ✅ Shipped | `environmentDefaults` on `create()` / `update()` |
| **OpenFeature provider** | ✅ Shipped | `createRolleaseProvider()` — see [OpenFeature](openfeature.md) |
| **Config export / diff / promote** | ✅ Shipped | `rollease/sync` — see [Configuration Sync](sync.md) |
| **A/B stats (p-values, CIs, bandits)** | ✅ Shipped | `rollease/stats` — see [Statistics Engine](stats.md) |
| **Cloudflare KV / D1 adapters** | ✅ Shipped | `rollease/db/cloudflare-kv`, `rollease/db/cloudflare-d1` — see [Cloudflare](cloudflare.md) |

### Real-time updates — current shape

```ts
// Server: any mutation fires onChange (in-process) and, when an
// InvalidationBus is configured, propagates to other replicas.
const unsubscribe = rl.flags.onChange((e) => console.log(e.action, e.flagKey))

// Browser: subscribe to the SSE endpoint exposed by the handler.
const es = new EventSource('/api/rollease/flags/stream')
es.onmessage = (msg) => {
  const { flags } = JSON.parse(msg.data) // re-pushed on every change
}
```

### Still on the roadmap

- **Built-in GeoIP auto-resolution.** `GeoIPAdapter`/`GeoContext` types exist; today you resolve IP → region inside an `onBeforeEvaluation` hook. A first-class `config.geoip` that auto-enriches context is not yet wired.
- **`useExperiment` React hook.** Server-side experiment plumbing ships as `createExperimentHooks` + `config.analyticsSink`; a React `useExperiment(key)` convenience hook that auto-tracks exposure/conversion is still planned.
- **CLI (`npx rollease …`).** Flag management from the terminal is not yet built — use the HTTP API or call `rl.flags.*` from a script.

---

## Quick Reference

### Evaluation (server)

```ts
const enabled = await rl.flags.isEnabled('key', context)
const value = await rl.flags.getValue<string>('key', context)
const variant = await rl.flags.getVariant('key', context)
const result = await rl.flags.evaluate('key', context)   // FlagResult
const all = await rl.flags.evaluateAll(context)          // FlagMap
const detailed = await rl.flags.evaluateAllDetailed(context)  // DetailedFlagMap
```

### Flag management

```ts
await rl.flags.create({ key, type, defaultValue })
await rl.flags.update(key, patch)
await rl.flags.kill(key)
await rl.flags.archive(key)
await rl.flags.restore(key)
await rl.flags.delete(key, { confirm: true })
await rl.flags.clone(key, { newKey, includeRules: true })
await rl.flags.getHistory(key)
```

### Rules

```ts
await rl.flags.addRule(flagKey, { priority, value, conditions })
await rl.flags.updateRule(flagKey, ruleId, patch)
await rl.flags.removeRule(flagKey, ruleId)
await rl.flags.listRules(flagKey)
await rl.flags.reorderRules(flagKey, [{ ruleId, priority }])
```

### React hooks

```tsx
const { enabled } = useFlag('key')
const { variant } = useVariant('key')
const flags = useFlags()
const details = useFlagDetails('key')
```

### Next.js

```ts
// middleware.ts
export default rolleaseMiddleware(rl, { userIdExtractor, flagContext })

// RSC / Server Component
const flag = await getFlag('key', defaultValue)
const flags = await getAllFlags()
```

### Error types

```ts
FlagNotFoundError   // 404 — flag key doesn't exist
FlagLockedError     // 423 — flag is locked
FlagConflictError   // 409 — duplicate key
ValidationError     // 422 — invalid input
ReleaseConflictError // 409 — release conflict
RuleNotFoundError    // 404 — rule not found
SegmentNotFoundError // 404 — segment not found
ReleaseNotFoundError // 404 — release not found
RolleaseInternalError // 500 — unexpected internal error
```

All extend `RolleaseError` with `.statusCode`, `.code`, `.meta`, `.toJSON()`.
