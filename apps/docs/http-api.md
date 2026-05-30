# Rollease SDK — HTTP API Reference

> **Created by:** `rl.createHandler(options?)` → a fetch-compatible `(Request) => Promise<Response>` handler.
> **Default mount path:** `/api/rollease` (override with `basePath`).

`createHandler()` turns a Rollease client into a complete REST API: public flag **evaluation** for browsers/clients, and **admin** routes for flag/rule/segment/release management — all behind a layered auth model with first-class RBAC. It speaks the Fetch API, so it drops into Next.js App Router, Hono, Bun, Cloudflare Workers, Deno, or any runtime that hands you a `Request`.

---

## Mounting the handler

**Next.js App Router** — `app/api/rollease/[...path]/route.ts`:

```ts
import { rl } from '@/lib/rollease'

const handler = rl.createHandler({
  contextFromRequest: async (req) => ({ userId: await getServerUserId(req) }),
  adminAuth: async (req) => req.headers.get('x-admin-token') === process.env.ADMIN_TOKEN,
})

export const GET = handler
export const POST = handler
export const PATCH = handler
export const DELETE = handler
```

**Hono / Bun.serve:**

```ts
const handler = rl.createHandler({ contextFromRequest })
app.all('/api/rollease/*', (c) => handler(c.req.raw))
```

**Cloudflare Workers:** see [Cloudflare guide](cloudflare.md).

> The handler also answers `OPTIONS` (CORS preflight) with `204`. Mount all four methods (`GET`/`POST`/`PATCH`/`DELETE`) so admin routes work.

---

## The auth model

There are **three tiers** of routes. Each has its own gate:

| Tier | Routes | Gate |
|------|--------|------|
| **Public eval** | `GET /flags`, `GET /flags/stream`, `GET /flags/:key`, `POST /events` | Open by default; require a **client key** when `clientKeys` is configured |
| **Health** | `GET /health` (and `GET /`) | Open by default; gated by `healthAuth` when provided |
| **Admin** | everything under `/admin/*`, plus `GET /metrics` and `GET /openapi.json` | `adminIPAllowlist` (if set) **then** `adminAuth`, and per-action RBAC via the `onBeforeMutation` hook |

### How an admin request is authorized

```
admin request
   │
   ├─ 1. adminIPAllowlist set?  ── IP not on list ─→ 403 "IP not allowlisted"
   │                               (fails closed if the IP can't be read)
   │
   ├─ 2. adminAuth(req)         ── not configured ─→ 401 "Unauthorized"
   │                            ── returns false / throws ─→ 401
   │
   ├─ 3. extractActor(req)      ── produces the AuditActor passed to the write
   │
   └─ 4. onBeforeMutation hook  ── RBAC policy denies the action ─→ 400 (hook throws)
```

Steps 1–2 keep unauthenticated callers off admin routes entirely. Steps 3–4 enforce **per-operation** permissions: the handler passes the extracted `actor` into every manager write, and `createRBACHook(policy)` checks the action→permission mapping, throwing to abort.

### Wiring RBAC (recommended admin setup)

```ts
import {
  createDefaultRBACPolicy, createRBACHook, createRBACAdminAuth,
} from 'rollease'

const policy = createDefaultRBACPolicy({
  'u_alice': 'admin', 'u_bob': 'editor', 'u_carol': 'viewer',
})

// 1. Per-action permission checks on every write:
export const rl = createRollease({
  db, secret: process.env.ROLLEASE_SECRET!,
  hooks: { onBeforeMutation: createRBACHook(policy) },
})

// 2. Gate admin routes + identify the actor:
const extractActor = async (req: Request) => {
  const session = await getSession(req)
  return session ? { id: session.userId, type: 'user' as const, name: session.name } : undefined
}

const handler = rl.createHandler({
  extractActor,
  adminAuth: createRBACAdminAuth(policy, extractActor), // requires flag.create (editor+)
  contextFromRequest: async (req) => ({ userId: await getServerUserId(req) }),
})
```

See the full role/permission matrix in the **[RBAC guide](rbac.md)**.

---

## Handler options

```ts
rl.createHandler(options?: RolleaseHandlerOptions)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `contextFromRequest` | `(req) => FlagContext \| Promise<FlagContext>` | — | Build the evaluation context. When omitted, the handler falls back to the `X-Rollease-Context` header or `?context=` query param (base64url-encoded JSON). |
| `adminAuth` | `(req) => boolean \| Promise<boolean>` | — | Authorize admin (write) routes. Return `true` to allow. When omitted, **all admin routes return 401**. |
| `extractActor` | `(req) => AuditActor \| undefined \| Promise<…>` | — | Extract the actor passed to manager writes (for RBAC + audit history). |
| `basePath` | `string` | `'/api/rollease'` | Path prefix stripped before route matching. |
| `cors` | `string \| false` | `'*'` | CORS `Access-Control-Allow-Origin`. `false` disables CORS headers. |
| `clientKeys` | `Record<string, RolleasePublicClientKeyConfig>` | — | When set, public eval/event routes require a valid client key. |
| `healthAuth` | `(req) => boolean \| Promise<boolean>` | — | Gate `GET /health`. When omitted, health is public. |
| `adminIPAllowlist` | `string[]` | — | Restrict admin routes to these IPs / IPv4 CIDR ranges. Checked **before** `adminAuth`. Fails closed when the client IP can't be read. |
| `getClientIP` | `(req) => string \| undefined` | — | Override client-IP extraction (default order: `cf-connecting-ip` → `x-real-ip` → `x-forwarded-for`). |

```ts
interface RolleasePublicClientKeyConfig {
  flags?: string[]          // explicit allow-list of evaluatable keys
  environments?: string[]   // restrict to these environments
  requireClientVisible?: boolean  // default true — only flags with clientVisible:true
  context?: FlagContext | ((req: Request) => FlagContext | Promise<FlagContext>)  // server-owned context, merged over caller context
}
```

---

## Public routes

> When `clientKeys` is configured, these require `X-Rollease-Client-Key: <key>` (or `?clientKey=<key>`). Without a valid key → `401`. The key's `flags`/`environments`/`requireClientVisible` constrain what can be evaluated, and its `context` is merged **over** the caller-supplied context.

### `GET /health` (and `GET /`)

Health probe. Public unless `healthAuth` is set. Returns `200` with the [health result](observability.md#4-health-probe), or `503` when `status` is `unhealthy`.

### `GET /flags`

Evaluate all visible flags for the resolved context.

- **Response:** `200 { flags: DetailedFlagMap, ts: number }` — each entry is a full `FlagResult`.
- **Caching:** responds with an `ETag`; send `If-None-Match` to get `304 Not Modified`.
- **Context:** from `contextFromRequest`, else `X-Rollease-Context` header / `?context=` (base64url JSON).

```bash
curl 'https://app.example.com/api/rollease/flags' \
  -H 'X-Rollease-Context: eyJ1c2VySWQiOiJ1X2FsaWNlIn0'   # base64url({"userId":"u_alice"})
```

### `GET /flags/stream`

Server-Sent Events stream. Pushes `data: { flags, ts }` immediately and again on **every** flag change (wired to `onChange`). `Content-Type: text/event-stream`.

```ts
const es = new EventSource('/api/rollease/flags/stream')
es.onmessage = (e) => applyFlags(JSON.parse(e.data).flags)
```

### `GET /flags/:key`

Evaluate a single flag. `200 { ...FlagResult, ts }`, or `404` when the flag is missing or not permitted by the client key.

### `POST /events`

Record a custom conversion/analytics event (single or batch). `204 No Content`.

```jsonc
// single
{ "event": "purchase", "userId": "u_alice", "value": 49.99, "metadata": { "sku": "pro" } }
// batch
{ "events": [ { "event": "view" }, { "event": "click" } ] }
```

`userId` falls back to the resolved context's `userId`. Missing `event` → `400`.

---

## Admin routes

All require the [admin gate](#how-an-admin-request-is-authorized). Mutations carry the extracted `actor` into the manager so the RBAC hook and audit history see it.

### Flags

| Method & path | Body / query | Success | Notes |
|---------------|--------------|---------|-------|
| `GET /admin/flags` | `?namespace&status&search&limit&offset` | `200 { flags, total, hasMore, ts }` | List with filters |
| `POST /admin/flags` | `CreateFlagInput` | `201 Flag` | Create |
| `GET /admin/flags/:key` | — | `200 { ...Flag, rules, ts }` | Flag + its rules; `404` if missing |
| `PATCH /admin/flags/:key` | `UpdateFlagInput` | `200 Flag` | Update (lock fields stripped) |
| `DELETE /admin/flags/:key` | — | `204` | **Archives** (soft delete), not hard delete |
| `POST /admin/flags/:key/kill` | `{ reason?, killedBy? }` | `204` | Kill switch |
| `POST /admin/flags/:key/restore` | `{ reason? }` | `204` | Restore killed/archived |
| `POST /admin/flags/:key/lock` | `{ locked, reason? }` | `204` | Lock/unlock |
| `GET /admin/flags/:key/history` | — | `200 { history, ts }` | Audit trail |

> There is **no hard-delete route** — `DELETE` archives. Use `rl.flags.delete(key, { confirm: true })` programmatically if you truly need to purge.

### Rules

| Method & path | Body | Success |
|---------------|------|---------|
| `GET /admin/flags/:key/rules` | — | `200 { rules, ts }` |
| `POST /admin/flags/:key/rules` | `AddRuleInput` | `201 FlagRule` |
| `PATCH /admin/flags/:key/rules/:ruleId` | `UpdateRuleInput` | `200 FlagRule` |
| `DELETE /admin/flags/:key/rules/:ruleId` | — | `204` |
| `POST /admin/flags/:key/rollout` | `{ rollout }` or a `RolloutConfig` directly | `204` |

### Segments

| Method & path | Body | Success |
|---------------|------|---------|
| `GET /admin/segments` | — | `200 { segments, ts }` |
| `POST /admin/segments` | `CreateSegmentInput` | `201 Segment` |
| `PATCH /admin/segments/:key` | `UpdateSegmentInput` | `200 Segment` |
| `DELETE /admin/segments/:key` | — | `204` |

### Releases

| Method & path | Body / query | Success |
|---------------|--------------|---------|
| `GET /admin/releases` | `?environment&status&limit` | `200 { releases, ts }` |
| `POST /admin/releases` | `CreateReleaseInput` | `201 Release` |
| `POST /admin/releases/:id/deploy` | `{ deployedBy? }` | `204` |
| `POST /admin/releases/:id/rollback` | `{ rolledBackBy?, reason? }` | `204` |
| `POST /admin/releases/:id/approve` | `{ approverId? }` | `200 Release` |
| `POST /admin/releases/:id/reject` | `{ rejectorId?, reason? }` | `200 Release` |

> `approve`/`reject` default the approver/rejector id to the extracted actor's `id` when the body omits it. Deploying a release with `requiresApproval: true` before approval returns `400` (a `ReleaseConflictError`).

### Operations & introspection

| Method & path | Auth | Success | Notes |
|---------------|------|---------|-------|
| `GET /metrics` | Admin | `200 text/plain` | Prometheus exposition; empty unless a `metrics` adapter is configured |
| `GET /admin/users/:userId/impressions` | Admin | `200 { userId, impressions, ts }` | `?limit&flagKey`; GDPR right-to-explanation |
| `GET /openapi.json` | Admin | `200 application/json` | Generated OpenAPI spec for these routes |

---

## Status codes

| Code | When |
|------|------|
| `200` | Success (GET/PATCH, approve/reject) |
| `201` | Resource created (flag, rule, segment, release) |
| `204` | Success with no body (kill, restore, lock, delete/archive, rollout, events, deploy, rollback) |
| `304` | `GET /flags` with a matching `If-None-Match` ETag |
| `400` | Invalid body, validation failure, or a write denied by the RBAC hook |
| `401` | Missing/invalid client key (public routes) or failed `adminAuth` / `healthAuth` |
| `403` | Admin request from an IP not on `adminIPAllowlist` |
| `404` | Unknown flag (eval), unknown admin resource, or unmatched route |
| `503` | `GET /health` when status is `unhealthy` |

**Error body:** `{ "error": "<message>" }`. For admin writes the handler **masks** internal errors — only validation-class messages (`ValidationError`, `FlagNotFoundError`, `FlagLockedError`, `FlagConflictError`, `ReleaseConflictError`, `RuleNotFoundError`, `SegmentNotFoundError`) are surfaced; everything else becomes a generic message. Note this means validation failures over HTTP return **`400`**, even though the underlying `ValidationError.statusCode` is `422` (see [Error Handling](error-handling.md)).

---

## CORS

By default the handler adds permissive CORS headers (`Access-Control-Allow-Origin: *`) and answers preflight `OPTIONS` with `204`. Lock it down per origin, or disable entirely:

```ts
rl.createHandler({ cors: 'https://app.example.com' }) // single origin
rl.createHandler({ cors: false })                     // no CORS headers
```

Allowed methods: `GET, POST, PATCH, DELETE, OPTIONS`. Allowed headers include `Content-Type, Authorization, X-Rollease-Context, X-Rollease-Client-Key`.

---

## IP allowlisting admin routes

```ts
rl.createHandler({
  adminAuth: (r) => r.headers.get('x-admin-token') === process.env.ADMIN_TOKEN,
  adminIPAllowlist: ['203.0.113.5', '10.0.0.0/8'], // single IPs + IPv4 CIDR
})
```

The client IP is read from `cf-connecting-ip` → `x-real-ip` → `x-forwarded-for` (first entry), or your `getClientIP`. When the allowlist is set but no IP can be read, the request is **denied** (fails closed). IPv6 and unparseable CIDRs fall back to exact-string match so a typo never widens access.

---

## Related

- **[RBAC](rbac.md)** — roles, permissions, policies, and the `adminAuth`/`onBeforeMutation` wiring.
- **[API Reference](api-reference.md)** — the `rl.flags.*` methods these routes call.
- **[Observability](observability.md)** — `/metrics`, `/health`, and audit logging.
- **[Cloudflare](cloudflare.md)** — running the handler in a Worker.
