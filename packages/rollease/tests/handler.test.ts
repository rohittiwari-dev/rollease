import { describe, expect, it } from "vitest";
import { createRollease } from "../src";
import { createMemoryAdapter } from "../src/db/memory";

const SECRET = "handler-secret-at-least-16";

describe("Universal handler", () => {
  it("requires public client keys and only exposes client-visible flags", async () => {
    const db = createMemoryAdapter();
    const rl = createRollease({ db, secret: SECRET });
    await rl.flags.create({
      key: "public.checkout",
      type: "boolean",
      defaultValue: true,
      clientVisible: true,
    });
    await rl.flags.create({
      key: "server.secret",
      type: "boolean",
      defaultValue: true,
      clientVisible: false,
    });

    const handler = rl.createHandler({
      clientKeys: {
        "pk_test": {
          environments: ["production"],
          context: { environment: "production", userType: "paid" },
        },
      },
    });

    const unauthorized = await handler(new Request("https://x.test/api/rollease/flags"));
    expect(unauthorized.status).toBe(401);

    const res = await handler(
      new Request("https://x.test/api/rollease/flags", {
        headers: { "X-Rollease-Client-Key": "pk_test" },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: Record<string, unknown> };
    expect(Object.keys(body.flags)).toEqual(["public.checkout"]);

    const hidden = await handler(
      new Request("https://x.test/api/rollease/flags/server.secret", {
        headers: { "X-Rollease-Client-Key": "pk_test" },
      })
    );
    expect(hidden.status).toBe(404);
    await rl.close();
  });

  it("honors empty public client key allowlists", async () => {
    const db = createMemoryAdapter();
    const rl = createRollease({ db, secret: SECRET });
    await rl.flags.create({
      key: "public.checkout",
      type: "boolean",
      defaultValue: true,
      clientVisible: true,
    });

    const handler = rl.createHandler({
      clientKeys: {
        "pk_empty": { flags: [] },
      },
    });

    const res = await handler(
      new Request("https://x.test/api/rollease/flags", {
        headers: { "X-Rollease-Client-Key": "pk_empty" },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: Record<string, unknown> };
    expect(body.flags).toEqual({});

    const single = await handler(
      new Request("https://x.test/api/rollease/flags/public.checkout", {
        headers: { "X-Rollease-Client-Key": "pk_empty" },
      })
    );
    expect(single.status).toBe(404);
    await rl.close();
  });

  it("persists batched tracking events", async () => {
    const db = createMemoryAdapter();
    const rl = createRollease({ db, secret: SECRET });
    const handler = rl.createHandler({
      clientKeys: {
        "pk_events": {
          context: { userId: "server-user" },
        },
      },
    });

    const res = await handler(
      new Request("https://x.test/api/rollease/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Rollease-Client-Key": "pk_events",
        },
        body: JSON.stringify({
          events: [
            { event: "checkout_started" },
            { event: "checkout_completed", value: 99 },
          ],
        }),
      })
    );

    expect(res.status).toBe(204);
    const events = await db.listTrackingEvents?.();
    expect(events?.map((event) => event.event)).toEqual([
      "checkout_started",
      "checkout_completed",
    ]);
    expect(events?.[0].userId).toBe("server-user");
    await rl.close();
  });
});
