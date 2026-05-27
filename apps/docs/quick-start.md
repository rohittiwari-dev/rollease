# Rollease SDK — Quick Start

> Get up and running with Rollease in under 5 minutes.

---

## Installation

```bash
npm install rollease
```

---

## 1. Create Your First Flag (In-Memory — Dev/Test)

```ts
import { createRollease, createMemoryAdapter } from 'rollease'

const rl = createRollease({
  db: createMemoryAdapter(),
  secret: 'my-dev-secret-at-least-16-chars',
})

// Create a boolean flag
await rl.flags.create({
  key: 'new_checkout',
  type: 'boolean',
  defaultValue: false,
  description: 'Enable the new checkout flow',
})

// Evaluate it
const enabled = await rl.flags.isEnabled('new_checkout', {
  userId: 'user_123',
  environment: 'development',
})
console.log('New checkout enabled:', enabled) // → false
```

---

## 2. Add Targeting Rules

```ts
// Enable for beta users only
await rl.flags.addRule('new_checkout', {
  name: 'Beta users',
  priority: 1,
  value: true,
  conditions: {
    all: [
      { dimension: 'userType', op: 'in', value: ['beta', 'internal'] },
    ],
  },
})

// Beta user → true
await rl.flags.isEnabled('new_checkout', { userId: 'u1', userType: 'beta' })
// → true

// Regular user → false
await rl.flags.isEnabled('new_checkout', { userId: 'u2', userType: 'free' })
// → false
```

---

## 3. Add Percentage Rollout

```ts
// Roll out to 25% of users
await rl.flags.setRollout('new_checkout', {
  percentage: 25,
  sticky: true,      // same user always gets same result
  hashKey: 'userId',
})

// User gets consistent true/false based on hash bucket
await rl.flags.isEnabled('new_checkout', { userId: 'user_123' })
```

---

## 4. Use with React

```tsx
// Server: evaluate all flags
const flags = await rl.flags.evaluateAll({ userId: user.id })

// Pass to React
import { RolleaseProvider, useFlag, FeatureGate } from 'rollease/react'

function App({ flags }) {
  return (
    <RolleaseProvider initialFlags={flags}>
      <Dashboard />
    </RolleaseProvider>
  )
}

function Dashboard() {
  const { enabled } = useFlag('new_checkout')

  return (
    <div>
      {enabled ? <NewCheckout /> : <OldCheckout />}

      <FeatureGate flag="dark_mode" fallback={<LightTheme />}>
        <DarkTheme />
      </FeatureGate>
    </div>
  )
}
```

---

## 5. Kill Switch (Emergency Off)

```ts
// Instantly disable a flag for all users
await rl.flags.kill('new_checkout', {
  reason: 'Payment errors spiking',
  killedBy: 'oncall-alice',
})

// All evaluations now return false
await rl.flags.isEnabled('new_checkout', { userId: 'anyone' })
// → false

// Kill ALL flags (incident response)
await rl.flags.killAll({ reason: 'Production incident' })

// Restore when fixed
await rl.flags.restore('new_checkout')
```

---

## 6. Connect a Real Database (Prisma)

```ts
import { createRollease } from 'rollease'
import { createPrismaAdapter } from 'rollease/db/prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const rl = createRollease({
  db: createPrismaAdapter({ prisma }),
  secret: process.env.ROLLEASE_SECRET!,
  cache: {
    driver: 'redis',
    redis: { url: process.env.REDIS_URL! },
    ttl: 60,
  },
  autoResolveSegments: true, // auto-evaluate segment definitions
})

// Don't forget to close on shutdown
process.on('SIGTERM', () => rl.close())
```

---

## 7. Local Developer Overrides

Create `.rolleaserc.json` in your project root:

```json
{
  "new_checkout": true,
  "exp.pricing": "variant_b",
  "dark_mode": true
}
```

These overrides bypass all rules and rollouts during development. Add to `.gitignore`:

```
.rolleaserc.json
```

---

## Next Steps

| Guide | What you'll learn |
|-------|-------------------|
| [Developer Guide](developer-guide.md) | Full architecture, Next.js integration, all features |
| [API Reference](api-reference.md) | Every method, parameter, and return type |
| [Error Handling](error-handling.md) | Error classes, best practices, API route patterns |
| [Testing Guide](testing-guide.md) | Unit testing, React testing, mock patterns |
| [Architecture](architecture.md) | Internal design, evaluation pipeline, security model |
| [Prisma & Drizzle Examples](prisma-drizzle-examples.md) | ORM adapter setup |
| [Sequelize & Redis Examples](sequelize-redis-examples.md) | Sequelize + Redis cache setup |

---

## Flag Types

| Type | defaultValue | Use case |
|------|-------------|----------|
| `boolean` | `true` / `false` | Feature gates, kill switches |
| `string` | `'dark'` / `'light'` | Config values, theme selection |
| `number` | `3` / `0.5` | Numeric config (retry counts, timeouts) |
| `json` | `{ theme: 'dark' }` | Complex config objects |
| `multivariate` | `null` | A/B testing with weighted variants |
| `percentage` | `false` | Gradual rollouts |

---

## Context Fields

Pass any relevant user/request context to evaluation:

```ts
await rl.flags.isEnabled('my_flag', {
  userId: 'u_alice',              // Required for rollouts & targeting
  environment: 'production',      // 'dev' | 'staging' | 'production'
  version: '2.1.0',              // App version for semver targeting
  region: 'us',                  // Geographic region
  userType: 'beta',              // User cohort
  segments: ['power_users'],     // Pre-resolved segments
  attributes: {                  // Arbitrary custom attributes
    plan: 'enterprise',
    company_size: 500,
  },
  tenantId: 'tenant_acme',      // Multi-tenant isolation
  ip: '1.2.3.4',               // For GeoIP resolution
})
```
