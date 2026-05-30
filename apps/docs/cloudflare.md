# Rollease SDK — Cloudflare Workers

Rollease ships two Cloudflare-native adapters and a fetch-compatible handler that drops straight into a Worker.

| Adapter | Module | Storage model | Best for |
|---------|--------|--------------|----------|
| **Cloudflare KV** | `rollease/db/cloudflare-kv` | Eventually-consistent key-value | Read-heavy, edge-cached flag config |
| **Cloudflare D1** | `rollease/db/cloudflare-d1` | SQLite at the edge | Strongly-consistent, queryable, supports rules + history |

---

## 1. Cloudflare D1 (recommended for serious use)

D1 is SQLite. It supports rich queries, history, releases, and impressions — the full DbAdapter surface.

### Create the database

```bash
wrangler d1 create rollease-prod
# Note the database_id; add it to wrangler.toml
```

`wrangler.toml`:
```toml
name = "my-worker"
main = "src/worker.ts"
compatibility_date = "2026-05-29"

[[d1_databases]]
binding = "DB"
database_name = "rollease-prod"
database_id = "xxxxxxxx-xxxx-..."
```

### Apply the schema

```bash
wrangler d1 execute rollease-prod --command "$(node -e 'console.log(require(\"rollease/db/cloudflare-d1\").ROLLEASE_D1_SCHEMA)')"
```

Or do it once at startup from the Worker:

```ts
import { createD1Adapter } from "rollease/db/cloudflare-d1";

export interface Env { DB: D1Database; ROLLEASE_SECRET: string }

let applied = false;
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const adapter = createD1Adapter(env.DB);
    if (!applied) {
      await adapter.applySchema();
      applied = true;
    }
    // ... continue
  }
};
```

### Wire it into Rollease

```ts
import { createRollease } from "rollease";
import { createD1Adapter } from "rollease/db/cloudflare-d1";

export interface Env {
  DB: D1Database;
  ROLLEASE_SECRET: string;
  ROLLEASE_ADMIN_TOKEN: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const rl = createRollease({
      db: createD1Adapter(env.DB),
      secret: env.ROLLEASE_SECRET,
      cache: { driver: "memory", ttl: 30 }, // L1 only — KV would add latency
    });

    const handler = rl.createHandler({
      contextFromRequest: (r) => ({
        userId: r.headers.get("x-user-id") ?? undefined,
        region: r.cf?.region as string | undefined,
      }),
      adminAuth: (r) => r.headers.get("x-admin-token") === env.ROLLEASE_ADMIN_TOKEN,
    });

    return handler(req);
  },
};
```

### Notes on D1 transactions

D1 doesn't expose interactive transactions. The adapter implements the `transaction()` shape for interface compatibility but writes execute sequentially — no rollback across statements. For multi-write operations, batch the SQL yourself:

```ts
await env.DB.batch([
  env.DB.prepare("UPDATE rl_flag SET status = ? WHERE key = ?").bind("killed", "checkout_v2"),
  env.DB.prepare("INSERT INTO rl_history (id, flagKey, action, at) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), "checkout_v2", "flag.killed", new Date().toISOString()),
]);
```

---

## 2. Cloudflare KV

KV is faster but eventually-consistent and not queryable. Good for **read-heavy public flag distribution** where strong consistency isn't required.

### Configure the binding

`wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "FLAGS_KV"
id = "xxxxxxxx..."
```

### Wire it

```ts
import { createRollease } from "rollease";
import { CloudflareKVAdapter } from "rollease/db/cloudflare-kv";

export interface Env { FLAGS_KV: KVNamespace; ROLLEASE_SECRET: string }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const rl = createRollease({
      db: new CloudflareKVAdapter(env.FLAGS_KV, { namespace: "prod" }),
      secret: env.ROLLEASE_SECRET,
    });

    const handler = rl.createHandler({
      // Public read access; no admin routes via this Worker.
      clientKeys: {
        [env.PUBLIC_CLIENT_KEY]: { requireClientVisible: true },
      },
    });
    return handler(req);
  },
};
```

### Hybrid pattern: write to D1, distribute via KV

Authoritative writes go to D1; KV holds a denormalized read replica that the public Worker serves at edge speed.

```ts
// On a flag write (server-side, in your admin app)
await prodRl.flags.update("checkout_v2", { defaultValue: true });
const snapshot = await exportFlags(prodRl.flags);  // from rollease/sync
await env.FLAGS_KV.put("snapshot:latest", JSON.stringify(snapshot));
```

```ts
// In the public Worker
const raw = await env.FLAGS_KV.get("snapshot:latest");
const snapshot = parseSnapshot(raw!);
// ... evaluate from snapshot without touching D1
```

---

## 3. Handler conveniences for Workers

### CORS for cross-origin browsers

```ts
const handler = rl.createHandler({
  cors: "https://app.example.com",  // or "*", or false to disable
});
```

### IP allowlist for admin routes

Workers see the client IP via `cf-connecting-ip` (the handler reads this automatically):

```ts
const handler = rl.createHandler({
  adminAuth: (r) => r.headers.get("x-admin-token") === env.ADMIN_TOKEN,
  adminIPAllowlist: [
    "203.0.113.5",        // ops laptop
    "10.0.0.0/8",         // VPN range
  ],
});
```

### Read context from CF metadata

```ts
const handler = rl.createHandler({
  contextFromRequest: (r) => ({
    userId: r.headers.get("x-user-id") ?? undefined,
    region: r.cf?.region as string | undefined,
    ip: r.headers.get("cf-connecting-ip") ?? undefined,
    attributes: {
      country: r.cf?.country,
      colo: r.cf?.colo,
      asn: r.cf?.asn,
    },
  }),
});
```

---

## 4. Durable Object for cross-Worker invalidation

Workers are stateless — when you mutate a flag, other isolates won't see the change until L1 TTL expires. To force invalidation across all isolates, publish through a Durable Object as your `InvalidationBus`:

```ts
import type { InvalidationBus, InvalidationMessage } from "rollease/db/adapter";

export class FlagBus {
  private listeners = new Set<WebSocket>();
  constructor(private state: DurableObjectState) {}

  async fetch(req: Request) {
    const url = new URL(req.url);
    if (url.pathname === "/publish") {
      const msg = await req.json();
      for (const ws of this.listeners) ws.send(JSON.stringify(msg));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/subscribe") {
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      this.listeners.add(server);
      server.addEventListener("close", () => this.listeners.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("not found", { status: 404 });
  }
}

class DOInvalidationBus implements InvalidationBus {
  constructor(private stub: DurableObjectStub) {}
  async publish(msg: InvalidationMessage) {
    await this.stub.fetch("https://do/publish", { method: "POST", body: JSON.stringify(msg) });
  }
  subscribe(/* ... */) {
    // open WebSocket, forward messages
    // (sketch — implement based on your DO routing)
    return () => {};
  }
}
```

---

## 5. Local development

```bash
# Test the Worker locally with miniflare's D1 emulation
wrangler dev --local --persist
```

In dev, the in-memory `MemoryDbAdapter` is faster than D1 for tight iteration:

```ts
import { createMemoryAdapter } from "rollease";

const db = env.ENVIRONMENT === "development"
  ? createMemoryAdapter()
  : createD1Adapter(env.DB);
```

---

## Performance characteristics

| Operation | KV | D1 | Memory |
|-----------|-----|------|--------|
| Single flag read (cached) | ~5ms | ~10ms | <1ms |
| Single flag read (uncached) | ~30ms (cold) | ~10ms | <1ms |
| Bulk evaluateAll (100 flags) | ~50ms | ~20ms | <2ms |
| Mutation | ~150ms (replication) | ~15ms | <1ms |
| Consistency | Eventual (~60s) | Strong (region-local) | Strong |

Rule of thumb: **D1 for the source of truth + L1 memory cache for hot reads**. Add KV only when you need true edge distribution of public-facing flags.
