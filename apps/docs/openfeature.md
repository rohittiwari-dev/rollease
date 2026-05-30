# Rollease SDK — OpenFeature Provider

> **Module:** `rollease/openfeature`
> **Spec:** OpenFeature 0.7+

If your team is already on the [OpenFeature](https://openfeature.dev) API, Rollease can be your provider — no code changes at call sites.

---

## Install both packages

```bash
npm install @openfeature/server-sdk rollease
```

---

## Wire the provider

```ts
import { OpenFeature } from "@openfeature/server-sdk";
import { createRollease, createMemoryAdapter } from "rollease";
import { createRolleaseProvider } from "rollease/openfeature";

const rl = createRollease({
  db: createMemoryAdapter(),
  secret: process.env.ROLLEASE_SECRET!,
});

await OpenFeature.setProviderAndWait(createRolleaseProvider(rl.flags));

const client = OpenFeature.getClient();
const enabled = await client.getBooleanValue("new_checkout", false, {
  targetingKey: "u_alice",         // → context.userId
  environment: "production",
  region: "us",
  plan: "enterprise",              // → context.attributes.plan
});
```

### Context mapping

The provider maps the OpenFeature evaluation context with a single rule: `targetingKey` becomes `context.userId`, and **every other field is placed into `context.attributes`** (see `toRolleaseContext` in `frameworks/openfeature.ts`).

| OpenFeature | Rollease |
|-------------|----------|
| `targetingKey` | `context.userId` |
| Everything else (`plan`, `environment`, `region`, …) | `context.attributes.<key>` |

Because non-`targetingKey` fields land in `attributes`, target on them with custom-attribute rules — `{ dimension: "plan", op: "eq", value: "enterprise" }` resolves to `context.attributes.plan`:

```ts
const enabled = await client.getBooleanValue("new_checkout", false, {
  targetingKey: "u_alice",   // → context.userId
  plan: "enterprise",        // → context.attributes.plan  → dimension: "plan"
});
```

> **Heads-up — reserved dimensions don't auto-map.** The evaluator reads `environment`, `region`, `version`, `userType`, `tenantId`, `ip`, and `segment` from **top-level** `FlagContext` fields, not from `attributes`. Passing `environment`/`region`/etc. through the OpenFeature context puts them in `attributes`, so rules using those built-in dimensions (and environment scoping) won't see them. To target on environment/region today, add a `before` hook that lifts those fields onto the returned context, or use custom-attribute dimensions. See the [Known limitations](#known-limitations) note.

### Reason mapping

`toOpenFeatureReason` maps Rollease `EvalReason` values to OpenFeature `Reason` values; any unmapped reason falls back to `DEFAULT`.

| Rollease `EvalReason` | OpenFeature `Reason` |
|-----------------------|----------------------|
| `kill_switch`, `disabled`, `not_scheduled`, `expired`, `prerequisite_not_met` | `DISABLED` |
| `rule_match` | `TARGETING_MATCH` |
| `assignment`, `percentage`, `weighted_random`, `exclusion_group_miss` | `SPLIT` |
| `override` | `STATIC` |
| `default` (and any unmapped reason) | `DEFAULT` |
| `exclusion_layer_not_found`, `error_fallback` | `ERROR` |

---

## Hooks (full lifecycle)

OpenFeature defines `before`, `after`, `error`, `finally` hooks. The provider supports all four.

```ts
import { createRolleaseProvider } from "rollease/openfeature";

const provider = createRolleaseProvider(rl.flags, {
  hooks: [
    {
      before(hookContext) {
        // Last chance to mutate the evaluation context.
        // Return a partial context to merge with the caller's.
        return { userId: getCanonicalUserId(hookContext.context.targetingKey) };
      },
      after(hookContext, evaluationDetails) {
        console.log(`${hookContext.flagKey} → ${evaluationDetails.value} (${evaluationDetails.reason})`);
      },
      error(hookContext, error) {
        Sentry.captureException(error, { tags: { flagKey: hookContext.flagKey } });
      },
      finally(hookContext) {
        // Always runs, whether evaluation succeeded or threw.
      },
    },
  ],
});
```

> Hook errors don't abort evaluation — they're caught and logged. The flag still returns the resolved value or the spec-defined default.

---

## Tracking (OpenFeature spec)

OpenFeature 0.8 introduced a tracking API. The provider forwards `track()` calls to `FlagManager.trackEvent()`:

```ts
client.track("purchase", {
  targetingKey: "u_alice",
  value: 49.99,
  metadata: { sku: "sku_pro" },
});
```

Becomes:

```ts
await rl.flags.trackEvent({
  userId: "u_alice",
  event: "purchase",
  value: 49.99,
  metadata: { sku: "sku_pro" },
});
```

If you configured `analyticsSink`, the event also flows to Segment/Mixpanel/PostHog (see `config.analyticsSink` and `trackEvent()` in the [API Reference](api-reference.md#createrollease)).

---

## Switching providers without rewriting call sites

The reason to use OpenFeature is *exactly this* — your `client.getBooleanValue(...)` calls don't change when you swap providers:

```ts
// Day 1: hand-rolled.
await OpenFeature.setProviderAndWait(createRolleaseProvider(rl.flags));

// Day 100: scaling, want to try LaunchDarkly.
import { LaunchDarklyProvider } from "@openfeature/launchdarkly-provider";
await OpenFeature.setProviderAndWait(new LaunchDarklyProvider({ sdkKey: ... }));

// Day 200: back to Rollease for a sister product.
await OpenFeature.setProviderAndWait(createRolleaseProvider(otherRl.flags));
```

All `client.getBooleanValue / getStringValue / getNumberValue / getObjectValue` calls keep working.

---

## Structural typing — no hard dep on @openfeature/core

`rollease/openfeature` doesn't import OpenFeature. It exports a provider object that *structurally* matches the OF provider interface. This means:

- You only pay for OpenFeature if you actually install it.
- Tests of Rollease itself don't need OpenFeature installed.
- You can use the provider from any framework that accepts a structural provider shape.

```ts
// This works even if @openfeature/server-sdk isn't installed:
const provider = createRolleaseProvider(rl.flags);
provider.metadata.name;                 // 'Rollease'
await provider.resolveBooleanEvaluation("k", false, { targetingKey: "u1" });
```

---

## Variant flags via OpenFeature

OpenFeature treats variants as object-valued flags. For a Rollease multivariate flag with variants `{ key: "A", value: 10 }` and `{ key: "B", value: 20 }`:

```ts
const result = await client.getNumberDetails("price_test", 0, {
  targetingKey: "u_alice",
});
result.value     // 10 or 20
result.variant   // 'A' or 'B'
result.reason    // 'SPLIT'
```

For full multivariate inspection, use `getObjectDetails`:

```ts
const result = await client.getObjectDetails("checkout_config", { /* default */ }, ctx);
result.value     // the variant's value object
result.variant   // variant key
```

---

## Known limitations

- **Built-in dimensions aren't auto-mapped from the OpenFeature context.** `targetingKey` maps to `context.userId`; everything else goes into `context.attributes`. The evaluator reads `environment`, `region`, `version`, `userType`, `tenantId`, `ip`, and `segment` from top-level `FlagContext` fields, so rules on those dimensions — and environment scoping — won't pick them up from an OpenFeature context. Workaround: register a `before` hook that returns those fields shaped for the evaluator, or target via custom-attribute dimensions. (A future provider change may map these automatically.)
- **`metadata.name` is `"Rollease"`** (capitalized), not `"rollease"` — match exactly if you assert on it.
