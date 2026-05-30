# Rollease SDK — Client & Server

> How flag evaluation is split between your **server** (which owns the database and secret) and your **browser/client** (which never sees either) — and the **internal API** that connects them.

Rollease evaluates flags **on the server** and hands results to the client. The browser never holds a DB connection, the signing secret, or your targeting rules — it only receives evaluated values. There are two planes:

```
┌──────────────────────────── SERVER ─────────────────────────────┐
│  createRollease({ db, secret })          ← DB access + secret    │
│  rl.flags.isEnabled() / evaluateAll()    ← direct evaluation     │
│  rl.createHandler()                      ← exposes the internal  │
│                                             REST API (http-api)  │
└─────────────────────────────┬───────────────────────────────────┘
                              │  HTTP (evaluated values only)
                              │  GET /flags · /flags/stream · POST /events
                              ▼
┌──────────────────────────── CLIENT ─────────────────────────────┐
│  createRolleaseClient({ baseUrl })       ← browser, no DB/secret │
│  rlClient.flag('key', false)             ← sync read             │
│  <RolleaseProvider client={rlClient}>    ← React, real-time      │
└──────────────────────────────────────────────────────────────────┘
```

The connective tissue is the **internal API** — the routes produced by `rl.createHandler()` (documented in full in the [HTTP API Reference](http-api.md)). The browser client (`rollease/client`) is a purpose-built consumer of those routes.

---

## Where each API can be used

| API | Import | Runs | Needs DB/secret | Use it for |
|-----|--------|------|-----------------|------------|
| `createRollease` / `rl.flags.*` | `rollease` | **Server only** | ✅ | Direct evaluation in API routes, RSC, jobs, cron |
| `rl.createHandler()` | `rollease` | **Server** (any fetch runtime) | ✅ | Exposing the internal REST API to browsers/other services |
| `createRolleaseClient` | `rollease/client` | **Browser** (or any fetch env) | ❌ | Fetching evaluated flags + streaming + analytics from the internal API |
| `RolleaseProvider` / hooks | `rollease/react` | **Browser** + RSC | ❌ | Consuming flags in React |
| `evaluateFlag` | `rollease` | **Anywhere** (pure) | ❌ | Evaluating a `Flag` you already loaded, with no I/O |

> ⚠️ Never import `rollease` (the server entry, `createRollease`) into client/browser bundles — it carries DB adapters and the secret path. In the browser, import only from `rollease/client` and `rollease/react`.

---

## Choosing a pattern

| Pattern | How | Real-time? | Best for |
|---------|-----|-----------|----------|
| **Server-direct** | Call `rl.flags.*` on the server | n/a | API routes, server actions, RSC, cron |
| **SSR hydration** | Evaluate on server → pass `initialFlags` to `<RolleaseProvider>` | No (static snapshot) | SSR pages where flags are fixed for the request |
| **Live browser client** | `createRolleaseClient` → `<RolleaseProvider client>` | ✅ SSE/polling | SPAs, dashboards, anything that should react to flag changes |
| **Next.js middleware** | Signed header/cookie transport | Per request | Full-stack Next.js (see [Developer Guide §8](developer-guide.md#8-nextjs-full-stack-integration)) |

You can combine them — e.g. SSR-hydrate `initialFlags` for first paint **and** attach a live `client` for subsequent updates.

---

## 1. Server: expose the internal API

Mount `rl.createHandler()` at a catch-all route. This is what the browser client talks to. See the [HTTP API Reference](http-api.md) for every route and the auth model.

```ts
// app/api/rollease/[...path]/route.ts  (Next.js App Router)
import { rl } from '@/lib/rollease'

const handler = rl.createHandler({
  // Server-owned context merged into every public evaluation.
  contextFromRequest: async (req) => ({ userId: await getServerUserId(req) }),

  // Gate public eval/event routes with browser-safe client keys.
  clientKeys: {
    [process.env.ROLLEASE_PUBLIC_KEY!]: { requireClientVisible: true },
  },
})

export const GET = handler
export const POST = handler
```

### The security boundary

The browser only ever reaches the **public** routes (`GET /flags`, `GET /flags/:key`, `GET /flags/stream`, `POST /events`). Two layers keep it safe:

- **`clientKeys`** — when configured, public routes require `X-Rollease-Client-Key`. Each key can be scoped to specific `flags`, `environments`, and (default) only flags marked `clientVisible: true`.
- **`clientVisible`** — set `clientVisible: true` on a flag to allow it through public client keys. Flags without it are never exposed to the browser.

```ts
await rl.flags.create({
  key: 'new_checkout',
  type: 'boolean',
  defaultValue: false,
  clientVisible: true,   // ← may be served to browsers via a client key
})
```

> A public client key is **not a secret** — treat it like a publishable key. It only permits evaluating the flags you allow-listed; it can't read admin routes, rules, or the DB.

---

## 2. Browser client — `rollease/client`

`createRolleaseClient` is a zero-dependency browser client that fetches evaluated flags from the handler, optionally streams updates over SSE, caches to `localStorage`, and batches analytics events. It calls `GET {baseUrl}/flags`, `GET {baseUrl}/flags/stream`, and `POST {baseUrl}/events`.

```ts
// lib/rollease-client.ts  (shared by client components)
import { createRolleaseClient } from 'rollease/client'

export const rlClient = createRolleaseClient({
  baseUrl: '/api/rollease',                 // where you mounted createHandler()
  context: () => ({ userId: getCurrentUserId() }),
  clientKey: process.env.NEXT_PUBLIC_ROLLEASE_KEY,
  streaming: true,                          // real-time via SSE
  localStorage: true,                       // zero-flicker on reload
})
```

```ts
// Vanilla JS (no React):
await rlClient.ready()
if (rlClient.flag('new_checkout', false)) renderNewCheckout()

rlClient.track('purchase', { value: 49.99 })
```

### Config (`RolleaseClientConfig`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | — (required) | Base path of the mounted handler, e.g. `/api/rollease` |
| `context` | `FlagContext \| () => FlagContext \| Promise<FlagContext>` | `{}` | Context sent with each request (static or factory) |
| `clientKey` | `string` | — | Public client key (sent as `X-Rollease-Client-Key`) |
| `streaming` | `boolean` | `false` | Subscribe to `/flags/stream` (SSE) for real-time updates |
| `refreshInterval` | `number` | `0` | Poll interval (ms); `0` disables. Used as fallback when not streaming |
| `localStorage` | `boolean` | `false` | Cache flags in `localStorage` for instant first paint |
| `localStorageKey` | `string` | `'rollease:flags'` | Storage key |
| `headers` | `Record<string,string>` | — | Extra headers on every request |
| `eventBatchSize` | `number` | `10` | Flush analytics after N events |
| `eventFlushIntervalMs` | `number` | `5000` | Max delay before flushing events |
| `anonymousId` | `string` | auto | Stable anon id (auto-generated + persisted to `localStorage` when omitted) |
| `onFlagsChange` | `(flags: DetailedFlagMap) => void` | — | Called after each refresh |
| `onError` | `(err: Error) => void` | — | Called on fetch/stream errors |

> When the resolved context has no `userId`, the client substitutes a stable `anonymousId` so percentage rollouts bucket consistently before sign-in.

### Methods (`RolleaseBrowserClient`)

| Method | Description |
|--------|-------------|
| `flag<T>(key, defaultValue)` | Synchronous read of the evaluated value (returns the default before `ready()`) |
| `flags()` | Current `key → value` map |
| `flagDetails()` | Current `key → FlagResult` map (value, variant, reason) |
| `ready()` | Resolves after the first successful fetch |
| `refetch()` | Force an immediate refetch |
| `identify(context)` | Swap the context (e.g. after sign-in) and refetch (reconnects SSE) |
| `track(event, { value?, metadata? })` | Queue an analytics event (batched, fire-and-forget) |
| `flush()` | Flush queued events now |
| `onChange(listener)` | Subscribe to any flag change → returns unsubscribe |
| `onFlagChange(key, listener)` | Subscribe to one flag's value changes → returns unsubscribe |
| `destroy()` | Tear down SSE/polling/timers (call on unmount / navigation) |

---

## 3. React — live client

Pass the browser client to `RolleaseProvider`; the provider subscribes to its changes and exposes loading/refetch state through hooks. This is the preferred pattern with `createHandler()`.

```tsx
// app/providers.tsx
'use client'
import { RolleaseProvider } from 'rollease/react'
import { rlClient } from '@/lib/rollease-client'

export function Providers({ children }: { children: React.ReactNode }) {
  return <RolleaseProvider client={rlClient}>{children}</RolleaseProvider>
}
```

```tsx
'use client'
import { useFlag, FeatureGate } from 'rollease/react'

function Checkout() {
  const { enabled, isLoading } = useFlag('new_checkout')
  if (isLoading) return <Skeleton />
  return (
    <FeatureGate flag="new_checkout" loading={<Skeleton />} fallback={<OldCheckout />}>
      <NewCheckout />
    </FeatureGate>
  )
}
```

### The three provider modes

`RolleaseProvider` accepts one of three sources (in priority order):

| Prop | Mode | Real-time | Notes |
|------|------|-----------|-------|
| `client` | Live browser client | ✅ | Preferred; subscribes to SSE/polling. Takes precedence over the others. |
| `initialFlags` | Static hydration | No | A `FlagMap` or `DetailedFlagMap` from `evaluateAll()` / `evaluateAllDetailed()` — for SSR first paint |
| `flagsUrl` (+ `refreshInterval`) | Provider-managed fetch | Polls | Provider fetches the URL on mount and polls; simplest setup without the dedicated client |

```tsx
// SSR hydration (no live updates) — evaluate on the server, pass down:
const flags = await rl.flags.evaluateAllDetailed({ userId })
<RolleaseProvider initialFlags={flags}>{children}</RolleaseProvider>

// Provider-managed fetch + polling (no separate client):
<RolleaseProvider flagsUrl="/api/rollease/flags" refreshInterval={15000}>{children}</RolleaseProvider>
```

### Hooks & components

Full signatures are in the [API Reference — React Integration](api-reference.md#react-integration). The short list:

- `useFlag(key)` → `{ enabled, isLoading, isRefetching, error, refetch, invalidate, lastUpdatedAt }`
- `useVariant(key)` → `{ variant, … }`
- `useFlagValue<T>(key, default)` → `T`
- `useFlags()`, `useFlagDetails(key)`, `useWatchFlag(key)`, `useFlagSet(keys)`, `useRollease()`
- `<FeatureGate flag fallback loading>`, `<FeatureRequire flags={[…]} fallback>`

### Vue, Svelte, Angular

The same `rlClient` drives the Vue plugin, Svelte store, and Angular signal bindings — only the reactive wrapper differs. See **[Framework Integrations](frameworks.md)**.

---

## End-to-end: Next.js App Router

```ts
// 1. lib/rollease.ts — SERVER singleton (never imported by client code)
import { createRollease } from 'rollease'
import { createPrismaAdapter } from 'rollease/db/prisma'
import { prisma } from './prisma'

export const rl = createRollease({
  db: createPrismaAdapter({ prisma }),
  secret: process.env.ROLLEASE_SECRET!,
})
```

```ts
// 2. app/api/rollease/[...path]/route.ts — expose the internal API
import { rl } from '@/lib/rollease'
const handler = rl.createHandler({
  contextFromRequest: async (req) => ({ userId: await getServerUserId(req) }),
  clientKeys: { [process.env.ROLLEASE_PUBLIC_KEY!]: { requireClientVisible: true } },
})
export const GET = handler
export const POST = handler
```

```ts
// 3. lib/rollease-client.ts — BROWSER client
import { createRolleaseClient } from 'rollease/client'
export const rlClient = createRolleaseClient({
  baseUrl: '/api/rollease',
  clientKey: process.env.NEXT_PUBLIC_ROLLEASE_KEY,
  streaming: true,
  localStorage: true,
})
```

```tsx
// 4. app/providers.tsx — wire React to the live client
'use client'
import { RolleaseProvider } from 'rollease/react'
import { rlClient } from '@/lib/rollease-client'
export function Providers({ children }) {
  return <RolleaseProvider client={rlClient}>{children}</RolleaseProvider>
}
```

Server components and API routes still call `rl.flags.*` directly — the client plane is only for the browser.

## SPA without SSR (Vite / CRA)

Same browser client, pointed at wherever your backend mounts the handler:

```ts
import { createRolleaseClient } from 'rollease/client'

const rlClient = createRolleaseClient({
  baseUrl: 'https://api.example.com/api/rollease',
  clientKey: import.meta.env.VITE_ROLLEASE_KEY,
  context: () => ({ userId: store.getUserId() }),
  streaming: true,
})

await rlClient.ready()
render(rlClient.flag('new_dashboard', false))
rlClient.onChange(() => rerender())
```

---

## Related

- **[HTTP API Reference](http-api.md)** — every route the client talks to, plus the admin routes and auth model.
- **[API Reference — React Integration](api-reference.md#react-integration)** — full hook/component signatures.
- **[Developer Guide §8](developer-guide.md#8-nextjs-full-stack-integration)** — the Next.js middleware (signed transport) variant.
- **[Observability](observability.md)** — the SSE stream and change events that drive real-time updates.
