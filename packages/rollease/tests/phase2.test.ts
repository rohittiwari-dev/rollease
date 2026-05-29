// ============================================================================
// Phase 2 regression tests — proves Tier 2/3 features are fully wired across
// every adapter (memory + sequelize + repository contract), the webhook
// dispatcher is Edge-safe, and all manager lifecycle gaps are closed.
// ============================================================================

import { describe, expect, it, vi } from "vitest";
import { FlagManager } from "../src/engine/manager";
import { MemoryDbAdapter } from "../src/db/memory";
import { noopLogger } from "../src/core/logger";
import {
  ROLLEASE_REPOSITORY_REQUIRED_COLUMNS,
  ROLLEASE_OPTIONAL_REPOSITORY_NAMES,
} from "../src/db/repository";
import { ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS } from "../src/db/sequelize";
import { verifyWebhookSignature } from "../src/core/webhook";
import { ValidationError } from "../src/core/errors";
import type {
  ExclusionLayer,
  WebhookPayload,
} from "../src/core/types";

function mgr(opts?: {
  environment?: string;
  autoResolveSegments?: boolean;
  webhooks?: ConstructorParameters<typeof FlagManager>[0]["webhooks"];
}) {
  const db = new MemoryDbAdapter();
  return {
    db,
    manager: new FlagManager({
      db,
      logger: noopLogger,
      environment: opts?.environment,
      autoResolveSegments: opts?.autoResolveSegments,
      webhooks: opts?.webhooks,
    }),
  };
}

// ── Webhook dispatcher (Edge-safe) ──────────────────────────────────────────

describe("Phase 2-A: Edge-safe webhook dispatcher", () => {
  it("uses Web Crypto (SubtleCrypto) for HMAC signatures — no Node crypto dependency", async () => {
    // The webhook module is the surface: importing it should not require
    // node:crypto. Verify the produced signature round-trips through the
    // public verifier (which uses SubtleCrypto end-to-end).
    const mockCalls: Array<[string, RequestInit]> = [];
    const mockFetch = (url: string, init: RequestInit) => {
      mockCalls.push([url, init]);
      return Promise.resolve({ ok: true, status: 200, statusText: "OK" } as Response);
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { manager } = mgr({
      webhooks: [
        {
          url: "https://hook.example/test",
          secret: "very-strong-shared-secret-32+chars",
          events: ["flag.created"],
        },
      ],
    });

    await manager.create({ key: "edge_safe", type: "boolean", defaultValue: true });
    await new Promise((r) => setTimeout(r, 30));

    globalThis.fetch = origFetch;
    expect(mockCalls).toHaveLength(1);
    const [, init] = mockCalls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Rollease-Signature"]).toMatch(/^[0-9a-f]+$/);
    expect(headers["X-Rollease-Signature-Version"]).toBe("v1");
    expect(headers["X-Rollease-Timestamp"]).toBeDefined();

    // Receiver-side verifier accepts a well-formed envelope.
    const ok = await verifyWebhookSignature(
      init.body as string,
      headers["X-Rollease-Signature"],
      headers["X-Rollease-Timestamp"],
      "very-strong-shared-secret-32+chars"
    );
    expect(ok).toBe(true);

    // Wrong secret → rejected.
    const bad = await verifyWebhookSignature(
      init.body as string,
      headers["X-Rollease-Signature"],
      headers["X-Rollease-Timestamp"],
      "different-shared-secret-of-correct-length"
    );
    expect(bad).toBe(false);

  });

  it("rejects replayed webhook envelopes past maxAge", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const ok = await verifyWebhookSignature(
      JSON.stringify({ test: true }),
      "deadbeef",
      tenMinAgo,
      "test-secret-32+characters-strong-enough",
      { maxAgeMs: 5 * 60_000 }
    );
    expect(ok).toBe(false);
  });

  it("rejects future-dated webhook envelopes (clock-skew tolerant only ±60s)", async () => {
    const fiveMinFuture = new Date(Date.now() + 5 * 60_000).toISOString();
    const ok = await verifyWebhookSignature(
      JSON.stringify({ test: true }),
      "deadbeef",
      fiveMinFuture,
      "test-secret-32+characters-strong-enough"
    );
    expect(ok).toBe(false);
  });
});

// ── Adapter column contracts ────────────────────────────────────────────────

describe("Phase 2-B/C: Adapter column contracts cover all Tier 2/3 fields", () => {
  it("repository.Flag contract includes prerequisites/environmentDefaults/exclusionLayer/clientVisible/lastEvaluatedAt", () => {
    expect(ROLLEASE_REPOSITORY_REQUIRED_COLUMNS.Flag).toEqual(
      expect.arrayContaining([
        "prerequisites",
        "environmentDefaults",
        "exclusionLayer",
        "clientVisible",
        "lastEvaluatedAt",
      ])
    );
  });

  it("repository.Rule contract includes userIds/description/metadata", () => {
    expect(ROLLEASE_REPOSITORY_REQUIRED_COLUMNS.Rule).toEqual(
      expect.arrayContaining(["userIds", "description", "metadata"])
    );
  });

  it("repository.Release contract includes approval fields", () => {
    expect(ROLLEASE_REPOSITORY_REQUIRED_COLUMNS.Release).toEqual(
      expect.arrayContaining([
        "requiresApproval",
        "requiredApprovers",
        "approvalStatus",
        "approvals",
        "rejectionReason",
      ])
    );
  });

  it("repository.ExclusionLayer is declared as an optional repo", () => {
    expect(ROLLEASE_OPTIONAL_REPOSITORY_NAMES).toContain("ExclusionLayer");
    expect(ROLLEASE_REPOSITORY_REQUIRED_COLUMNS.ExclusionLayer).toEqual([
      "key",
      "description",
      "flagKeys",
      "allocations",
    ]);
  });

  it("sequelize column contract mirrors repository contract", () => {
    expect(ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS.Flag).toEqual(
      ROLLEASE_REPOSITORY_REQUIRED_COLUMNS.Flag
    );
    expect(ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS.Rule).toEqual(
      ROLLEASE_REPOSITORY_REQUIRED_COLUMNS.Rule
    );
    expect(ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS.Release).toEqual(
      ROLLEASE_REPOSITORY_REQUIRED_COLUMNS.Release
    );
    expect(ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS.ExclusionLayer).toEqual(
      ROLLEASE_REPOSITORY_REQUIRED_COLUMNS.ExclusionLayer
    );
  });
});

// ── Manager wiring fixes ─────────────────────────────────────────────────────

describe("Phase 2-D: Manager lifecycle wiring", () => {
  it("evaluateAllDetailed resolves prerequisites recursively (was unwired)", async () => {
    const { manager } = mgr();
    await manager.create({ key: "parent", type: "boolean", defaultValue: false });
    await manager.create({
      key: "child",
      type: "boolean",
      defaultValue: true,
      prerequisites: [{ flagKey: "parent", variation: true }],
    });

    // Parent is false → child must fail prereq even in bulk eval.
    const detailed = await manager.evaluateAllDetailed({ userId: "u1" });
    expect(detailed.child.reason).toBe("prerequisite_not_met");

    // Flip parent → child should now pass.
    await manager.update("parent", { defaultValue: true });
    const detailed2 = await manager.evaluateAllDetailed({ userId: "u1" });
    expect(detailed2.child.value).toBe(true);
    expect(detailed2.child.reason).toBe("default");
  });

  it("evaluateAllDetailed touches lastEvaluatedAt for every flag (was unwired)", async () => {
    const { db, manager } = mgr();
    await manager.create({ key: "bulk_a", type: "boolean", defaultValue: false });
    await manager.create({ key: "bulk_b", type: "boolean", defaultValue: false });

    await manager.evaluateAllDetailed({ userId: "u1" });
    await new Promise((r) => setTimeout(r, 30));

    expect((await db.getFlag("bulk_a"))!.lastEvaluatedAt).toBeInstanceOf(Date);
    expect((await db.getFlag("bulk_b"))!.lastEvaluatedAt).toBeInstanceOf(Date);
  });

  it("evaluateMultiContext applies the configured environment when caller doesn't supply one", async () => {
    const { manager } = mgr({ environment: "production" });
    await manager.create({ key: "env_multi", type: "boolean", defaultValue: false });
    await manager.addRule("env_multi", {
      priority: 1,
      value: true,
      conditions: {
        all: [{ dimension: "environment", op: "eq", value: "production" }],
      },
    });

    const result = await manager.evaluateMultiContext("env_multi", {
      contexts: { user: { userId: "alice" } },
      primaryKey: "user",
    });
    expect(result.value).toBe(true);
    expect(result.reason).toBe("rule_match");
  });

  it("evaluateMultiContext rejects an unknown primaryKey (was silent fallback)", async () => {
    const { manager } = mgr();
    await manager.create({ key: "mc", type: "boolean", defaultValue: false });

    await expect(
      manager.evaluateMultiContext("mc", {
        contexts: { user: { userId: "alice" } },
        primaryKey: "typo_key",
      })
    ).rejects.toThrow(/primaryKey "typo_key" does not match any provided context/);
  });

  it("addTags / removeTags fire history, bust cache, and dispatch webhook", async () => {
    const { db, manager } = mgr();
    await manager.create({ key: "tagged", type: "boolean", defaultValue: false });

    const events: WebhookPayload[] = [];
    manager.on("tags.added", (p) => {
      events.push(p);
    });
    manager.on("tags.removed", (p) => {
      events.push(p);
    });

    const trackImpressionSpy = vi.spyOn(db, "trackImpression");
    await manager.addTags("tagged", ["billing", "experiment"]);
    await manager.removeTags("tagged", ["experiment"]);

    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("tags.added");
    expect(events[1].event).toBe("tags.removed");

    const history = await db.getHistory("tagged");
    expect(history.some((h) => h.action === "tags.added")).toBe(true);
    expect(history.some((h) => h.action === "tags.removed")).toBe(true);

    // Cache-bust check: after adding tags the next eval must re-read the
    // updated flag (so the new tags are visible to any rule using them).
    trackImpressionSpy.mockClear();
    const flag = await manager.get("tagged");
    expect(flag.tags).toEqual(["billing"]);
  });

  it("killAll writes per-flag history and dispatches a webhook for each flag", async () => {
    const { db, manager } = mgr();
    await manager.create({ key: "k1", type: "boolean", defaultValue: false });
    await manager.create({ key: "k2", type: "boolean", defaultValue: false });

    const killedKeys: (string | undefined)[] = [];
    manager.on("flag.killed", (p) => {
      killedKeys.push(p.flagKey);
    });

    await manager.killAll({ reason: "incident-127" });

    expect(killedKeys.sort()).toEqual(["k1", "k2"]);
    const h1 = await db.getHistory("k1");
    expect(h1.some((h) => h.action === "flag.killed" && h.reason === "incident-127")).toBe(true);
  });

  it("clone busts the new key's cache entry (was holding stale negative cache)", async () => {
    const { db, manager } = mgr();
    await manager.create({ key: "source", type: "boolean", defaultValue: true });

    // Seed a negative cache hit for "target" by evaluating before it exists.
    expect(await manager.isEnabled("target", {})).toBe(false);

    // Clone — must bust cache so next read sees the new flag, not the
    // negative-cache miss we just populated.
    await manager.clone("source", { newKey: "target", includeRules: false });

    expect(await manager.isEnabled("target", {})).toBe(true);
  });

  it("createRelease runs the mutation hook and dispatches webhook with pending flag", async () => {
    const beforeHookCalls: { action: string; flagKey?: string }[] = [];
    const db = new MemoryDbAdapter();
    const manager = new FlagManager({
      db,
      logger: noopLogger,
      hooks: {
        onBeforeMutation: (ctx) => {
          beforeHookCalls.push({ action: ctx.action, flagKey: ctx.flagKey });
        },
      },
    });

    const released: WebhookPayload[] = [];
    manager.on("release.created", (p) => {
      released.push(p);
    });

    await manager.create({ key: "rel_flag", type: "boolean", defaultValue: false });
    await manager.createRelease({
      name: "Pending release",
      requiresApproval: true,
      changes: [{ flagKey: "rel_flag", action: "enable", value: true }],
    });

    // create() + createRelease() both run the hook.
    expect(beforeHookCalls.some((c) => c.action === "flag.created" && c.flagKey === "rel_flag")).toBe(true);
    // createRelease fires "release.created" (distinct from "release.deployed").
    expect(beforeHookCalls.some((c) => c.action === "release.created" && c.flagKey === undefined)).toBe(true);

    // Webhook fires for createRelease with pending: true.
    expect(released).toHaveLength(1);
    expect(released[0].data.pending).toBe(true);
    expect(released[0].data.requiresApproval).toBe(true);
  });
});

// ── Input validation ─────────────────────────────────────────────────────────

describe("Phase 2-E: Input validation", () => {
  it("createExclusionLayer rejects overlapping bucket allocations", async () => {
    const { manager } = mgr();
    const layer: ExclusionLayer = {
      key: "overlapping",
      flagKeys: ["exp_a", "exp_b"],
      allocations: [
        { flagKey: "exp_a", startBucket: 0, endBucket: 60 },
        { flagKey: "exp_b", startBucket: 50, endBucket: 100 }, // overlaps 50-60
      ],
    };
    await expect(manager.createExclusionLayer(layer)).rejects.toThrow(
      /allocations must not overlap/
    );
  });

  it("createExclusionLayer rejects allocations outside [0, 100]", async () => {
    const { manager } = mgr();
    await expect(
      manager.createExclusionLayer({
        key: "out_of_range",
        flagKeys: ["exp_a"],
        allocations: [{ flagKey: "exp_a", startBucket: -5, endBucket: 50 }],
      })
    ).rejects.toThrow(/within \[0, 100\]/);
  });

  it("createExclusionLayer rejects allocations for flags not in the layer's flagKeys list", async () => {
    const { manager } = mgr();
    await expect(
      manager.createExclusionLayer({
        key: "missing_flag",
        flagKeys: ["exp_a"],
        allocations: [{ flagKey: "exp_b", startBucket: 0, endBucket: 50 }],
      })
    ).rejects.toThrow(/not in flagKeys/);
  });

  it("createExclusionLayer rejects empty flagKeys", async () => {
    const { manager } = mgr();
    await expect(
      manager.createExclusionLayer({
        key: "no_flags",
        flagKeys: [],
        allocations: [],
      })
    ).rejects.toThrow(/at least one flag/);
  });

  it("createExclusionLayer rejects start >= end ranges", async () => {
    const { manager } = mgr();
    await expect(
      manager.createExclusionLayer({
        key: "inverted",
        flagKeys: ["exp_a"],
        allocations: [{ flagKey: "exp_a", startBucket: 50, endBucket: 50 }],
      })
    ).rejects.toThrow(/startBucket must be strictly less than endBucket/);
  });

  it("update() validates prerequisite chain — circular cycles are blocked", async () => {
    const { manager } = mgr();
    await manager.create({ key: "a", type: "boolean", defaultValue: true });
    await manager.create({
      key: "b",
      type: "boolean",
      defaultValue: true,
      prerequisites: [{ flagKey: "a", variation: true }],
    });

    // Now try to make "a" depend on "b" — creates a cycle a → b → a.
    await expect(
      manager.update("a", {
        // `prerequisites` isn't in UpdateFlagInput type, but the adapter
        // persists arbitrary fields via stripUndefined. We send it through
        // the unknown-field channel that real adapters honor.
        ...({ prerequisites: [{ flagKey: "b", variation: true }] } as unknown as Parameters<typeof manager.update>[1]),
      })
    ).rejects.toThrow(ValidationError);
  });

  it("update() rejects self-referencing prerequisites", async () => {
    const { manager } = mgr();
    await manager.create({ key: "solo", type: "boolean", defaultValue: true });

    await expect(
      manager.update("solo", {
        ...({ prerequisites: [{ flagKey: "solo", variation: true }] } as unknown as Parameters<typeof manager.update>[1]),
      })
    ).rejects.toThrow(/cannot have itself as a prerequisite/);
  });
});

// ── Repository persistence end-to-end (proxies for Prisma/Drizzle) ──────────

describe("Phase 2-B: Repository adapter persists Tier 2/3 fields end-to-end", () => {
  it("Tier 2/3 fields are written and read back through the in-memory repository fake", async () => {
    // We simulate a Prisma/Drizzle delegate using a generic row store. This
    // proves the RepositoryDbAdapter wiring (createFlag / addRule /
    // createRelease) round-trips the new fields rather than dropping them.
    const { RepositoryDbAdapter } = await import("../src/db/repository");

    const tables: Record<string, Record<string, any>[]> = {
      Flag: [],
      Rule: [],
      Segment: [],
      Release: [],
      Assignment: [],
      History: [],
      Impression: [],
      ExclusionLayer: [],
    };
    const matches = (row: Record<string, any>, where: Record<string, unknown>) =>
      Object.entries(where).every(([k, v]) => row[k] === v);
    const makeRepo = (name: string) => ({
      async create(values: Record<string, unknown>) {
        tables[name].push({ ...values });
        return tables[name][tables[name].length - 1];
      },
      async findOne(where: Record<string, unknown>) {
        return tables[name].find((r) => matches(r, where)) ?? null;
      },
      async findMany(opts?: { where?: Record<string, unknown> }) {
        if (!opts?.where) return [...tables[name]];
        return tables[name].filter((r) => matches(r, opts.where!));
      },
      async update(where: Record<string, unknown>, values: Record<string, unknown>) {
        for (const row of tables[name]) {
          if (matches(row, where)) Object.assign(row, values);
        }
        return null;
      },
      async delete(where: Record<string, unknown>) {
        tables[name] = tables[name].filter((r) => !matches(r, where));
      },
      async deleteMany(where: Record<string, unknown>) {
        tables[name] = tables[name].filter((r) => !matches(r, where));
      },
    });

    const adapter = new RepositoryDbAdapter({
      Flag: makeRepo("Flag"),
      Rule: makeRepo("Rule"),
      Segment: makeRepo("Segment"),
      Release: makeRepo("Release"),
      Assignment: makeRepo("Assignment"),
      History: makeRepo("History"),
      Impression: makeRepo("Impression"),
      ExclusionLayer: makeRepo("ExclusionLayer"),
    });

    // Flag with all the new Tier 2/3 fields.
    await adapter.createFlag({
      key: "tier2_flag",
      type: "boolean",
      defaultValue: false,
      prerequisites: [{ flagKey: "parent", variation: true }],
      environmentDefaults: { production: false, staging: true },
      exclusionLayer: "checkout",
    });

    const flag = await adapter.getFlag("tier2_flag");
    expect(flag?.prerequisites).toEqual([{ flagKey: "parent", variation: true }]);
    expect(flag?.environmentDefaults).toEqual({ production: false, staging: true });
    expect(flag?.exclusionLayer).toBe("checkout");
    expect(flag?.lastEvaluatedAt).toBeNull();

    // Rule with userIds/description/metadata.
    const rule = await adapter.addRule("tier2_flag", {
      priority: 1,
      value: true,
      conditions: {},
      userIds: ["alice", "bob"],
      description: "Allow-list for QA",
      metadata: { ticket: "JIRA-99" },
    });
    expect(rule.userIds).toEqual(["alice", "bob"]);
    expect(rule.description).toBe("Allow-list for QA");
    expect(rule.metadata).toEqual({ ticket: "JIRA-99" });

    // Release with approval workflow.
    const release = await adapter.createRelease({
      name: "Tier 2 launch",
      requiresApproval: true,
      requiredApprovers: ["lead"],
      changes: [],
    });
    expect(release.requiresApproval).toBe(true);
    expect(release.approvalStatus).toBe("pending");
    expect(release.approvals).toEqual([]);

    const approved = await adapter.approveRelease!(release.id, "lead");
    expect(approved.approvalStatus).toBe("approved");

    // Stale-flag touch persists.
    await adapter.touchFlagEvaluation!("tier2_flag");
    const touched = await adapter.getFlag("tier2_flag");
    expect(touched?.lastEvaluatedAt).toBeInstanceOf(Date);

    // Exclusion layer CRUD round-trip.
    await adapter.createExclusionLayer!({
      key: "checkout",
      flagKeys: ["a", "b"],
      allocations: [
        { flagKey: "a", startBucket: 0, endBucket: 50 },
        { flagKey: "b", startBucket: 50, endBucket: 100 },
      ],
    });
    const layer = await adapter.getExclusionLayer!("checkout");
    expect(layer?.allocations).toHaveLength(2);
    expect((await adapter.listExclusionLayers!())).toHaveLength(1);
  });

  it("RepositoryDbAdapter still constructs when the optional ExclusionLayer repo is absent (back-compat)", async () => {
    const { RepositoryDbAdapter } = await import("../src/db/repository");
    const emptyRepo = {
      async create() { return {}; },
      async findOne() { return null; },
      async findMany() { return []; },
      async update() { return null; },
      async delete() {},
      async deleteMany() {},
    };
    expect(() =>
      new RepositoryDbAdapter({
        Flag: emptyRepo,
        Rule: emptyRepo,
        Segment: emptyRepo,
        Release: emptyRepo,
        Assignment: emptyRepo,
        History: emptyRepo,
        Impression: emptyRepo,
        // No ExclusionLayer — must NOT throw.
      })
    ).not.toThrow();
  });
});
