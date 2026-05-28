import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    // Core
    index: "src/index.ts",
    client: "src/client/index.ts",
    handler: "src/handler.ts",
    testing: "src/testing/index.ts",
    codegen: "src/codegen/index.ts",

    // Frameworks
    react: "src/frameworks/react.ts",
    next: "src/frameworks/next.ts",
    vue: "src/frameworks/vue.ts",
    svelte: "src/frameworks/svelte.ts",
    angular: "src/frameworks/angular.ts",
    nestjs: "src/frameworks/nestjs.ts",
    "react-native": "src/frameworks/react-native.ts",
    middleware: "src/frameworks/middleware.ts",
    openfeature: "src/frameworks/openfeature.ts",

    // Database adapters
    "db/adapter": "src/db/adapter.ts",
    "db/memory": "src/db/memory.ts",
    "db/redis": "src/db/redis.ts",
    "db/sequelize": "src/db/sequelize.ts",
    "db/prisma": "src/db/prisma.ts",
    "db/drizzle": "src/db/drizzle.ts",
    "db/repository": "src/db/repository.ts",
    "db/cloudflare-kv": "src/db/cloudflare-kv.ts",

    // Core modules
    "core/types": "src/core/types.ts",
    "core/flag-types": "src/core/flag-types.ts",
    "core/errors": "src/core/errors.ts",
    "core/security": "src/core/security.ts",
    "core/logger": "src/core/logger.ts",
    "core/internal": "src/core/internal.ts",
    "core/metrics": "src/core/metrics.ts",
    "core/rbac": "src/core/rbac.ts",
    "core/openapi": "src/core/openapi.ts",
    "core/exposure": "src/core/exposure.ts",
    "core/tenant": "src/core/tenant.ts",
    "core/replica": "src/core/replica.ts",
    telemetry: "src/core/telemetry.ts",

    // Engine
    "engine/evaluator": "src/engine/evaluator.ts",
    "engine/manager": "src/engine/manager.ts",

    // Migrations
    migrations: "src/migrations/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  minify: false,
  sourcemap: true,
  external: [
    "react",
    "react-native",
    "next",
    "pg",
    "redis",
    "sequelize",
    "@prisma/client",
    "drizzle-orm",
    "vue",
    "svelte",
    "@angular/core",
    "@nestjs/common",
    "@react-native-async-storage/async-storage",
    "@react-native-community/netinfo",
  ],
  splitting: false,
});
