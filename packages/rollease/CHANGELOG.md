# Changelog

All notable changes to this project will be documented in this file.

## [0.0.0-alpha.0] - 2026-05-27

### Added
- Initial alpha release of the Rollease feature flag SDK.
- Layered cache cascade architecture supporting L1 (in-process memory cache) and L2 (Redis cache).
- Multi-database adapter layer with native support for:
  - In-Memory adapter (`MemoryDbAdapter`)
  - Sequelize (PostgreSQL) adapter (`SequelizeDbAdapter`)
  - Prisma adapter (`PrismaDbAdapter`)
  - Drizzle adapter (`DrizzleDbAdapter`)
- Core targeting and evaluation engine:
  - 9-step evaluation pipeline (kill switches, schedule date windows, overrides, sticky assignments, rules, and rollouts).
  - Flexible rule operator suite (`eq`, `neq`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `contains`, `startsWith`, `endsWith`, `regex`, `semverGte`, `semverLte`, `exists`, `dateAfter`, `dateBefore`).
- Advanced Security and ReDoS Prevention:
  - Safe regex check (`safeRegexTest`) guarding against Regular Expression Denial of Service (ReDoS).
  - Condition group depth and node size assertions (`assertSafeConditionGroup`) checking rule & segment complexity limits.
- Framework-specific integrations:
  - **React**: Context `RolleaseProvider`, hooks (`useFlag`, `useVariant`, `useFlags`, `useFlagDetails`), and declarative `<FeatureGate />`.
  - **Next.js**: Edge middleware evaluator and React Server Components (RSC) header/cookie readers.
- 100% statement coverage test suite using Vitest.
