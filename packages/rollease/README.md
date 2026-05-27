# Rollease SDK

A production-grade, database-backed, multi-environment feature flag SDK for Node.js, React, and Next.js. Supports percentage-based rollouts, sticky user assignments, custom rule-based user segments, geo-targeting, multi-layer caching, local development overrides, and goal conversion tracking.

---

## Installation

Install the Rollease core package. Install additional database and cache adapters depending on your setup.

```bash
# Core SDK
npm install rollease

# Optional durable storage/cache adapters
npm install sequelize pg redis
npm install @prisma/client drizzle-orm redis

# If using Bun
bun add rollease

# If using pnpm
pnpm add rollease
```

---

## 1. Quickstart (In-Memory Development)

For local development or testing, use the built-in in-memory adapters:

```typescript
import { createRollease, createMemoryAdapter } from "rollease";

const db = createMemoryAdapter();

const rollease = createRollease({
  db,
  secret: process.env.ROLLEASE_SECRET ?? "dev-secret-change-me-now"
});

await rollease.flags.create({
  key: "new-dashboard",
  type: "boolean",
  defaultValue: false,
  description: "New application dashboard layout",
  rollout: { percentage: 50, sticky: true, hashKey: "userId" }
});

const enabled = await rollease.flags.isEnabled("new-dashboard", {
  userId: "user-999"
});

console.log(enabled); // true or false, consistently hashed by userId
```

---

## 2. Server Initialization (Production PostgreSQL & Redis)

For production environments, pass your durable `DbAdapter` and optionally enable shared cache. Under the hood, Rollease is designed for a multi-layered cache cascade:
- **L1 Cache**: In-process memory cache with a default 5-second TTL (prevents network calls on rapid evaluations in a single request).
- **L2 Cache**: Redis cache with a default 30-second TTL (shared cache across web app instances).
- **L3 DB**: PostgreSQL database (source of truth).

```typescript
import {
  createRollease,
  createSequelizeAdapter,
  createRedisCache
} from "rollease";
import { Sequelize } from "sequelize";

const sequelize = new Sequelize(process.env.DATABASE_URL!, {
  dialect: "postgres",
  logging: false
});

export const rollease = createRollease({
  db: createSequelizeAdapter({
    sequelize,
    tablePrefix: "rollease_",
    sync: false
  }),
  secret: process.env.ROLLEASE_SECRET!,
  cache: {
    driver: "redis",
    redis: { url: process.env.REDIS_URL! },
    ttl: 60
  },
  l1TtlMs: 5000,
  localOverrides: process.env.NODE_ENV === "development"
});

// You can also pass a Redis cache adapter directly into FlagManager:
const redisCache = createRedisCache({ url: process.env.REDIS_URL });
```

---

### 2.1 Prisma and Drizzle Adapters

Use Prisma when your Rollease tables are part of your Prisma schema:

```typescript
import { PrismaClient } from "@prisma/client";
import { createPrismaAdapter, createRollease } from "rollease";

const prisma = new PrismaClient();

export const rollease = createRollease({
  db: createPrismaAdapter({
    prisma,
    validateModelFields: true,
    disconnectOnClose: false
  }),
  secret: process.env.ROLLEASE_SECRET!
});
```

Use Drizzle by passing your table objects and helpers:

```typescript
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "./db";
import * as tables from "./rollease-schema";
import { createDrizzleAdapter, createRollease } from "rollease";

export const rollease = createRollease({
  db: createDrizzleAdapter({
    db,
    tables: {
      Flag: tables.rolleaseFlags,
      Rule: tables.rolleaseRules,
      Segment: tables.rolleaseSegments,
      Release: tables.rolleaseReleases,
      Assignment: tables.rolleaseAssignments,
      History: tables.rolleaseHistory,
      Impression: tables.rolleaseImpressions
    },
    helpers: { eq, and, asc, desc }
  }),
  secret: process.env.ROLLEASE_SECRET!
});
```

Both adapters expose required field lists for schema checks:
`ROLLEASE_PRISMA_REQUIRED_FIELDS` and `ROLLEASE_DRIZZLE_REQUIRED_COLUMNS`.

---

## 3. Flag Types & Targetings

### 3.1 Boolean Flag (On/Off)

```typescript
const isNewCheckout = await rollease.flags.isEnabled("new-checkout", {
  userId: "user_102",
  userType: "standard"
});

if (isNewCheckout) {
  // Render new checkout flow
}
```

### 3.2 Multivariate / A/B Test Flag

For multivariate flags, specify the type parameter to get typed results. The variant key is returned under `variant`, and the corresponding variant value is returned under `value`:

```typescript
const ctaFlag = await rollease.flags.getVariant("checkout-cta", {
  userId: "user_505"
});

console.log(ctaFlag.key);     // "control" | "treatment_a" | "treatment_b"
console.log(ctaFlag.value);   // "Buy Now" | "Get Started" | "Claim Offer"
```

### 3.3 Custom User Segment Targeting

Target users dynamically using environment parameters and custom attribute rule segments.

```typescript
const result = await rollease.flags.getValue("regional-discount", {
  userId: "user_707",
  userType: "beta",
  region: "IN",
  attributes: {
    plan: "enterprise",
    signUpYear: 2025
  }
});
```

Supported rule operators:
- `eq` | `neq`
- `in` | `nin` (expects arrays of values)
- `contains` | `startsWith` | `endsWith`
- `regex` (safe-pattern checked before evaluation)
- `gt` | `gte` | `lt` | `lte`
- `semverGte` | `semverLte`
- `exists` | `dateAfter` | `dateBefore`

---

## 4. Local Development Overrides

Speed up development by overriding flag values locally without updating the database. Create a file called `.rolleaserc.json` in your project root:

```json
{
  "new-dashboard": true,
  "checkout-cta": "treatment_a",
  "rate-limits": { "requests": 50000, "windowMs": 60000 }
}
```

*Make sure to add `.rolleaserc.json` to your `.gitignore` file.*

---

## 5. React Integration

Bootstrap evaluated flag values from the server into your React client application using the context provider to ensure zero page flicker and no loading waterfalls.

```tsx
// src/App.tsx
import React from "react";
import { RolleaseProvider, useFlag, useVariant } from "rollease/react";

// 'bootstrapFlags' is pre-evaluated and serialized from your server
const bootstrapFlags = {
  "new-dashboard": {
    key: "new-dashboard",
    value: true,
    variant: null,
    enabled: true,
    reason: "percentage",
    ruleId: null,
    evaluatedAt: new Date()
  }
};

export default function App() {
  return (
    <RolleaseProvider initialFlags={bootstrapFlags}>
      <Dashboard />
    </RolleaseProvider>
  );
}

function Dashboard() {
  const newDash = useFlag("new-dashboard");
  const ctaVariant = useVariant("checkout-cta");

  return (
    <div>
      {newDash.enabled ? <h1>New Dashboard</h1> : <h1>Old Dashboard</h1>}
      <button>Variant: {ctaVariant.variant?.key ?? "default"}</button>
    </div>
  );
}
```

---

## 6. Next.js App Router Integration

Evaluate flags in Next.js Middleware and access them instantly inside Server Components (RSC) and Client Components with zero latency.

### 6.1 Middleware Setup

Evaluate flags at the edge and inject a signed flag envelope into request headers and cookies. The signature prevents forged request headers or cookies from enabling server-side flags.

```typescript
// middleware.ts
import { rolleaseMiddleware } from "rollease/next";
import { rollease } from "@/lib/rollease";

export const middleware = rolleaseMiddleware(rollease, {
  userIdExtractor: (req) => req.cookies.get("userId")?.value || "guest",
  flagContext: (req) => ({
    environment: process.env.NODE_ENV,
    attributes: {
      device: req.headers.get("user-agent") || "unknown"
    }
  }),
  flags: ["new-navigation", "sidebar-redesign"]
});

export const config = {
  matcher: ["/dashboard/:path*", "/checkout/:path*"]
};
```

### 6.2 Reading Flags in Server Components (RSC)

RSC reads injected flags from headers/cookies in `O(1)` memory access time:

```tsx
// app/dashboard/page.tsx
import { getFlag } from "rollease/next";

export default async function DashboardPage() {
  const showNav = await getFlag<boolean>("new-navigation", false);

  return (
    <div>
      {showNav.value ? <NewNav /> : <LegacyNav />}
      <MainContent />
    </div>
  );
}
```

---

## 7. PostgreSQL Database Schema

To set up the database tables in your PostgreSQL database, run the following SQL script. By default, tables are prefixed with `rollease_`. You can customize this prefix during `PostgresAdapter` initialization.

```sql
-- 1. Organizations
CREATE TABLE rollease_orgs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  plan       TEXT DEFAULT 'free',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Environments
CREATE TABLE rollease_environments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID REFERENCES rollease_orgs(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL, -- 'development' | 'staging' | 'production'
  name       TEXT NOT NULL,
  is_default BOOLEAN DEFAULT false,
  color      TEXT,
  UNIQUE(org_id, slug)
);

-- 3. Flag definitions
CREATE TABLE rollease_flags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES rollease_orgs(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  type        TEXT NOT NULL, -- 'boolean' | 'string' | 'number' | 'json' | 'multivariate'
  description TEXT,
  namespace   TEXT,
  parent_id   UUID REFERENCES rollease_flags(id),
  tags        TEXT[],
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, key)
);

-- 4. Flag configuration per environment
CREATE TABLE rollease_flag_configs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id        UUID REFERENCES rollease_flags(id) ON DELETE CASCADE,
  env_id         UUID REFERENCES rollease_environments(id) ON DELETE CASCADE,
  enabled        BOOLEAN DEFAULT false,
  kill_switched  BOOLEAN DEFAULT false,
  locked         BOOLEAN DEFAULT false,
  default_value  JSONB NOT NULL,
  rollout_pct    SMALLINT DEFAULT 0,
  expires_at     TIMESTAMPTZ,
  scheduled_at   TIMESTAMPTZ,
  version        INTEGER DEFAULT 1,
  updated_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE(flag_id, env_id)
);

-- 5. Variants (for Multivariate A/B tests)
CREATE TABLE rollease_variants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id   UUID REFERENCES rollease_flag_configs(id) ON DELETE CASCADE,
  key         TEXT NOT NULL, -- 'control' | 'treatment_a'
  value       JSONB NOT NULL,
  weight      SMALLINT DEFAULT 0, -- Weight 0-100 (sum must equal 100)
  description TEXT
);

-- 6. Targeting Rules
CREATE TABLE rollease_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id   UUID REFERENCES rollease_flag_configs(id) ON DELETE CASCADE,
  priority    SMALLINT NOT NULL,
  name        TEXT,
  user_types  TEXT[], -- ['internal', 'beta', 'standard']
  segments    JSONB,  -- [{ "attribute": "plan", "operator": "equals", "value": "enterprise" }]
  regions     TEXT[], -- ['IN', 'US']
  user_ids    TEXT[], -- whitelisted user IDs
  exclude_ids TEXT[], -- blacklisted user IDs
  rollout_pct SMALLINT, -- Rule-level rollout % (0-100)
  variant_id  UUID REFERENCES rollease_variants(id),
  is_holdout  BOOLEAN DEFAULT false,
  enabled     BOOLEAN DEFAULT true
);

-- 7. Sticky User Assignments
CREATE TABLE rollease_assignments (
  flag_id     UUID REFERENCES rollease_flags(id) ON DELETE CASCADE,
  env_id      UUID REFERENCES rollease_environments(id),
  user_id     TEXT NOT NULL,
  variant_id  UUID REFERENCES rollease_variants(id),
  reason      TEXT,
  assigned_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY(flag_id, env_id, user_id)
);

-- 8. Impression Logs (Evaluation Events)
CREATE TABLE rollease_impressions (
  id          BIGSERIAL PRIMARY KEY,
  flag_id     UUID REFERENCES rollease_flags(id) ON DELETE CASCADE,
  env_id      UUID REFERENCES rollease_environments(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  variant_key TEXT,
  reason      TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- 9. Conversions & Audit Logs
CREATE TABLE rollease_audit_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action     TEXT NOT NULL, -- 'flag.create', 'conversion', etc.
  diff       JSONB,
  meta       JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create optimization indexes
CREATE INDEX ON rollease_flags(org_id, key);
CREATE INDEX ON rollease_flag_configs(flag_id, env_id);
CREATE INDEX ON rollease_rules(config_id, priority);
CREATE INDEX ON rollease_variants(config_id);
CREATE INDEX ON rollease_assignments(flag_id, env_id, user_id);
```
