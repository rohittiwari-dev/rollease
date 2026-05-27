# Prisma and Drizzle Adapter Examples

Rollease can use Prisma delegates or Drizzle table objects for durable feature flag storage.

## Prisma

Use the default delegate names when your Prisma models are named `RolleaseFlag`, `RolleaseRule`, `RolleaseSegment`, `RolleaseRelease`, `RolleaseAssignment`, `RolleaseHistory`, and `RolleaseImpression`.

```ts
import { PrismaClient } from "@prisma/client";
import { createPrismaAdapter, createRollease } from "rollease";

const prisma = new PrismaClient();

export const rollease = createRollease({
  db: createPrismaAdapter({
    prisma,
    validateModelFields: true,
  }),
  secret: process.env.ROLLEASE_SECRET!,
});
```

Pass custom delegate names when your schema uses different model names:

```ts
const db = createPrismaAdapter({
  prisma,
  delegates: {
    Flag: "featureFlag",
    Rule: "featureFlagRule",
    Segment: "featureFlagSegment",
    Release: "featureFlagRelease",
    Assignment: "featureFlagAssignment",
    History: "featureFlagHistory",
    Impression: "featureFlagImpression",
  },
  modelNames: {
    Flag: "FeatureFlag",
    Rule: "FeatureFlagRule",
    Segment: "FeatureFlagSegment",
    Release: "FeatureFlagRelease",
    Assignment: "FeatureFlagAssignment",
    History: "FeatureFlagHistory",
    Impression: "FeatureFlagImpression",
  },
  validateModelFields: true,
});
```

Prisma runtime metadata is needed for field validation. If you only want delegate method validation, omit `validateModelFields`.

## Drizzle

Pass the Drizzle database, Rollease table objects, and helpers from `drizzle-orm`:

```ts
import { and, asc, desc, eq } from "drizzle-orm";
import { createDrizzleAdapter, createRollease } from "rollease";
import { db } from "./db";
import {
  rolleaseAssignments,
  rolleaseFlags,
  rolleaseHistory,
  rolleaseImpressions,
  rolleaseReleases,
  rolleaseRules,
  rolleaseSegments,
} from "./rollease-schema";

export const rollease = createRollease({
  db: createDrizzleAdapter({
    db,
    tables: {
      Flag: rolleaseFlags,
      Rule: rolleaseRules,
      Segment: rolleaseSegments,
      Release: rolleaseReleases,
      Assignment: rolleaseAssignments,
      History: rolleaseHistory,
      Impression: rolleaseImpressions,
    },
    helpers: { eq, and, asc, desc },
    validateTables: true,
  }),
  secret: process.env.ROLLEASE_SECRET!,
});
```

For non-standard Drizzle drivers, pass repository methods directly:

```ts
import { createDrizzleAdapter, type RepositorySet } from "rollease";

const repositories: RepositorySet = {
  Flag: flagRepository,
  Rule: ruleRepository,
  Segment: segmentRepository,
  Release: releaseRepository,
  Assignment: assignmentRepository,
  History: historyRepository,
  Impression: impressionRepository,
};

const db = createDrizzleAdapter({ repositories });
```

## Required Fields

```ts
import {
  ROLLEASE_DRIZZLE_REQUIRED_COLUMNS,
  ROLLEASE_PRISMA_REQUIRED_FIELDS,
} from "rollease";

console.log(ROLLEASE_PRISMA_REQUIRED_FIELDS.Flag);
console.log(ROLLEASE_DRIZZLE_REQUIRED_COLUMNS.Flag);
```

Both maps contain the same required storage contract:

```ts
{
  Flag: [
    "id", "key", "type", "status", "defaultValue", "description",
    "namespace", "tags", "locked", "lockedReason", "environments",
    "variants", "rollout", "scheduledAt", "expiresAt", "createdAt",
    "updatedAt",
  ],
  Rule: [
    "id", "flagKey", "name", "priority", "value", "conditions",
    "enabled", "rolloutPct", "isHoldout", "variantId",
  ],
  Segment: ["key", "description", "rules", "createdAt", "updatedAt"],
  Release: [
    "id", "name", "description", "environment", "status", "changes",
    "scheduledAt", "deployedAt", "deployedBy", "rolledBackAt",
    "rolledBackBy", "rollbackReason", "createdAt",
  ],
  Assignment: ["flagKey", "userId", "variantKey"],
  History: ["id", "flagKey", "action", "by", "at", "changes", "reason", "releaseId"],
  Impression: ["id", "flagKey", "userId", "value", "variant", "reason", "at"],
}
```
