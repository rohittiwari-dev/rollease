// Edge-compatible Rollease client — used only in middleware (no Node APIs).
// The MemoryDbAdapter is suitable for demo/edge use; replace with a KV
// adapter (Cloudflare KV, Vercel Edge Config) in production.

import { createRollease } from "rollease";
import { createMemoryAdapter } from "rollease/db/memory";

export const rl = createRollease({
  db: createMemoryAdapter(),
  secret: process.env.ROLLEASE_SECRET ?? "dev-only-secret-change-in-prod",
});
