# Prisma and Drizzle Adapter — Detailed Examples

> Complete setup guides for using Rollease with Prisma and Drizzle ORM.

---

## Table of Contents

1. [Prisma Setup](#prisma-setup)
2. [Prisma Schema](#prisma-schema)
3. [Prisma Custom Model Names](#prisma-custom-model-names)
4. [Prisma Field Validation](#prisma-field-validation)
5. [Drizzle Setup](#drizzle-setup)
6. [Drizzle Schema Definition](#drizzle-schema-definition)
7. [Drizzle Repository Pattern](#drizzle-repository-pattern)
8. [Required Storage Fields](#required-storage-fields)
9. [Migrations](#migrations)

---

## Prisma Setup

### Basic setup with default model names

```ts
import { PrismaClient } from '@prisma/client'
import { createRollease, createPrismaAdapter } from 'rollease'

const prisma = new PrismaClient()

export const rollease = createRollease({
  db: createPrismaAdapter({
    prisma,
    validateModelFields: true,  // Validates schema at startup
  }),
  secret: process.env.ROLLEASE_SECRET!,
})
```

The adapter expects Prisma models named `RolleaseFlag`, `RolleaseRule`, `RolleaseSegment`, `RolleaseRelease`, `RolleaseAssignment`, `RolleaseHistory`, and `RolleaseImpression`.

### Default delegate mapping

The adapter maps model names to Prisma Client delegates:

```ts
// Default mapping (case-lowered first character)
const DEFAULTS = {
  Flag:       'rolleaseFlag',        // prisma.rolleaseFlag
  Rule:       'rolleaseRule',        // prisma.rolleaseRule
  Segment:    'rolleaseSegment',     // prisma.rolleaseSegment
  Release:    'rolleaseRelease',     // prisma.rolleaseRelease
  Assignment: 'rolleaseAssignment',  // prisma.rolleaseAssignment
  History:    'rolleaseHistory',     // prisma.rolleaseHistory
  Impression: 'rolleaseImpression',  // prisma.rolleaseImpression
}
```

---

## Prisma Schema

Add these models to your `schema.prisma`:

```prisma
model RolleaseFlag {
  id            String    @id @default(uuid())
  key           String    @unique
  type          String    // 'boolean' | 'string' | 'number' | 'json' | 'multivariate' | 'percentage'
  status        String    @default("active")  // 'active' | 'killed' | 'archived'
  defaultValue  Json
  description   String?
  namespace     String?
  tags          Json?     // String[]
  locked        Boolean   @default(false)
  lockedReason  String?
  environments  Json?     // String[]
  variants      Json?     // FlagVariantDef[]
  rollout       Json?     // RolloutConfig
  scheduledAt   DateTime?
  expiresAt     DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  rules         RolleaseRule[]
  assignments   RolleaseAssignment[]
  history       RolleaseHistory[]

  @@map("rollease_flags")
}

model RolleaseRule {
  id          String  @id @default(uuid())
  flagKey     String
  name        String?
  priority    Int
  value       Json
  conditions  Json    // FlagConditionGroup
  enabled     Boolean @default(true)
  rolloutPct  Float?
  isHoldout   Boolean @default(false)
  variantId   String?

  flag        RolleaseFlag @relation(fields: [flagKey], references: [key], onDelete: Cascade)

  @@map("rollease_rules")
}

model RolleaseSegment {
  key         String   @id
  description String?
  rules       Json     // FlagConditionGroup
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@map("rollease_segments")
}

model RolleaseRelease {
  id              String    @id @default(uuid())
  name            String
  description     String?
  environment     String?
  status          String    @default("pending")  // 'pending' | 'deployed' | 'rolled_back' | 'scheduled'
  changes         Json      // ReleaseChange[]
  snapshots       Json?     // ReleaseSnapshot[]
  scheduledAt     DateTime?
  deployedAt      DateTime?
  deployedBy      String?
  rolledBackAt    DateTime?
  rolledBackBy    String?
  rollbackReason  String?
  createdAt       DateTime  @default(now())

  @@map("rollease_releases")
}

model RolleaseAssignment {
  flagKey     String
  userId      String
  variantKey  String

  @@id([flagKey, userId])
  flag        RolleaseFlag @relation(fields: [flagKey], references: [key], onDelete: Cascade)

  @@map("rollease_assignments")
}

model RolleaseHistory {
  id        String   @id @default(uuid())
  flagKey   String?
  action    String   // HistoryAction
  by        Json?    // string | AuditActor
  at        DateTime @default(now())
  changes   Json?
  reason    String?
  releaseId String?

  flag      RolleaseFlag? @relation(fields: [flagKey], references: [key], onDelete: SetNull)

  @@map("rollease_history")
}

model RolleaseImpression {
  id        String   @id @default(uuid())
  flagKey   String
  userId    String
  value     Json?
  variant   String?
  reason    String?
  at        DateTime @default(now())

  @@index([flagKey, userId])
  @@map("rollease_impressions")
}
```

After adding the schema, run:

```bash
npx prisma migrate dev --name add-rollease-tables
```

---

## Prisma Custom Model Names

When your Prisma models use different names (e.g., existing tables):

```ts
const db = createPrismaAdapter({
  prisma,
  delegates: {
    Flag:       'featureFlag',        // prisma.featureFlag
    Rule:       'featureFlagRule',
    Segment:    'featureFlagSegment',
    Release:    'featureFlagRelease',
    Assignment: 'featureFlagAssignment',
    History:    'featureFlagHistory',
    Impression: 'featureFlagImpression',
  },
  modelNames: {
    Flag:       'FeatureFlag',        // For Prisma metadata
    Rule:       'FeatureFlagRule',
    Segment:    'FeatureFlagSegment',
    Release:    'FeatureFlagRelease',
    Assignment: 'FeatureFlagAssignment',
    History:    'FeatureFlagHistory',
    Impression: 'FeatureFlagImpression',
  },
  validateModelFields: true,
})
```

### Understanding delegates vs modelNames

- **`delegates`** — Property name on the Prisma Client (e.g., `prisma.featureFlag`). This is the camelCase version of your Prisma model name.
- **`modelNames`** — The PascalCase model name as defined in `schema.prisma`. Used for runtime metadata validation (`Prisma.dmmf.datamodel.models`).

---

## Prisma Field Validation

The adapter can validate that your Prisma models have all required fields at startup:

```ts
const db = createPrismaAdapter({
  prisma,
  validateModelFields: true,  // Enable validation
})
```

When enabled, the adapter calls `validatePrismaModelFields(prisma, modelNames)` which:
1. Reads Prisma's runtime DMMF (Data Model Meta Format)
2. Checks each model has the required columns (see [Required Fields](#required-storage-fields))
3. Throws `ValidationError` with details if any field is missing

### Manual validation

```ts
import { validatePrismaDelegates, validatePrismaModelFields } from 'rollease'

// Validate delegates exist on the Prisma client
validatePrismaDelegates(prisma, delegates)

// Validate model fields match required schema
validatePrismaModelFields(prisma, modelNames)
```

---

## Drizzle Setup

### Basic setup

```ts
import { and, asc, desc, eq } from 'drizzle-orm'
import { createRollease, createDrizzleAdapter } from 'rollease'
import { db } from './db'
import {
  rolleaseFlags, rolleaseRules, rolleaseSegments,
  rolleaseReleases, rolleaseAssignments, rolleaseHistory,
  rolleaseImpressions,
} from './rollease-schema'

export const rollease = createRollease({
  db: createDrizzleAdapter({
    db,
    tables: {
      Flag:       rolleaseFlags,
      Rule:       rolleaseRules,
      Segment:    rolleaseSegments,
      Release:    rolleaseReleases,
      Assignment: rolleaseAssignments,
      History:    rolleaseHistory,
      Impression: rolleaseImpressions,
    },
    helpers: { eq, and, asc, desc },
    validateTables: true,  // Validate column definitions
  }),
  secret: process.env.ROLLEASE_SECRET!,
})
```

---

## Drizzle Schema Definition

### PostgreSQL example

```ts
import { pgTable, text, boolean, integer, json, timestamp, primaryKey, index, doublePrecision } from 'drizzle-orm/pg-core'

export const rolleaseFlags = pgTable('rollease_flags', {
  id:           text('id').primaryKey(),
  key:          text('key').notNull().unique(),
  type:         text('type').notNull(),
  status:       text('status').notNull().default('active'),
  defaultValue: json('default_value').notNull(),
  description:  text('description'),
  namespace:    text('namespace'),
  tags:         json('tags'),
  locked:       boolean('locked').default(false),
  lockedReason: text('locked_reason'),
  environments: json('environments'),
  variants:     json('variants'),
  rollout:      json('rollout'),
  scheduledAt:  timestamp('scheduled_at'),
  expiresAt:    timestamp('expires_at'),
  createdAt:    timestamp('created_at').notNull().defaultNow(),
  updatedAt:    timestamp('updated_at').notNull().defaultNow(),
})

export const rolleaseRules = pgTable('rollease_rules', {
  id:         text('id').primaryKey(),
  flagKey:    text('flag_key').notNull().references(() => rolleaseFlags.key, { onDelete: 'cascade' }),
  name:       text('name'),
  priority:   integer('priority').notNull(),
  value:      json('value').notNull(),
  conditions: json('conditions').notNull(),
  enabled:    boolean('enabled').default(true),
  rolloutPct: doublePrecision('rollout_pct'),
  isHoldout:  boolean('is_holdout').default(false),
  variantId:  text('variant_id'),
})

export const rolleaseSegments = pgTable('rollease_segments', {
  key:         text('key').primaryKey(),
  description: text('description'),
  rules:       json('rules').notNull(),
  createdAt:   timestamp('created_at').notNull().defaultNow(),
  updatedAt:   timestamp('updated_at').notNull().defaultNow(),
})

export const rolleaseReleases = pgTable('rollease_releases', {
  id:             text('id').primaryKey(),
  name:           text('name').notNull(),
  description:    text('description'),
  environment:    text('environment'),
  status:         text('status').notNull().default('pending'),
  changes:        json('changes').notNull(),
  snapshots:      json('snapshots'),
  scheduledAt:    timestamp('scheduled_at'),
  deployedAt:     timestamp('deployed_at'),
  deployedBy:     text('deployed_by'),
  rolledBackAt:   timestamp('rolled_back_at'),
  rolledBackBy:   text('rolled_back_by'),
  rollbackReason: text('rollback_reason'),
  createdAt:      timestamp('created_at').notNull().defaultNow(),
})

export const rolleaseAssignments = pgTable('rollease_assignments', {
  flagKey:    text('flag_key').notNull().references(() => rolleaseFlags.key, { onDelete: 'cascade' }),
  userId:     text('user_id').notNull(),
  variantKey: text('variant_key').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.flagKey, t.userId] }),
}))

export const rolleaseHistory = pgTable('rollease_history', {
  id:        text('id').primaryKey(),
  flagKey:   text('flag_key'),
  action:    text('action').notNull(),
  by:        json('by'),
  at:        timestamp('at').notNull().defaultNow(),
  changes:   json('changes'),
  reason:    text('reason'),
  releaseId: text('release_id'),
})

export const rolleaseImpressions = pgTable('rollease_impressions', {
  id:      text('id').primaryKey(),
  flagKey: text('flag_key').notNull(),
  userId:  text('user_id').notNull(),
  value:   json('value'),
  variant: text('variant'),
  reason:  text('reason'),
  at:      timestamp('at').notNull().defaultNow(),
}, (t) => ({
  flagUserIdx: index('rollease_imp_flag_user').on(t.flagKey, t.userId),
}))
```

### SQLite example

```ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const rolleaseFlags = sqliteTable('rollease_flags', {
  id:           text('id').primaryKey(),
  key:          text('key').notNull().unique(),
  type:         text('type').notNull(),
  status:       text('status').notNull().default('active'),
  defaultValue: text('default_value', { mode: 'json' }).notNull(),
  // ... same fields, using text({ mode: 'json' }) for JSON columns
})
```

---

## Drizzle Repository Pattern

For non-standard Drizzle setups or when you want full control over queries:

```ts
import { createDrizzleAdapter, type RepositorySet, type RowRepository } from 'rollease'

// Implement custom repositories
const flagRepo: RowRepository = {
  findMany: async (options) => {
    // Custom query logic
    return db.select().from(myFlagsTable).all()
  },
  findUnique: async (where) => {
    return db.select().from(myFlagsTable).where(eq(myFlagsTable.key, where.key)).get()
  },
  create: async (data) => {
    return db.insert(myFlagsTable).values(data).returning().get()
  },
  update: async (where, data) => {
    return db.update(myFlagsTable).set(data).where(eq(myFlagsTable.key, where.key)).returning().get()
  },
  delete: async (where) => {
    await db.delete(myFlagsTable).where(eq(myFlagsTable.key, where.key))
  },
}

const repositories: RepositorySet = {
  Flag: flagRepo,
  Rule: ruleRepo,
  Segment: segmentRepo,
  Release: releaseRepo,
  Assignment: assignmentRepo,
  History: historyRepo,
  Impression: impressionRepo,
}

const db = createDrizzleAdapter({ repositories })
```

---

## Required Storage Fields

Both Prisma and Drizzle adapters validate against the same required field contract:

```ts
import {
  ROLLEASE_PRISMA_REQUIRED_FIELDS,
  ROLLEASE_DRIZZLE_REQUIRED_COLUMNS,
} from 'rollease'
```

| Table | Required Fields |
|-------|----------------|
| **Flag** | `id`, `key`, `type`, `status`, `defaultValue`, `description`, `namespace`, `tags`, `locked`, `lockedReason`, `environments`, `variants`, `rollout`, `scheduledAt`, `expiresAt`, `createdAt`, `updatedAt` |
| **Rule** | `id`, `flagKey`, `name`, `priority`, `value`, `conditions`, `enabled`, `rolloutPct`, `isHoldout`, `variantId` |
| **Segment** | `key`, `description`, `rules`, `createdAt`, `updatedAt` |
| **Release** | `id`, `name`, `description`, `environment`, `status`, `changes`, `scheduledAt`, `deployedAt`, `deployedBy`, `rolledBackAt`, `rolledBackBy`, `rollbackReason`, `createdAt` |
| **Assignment** | `flagKey`, `userId`, `variantKey` |
| **History** | `id`, `flagKey`, `action`, `by`, `at`, `changes`, `reason`, `releaseId` |
| **Impression** | `id`, `flagKey`, `userId`, `value`, `variant`, `reason`, `at` |

---

## Migrations

### Prisma

```bash
# Generate migration from schema changes
npx prisma migrate dev --name add-rollease-tables

# Apply in production
npx prisma migrate deploy
```

### Drizzle

```bash
# Generate migration
npx drizzle-kit generate:pg --schema=./src/rollease-schema.ts

# Apply migration
npx drizzle-kit push:pg
```

### Adding new fields

When Rollease adds new fields in future versions, the adapter validation will warn about missing columns. Update your schema and run a migration to add them.
