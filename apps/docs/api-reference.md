# Rollease SDK — API Reference

> **Package:** `rollease`  
> **Version:** 0.0.0-alpha.0  
> **Last updated:** 2026-05-27

---

## Table of Contents

1. [createRollease()](#createrollease)
2. [FlagManager — Evaluation Methods](#flagmanager--evaluation-methods)
3. [FlagManager — Flag CRUD](#flagmanager--flag-crud)
4. [FlagManager — Rules](#flagmanager--rules)
5. [FlagManager — Segments](#flagmanager--segments)
6. [FlagManager — Releases](#flagmanager--releases)
7. [FlagManager — Kill Switch](#flagmanager--kill-switch)
8. [FlagManager — Locking](#flagmanager--locking)
9. [FlagManager — Tags](#flagmanager--tags)
10. [FlagManager — History & Audit](#flagmanager--history--audit)
11. [FlagManager — Cache](#flagmanager--cache)
12. [FlagManager — Events](#flagmanager--events)
13. [evaluateFlag() — Pure Evaluation](#evaluateflag--pure-evaluation)
14. [Bucketing — getBucket() & murmurhash3_32()](#bucketing)
15. [Security Utilities](#security-utilities)
16. [Logger](#logger)
17. [Local Overrides](#local-overrides)
18. [React Integration](#react-integration)
19. [Next.js Integration](#nextjs-integration)

---

## createRollease()

Factory function that creates a configured `RolleaseClient` instance.

```ts
import { createRollease } from 'rollease'

function createRollease(config: RolleaseConfig): RolleaseClient
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `config.db` | `DbAdapter` | ✅ | Database adapter for persistence |
| `config.secret` | `string` | ✅ | HMAC signing secret (min 16 chars) |
| `config.cache` | `CacheConfig` | — | L2 cache configuration |
| `config.cache.driver` | `'memory' \| 'redis'` | — | Cache backend |
| `config.cache.ttl` | `number` | `60` | L2 TTL in seconds |
| `config.cache.redis` | `{ url: string }` | — | Redis connection (required when driver is `'redis'`) |
| `config.l1TtlMs` | `number` | `5000` | L1 in-process cache TTL in milliseconds |
| `config.localOverrides` | `boolean` | `true` in dev | Enable `.rolleaserc.json` overrides |
| `config.localOverridesFile` | `string` | `'.rolleaserc.json'` | Override file path (relative to `cwd`) |
| `config.hooks` | `RolleaseHooks` | — | Lifecycle hooks (RBAC, metrics, audit) |
| `config.impressions` | `ImpressionConfig` | — | Evaluation tracking configuration |
| `config.impressions.enabled` | `boolean` | `true` | Enable impression tracking |
| `config.impressions.sampleRate` | `number` | `1.0` | Sample rate 0..1 (0 = disabled) |
| `config.logging` | `LoggingConfig` | — | Log level and sink |
| `config.audit` | `AuditConfig` | — | Audit logging configuration |
| `config.evaluateAllPageSize` | `number` | `1000` | Page size for bulk flag fetching |
| `config.autoResolveSegments` | `boolean` | `false` | Auto-evaluate segment definitions against context at eval time |

### Returns

```ts
interface RolleaseClient {
  flags: FlagManager       // All flag operations
  close(): Promise<void>   // Graceful shutdown (closes DB + cache connections)
}
```

### Example

```ts
import { createRollease } from 'rollease'
import { createPrismaAdapter } from 'rollease/db/prisma'

const rl = createRollease({
  db: createPrismaAdapter({ prisma }),
  secret: process.env.ROLLEASE_SECRET!,
  cache: { driver: 'redis', redis: { url: process.env.REDIS_URL! }, ttl: 120 },
  l1TtlMs: 10_000,
  hooks: {
    onBeforeMutation: ({ action, flagKey }) => {
      // RBAC check — throw to deny
      if (!isAdmin(currentUser)) throw new Error('Unauthorized')
    },
  },
})

// Always close on shutdown
process.on('SIGTERM', () => rl.close())
```

### Throws

- `ValidationError` — if `secret` is missing or shorter than 16 characters.

---

## FlagManager — Evaluation Methods

All evaluation methods are available on `rl.flags`.

### `isEnabled(key, context)`

Check if a boolean flag is enabled for the given context. Returns `false` for missing flags (never throws).

```ts
isEnabled(key: string, context: FlagContext): Promise<boolean>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `key` | `string` | Flag key |
| `context` | `FlagContext` | Evaluation context |

**Returns:** `Promise<boolean>` — `true` if the flag is active and evaluates to a truthy value.

```ts
const enabled = await rl.flags.isEnabled('new_checkout', {
  userId: 'u_alice',
  environment: 'production',
})
```

> **Note:** For missing flags, `isEnabled` returns `false` instead of throwing `FlagNotFoundError`. This allows safe evaluation without try/catch.

---

### `getValue<T>(key, context)`

Get the evaluated value of a flag with full type inference.

```ts
getValue<T>(key: string, context: FlagContext): Promise<T>
```

**Returns:** `Promise<T>` — the evaluated value (default, rule match, rollout, etc.)

```ts
const maxRetries = await rl.flags.getValue<number>('max_retries', { userId: 'u1' })
const theme = await rl.flags.getValue<string>('theme', { userId: 'u1' })
```

---

### `getVariant(key, context)`

Get the variant result for a multivariate flag.

```ts
getVariant(key: string, context: FlagContext): Promise<Variant>
```

**Returns:** `Promise<Variant>`

```ts
interface Variant {
  key: string         // e.g. 'variant_b'
  value: unknown      // e.g. { price: 49.99 }
  reason: EvalReason  // e.g. 'weighted_random'
}
```

```ts
const { key, value } = await rl.flags.getVariant('exp.pricing', {
  userId: 'u_alice',
})
// key → 'variant_b', value → { price: 49.99 }
```

---

### `evaluate(key, context)`

Full evaluation returning a `FlagResult` with all diagnostic fields.

```ts
evaluate<T>(key: string, context: FlagContext): Promise<FlagResult<T>>
```

**Returns:** `Promise<FlagResult<T>>`

```ts
interface FlagResult<T> {
  key: string             // flag key
  value: T                // evaluated value
  variant: string | null  // variant key (multivariate flags)
  enabled: boolean        // is this flag operationally "on"?
  reason: EvalReason      // which pipeline step produced this result
  ruleId: string | null   // which rule matched (if any)
  evaluatedAt: Date       // timestamp of evaluation
}
```

```ts
const result = await rl.flags.evaluate<boolean>('new_checkout', {
  userId: 'u_alice',
  environment: 'production',
  version: '2.1.0',
})
console.log(result.reason)  // 'rule_match' | 'percentage' | 'default' | ...
console.log(result.ruleId)  // 'rule_abc123' or null
```

---

### `evaluateAll(context, options?)`

Evaluate all active flags and return a flat key → value map.

```ts
evaluateAll(
  context: FlagContext,
  options?: { namespace?: string }
): Promise<FlagMap>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `context` | `FlagContext` | Evaluation context |
| `options.namespace` | `string` | Filter to a specific namespace |

**Returns:** `Promise<Record<string, unknown>>`

```ts
const all = await rl.flags.evaluateAll(
  { userId: 'u1', environment: 'production' },
  { namespace: 'ui' }
)
// → { new_checkout: true, theme: 'dark', max_retries: 3 }
```

---

### `evaluateAllDetailed(context, options?)`

Same as `evaluateAll` but returns full `FlagResult` objects.

```ts
evaluateAllDetailed(
  context: FlagContext,
  options?: { namespace?: string }
): Promise<DetailedFlagMap>
```

**Returns:** `Promise<Record<string, FlagResult>>`

```ts
const detailed = await rl.flags.evaluateAllDetailed({ userId: 'u1' })
// → { new_checkout: { key: 'new_checkout', value: true, reason: 'rule_match', ... } }
```

---

## FlagManager — Flag CRUD

### `create(input)`

Create a new feature flag.

```ts
create(input: CreateFlagInput): Promise<Flag>
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | `string` | ✅ | Unique key (lowercase, alphanumeric, dots, hyphens, underscores) |
| `type` | `FlagType` | ✅ | `'boolean' \| 'string' \| 'number' \| 'json' \| 'multivariate' \| 'percentage'` |
| `defaultValue` | `unknown` | ✅ | Value returned when no rule or rollout matches |
| `description` | `string` | — | Human-readable description |
| `namespace` | `string` | — | Organizational namespace |
| `tags` | `string[]` | — | Arbitrary tags for filtering |
| `environments` | `string[]` | — | Restrict to specific environments |
| `variants` | `FlagVariantDef[]` | — | Variant definitions (for multivariate) |
| `rollout` | `RolloutConfig` | — | Initial rollout configuration |
| `scheduledAt` | `string \| null` | — | ISO date — auto-activate at this time |
| `expiresAt` | `string \| null` | — | ISO date — auto-deactivate after this time |
| `actor` | `AuditActor` | — | Who is creating the flag |

**Throws:**
- `ValidationError` — invalid key format
- `ValidationError` — `defaultValue` type doesn't match flag type (e.g. string default on boolean flag)
- `ValidationError` — variant weights don't sum to 100 (multivariate flags)
- `FlagConflictError` — duplicate key

```ts
await rl.flags.create({
  key: 'new_checkout',
  type: 'boolean',
  defaultValue: false,
  description: 'Enable the new checkout flow',
  namespace: 'checkout',
  tags: ['frontend', 'experiment'],
  environments: ['staging', 'production'],
  scheduledAt: '2026-06-01T00:00:00Z',
  actor: { id: 'alice', type: 'user', name: 'Alice' },
})
```

#### Key validation rules

- Must be non-empty
- Must be lowercase
- Allowed characters: `a-z`, `0-9`, `.`, `-`, `_`
- Forbidden keys: `__proto__`, `constructor`, `prototype`, `toString`, `hasOwnProperty`, `valueOf`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`

---

### `get(key)`

Fetch a single flag by key.

```ts
get(key: string): Promise<Flag>
```

**Throws:** `FlagNotFoundError`

---

### `list(input?)`

List flags with filtering, pagination, and search.

```ts
list(input?: ListFlagsInput): Promise<ListFlagsResult>
```

| Field | Type | Description |
|-------|------|-------------|
| `namespace` | `string` | Filter by namespace |
| `tags` | `string[]` | Filter by tags (any match) |
| `status` | `FlagStatus` | Filter by status (`active \| killed \| archived`) |
| `environment` | `string` | Filter by environment |
| `search` | `string` | Full-text search on key and description |
| `limit` | `number` | Max results (default: 50) |
| `offset` | `number` | Pagination offset |

**Returns:**

```ts
interface ListFlagsResult {
  data: Flag[]
  total: number
  hasMore: boolean
}
```

---

### `update(key, patch)`

Update flag properties. Cannot modify `locked` — use `setLock()` instead.

```ts
update(key: string, patch: UpdateFlagInput): Promise<Flag>
```

**Throws:** `FlagNotFoundError`, `FlagLockedError`

> **Important:** The `locked` field in `UpdateFlagInput` is deprecated and silently stripped. Use `setLock()` for explicit lock management with audit trail.

---

### `delete(key, options)`

Permanently delete a flag. Requires explicit confirmation.

```ts
delete(key: string, options?: { confirm?: boolean; actor?: AuditActor }): Promise<void>
```

**Throws:** `ValidationError` (if `confirm !== true`), `FlagNotFoundError`, `FlagLockedError`

```ts
await rl.flags.delete('old_feature', { confirm: true })
```

---

### `clone(key, options)`

Clone a flag with a new key. Optionally include rules and rollout config.

```ts
clone(key: string, options: CloneFlagInput): Promise<Flag>
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `newKey` | `string` | ✅ | Key for the cloned flag |
| `includeRules` | `boolean` | `true` | Copy targeting rules |
| `includeRollout` | `boolean` | `true` | Copy rollout config |
| `actor` | `AuditActor` | — | Audit actor |

```ts
await rl.flags.clone('checkout_v2', {
  newKey: 'checkout_v3',
  includeRules: true,
  includeRollout: false,
})
```

---

## FlagManager — Rules

### `addRule(flagKey, input)`

Add a targeting rule to a flag.

```ts
addRule(flagKey: string, input: AddRuleInput): Promise<FlagRule>
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | — | Human-readable rule name |
| `priority` | `number` | ✅ | Evaluation order (lower = first) |
| `value` | `unknown` | ✅ | Value to return when rule matches |
| `conditions` | `FlagConditionGroup` | ✅ | Targeting conditions (AND/OR/NOT) |
| `enabled` | `boolean` | `true` | Whether this rule is active |
| `rolloutPct` | `number` | — | Per-rule rollout (0–100). Only this % of matched users get the value. |
| `isHoldout` | `boolean` | — | If `true`, matched users get `defaultValue` (control group) |
| `variantId` | `string` | — | Specific variant to assign (multivariate flags only) |
| `actor` | `AuditActor` | — | Audit actor |

**Throws:** `FlagNotFoundError`, `FlagLockedError`, `ValidationError` (unsafe regex/conditions)

```ts
const rule = await rl.flags.addRule('new_checkout', {
  name: 'Beta users in US',
  priority: 1,
  value: true,
  conditions: {
    all: [
      { dimension: 'userType', op: 'in', value: ['beta', 'internal'] },
      { dimension: 'region', op: 'eq', value: 'us' },
    ],
  },
  rolloutPct: 50,  // only 50% of matched beta/internal US users
})
```

---

### `updateRule(flagKey, ruleId, patch)`

Update an existing rule.

```ts
updateRule(flagKey: string, ruleId: string, patch: UpdateRuleInput): Promise<FlagRule>
```

**Throws:** `FlagNotFoundError`, `FlagLockedError`, `RuleNotFoundError`

---

### `removeRule(flagKey, ruleId)`

Remove a rule from a flag.

```ts
removeRule(flagKey: string, ruleId: string): Promise<void>
```

**Throws:** `FlagNotFoundError`, `FlagLockedError`, `RuleNotFoundError`

---

### `listRules(flagKey)`

List all rules for a flag, sorted by priority.

```ts
listRules(flagKey: string): Promise<FlagRule[]>
```

---

### `reorderRules(flagKey, orderings)`

Batch-update rule priorities.

```ts
reorderRules(flagKey: string, orderings: RuleOrdering[]): Promise<void>
```

```ts
await rl.flags.reorderRules('checkout', [
  { ruleId: 'rule_1', priority: 2 },
  { ruleId: 'rule_2', priority: 1 },  // now evaluates first
])
```

---

## FlagManager — Segments

Segments are reusable audience definitions.

### `createSegment(input)`

```ts
createSegment(input: CreateSegmentInput): Promise<Segment>
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | `string` | ✅ | Unique segment key |
| `description` | `string` | — | Human description |
| `rules` | `FlagConditionGroup` | ✅ | Targeting conditions |

```ts
await rl.flags.createSegment({
  key: 'enterprise_users',
  description: 'Users on enterprise plans',
  rules: {
    all: [
      { dimension: 'userType', op: 'in', value: ['enterprise', 'enterprise_plus'] },
    ],
  },
})
```

---

### `listSegments()`

```ts
listSegments(): Promise<Segment[]>
```

### `updateSegment(key, patch)`

```ts
updateSegment(key: string, patch: UpdateSegmentInput): Promise<Segment>
```

### `deleteSegment(key)`

```ts
deleteSegment(key: string): Promise<void>
```

### `getSegmentUsage(key)`

Find all flag rules that reference this segment.

```ts
getSegmentUsage(key: string): Promise<SegmentUsage[]>
```

**Returns:** Array of `{ flagKey, ruleId }` pairs.

---

## FlagManager — Releases

Releases bundle multiple flag changes into a single atomic operation.

### `createRelease(input)`

```ts
createRelease(input: CreateReleaseInput): Promise<Release>
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | ✅ | Release name |
| `description` | `string` | — | Description |
| `environment` | `string` | — | Target environment |
| `changes` | `ReleaseChange[]` | ✅ | Array of flag changes |
| `scheduledAt` | `string` | — | Schedule deployment for later |

#### `ReleaseChange` actions

| Action | Effect | Extra fields |
|--------|--------|-------------|
| `enable` | Sets status to `active` | — |
| `disable` | Sets status to `archived` | — |
| `kill` | Sets status to `killed` | — |
| `restore` | Restores to `active` | — |
| `setValue` | Changes `defaultValue` | `value: unknown` |
| `setRollout` | Changes rollout config | `rollout: Partial<RolloutConfig>` |

```ts
const release = await rl.flags.createRelease({
  name: 'Checkout v2 Launch',
  environment: 'production',
  changes: [
    { flagKey: 'new_checkout', action: 'enable' },
    { flagKey: 'old_checkout', action: 'kill' },
    { flagKey: 'checkout.theme', action: 'setValue', value: 'modern' },
    { flagKey: 'checkout.rollout', action: 'setRollout', rollout: { percentage: 100 } },
  ],
})
```

---

### `listReleases()`

```ts
listReleases(): Promise<Release[]>
```

### `previewRelease(releaseId)`

Preview the before/after state for each flag in the release without applying changes.

```ts
previewRelease(releaseId: string): Promise<ReleasePreview[]>
```

**Returns:**

```ts
interface ReleasePreview {
  flagKey: string
  before: { value: unknown; status: FlagStatus }
  after: { value: unknown; status: FlagStatus }
}
```

---

### `deployRelease(releaseId, options?)`

Apply all changes in a release atomically. Captures `ReleaseSnapshot[]` for rollback.

```ts
deployRelease(releaseId: string, options?: DeployReleaseInput): Promise<void>
```

> Snapshots are deduplicated per `flagKey` — if a release contains multiple changes to the same flag (e.g. `setValue` + `setRollout`), only one snapshot is captured representing the original pre-deployment state.

---

### `rollbackRelease(releaseId, options?)`

Reverse all changes from a deployed release using the captured snapshots.

```ts
rollbackRelease(releaseId: string, options?: RollbackReleaseInput): Promise<void>
```

```ts
await rl.flags.rollbackRelease(release.id, {
  rolledBackBy: 'alice',
  reason: 'Error rate spike after deployment',
})
```

---

## FlagManager — Kill Switch

### `kill(key, options?)`

Immediately kill a flag (returns `false` for all evaluations).

```ts
kill(key: string, options?: KillFlagInput): Promise<void>
```

### `killAll(options?)`

Kill all active flags (emergency incident response).

```ts
killAll(options?: { reason?: string; killedBy?: string; actor?: AuditActor }): Promise<void>
```

### `restore(key, options?)`

Restore a killed or archived flag to active status.

```ts
restore(key: string, options?: RestoreFlagInput): Promise<void>
```

### `restoreAll(options?)`

Restore all killed/archived flags.

```ts
restoreAll(options?: { restoredBy?: string; reason?: string; actor?: AuditActor }): Promise<void>
```

---

## FlagManager — Locking

### `setLock(key, input)`

Lock or unlock a flag. Locking prevents all modifications and creates an audit entry.

```ts
setLock(key: string, input: SetLockInput): Promise<void>
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `locked` | `boolean` | ✅ | Lock state |
| `reason` | `string` | — | Reason for locking |
| `actor` | `AuditActor` | — | Who is locking |

```ts
// Lock
await rl.flags.setLock('critical_flag', {
  locked: true,
  reason: 'Compliance audit — contact legal before changing',
  actor: { id: 'compliance-bot', type: 'service' },
})

// Unlock
await rl.flags.setLock('critical_flag', { locked: false })
```

Operations blocked by lock: `update`, `addRule`, `updateRule`, `removeRule`, `reorderRules`, `setRollout`, `kill`, `delete`.

---

## FlagManager — Tags

### `addTags(key, tags)`

```ts
addTags(key: string, tags: string[]): Promise<void>
```

### `removeTags(key, tags)`

```ts
removeTags(key: string, tags: string[]): Promise<void>
```

---

## FlagManager — History & Audit

### `getHistory(key)`

Get the audit trail for a flag.

```ts
getHistory(key: string): Promise<HistoryEntry[]>
```

**Returns:** Chronological list of all mutations, each with:

```ts
interface HistoryEntry {
  id: string
  flagKey?: string
  action: HistoryAction   // 'flag.created' | 'flag.updated' | 'rule.added' | ...
  by?: string | AuditActor
  at: Date
  changes?: Record<string, unknown>
  reason?: string
  releaseId?: string
}
```

#### Tracked actions

| Action | Trigger |
|--------|---------|
| `flag.created` | `create()` |
| `flag.updated` | `update()` |
| `flag.archived` | `archive()` |
| `flag.restored` | `restore()` |
| `flag.killed` | `kill()` |
| `flag.deleted` | `delete()` |
| `flag.locked` | `setLock(locked: true)` |
| `flag.unlocked` | `setLock(locked: false)` |
| `flag.cloned` | `clone()` |
| `rule.added` | `addRule()` |
| `rule.updated` | `updateRule()` |
| `rule.removed` | `removeRule()` |
| `rule.reordered` | `reorderRules()` |
| `rollout.set` | `setRollout()` |
| `release.deployed` | `deployRelease()` |
| `release.rolled_back` | `rollbackRelease()` |
| `segment.created` | `createSegment()` |
| `segment.updated` | `updateSegment()` |
| `segment.deleted` | `deleteSegment()` |
| `tags.added` | `addTags()` |
| `tags.removed` | `removeTags()` |

---

## FlagManager — Cache

### `invalidateCache(key)`

Bust the L1 and L2 cache for a specific flag.

```ts
invalidateCache(key: string): Promise<void>
```

### `invalidateAllCaches()`

Bust all cached flag data.

```ts
invalidateAllCaches(): Promise<void>
```

> **Note:** Cache is automatically invalidated on all write operations (update, kill, addRule, deployRelease, etc.). Manual invalidation is only needed when data is modified outside of Rollease.

---

## FlagManager — Events

### `onChange(listener)`

Subscribe to flag change events. Returns an unsubscribe function.

```ts
onChange(listener: (event: ChangeEvent) => void): () => void
```

```ts
interface ChangeEvent {
  flagKey: string
  action: string      // 'created' | 'updated' | 'killed' | ...
  timestamp: Date
}
```

Listener errors are caught and logged — they never crash the SDK.

```ts
const unsubscribe = rl.flags.onChange((event) => {
  console.log(`Flag ${event.flagKey} was ${event.action}`)
  metrics.increment('rollease.flag_changes')
})

// Later
unsubscribe()
```

---

## evaluateFlag() — Pure Evaluation

The core evaluation function. Stateless and side-effect free — no DB calls, no network, no disk I/O. Safe to run in any runtime (Node, Edge, browser, Cloudflare Workers).

```ts
import { evaluateFlag } from 'rollease'

function evaluateFlag<T>(
  flag: Flag,
  context: FlagContext,
  options?: EvaluateOptions
): FlagResult<T>
```

### EvaluateOptions

| Field | Type | Description |
|-------|------|-------------|
| `rules` | `FlagRule[]` | Targeting rules from DB |
| `userAssignment` | `string` | Sticky variant assignment |
| `localOverride` | `unknown` | Developer override value |
| `segments` | `Segment[]` | Segments for condition resolution |
| `now` | `Date` | Override current time (for testing) |
| `onWarning` | `(msg, meta?) => void` | Callback for evaluation warnings |

### Pipeline

```
Step 1: Flag exists?        → default
Step 2: Kill switch?        → kill_switch (false)
Step 3: Archived?           → disabled (defaultValue)
Step 4: Date window?        → not_scheduled / expired
Step 5: Local override?     → override
Step 6: Sticky assignment?  → assignment
Step 7: Targeting rules?    → rule_match
Step 8: Rollout?            → percentage / weighted_random
Step 9: Default             → default (defaultValue)
```

---

## Bucketing

### `getBucket(userId, flagId, salt?)`

Returns a consistent bucket (0–99) for a given user and flag.

```ts
import { getBucket } from 'rollease'

getBucket(userId: string, flagId: string, salt?: string): number
```

Uses MurmurHash3 (32-bit). The same inputs always produce the same bucket. Used internally for percentage rollouts and weighted variant distribution.

### `murmurhash3_32(key, seed?)`

Raw 32-bit MurmurHash3 implementation.

```ts
import { murmurhash3_32 } from 'rollease'

murmurhash3_32(key: string, seed?: number): number
```

---

## Security Utilities

All available from `rollease` or `rollease/core/security`.

### `isSafeRegexPattern(pattern)`

Returns `true` if the pattern is safe from ReDoS attacks.

```ts
isSafeRegexPattern(pattern: unknown): pattern is string
```

Rejects: backreferences, lookaheads/lookbehinds, nested quantifiers, range quantifiers >1000, patterns >128 chars.

### `safeRegexTest(pattern, input)`

Test a string against a safe regex pattern.

```ts
safeRegexTest(pattern: unknown, actual: unknown): boolean
```

Input strings >4096 characters are rejected.

### `assertSafeConditionGroup(group, label?)`

Validates a condition group for safety (depth ≤12, nodes ≤100, safe regex patterns). Throws `ValidationError` on violation.

```ts
assertSafeConditionGroup(group: FlagConditionGroup, label?: string): void
```

### `isSafeFlagKey(key)` / `assertSafeFlagKey(key, label?)`

Validate flag/segment key format.

```ts
isSafeFlagKey(key: unknown): key is string
assertSafeFlagKey(key: unknown, label?: string): asserts key is string
```

### `validateOverridePath(filePath, cwd)`

Validates that an override file path resolves inside the working directory (prevents path traversal).

```ts
validateOverridePath(filePath: string, cwd: string): string  // returns resolved path
```

---

## Logger

### `createLogger(config?)`

Create a logger that respects level thresholds and custom sinks.

```ts
import { createLogger } from 'rollease'

const logger = createLogger({
  level: 'debug',    // 'silent' | 'error' | 'warn' | 'info' | 'debug'
  sink: (level, message, meta) => {
    myLoggingService.log({ level, message, ...meta })
  },
})
```

Log levels (in order): `silent < error < warn < info < debug`

All internal SDK logs go through this logger. Default level is `warn`. Default sink is `console.<level>`. Logger failures never propagate — they are silently swallowed.

---

## Local Overrides

### `loadLocalOverrides(filePath?, cwd?)`

Low-level function to read `.rolleaserc.json`. Returns `{}` on any failure.

```ts
import { loadLocalOverrides } from 'rollease'

loadLocalOverrides(
  filePath?: string,    // default: '.rolleaserc.json'
  cwd?: string          // default: process.cwd()
): Record<string, unknown>
```

Edge-safe: returns `{}` when `fs` is not available (Edge runtimes, browser).

---

## React Integration

Available from `rollease/react`.

### `<RolleaseProvider>`

```tsx
import { RolleaseProvider } from 'rollease/react'

<RolleaseProvider initialFlags={flags}>
  <App />
</RolleaseProvider>
```

Accepts either `FlagMap` or `Record<string, FlagResult>` — auto-detects format.

### `useFlag(key)` → `{ enabled, loading, error }`

### `useVariant(key)` → `{ variant, loading, error }`

### `useFlags()` → `FlagMap`

### `useFlagDetails(key)` → `FlagResult`

### `useRollease()` → `{ flags, flagDetails }`

### `<FeatureGate flag={key} fallback={...}>`

Declarative conditional rendering.

---

## Next.js Integration

Available from `rollease/next`.

### `rolleaseMiddleware(client, options)`

Creates Next.js middleware that evaluates flags per-request.

### `getFlag(key, defaultValue?)`

Read a single flag in Server Components (from signed header).

### `getAllFlags()`

Read all flags in Server Components.

See the [Developer Guide — Section 8](developer-guide.md#8-nextjs-full-stack-integration) for complete setup instructions.
