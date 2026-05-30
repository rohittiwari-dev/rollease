# Rollease SDK — Role-Based Access Control

> **Module:** `rollease` (RBAC exports re-exported from `rollease/core/rbac`)

RBAC in Rollease has three layers:

1. **A policy** — answers `can this actor do X to flag Y?`
2. **A mutation hook** — wraps every write so a policy denial aborts it
3. **An admin gate** — keeps unauthenticated callers off admin HTTP routes

You wire them together once at startup.

---

## Quick start (in-memory policy)

```ts
import {
  createRollease,
  createMemoryAdapter,
  createDefaultRBACPolicy,
  createRBACHook,
  createRBACAdminAuth,
} from "rollease";

// 1. Define who has which role.
const policy = createDefaultRBACPolicy({
  "u_alice": "admin",
  "u_bob":   "editor",
  "u_carol": "viewer",
});

// 2. Wire the mutation hook.
const rl = createRollease({
  db: createMemoryAdapter(),
  secret: process.env.ROLLEASE_SECRET!,
  hooks: { onBeforeMutation: createRBACHook(policy) },
});

// 3. Gate admin HTTP routes.
const handler = rl.createHandler({
  extractActor: async (req) => {
    const session = await getSession(req);
    return session ? { id: session.userId, type: "user", name: session.name } : undefined;
  },
  adminAuth: createRBACAdminAuth(policy, async (req) => {
    const s = await getSession(req);
    return s ? { id: s.userId } : undefined;
  }),
});
```

That's it. Now:

- `rl.flags.create({ ..., actor: { id: "u_alice", type: "user" } })` — succeeds (admin).
- `rl.flags.create({ ..., actor: { id: "u_carol", type: "user" } })` — throws (viewer lacks `flag.create`).
- `POST /api/rollease/admin/flags` with Carol's session — returns 401.

---

## Built-in roles

| Role | Permissions |
|------|-------------|
| `viewer` | `flag.read` |
| `editor` | `flag.read`, `flag.create`, `flag.update`, `flag.kill`, `flag.restore`, `flag.lock`, `rule.manage`, `rollout.manage`, `segment.manage`, `tag.manage`, `release.create`, `release.approve`, `release.reject` |
| `admin` | All editor permissions + `flag.delete`, `release.deploy`, `release.rollback`, `webhook.manage` |
| `owner` | All admin permissions + `admin.full` (wildcard match for any permission) |

---

## Permissions reference

```
flag.read           List + read flags
flag.create         Create a new flag
flag.update         Modify flag settings
flag.delete         Permanently delete a flag (admin+)
flag.kill           Set status to "killed"
flag.restore        Restore a killed/archived flag
flag.lock           Use setLock() to lock/unlock
rule.manage         Add/update/remove/reorder rules
rollout.manage      Change rollout percentage, sticky, hashKey
segment.manage      CRUD segments
release.create      Create a release
release.deploy      Deploy a release (admin+)
release.rollback    Rollback a deployed release (admin+)
release.approve     Approve a release that requires approval
release.reject      Reject a release that requires approval
webhook.manage      CRUD webhooks (admin+)
tag.manage          Add/remove tags on flags
admin.full          Wildcard — grants everything (owner only)
```

---

## Customizing the permission matrix

Extend or override the defaults:

```ts
const policy = createDefaultRBACPolicy(
  { "u_release_mgr": "release-manager" as any },
  {
    permissions: {
      // Custom role: "release-manager" — can deploy but can't create flags.
      "release-manager" as any: [
        "flag.read",
        "release.create",
        "release.deploy",
        "release.rollback",
        "release.approve",
      ],
    },
  }
);
```

### Default role for unknown users

```ts
const policy = createDefaultRBACPolicy(
  { /* explicit role map */ },
  { defaultRole: "viewer" }      // anyone not in the map gets read-only
);
```

---

## Custom policy (database-backed)

For real apps, your roles live in Postgres / your auth provider. Implement `RolleaseRBACPolicy` directly:

```ts
import type { RolleaseRBACPolicy, RolleasePermission } from "rollease";

const policy: RolleaseRBACPolicy = {
  async check(actor, permission, resource) {
    if (!actor?.id) return false;

    // Fetch the user's permissions from your DB.
    const userPerms = await db.query.permissions.findMany({
      where: eq(schema.permissions.userId, actor.id),
    });

    // Optional: scope by resource — e.g. only allow if the user owns the flag.
    if (resource?.flagKey) {
      const flagOwner = await db.query.flags.findFirst({
        where: eq(schema.flags.key, resource.flagKey),
      });
      if (flagOwner?.ownerId !== actor.id && !userPerms.some(p => p.permission === "admin.full")) {
        return false;
      }
    }

    return userPerms.some((p) => p.permission === permission || p.permission === "admin.full");
  },
};
```

---

## How the actor flows

Every write method takes an optional `actor`. The HTTP handler extracts it once via `extractActor`:

```ts
const handler = rl.createHandler({
  extractActor: async (req) => {
    const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!jwt) return undefined;
    const payload = await verifyJWT(jwt);
    return { id: payload.sub, type: "user", name: payload.name };
  },
  adminAuth: createRBACAdminAuth(policy, async (req) => {
    const a = await extractActor(req);
    return a ? { id: a.id } : undefined;
  }),
});
```

Then on every admin route, the handler:
1. Calls `adminAuth(req)` — RBAC checks for `flag.create` (editor+).
2. Calls `extractActor(req)` — produces the `AuditActor`.
3. Passes the actor to the manager method.
4. `onBeforeMutation` runs the per-permission RBAC check.
5. The mutation proceeds (or throws).
6. The actor is recorded in the history entry.

---

## Programmatic actor (server-side mutations from your app)

When you call the manager directly (not via HTTP), pass an actor explicitly so the RBAC hook can authorize:

```ts
await rl.flags.create({
  key: "checkout_v2",
  type: "boolean",
  defaultValue: false,
  actor: { id: "u_alice", type: "user", name: "Alice" },
});

// For automated jobs:
await rl.flags.kill("checkout_v2", {
  actor: { id: "incident-bot", type: "service" },
  reason: "PagerDuty alert P1-1234",
});
```

A `system` actor type bypasses no checks — it's a label, not a privilege escalation. Map system IDs to roles in your policy.

---

## Combining with other hooks

`onBeforeMutation` runs **before** the write. If you have multiple hooks (RBAC + audit + custom telemetry), compose them:

```ts
const rbacHook = createRBACHook(policy);

const rl = createRollease({
  hooks: {
    onBeforeMutation: async (ctx) => {
      // 1. RBAC denies first.
      await rbacHook(ctx);
      // 2. Custom rate limiting.
      await checkRateLimit(ctx.actor?.id);
      // 3. Custom telemetry.
      metrics.increment("flag.mutation.attempted", { action: ctx.action });
    },
  },
});
```

Throwing from any composed step aborts the mutation with that error.

---

## Testing RBAC

```ts
import { describe, it, expect } from "vitest";
import { createMemoryAdapter, createRollease, createDefaultRBACPolicy, createRBACHook } from "rollease";

describe("RBAC", () => {
  it("viewers cannot create flags", async () => {
    const policy = createDefaultRBACPolicy({ "u_viewer": "viewer" });
    const rl = createRollease({
      db: createMemoryAdapter(),
      secret: "x".repeat(16),
      hooks: { onBeforeMutation: createRBACHook(policy) },
    });

    await expect(
      rl.flags.create({
        key: "test",
        type: "boolean",
        defaultValue: false,
        actor: { id: "u_viewer", type: "user" },
      })
    ).rejects.toThrow(/does not have permission/);
  });
});
```
