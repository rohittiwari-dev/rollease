// Singleton Rollease client — import this from any server file.
//
// In production, replace MemoryDbAdapter with a real database adapter:
//   import { createPrismaAdapter } from 'rollease/db/prisma'
//   db: createPrismaAdapter(prismaClient)

import { createRollease } from "rollease";
import { createMemoryAdapter } from "rollease/db/memory";

export const rl = createRollease({
  db: createMemoryAdapter(),
  secret: process.env.ROLLEASE_SECRET ?? "dev-only-secret-change-in-prod",
  cache: { driver: "memory", ttl: 30 },
  logging: { level: "debug" },
});

// Seed a couple of demo flags on startup (in-memory, resets on restart).
void (async () => {
  await rl.flags.create({
    key: "new-checkout",
    type: "boolean",
    defaultValue: false,
    description: "Enable the redesigned checkout flow",
  });

  await rl.flags.create({
    key: "pricing-experiment",
    type: "multivariate",
    defaultValue: "control",
    description: "Pricing page A/B/C experiment",
    variants: [
      { key: "control", value: "control", weight: 34 },
      { key: "discount-10", value: "discount-10", weight: 33 },
      { key: "discount-20", value: "discount-20", weight: 33 },
    ],
  });

  // Enable new-checkout for 50 % of users via rollout.
  await rl.flags.setRollout("new-checkout", { percentage: 50 });
})();
