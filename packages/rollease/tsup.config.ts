import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    react: "src/frameworks/react.ts",
    next: "src/frameworks/next.ts",
    "db/adapter": "src/db/adapter.ts",
    "db/memory": "src/db/memory.ts",
    "db/redis": "src/db/redis.ts",
    "db/sequelize": "src/db/sequelize.ts",
    "db/prisma": "src/db/prisma.ts",
    "db/drizzle": "src/db/drizzle.ts",
    "db/repository": "src/db/repository.ts",
    "core/types": "src/core/types.ts",
    "core/errors": "src/core/errors.ts",
    "core/security": "src/core/security.ts",
    "engine/evaluator": "src/engine/evaluator.ts",
    "engine/manager": "src/engine/manager.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  minify: false,
  sourcemap: true,
  external: ["react", "next", "pg", "redis", "sequelize", "@prisma/client", "drizzle-orm"],
  splitting: false,
});
