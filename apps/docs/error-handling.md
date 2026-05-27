# Rollease SDK — Error Handling Guide

> **Package:** `rollease`  
> **Last updated:** 2026-05-27

---

## Error Hierarchy

All Rollease errors extend `RolleaseError`, which extends the native `Error` class. Every error carries structured metadata for API responses and logging.

```
Error (native)
  └── RolleaseError
        ├── FlagNotFoundError      (404)
        ├── FlagLockedError        (423)
        ├── FlagConflictError      (409)
        ├── ValidationError        (422)
        ├── RuleNotFoundError      (404)
        ├── SegmentNotFoundError   (404)
        ├── ReleaseNotFoundError   (404)
        ├── ReleaseConflictError   (409)
        └── RolleaseInternalError  (500)
```

---

## RolleaseError (Base Class)

Every Rollease error includes:

```ts
class RolleaseError extends Error {
  readonly statusCode: number              // HTTP status code
  readonly code: string                    // Machine-readable error code
  readonly meta: Record<string, unknown>   // Structured context

  toJSON(): {
    error: string
    statusCode: number
    code: string
    message: string
    meta: Record<string, unknown>
  }
}
```

### Using `toJSON()` in API Routes

```ts
// app/api/flags/[key]/route.ts
import { RolleaseError } from 'rollease'

export async function GET(req: Request, { params }: { params: { key: string } }) {
  try {
    const flag = await rl.flags.get(params.key)
    return Response.json(flag)
  } catch (err) {
    if (err instanceof RolleaseError) {
      return Response.json(err.toJSON(), { status: err.statusCode })
    }
    return Response.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
```

### `instanceof` checks

All error classes use `Object.setPrototypeOf(this, new.target.prototype)` to ensure `instanceof` works correctly with TypeScript class hierarchies:

```ts
import { FlagNotFoundError, FlagLockedError, RolleaseError } from 'rollease'

try {
  await rl.flags.update('my-flag', { description: 'updated' })
} catch (err) {
  if (err instanceof FlagNotFoundError) {
    // 404 — flag doesn't exist
    console.log(err.meta.flagKey)  // → 'my-flag'
  }
  if (err instanceof FlagLockedError) {
    // 423 — flag is locked
    console.log(err.meta.reason)   // → 'compliance audit'
  }
  if (err instanceof RolleaseError) {
    // Catch-all for any Rollease error
    console.log(err.statusCode, err.code, err.message)
  }
}
```

---

## Error Reference

### FlagNotFoundError

| Property | Value |
|----------|-------|
| `statusCode` | `404` |
| `code` | `FLAG_NOT_FOUND` |
| `meta` | `{ flagKey: string }` |

**Thrown by:** `get()`, `update()`, `delete()`, `kill()`, `restore()`, `archive()`, `addRule()`, `updateRule()`, `removeRule()`, `setRollout()`, `setLock()`, `clone()`, `addTags()`, `removeTags()`, `getHistory()`

**Not thrown by:** `isEnabled()`, `getValue()`, `getVariant()` — these return safe defaults for missing flags instead of throwing.

```ts
// Safe — never throws for missing flags
const enabled = await rl.flags.isEnabled('nonexistent', {})  // → false

// Throws FlagNotFoundError
const flag = await rl.flags.get('nonexistent')  // → throws!
```

---

### FlagLockedError

| Property | Value |
|----------|-------|
| `statusCode` | `423` |
| `code` | `FLAG_LOCKED` |
| `meta` | `{ flagKey: string, reason?: string }` |

**Thrown by:** `update()`, `delete()`, `kill()`, `addRule()`, `updateRule()`, `removeRule()`, `reorderRules()`, `setRollout()`

Flags are locked via `setLock()`. Locked flags cannot be modified through any API — this is an intentional security boundary for compliance-sensitive flags.

```ts
await rl.flags.setLock('critical_flag', {
  locked: true,
  reason: 'SOC2 audit — contact compliance@company.com before modifying',
})

try {
  await rl.flags.update('critical_flag', { defaultValue: true })
} catch (err) {
  if (err instanceof FlagLockedError) {
    console.log(err.meta.reason)
    // → 'SOC2 audit — contact compliance@company.com before modifying'
  }
}
```

---

### FlagConflictError

| Property | Value |
|----------|-------|
| `statusCode` | `409` |
| `code` | `CONFLICT` |
| `meta` | `{ key: string, type: string }` |

**Thrown by:** `create()`, `clone()`, `createSegment()`

Thrown when trying to create a flag, segment, or clone with a key that already exists.

---

### ValidationError

| Property | Value |
|----------|-------|
| `statusCode` | `422` |
| `code` | `VALIDATION_ERROR` |
| `meta` | varies |

**Thrown by:** All write operations that validate input.

Common validation failures:

| Scenario | Message |
|----------|---------|
| Invalid flag key | `Invalid key "UPPERCASE". Keys must be lowercase...` |
| Empty flag key | `key is required` |
| Forbidden key | `key "__proto__" is reserved and cannot be used` |
| Type mismatch | `Boolean flag "x" must have a boolean default value, got string` |
| Variant weights | `Multivariate flag "x" variant weights must sum to 100, got 90` |
| Unsafe regex | `conditions.any[0] contains an unsafe regex pattern` |
| Condition depth | `conditions exceeds maximum nesting depth` |
| Condition count | `conditions exceeds maximum condition count` |
| Delete without confirm | `Deletion requires { confirm: true }` |
| Bad secret | `Rollease secret must be at least 16 characters long` |
| Path traversal | `Override file path must resolve inside the current working directory` |

---

### RuleNotFoundError

| Property | Value |
|----------|-------|
| `statusCode` | `404` |
| `code` | `RULE_NOT_FOUND` |
| `meta` | `{ flagKey: string, ruleId: string }` |

**Thrown by:** `updateRule()`, `removeRule()`

---

### SegmentNotFoundError

| Property | Value |
|----------|-------|
| `statusCode` | `404` |
| `code` | `SEGMENT_NOT_FOUND` |
| `meta` | `{ segmentKey: string }` |

**Thrown by:** `updateSegment()`, `deleteSegment()`, `getSegmentUsage()`

---

### ReleaseNotFoundError

| Property | Value |
|----------|-------|
| `statusCode` | `404` |
| `code` | `RELEASE_NOT_FOUND` |
| `meta` | `{ releaseId: string }` |

**Thrown by:** `deployRelease()`, `rollbackRelease()`, `previewRelease()`

---

### ReleaseConflictError

| Property | Value |
|----------|-------|
| `statusCode` | `409` |
| `code` | `RELEASE_CONFLICT` |
| `meta` | `{ releaseId: string, details?: string }` |

**Thrown by:** `deployRelease()` — when a release has already been deployed, or references flags in conflicting states.

---

### RolleaseInternalError

| Property | Value |
|----------|-------|
| `statusCode` | `500` |
| `code` | `INTERNAL_ERROR` |
| `meta` | varies |

Unexpected internal errors (DB connectivity failures, cache unavailability, etc.)

---

## Best Practices

### 1. Wrap API routes with a generic error handler

```ts
// lib/api-helpers.ts
import { RolleaseError } from 'rollease'

export function withRollease(
  handler: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      return await handler(req)
    } catch (err) {
      if (err instanceof RolleaseError) {
        return Response.json(err.toJSON(), { status: err.statusCode })
      }
      console.error('Unexpected error:', err)
      return Response.json(
        { error: 'Internal Server Error', code: 'UNKNOWN' },
        { status: 500 }
      )
    }
  }
}
```

### 2. Use `isEnabled()` for evaluation — it never throws

```ts
// ✅ Safe — returns false for missing, killed, or errored flags
const enabled = await rl.flags.isEnabled('my_flag', context)

// ❌ Throws FlagNotFoundError if flag doesn't exist
const flag = await rl.flags.get('my_flag')
```

### 3. Use hooks for cross-cutting error policies

```ts
const rl = createRollease({
  db,
  secret,
  hooks: {
    onBeforeMutation: async ({ action, flagKey, actor }) => {
      // RBAC enforcement — throw to deny
      if (!await hasPermission(actor, action, flagKey)) {
        throw new Error('Insufficient permissions')
      }
    },
  },
})
```

### 4. Log errors with structured metadata

```ts
try {
  await rl.flags.update(flagKey, patch)
} catch (err) {
  if (err instanceof RolleaseError) {
    logger.error('Rollease operation failed', {
      code: err.code,
      statusCode: err.statusCode,
      flagKey: err.meta.flagKey,
      message: err.message,
    })
  }
}
```

### 5. Use `onChange` for error monitoring

```ts
rl.flags.onChange((event) => {
  // Track all flag mutations in your monitoring system
  monitoring.trackEvent('flag_change', {
    flagKey: event.flagKey,
    action: event.action,
  })
})
```

Listener errors are caught by the SDK and logged via the configured logger — they never crash the application.
