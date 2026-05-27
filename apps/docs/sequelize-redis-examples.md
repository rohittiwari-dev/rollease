# Sequelize and Redis Adapter Examples

Rollease can own its Sequelize models, or you can pass existing Sequelize models that match the adapter contract.

## Without Passing Models

Use this when you want Rollease to define its own tables.

```ts
import { Sequelize } from "sequelize";
import {
  createRollease,
  createSequelizeAdapter,
} from "rollease";

const sequelize = new Sequelize(process.env.DATABASE_URL!, {
  dialect: "postgres",
  logging: false,
});

const db = createSequelizeAdapter({
  sequelize,
  tablePrefix: "rollease_",
  sync: { alter: true },
});

export const rollease = createRollease({
  db,
  secret: process.env.ROLLEASE_SECRET!,
  cache: {
    driver: "redis",
    redis: { url: process.env.REDIS_URL! },
    ttl: 60,
  },
});
```

## With Models Passed

Use this when your app owns model definitions or migrations.

```ts
import { DataTypes, Sequelize } from "sequelize";
import {
  createRollease,
  createSequelizeAdapter,
  ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS,
} from "rollease";

const sequelize = new Sequelize(process.env.DATABASE_URL!, {
  dialect: "postgres",
  logging: false,
});

const FlagModel = sequelize.define("FeatureFlag", {
  id: { type: DataTypes.STRING, primaryKey: true },
  key: { type: DataTypes.STRING, unique: true, allowNull: false },
  type: { type: DataTypes.STRING, allowNull: false },
  status: { type: DataTypes.STRING, allowNull: false },
  defaultValue: { type: DataTypes.JSON, allowNull: false },
  description: DataTypes.TEXT,
  namespace: DataTypes.STRING,
  tags: DataTypes.JSON,
  locked: DataTypes.BOOLEAN,
  lockedReason: DataTypes.TEXT,
  environments: DataTypes.JSON,
  variants: DataTypes.JSON,
  rollout: DataTypes.JSON,
  scheduledAt: DataTypes.DATE,
  expiresAt: DataTypes.DATE,
  createdAt: { type: DataTypes.DATE, allowNull: false },
  updatedAt: { type: DataTypes.DATE, allowNull: false },
}, {
  tableName: "feature_flags",
  timestamps: false,
});

// Define the remaining models with the required columns listed below.
const RuleModel = sequelize.define("FeatureFlagRule", { /* ... */ });
const SegmentModel = sequelize.define("FeatureFlagSegment", { /* ... */ });
const ReleaseModel = sequelize.define("FeatureFlagRelease", { /* ... */ });
const AssignmentModel = sequelize.define("FeatureFlagAssignment", { /* ... */ });
const HistoryModel = sequelize.define("FeatureFlagHistory", { /* ... */ });
const ImpressionModel = sequelize.define("FeatureFlagImpression", { /* ... */ });

const db = createSequelizeAdapter({
  sequelize,
  models: {
    Flag: FlagModel,
    Rule: RuleModel,
    Segment: SegmentModel,
    Release: ReleaseModel,
    Assignment: AssignmentModel,
    History: HistoryModel,
    Impression: ImpressionModel,
  },
  validateColumns: true,
  sync: false,
});

export const rollease = createRollease({
  db,
  secret: process.env.ROLLEASE_SECRET!,
});

console.log(ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS.Flag);
```

You may pass only some models. Rollease defines any model you omit:

```ts
const db = createSequelizeAdapter({
  sequelize,
  models: {
    Flag: FlagModel,
  },
});
```

## Column Validation

`validateColumns` defaults to `true`. The adapter checks Sequelize model attributes through `getAttributes()`, `rawAttributes`, or `tableAttributes`.

```ts
const db = createSequelizeAdapter({
  sequelize,
  models,
  validateColumns: true,
});
```

If a required column is missing, the adapter throws `ValidationError` before running flag operations.

Disable validation only when a custom model wrapper does not expose attributes but is known to be compatible:

```ts
const db = createSequelizeAdapter({
  sequelize,
  models,
  validateColumns: false,
});
```

## Required Columns

```ts
import { ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS } from "rollease";

console.log(ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS);
```

Current required attributes:

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

## Direct Redis Cache Adapter

`createRollease({ cache: { driver: "redis" } })` creates the Redis cache internally. If you need to pass a cache instance directly to `FlagManager`, use:

```ts
import { FlagManager, createRedisCache } from "rollease";

const flags = new FlagManager({
  db,
  l2Cache: createRedisCache({
    url: process.env.REDIS_URL!,
    keyPrefix: "myapp:",
  }),
});
```
