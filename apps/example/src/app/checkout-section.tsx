"use client";

// Client component — uses the browser SDK to subscribe to live flag changes.
// On first render it reads from localStorage (zero-flicker), then SSE keeps
// the value fresh without polling.

import { useEffect, useState } from "react";
import { createRolleaseClient } from "rollease/client";

const client = createRolleaseClient({
  baseUrl: "/api/rollease",
  // Identify the current user — in production read from your auth context.
  context: { userId: "demo-user-123" },
  streaming: true,
  localStorage: true,
});

export function CheckoutSection() {
  const [newCheckout, setNewCheckout] = useState<boolean | null>(null);
  const [variant, setVariant] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    // Subscribe to flag changes via SSE.
    const unsub = client.onChange((flags) => {
      const co = flags["new-checkout"];
      const pe = flags["pricing-experiment"];
      if (co !== undefined) setNewCheckout(Boolean(co.value));
      if (pe !== undefined) {
        setVariant(String(pe.value));
        setReason(pe.reason ?? null);
      }
    });

    // Hydrate immediately.
    void client.ready().then(() => {
      const details = client.flagDetails();
      const co = details["new-checkout"];
      const pe = details["pricing-experiment"];
      if (co !== undefined) setNewCheckout(Boolean(co.value));
      if (pe !== undefined) {
        setVariant(String(pe.value));
        setReason(pe.reason ?? null);
      }
    });

    return unsub;
  }, []);

  return (
    <section style={{ marginBottom: "1.5rem", borderTop: "1px solid #eee", paddingTop: "1.5rem" }}>
      <h2>Browser SDK (live via SSE)</h2>
      <p>
        <strong>new-checkout:</strong>{" "}
        <code>{newCheckout === null ? "loading…" : String(newCheckout)}</code>
      </p>
      <p>
        <strong>pricing-experiment:</strong>{" "}
        <code>{variant ?? "loading…"}</code>
        {reason && (
          <span style={{ marginLeft: 8, fontSize: "0.8em", color: "#888" }}>
            ({reason})
          </span>
        )}
      </p>

      <button
        style={{ marginTop: "0.5rem", padding: "0.4rem 0.8rem" }}
        onClick={() => client.refetch()}
      >
        Force refetch
      </button>
    </section>
  );
}
