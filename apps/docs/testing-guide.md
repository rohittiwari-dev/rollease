# Rollease SDK — Testing Guide

> **Package:** `rollease`  
> **Last updated:** 2026-05-27

This guide covers how to test feature flag logic in your application, write unit tests for flag-dependent code, and test custom database adapters.

---

## Table of Contents

1. [Testing with MemoryDbAdapter](#1-testing-with-memorydbadapter)
2. [Unit Testing Flag-Dependent Code](#2-unit-testing-flag-dependent-code)
3. [Testing Targeting Rules](#3-testing-targeting-rules)
4. [Testing Multivariate Flags & Variants](#4-testing-multivariate-flags--variants)
5. [Testing Rollouts & Percentages](#5-testing-rollouts--percentages)
6. [Testing the Evaluation Pipeline Directly](#6-testing-the-evaluation-pipeline-directly)
7. [Testing Releases & Rollbacks](#7-testing-releases--rollbacks)
8. [Testing React Components](#8-testing-react-components)
9. [Testing Next.js Integration](#9-testing-nextjs-integration)
10. [Testing Custom Database Adapters](#10-testing-custom-database-adapters)
11. [Testing Hooks & RBAC](#11-testing-hooks--rbac)
12. [Mocking & Spying](#12-mocking--spying)
13. [Test Configuration](#13-test-configuration)

---

## 1. Testing with MemoryDbAdapter

`MemoryDbAdapter` is the recommended adapter for all tests. It runs entirely in-process with no external dependencies.

```ts
import { describe, it, expect } from 'vitest'
import { FlagManager } from 'rollease'
import { MemoryDbAdapter } from 'rollease/db/memory'

describe('My Feature', () => {
  it('should use the new checkout when flag is enabled', async () => {
    // Fresh adapter per test — no shared state
    const db = new MemoryDbAdapter()
    const manager = new FlagManager({ db })

    await manager.create({
      key: 'new_checkout',
      type: 'boolean',
      defaultValue: false,
    })

    // Flag is off by default
    expect(await manager.isEnabled('new_checkout', { userId: 'u1' })).toBe(false)

    // Update flag
    await manager.update('new_checkout', { defaultValue: true })
    expect(await manager.isEnabled('new_checkout', { userId: 'u1' })).toBe(true)
  })
})
```

> **Important:** Always create a fresh `MemoryDbAdapter` per test to ensure test isolation. Never share adapter instances between tests.

---

## 2. Unit Testing Flag-Dependent Code

### Pattern: Inject the flag manager

```ts
// checkout.ts
export class CheckoutService {
  constructor(private flagManager: FlagManager) {}

  async getCheckoutFlow(userId: string): Promise<'v1' | 'v2'> {
    const enabled = await this.flagManager.isEnabled('new_checkout', { userId })
    return enabled ? 'v2' : 'v1'
  }
}
```

```ts
// checkout.test.ts
import { describe, it, expect } from 'vitest'
import { FlagManager, MemoryDbAdapter } from 'rollease'
import { CheckoutService } from './checkout'

describe('CheckoutService', () => {
  it('returns v2 flow when flag is enabled', async () => {
    const db = new MemoryDbAdapter()
    const manager = new FlagManager({ db })
    await manager.create({ key: 'new_checkout', type: 'boolean', defaultValue: true })

    const service = new CheckoutService(manager)
    expect(await service.getCheckoutFlow('u1')).toBe('v2')
  })

  it('returns v1 flow when flag is disabled', async () => {
    const db = new MemoryDbAdapter()
    const manager = new FlagManager({ db })
    await manager.create({ key: 'new_checkout', type: 'boolean', defaultValue: false })

    const service = new CheckoutService(manager)
    expect(await service.getCheckoutFlow('u1')).toBe('v1')
  })

  it('returns v1 when flag is killed', async () => {
    const db = new MemoryDbAdapter()
    const manager = new FlagManager({ db })
    await manager.create({ key: 'new_checkout', type: 'boolean', defaultValue: true })
    await manager.kill('new_checkout')

    const service = new CheckoutService(manager)
    expect(await service.getCheckoutFlow('u1')).toBe('v1')
  })
})
```

---

## 3. Testing Targeting Rules

```ts
import { describe, it, expect } from 'vitest'
import { FlagManager, MemoryDbAdapter } from 'rollease'

describe('Targeting Rules', () => {
  it('enables flag for beta users only', async () => {
    const db = new MemoryDbAdapter()
    const manager = new FlagManager({ db })

    await manager.create({ key: 'feature', type: 'boolean', defaultValue: false })

    await manager.addRule('feature', {
      priority: 1,
      value: true,
      conditions: {
        all: [
          { dimension: 'userType', op: 'eq', value: 'beta' },
        ],
      },
    })

    // Beta user → enabled
    expect(await manager.isEnabled('feature', {
      userId: 'u1',
      userType: 'beta',
    })).toBe(true)

    // Regular user → disabled
    expect(await manager.isEnabled('feature', {
      userId: 'u2',
      userType: 'free',
    })).toBe(false)
  })

  it('supports complex AND/OR/NOT conditions', async () => {
    const db = new MemoryDbAdapter()
    const manager = new FlagManager({ db })

    await manager.create({ key: 'premium', type: 'boolean', defaultValue: false })

    await manager.addRule('premium', {
      priority: 1,
      value: true,
      conditions: {
        all: [
          { dimension: 'environment', op: 'eq', value: 'production' },
          {
            any: [
              { dimension: 'userType', op: 'eq', value: 'enterprise' },
              { dimension: 'userType', op: 'eq', value: 'pro' },
            ],
          },
          {
            none: [
              { dimension: 'region', op: 'eq', value: 'cn' },
            ],
          },
        ],
      },
    })

    // Enterprise user in production, US → enabled
    expect(await manager.isEnabled('premium', {
      userId: 'u1', environment: 'production', userType: 'enterprise', region: 'us',
    })).toBe(true)

    // Enterprise user in staging → disabled (wrong environment)
    expect(await manager.isEnabled('premium', {
      userId: 'u1', environment: 'staging', userType: 'enterprise', region: 'us',
    })).toBe(false)

    // Enterprise user in CN → disabled (excluded region)
    expect(await manager.isEnabled('premium', {
      userId: 'u1', environment: 'production', userType: 'enterprise', region: 'cn',
    })).toBe(false)
  })

  it('evaluates rules by priority order (lowest first)', async () => {
    const db = new MemoryDbAdapter()
    const manager = new FlagManager({ db })

    await manager.create({ key: 'theme', type: 'string', defaultValue: 'light' })

    // Priority 2 — catch-all
    await manager.addRule('theme', {
      priority: 2,
      value: 'dark',
      conditions: {},
    })

    // Priority 1 — beta override (evaluated first)
    await manager.addRule('theme', {
      priority: 1,
      value: 'neon',
      conditions: {
        all: [{ dimension: 'userType', op: 'eq', value: 'beta' }],
      },
    })

    // Beta user → neon (priority 1 wins)
    expect(await manager.getValue('theme', {
      userId: 'u1', userType: 'beta',
    })).toBe('neon')

    // Regular user → dark (priority 2 catch-all)
    expect(await manager.getValue('theme', {
      userId: 'u2', userType: 'free',
    })).toBe('dark')
  })
})
```

---

## 4. Testing Multivariate Flags & Variants

```ts
describe('Multivariate Flags', () => {
  it('returns weighted variant based on user bucket', async () => {
    const db = new MemoryDbAdapter()
    const manager = new FlagManager({ db })

    await manager.create({
      key: 'exp.pricing',
      type: 'multivariate',
      defaultValue: null,
      variants: [
        { key: 'control', value: { price: 29.99 }, weight: 50 },
        { key: 'variant_a', value: { price: 39.99 }, weight: 25 },
        { key: 'variant_b', value: { price: 49.99 }, weight: 25 },
      ],
    })

    const variant = await manager.getVariant('exp.pricing', { userId: 'u_alice' })
    expect(variant.key).toBeDefined()
    expect(['control', 'variant_a', 'variant_b']).toContain(variant.key)

    // Same user → same variant (sticky bucketing)
    const variant2 = await manager.getVariant('exp.pricing', { userId: 'u_alice' })
    expect(variant2.key).toBe(variant.key)
  })
})
```

---

## 5. Testing Rollouts & Percentages

### Testing with getBucket()

Use `getBucket()` to understand which bucket a user falls into:

```ts
import { getBucket } from 'rollease'

describe('Percentage Rollout', () => {
  it('enables flag for users within rollout percentage', async () => {
    const db = new MemoryDbAdapter()
    const manager = new FlagManager({ db })

    await manager.create({
      key: 'gradual_release',
      type: 'boolean',
      defaultValue: false,
      rollout: { percentage: 50, sticky: true, hashKey: 'userId' },
    })

    // Find a user who falls in the 0-49 bucket (within 50% rollout)
    let inUser: string | null = null
    let outUser: string | null = null
    for (let i = 0; i < 200; i++) {
      const userId = `user_${i}`
      const bucket = getBucket(userId, 'gradual_release')
      if (bucket < 50 && !inUser) inUser = userId
      if (bucket >= 50 && !outUser) outUser = userId
      if (inUser && outUser) break
    }

    expect(await manager.isEnabled('gradual_release', { userId: inUser! })).toBe(true)
    expect(await manager.isEnabled('gradual_release', { userId: outUser! })).toBe(false)
  })

  it('verifies bucketing consistency', () => {
    // Same inputs → same bucket (deterministic)
    const bucket1 = getBucket('user_123', 'my_flag')
    const bucket2 = getBucket('user_123', 'my_flag')
    expect(bucket1).toBe(bucket2)

    // Different users → (likely) different buckets
    const bucketA = getBucket('user_a', 'my_flag')
    const bucketB = getBucket('user_b', 'my_flag')
    // Not guaranteed to differ, but statistically very likely for different inputs
    expect(typeof bucketA).toBe('number')
    expect(bucketA).toBeGreaterThanOrEqual(0)
    expect(bucketA).toBeLessThanOrEqual(99)
  })
})
```

---

## 6. Testing the Evaluation Pipeline Directly

For unit testing evaluation logic without any DB layer, use `evaluateFlag()` directly:

```ts
import { evaluateFlag } from 'rollease'
import type { Flag, FlagRule } from 'rollease'

describe('evaluateFlag() — pure function', () => {
  const baseFlag: Flag = {
    id: 'f1',
    key: 'test',
    type: 'boolean',
    status: 'active',
    defaultValue: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  it('returns kill_switch reason for killed flags', () => {
    const result = evaluateFlag({ ...baseFlag, status: 'killed' }, {})
    expect(result.enabled).toBe(false)
    expect(result.reason).toBe('kill_switch')
  })

  it('respects date windows', () => {
    const future = new Date('2099-01-01')
    const result = evaluateFlag(
      { ...baseFlag, scheduledAt: future },
      {},
      { now: new Date() }
    )
    expect(result.reason).toBe('not_scheduled')
  })

  it('applies local override', () => {
    const result = evaluateFlag(baseFlag, {}, { localOverride: true })
    expect(result.value).toBe(true)
    expect(result.reason).toBe('override')
  })

  it('evaluates rules by priority', () => {
    const rules: FlagRule[] = [
      {
        id: 'r1', flagKey: 'test', priority: 1, value: true, enabled: true,
        conditions: { all: [{ dimension: 'userType', op: 'eq', value: 'beta' }] },
      },
    ]

    const result = evaluateFlag(baseFlag, { userType: 'beta' }, { rules })
    expect(result.value).toBe(true)
    expect(result.reason).toBe('rule_match')
    expect(result.ruleId).toBe('r1')
  })

  it('falls through to default when no rules match', () => {
    const result = evaluateFlag(baseFlag, { userType: 'free' })
    expect(result.value).toBe(false)
    expect(result.reason).toBe('default')
  })
})
```

---

## 7. Testing Releases & Rollbacks

```ts
describe('Releases', () => {
  it('deploys and rolls back atomically', async () => {
    const db = new MemoryDbAdapter()
    const manager = new FlagManager({ db })

    await manager.create({ key: 'feat_a', type: 'boolean', defaultValue: false })
    await manager.create({ key: 'feat_b', type: 'string', defaultValue: 'v1' })

    const release = await manager.createRelease({
      name: 'Big Launch',
      changes: [
        { flagKey: 'feat_a', action: 'enable' },
        { flagKey: 'feat_b', action: 'setValue', value: 'v2' },
      ],
    })

    // Preview before deploying
    const preview = await manager.previewRelease(release.id)
    expect(preview).toHaveLength(2)

    // Deploy
    await manager.deployRelease(release.id)
    expect(await manager.isEnabled('feat_a', {})).toBe(true)
    expect(await manager.getValue('feat_b', {})).toBe('v2')

    // Rollback — restores original values
    await manager.rollbackRelease(release.id)
    expect((await manager.get('feat_a')).status).toBe('active')
    expect((await manager.get('feat_b')).defaultValue).toBe('v1')
  })
})
```

---

## 8. Testing React Components

### Testing hooks with RolleaseProvider

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RolleaseProvider, useFlag, FeatureGate } from 'rollease/react'

function TestComponent() {
  const { enabled } = useFlag('new_checkout')
  return <div>{enabled ? 'v2' : 'v1'}</div>
}

describe('React Integration', () => {
  it('reads flags from provider', () => {
    render(
      <RolleaseProvider initialFlags={{ new_checkout: true }}>
        <TestComponent />
      </RolleaseProvider>
    )
    expect(screen.getByText('v2')).toBeDefined()
  })

  it('renders fallback when flag is disabled', () => {
    render(
      <RolleaseProvider initialFlags={{ premium: false }}>
        <FeatureGate flag="premium" fallback={<span>Upgrade required</span>}>
          <span>Premium content</span>
        </FeatureGate>
      </RolleaseProvider>
    )
    expect(screen.getByText('Upgrade required')).toBeDefined()
  })

  it('throws when hooks used outside provider', () => {
    expect(() => {
      render(<TestComponent />)
    }).toThrow('Rollease hooks must be used within a <RolleaseProvider>')
  })
})
```

### Testing with DetailedFlagMap

```tsx
import type { FlagResult } from 'rollease'

const detailedFlags: Record<string, FlagResult> = {
  'exp.pricing': {
    key: 'exp.pricing',
    value: { price: 49.99 },
    variant: 'variant_b',
    enabled: true,
    reason: 'weighted_random',
    ruleId: null,
    evaluatedAt: new Date(),
  },
}

render(
  <RolleaseProvider initialFlags={detailedFlags}>
    <PricingComponent />
  </RolleaseProvider>
)
```

---

## 9. Testing Next.js Integration

### Testing middleware flag evaluation

```ts
import { describe, it, expect, vi } from 'vitest'

describe('Next.js Middleware', () => {
  it('sets x-rollease-flags header', async () => {
    // Create a mock middleware setup
    const db = new MemoryDbAdapter()
    const manager = new FlagManager({ db })
    await manager.create({ key: 'feature', type: 'boolean', defaultValue: true })

    const flags = await manager.evaluateAll({ userId: 'u1' })
    expect(flags.feature).toBe(true)
  })
})
```

### Testing getFlag() and getAllFlags()

These read from signed headers. In tests, mock the headers:

```ts
// Test that your RSC pages handle flags correctly
import { describe, it, expect } from 'vitest'

describe('Server Component', () => {
  it('renders based on flag value', async () => {
    // Directly test your page component with mocked flag values
    const flags = { new_checkout: true, theme: 'dark' }
    // ... render and assert
  })
})
```

---

## 10. Testing Custom Database Adapters

If you're implementing a custom `DbAdapter`, use the standard test suite:

```ts
import { describe, it, expect } from 'vitest'
import type { DbAdapter } from 'rollease/db/adapter'

function testDbAdapter(createAdapter: () => DbAdapter) {
  describe('DbAdapter compliance', () => {
    it('creates and retrieves flags', async () => {
      const db = createAdapter()
      const flag = await db.createFlag({
        key: 'test', type: 'boolean', defaultValue: false,
      })
      expect(flag.key).toBe('test')

      const retrieved = await db.getFlag('test')
      expect(retrieved?.key).toBe('test')
    })

    it('returns null for missing flags', async () => {
      const db = createAdapter()
      expect(await db.getFlag('nonexistent')).toBeNull()
    })

    it('updates flags', async () => {
      const db = createAdapter()
      await db.createFlag({ key: 'test', type: 'boolean', defaultValue: false })
      const updated = await db.updateFlag('test', { description: 'updated' })
      expect(updated.description).toBe('updated')
    })

    it('manages rules lifecycle', async () => {
      const db = createAdapter()
      await db.createFlag({ key: 'test', type: 'boolean', defaultValue: false })

      const rule = await db.addRule('test', {
        priority: 1, value: true, conditions: {},
      })
      expect(rule.id).toBeDefined()

      const rules = await db.listRules('test')
      expect(rules).toHaveLength(1)

      await db.removeRule('test', rule.id)
      expect(await db.listRules('test')).toHaveLength(0)
    })

    // ... add more compliance tests for segments, releases, etc.
  })
}

// Use with your custom adapter:
testDbAdapter(() => new MyCustomAdapter())
```

---

## 11. Testing Hooks & RBAC

```ts
describe('Hooks', () => {
  it('denies mutation when hook throws', async () => {
    const db = new MemoryDbAdapter()
    const manager = new FlagManager({
      db,
      hooks: {
        onBeforeMutation: ({ action }) => {
          if (action === 'flag.deleted') {
            throw new Error('Deletion not allowed')
          }
        },
      },
    })

    await manager.create({ key: 'protected', type: 'boolean', defaultValue: false })

    // Delete is denied by hook
    await expect(
      manager.delete('protected', { confirm: true })
    ).rejects.toThrow('Deletion not allowed')

    // Flag still exists
    expect(await manager.get('protected')).toBeDefined()
  })

  it('fires onEvaluate after evaluation', async () => {
    const evaluations: string[] = []
    const db = new MemoryDbAdapter()
    const manager = new FlagManager({
      db,
      hooks: {
        onEvaluate: (result) => {
          evaluations.push(`${result.key}:${result.reason}`)
        },
      },
    })

    await manager.create({ key: 'tracked', type: 'boolean', defaultValue: true })
    await manager.isEnabled('tracked', { userId: 'u1' })

    // onEvaluate is fire-and-forget — wait a tick
    await new Promise(r => setTimeout(r, 10))
    expect(evaluations.some(e => e.startsWith('tracked:'))).toBe(true)
  })
})
```

---

## 12. Mocking & Spying

### Spy on DB calls to verify caching

```ts
import { vi } from 'vitest'

it('caches flag reads in L1', async () => {
  const db = new MemoryDbAdapter()
  await db.createFlag({ key: 'cached', type: 'boolean', defaultValue: false })

  const getFlagSpy = vi.spyOn(db, 'getFlag')
  const manager = new FlagManager({ db, l1TtlMs: 10_000 })

  // First read → hits DB
  await manager.isEnabled('cached', { userId: 'u1' })
  const firstCallCount = getFlagSpy.mock.calls.length
  expect(firstCallCount).toBeGreaterThan(0)

  // Subsequent reads → hit cache, NOT DB
  for (let i = 0; i < 25; i++) {
    await manager.isEnabled('cached', { userId: 'u1' })
  }
  expect(getFlagSpy.mock.calls.length).toBe(firstCallCount)

  // Mutation busts cache → next read hits DB again
  await manager.update('cached', { description: 'touched' })
  await manager.isEnabled('cached', { userId: 'u1' })
  expect(getFlagSpy.mock.calls.length).toBeGreaterThan(firstCallCount)
})
```

### Spy on impression tracking

```ts
it('tracks impressions for identified users', async () => {
  const db = new MemoryDbAdapter()
  const impressionSpy = vi.spyOn(db, 'trackImpression')
  const manager = new FlagManager({ db })

  await manager.create({ key: 'tracked', type: 'boolean', defaultValue: false })

  // No userId → no impression
  await manager.isEnabled('tracked', {})
  await new Promise(r => setTimeout(r, 10))
  expect(impressionSpy).not.toHaveBeenCalled()

  // With userId → impression tracked
  await manager.isEnabled('tracked', { userId: 'alice' })
  await new Promise(r => setTimeout(r, 10))
  expect(impressionSpy).toHaveBeenCalledTimes(1)
  expect(impressionSpy.mock.calls[0][0]).toMatchObject({
    flagKey: 'tracked',
    userId: 'alice',
  })
})
```

---

## 13. Test Configuration

### Recommended vitest.config.ts

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    hookTimeout: 10000,
    include: ['tests/**/*.test.ts'],
  },
})
```

### Running tests

```bash
# Run all tests
npx vitest run

# Run with watch mode
npx vitest

# Run a specific test file
npx vitest run tests/manager.test.ts

# Run tests matching a pattern
npx vitest run -t "targeting rules"

# Run with coverage
npx vitest run --coverage
```

### Current test suite

| Test File | Tests | Covers |
|-----------|-------|--------|
| `db.test.ts` | 14 | MemoryDbAdapter CRUD, releases, rollbacks, snapshots |
| `evaluator.test.ts` | 26 | Pure evaluation pipeline, all operators, conditions |
| `manager.test.ts` | 16 | FlagManager API, locking, hooks, caching, impressions |
| `security.test.ts` | 14 | Regex safety, condition validation, key validation |
| `overrides.test.ts` | 5 | Local override loading, isolation, path traversal |
| `bucket.test.ts` | 4 | MurmurHash3, bucketing consistency |
| `react.test.ts` | 10 | Provider, hooks, FeatureGate, context |
| `next.test.ts` | 14 | Middleware, signed transport, getFlag/getAllFlags |
| `sdk-usage.test.ts` | 5 | End-to-end usage patterns, signed envelope |
| `sequelize.test.ts` | 4 | Sequelize adapter validation |
| `prisma.test.ts` | 3 | Prisma adapter validation |
| `drizzle.test.ts` | 2 | Drizzle adapter validation |
| `redis.test.ts` | 2 | Redis cache adapter |
| `errors.test.ts` | 1 | Error class hierarchy and toJSON |

**Total: 120 tests across 14 files**
