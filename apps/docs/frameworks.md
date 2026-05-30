# Rollease SDK — Framework Integrations (Vue · Svelte · Angular)

> First-class bindings for **Vue 3**, **Svelte**, and **Angular 17+**. (React lives in the [API Reference](api-reference.md#react-integration) and [Client & Server](client-server.md#3-react--live-client) guides.)

All three are **client-plane** integrations: they wrap the same browser client, [`createRolleaseClient`](client-server.md#2-browser-client--rolleaseclient), which fetches evaluated flags from your server's [`createHandler()`](http-api.md) internal API over HTTP/SSE. The **server setup is identical** regardless of framework — only the reactive binding differs:

```ts
// SERVER — same for every framework: expose the internal API
// app/api/rollease/[...path]/route.ts (or your framework's catch-all)
import { rl } from '@/lib/rollease'
const handler = rl.createHandler({
  contextFromRequest: async (req) => ({ userId: await getServerUserId(req) }),
  clientKeys: { [process.env.ROLLEASE_PUBLIC_KEY!]: { requireClientVisible: true } },
})
export const GET = handler
export const POST = handler
```

```ts
// CLIENT — same browser client every framework binds to
// lib/rollease-client.ts
import { createRolleaseClient } from 'rollease/client'

export const rlClient = createRolleaseClient({
  baseUrl: '/api/rollease',
  context: () => ({ userId: getCurrentUserId() }),
  clientKey: process.env.PUBLIC_ROLLEASE_KEY,   // framework's public-env convention
  streaming: true,                              // real-time via SSE
})
```

Each binding subscribes to `rlClient.onChange(...)` and re-renders on `ready()` and every flag change. The security model (public `clientKeys` + `clientVisible` flags) is the same — see [Client & Server](client-server.md#the-security-boundary).

> Install the matching peer dependency: `vue`, `svelte`, or `@angular/core`. Each is an **optional** peer dependency — you only pull in the one you use.

---

## Vue 3

`rollease/vue` provides a plugin and Composition-API composables.

### Wire the plugin

```ts
// main.ts
import { createApp } from 'vue'
import { RolleasePlugin } from 'rollease/vue'
import { rlClient } from './lib/rollease-client'
import App from './App.vue'

createApp(App)
  .use(RolleasePlugin, { client: rlClient })   // { client } is required
  .mount('#app')
```

### Composables

| Composable | Returns |
|------------|---------|
| `useFlag(key)` | `{ enabled: ComputedRef<boolean>, isLoading, isRefetching, error, lastUpdatedAt, refetch, invalidate }` |
| `useVariant(key)` | `{ variant: ComputedRef<Variant \| null>, isLoading, isRefetching, error, lastUpdatedAt, refetch }` |
| `useFlagValue<T>(key, defaultValue)` | `ComputedRef<T>` |
| `useFlags()` | `{ flags: ShallowRef<FlagMap>, …lifecycle, refetch }` |
| `useFlagDetails(key)` | `{ details: ComputedRef<FlagResult>, isLoading, error }` |
| `useFlagSet(keys)` | `ComputedRef<Record<string, boolean>>` |
| `useRolleaseClient()` | the underlying `RolleaseBrowserClient` |

Returned values are Vue refs/computed — use `.value` in `<script>`, auto-unwrapped in `<template>`.

```vue
<script setup lang="ts">
import { useFlag, useVariant, useFlagValue } from 'rollease/vue'

const { enabled, isLoading } = useFlag('checkout-v2')
const { variant } = useVariant('pricing-layout')
const maxItems = useFlagValue('max-items', 25)   // ComputedRef<number>
</script>

<template>
  <Skeleton v-if="isLoading" />
  <NewCheckout v-else-if="enabled" :layout="variant?.key" :max="maxItems" />
  <OldCheckout v-else />
</template>
```

Switch identity after sign-in via the client:

```ts
import { useRolleaseClient } from 'rollease/vue'
const client = useRolleaseClient()
await client.identify({ userId: signedInUser.id })   // refetches + reconnects SSE
```

---

## Svelte

`rollease/svelte` exposes a store factory (`createRolleaseStore`) and a SvelteKit server helper (`loadFlags`).

### Create the store

```ts
// lib/rollease.ts
import { createRolleaseClient } from 'rollease/client'
import { createRolleaseStore } from 'rollease/svelte'

const client = createRolleaseClient({ baseUrl: '/api/rollease', streaming: true })
export const rollease = createRolleaseStore(client)
```

The store exposes **store-valued properties** (subscribe with `$`) and **store factory methods** (call to get a store, then subscribe):

| Member | Kind | Subscribe with |
|--------|------|----------------|
| `flags` / `flagDetails` / `isLoading` / `error` | Readable stores | `$flags`, `$isLoading`, … |
| `flag(key)` | method → `Readable<FlagState>` | `const f = rollease.flag('k')` → `$f` |
| `variant(key)` | method → `Readable<Variant \| null>` | `const v = rollease.variant('k')` → `$v` |
| `flagValue<T>(key, default)` | method → `Readable<T>` | `const n = rollease.flagValue('k', 0)` → `$n` |
| `refetch()` / `client` / `destroy()` | imperative | — |

`FlagState` = `{ enabled, value, variant, reason, isLoading, error }`.

```svelte
<script lang="ts">
  import { rollease } from '$lib/rollease'

  // flag(key) RETURNS a store — assign it, then use $ to subscribe.
  const checkout = rollease.flag('checkout-v2')
  const maxItems = rollease.flagValue('max-items', 25)

  // store-valued properties subscribe directly:
  const { isLoading } = rollease
</script>

{#if $isLoading}
  <Skeleton />
{:else if $checkout.enabled}
  <NewCheckout max={$maxItems} />
{:else}
  <OldCheckout />
{/if}
```

> Don't write `$rollease.flag('k')` — `rollease` is not itself a store. Call `rollease.flag('k')` to get a store, assign it, then subscribe with `$`.

### SvelteKit — server-side hydration

`loadFlags` builds a `load` function that evaluates flags **on the server** (right-to-explanation, no flash) using your server client (`rl`, the one from `createRollease`):

```ts
// +page.server.ts
import { loadFlags } from 'rollease/svelte'
import { rl } from '$lib/server/rollease'

export const load = loadFlags(rl, (event) => ({
  userId: event.locals.user?.id,
}))
// → { flags } available to the page; pair with the store for live updates.
```

Call `rollease.destroy()` on teardown to release subscriptions (e.g. in a root layout's `onDestroy`).

---

## Angular (17+)

`rollease/angular` uses standalone providers and signals.

### Provide Rollease

```ts
// app.config.ts
import type { ApplicationConfig } from '@angular/core'
import { provideRollease } from 'rollease/angular'

export const appConfig: ApplicationConfig = {
  providers: [
    // Pass client config directly…
    provideRollease({ baseUrl: '/api/rollease', streaming: true }),
    // …or reuse an existing client: provideRollease({ client: rlClient })
  ],
}
```

`provideRollease` accepts a `RolleaseClientConfig` (it creates the client for you) **or** `{ client }` to reuse one you already built.

### Inject functions (signals)

| Function | Returns |
|----------|---------|
| `injectFlag(key)` | `Signal<boolean>` |
| `injectVariant(key)` | `Signal<Variant \| null>` |
| `injectFlagValue<T>(key, defaultValue)` | `Signal<T>` |
| `injectFlags()` | `Signal<FlagMap>` |
| `injectIsLoading()` | `Signal<boolean>` |
| `injectError()` | `Signal<Error \| null>` |
| `injectRolleaseClient()` | the underlying `RolleaseBrowserClient` |

Call them in an **injection context** (field initializer or constructor) so per-flag subscriptions auto-clean via `DestroyRef`.

```ts
import { Component } from '@angular/core'
import { injectFlag, injectVariant, injectFlagValue } from 'rollease/angular'

@Component({
  selector: 'app-checkout',
  standalone: true,
  template: `
    @if (isCheckoutV2()) {
      <new-checkout [layout]="pricing()?.key" [max]="maxItems()" />
    } @else {
      <old-checkout />
    }
  `,
})
export class CheckoutComponent {
  isCheckoutV2 = injectFlag('checkout-v2')      // Signal<boolean>
  pricing = injectVariant('pricing-layout')     // Signal<Variant | null>
  maxItems = injectFlagValue('max-items', 25)   // Signal<number>
}
```

Switch identity after sign-in:

```ts
import { injectRolleaseClient } from 'rollease/angular'
const client = injectRolleaseClient()
await client.identify({ userId: signedInUser.id })
```

---

## At a glance

| Framework | Wire-up | Read a flag | Reactive primitive |
|-----------|---------|-------------|--------------------|
| **React** | `<RolleaseProvider client={rlClient}>` | `useFlag('k').enabled` | hooks / state |
| **Vue** | `app.use(RolleasePlugin, { client })` | `useFlag('k').enabled.value` | refs / computed |
| **Svelte** | `createRolleaseStore(client)` | `const f = rollease.flag('k')` → `$f.enabled` | stores |
| **Angular** | `provideRollease({ baseUrl })` | `injectFlag('k')()` | signals |

All four share the **same context shape, evaluation reasons, and security boundary** — only the binding changes.

---

## Related

- **[Client & Server](client-server.md)** — the browser client (`createRolleaseClient`) these wrap, and the server boundary.
- **[HTTP API Reference](http-api.md)** — the internal API every binding consumes.
- **[API Reference — React Integration](api-reference.md#react-integration)** — the React equivalents.
