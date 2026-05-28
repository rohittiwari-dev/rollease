// RSC page — reads flags via getFlag() from the signed header injected by
// middleware. Zero extra fetch — value is in the cookie already.

import { getFlag } from "rollease/next";
import { rl } from "@/lib/rollease";
import { CheckoutSection } from "./checkout-section";

export default async function Home() {
  // Server-side evaluation via the signed middleware payload (falls back to
  // a direct DB eval if the header is absent — e.g. on first load).
  const newCheckout = await getFlag<boolean>("new-checkout", false);
  const pricingVariant = await getFlag<string>("pricing-experiment", "control");

  // You can also evaluate directly from the FlagManager for server-only data:
  const result = await rl.flags.evaluate("new-checkout", { userId: "server-render" });

  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 640 }}>
      <h1>Rollease Example</h1>

      <section style={{ marginBottom: "1.5rem" }}>
        <h2>Flag values (from middleware payload)</h2>
        <p>
          <strong>new-checkout:</strong>{" "}
          <code>{String(newCheckout)}</code>
        </p>
        <p>
          <strong>pricing-experiment variant:</strong>{" "}
          <code>{pricingVariant}</code>
        </p>
      </section>

      <section style={{ marginBottom: "1.5rem" }}>
        <h2>Detailed evaluation result (direct DB eval)</h2>
        <pre style={{ background: "#f4f4f4", padding: "1rem", borderRadius: 4, overflowX: "auto" }}>
          {JSON.stringify(
            {
              value: result.value,
              variant: result.variant,
              reason: result.reason,
              ruleId: result.ruleId,
            },
            null,
            2
          )}
        </pre>
      </section>

      {/* Client component that uses the browser SDK */}
      <CheckoutSection />

      <section style={{ marginTop: "2rem", fontSize: "0.85rem", color: "#666" }}>
        <h2>Quick test</h2>
        <p>
          Health: <a href="/api/rollease/health">/api/rollease/health</a>
        </p>
        <p>
          Flags: <a href="/api/rollease/flags">/api/rollease/flags</a>
        </p>
      </section>
    </main>
  );
}
