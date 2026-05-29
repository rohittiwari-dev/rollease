import { describe, expect, it } from "vitest";
import { FlagManager } from "../src/engine/manager";
import { MemoryDbAdapter } from "../src/db/memory";
import { noopLogger } from "../src/core/logger";
import { ReleaseConflictError } from "../src/core/errors";
import { getBucket } from "../src/bucket";
import type { ExclusionLayer, WebhookConfig, WebhookPayload } from "../src/core/types";

function createTestManager(opts?: {
  webhooks?: WebhookConfig[];
  environment?: string;
}) {
  const db = new MemoryDbAdapter();
  const manager = new FlagManager({
    db,
    logger: noopLogger,
    webhooks: opts?.webhooks,
    environment: opts?.environment,
  });
  return { db, manager };
}

// ═══════════════════════════════════════════════════════════════════════════
// Webhooks & Callbacks
// ═══════════════════════════════════════════════════════════════════════════

describe("Webhooks & Callback Listeners", () => {
  it("triggers local JS event listeners on mutations", async () => {
    const { manager } = createTestManager();
    const eventsReceived: WebhookPayload[] = [];

    manager.on("flag.created", (payload) => {
      eventsReceived.push(payload);
    });

    manager.on("*", (payload) => {
      expect(payload.event).toBeDefined();
    });

    await manager.create({
      key: "webhook_test",
      type: "boolean",
      defaultValue: false,
    });

    expect(eventsReceived).toHaveLength(1);
    expect(eventsReceived[0].event).toBe("flag.created");
    expect(eventsReceived[0].flagKey).toBe("webhook_test");
    expect(eventsReceived[0].data.flag).toBeDefined();
  });

  it("delivers HTTP POST webhooks with signatures", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const mockFetch = (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve({ ok: true, status: 200, statusText: "OK" } as Response);
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { manager } = createTestManager({
      webhooks: [
        {
          url: "https://example.com/webhook",
          secret: "my-webhook-signing-secret",
          events: ["flag.created"],
        },
      ],
    });

    await manager.create({
      key: "http_webhook_test",
      type: "boolean",
      defaultValue: true,
    });

    await new Promise((r) => setTimeout(r, 50));
    globalThis.fetch = origFetch;

    expect(calls).toHaveLength(1);
    const [url, requestInit] = calls[0];
    expect(url).toBe("https://example.com/webhook");
    expect(requestInit.method).toBe("POST");
    expect(requestInit.headers).toBeDefined();

    const headers = requestInit.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Rollease-Signature"]).toBeDefined();

    const body = JSON.parse(requestInit.body as string) as WebhookPayload;
    expect(body.event).toBe("flag.created");
    expect(body.flagKey).toBe("http_webhook_test");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Release Approvals
// ═══════════════════════════════════════════════════════════════════════════

describe("Release Approvals Workflow", () => {
  it("blocks deployment if release requires approval but is not approved", async () => {
    const { manager } = createTestManager();

    await manager.create({
      key: "approved_flag",
      type: "boolean",
      defaultValue: false,
    });

    const release = await manager.createRelease({
      name: "Protected Release",
      requiresApproval: true,
      changes: [
        { flagKey: "approved_flag", action: "enable", value: true },
      ],
    });

    expect(release.requiresApproval).toBe(true);
    expect(release.approvalStatus).toBe("pending");

    await expect(manager.deployRelease(release.id)).rejects.toThrow(
      ReleaseConflictError
    );

    expect(await manager.isEnabled("approved_flag", {})).toBe(false);
  });

  it("deploys successfully after receiving required approvals", async () => {
    const { manager } = createTestManager();

    await manager.create({
      key: "approved_flag",
      type: "boolean",
      defaultValue: false,
    });

    const release = await manager.createRelease({
      name: "Protected Release",
      requiresApproval: true,
      requiredApprovers: ["lead_dev", "qa_manager"],
      changes: [
        { flagKey: "approved_flag", action: "enable", value: true },
      ],
    });

    let updated = await manager.approveRelease(release.id, "lead_dev");
    expect(updated.approvalStatus).toBe("pending");
    expect(updated.approvals).toContain("lead_dev");

    updated = await manager.approveRelease(release.id, "qa_manager");
    expect(updated.approvalStatus).toBe("approved");

    await manager.deployRelease(release.id);
    expect(await manager.isEnabled("approved_flag", {})).toBe(true);
  });

  it("allows rejection of a release", async () => {
    const { manager } = createTestManager();
    const release = await manager.createRelease({
      name: "Risk Release",
      requiresApproval: true,
      changes: [],
    });

    const rejected = await manager.rejectRelease(release.id, "qa_lead", {
      reason: "Failed security scan",
    });

    expect(rejected.approvalStatus).toBe("rejected");
    expect(rejected.rejectionReason).toBe("Failed security scan");

    await expect(manager.deployRelease(release.id)).rejects.toThrow(
      ReleaseConflictError
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Multi-Context Evaluation
// ═══════════════════════════════════════════════════════════════════════════

describe("Multi-Context Evaluation", () => {
  it("merges multiple contexts with priority correctly", async () => {
    const { manager } = createTestManager();

    await manager.create({
      key: "multi_test",
      type: "boolean",
      defaultValue: false,
    });

    await manager.addRule("multi_test", {
      priority: 1,
      value: true,
      conditions: {
        all: [
          { dimension: "org", op: "eq", value: "Acme" },
          { dimension: "userType", op: "eq", value: "beta" },
        ],
      },
    });

    const result = await manager.evaluateMultiContext("multi_test", {
      contexts: {
        user: { userId: "alice", userType: "beta" },
        org: { attributes: { org: "Acme" } },
      },
      primaryKey: "user",
    });

    expect(result.value).toBe(true);
    expect(result.reason).toBe("rule_match");
  });

  it("merges segments and deduplicates them", async () => {
    const { manager } = createTestManager();
    await manager.create({
      key: "segment_test",
      type: "boolean",
      defaultValue: false,
    });
    await manager.addRule("segment_test", {
      priority: 1,
      value: true,
      conditions: {
        all: [{ dimension: "segment", op: "in", value: "internal" }],
      },
    });

    const result = await manager.evaluateMultiContext("segment_test", {
      contexts: {
        ctx1: { segments: ["internal", "beta"] },
        ctx2: { segments: ["internal", "alpha"] },
      },
    });

    expect(result.value).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mutual Exclusion Layers
// ═══════════════════════════════════════════════════════════════════════════

describe("Mutual Exclusion Layers", () => {
  it("allocates users deterministically and enforces exclusion at runtime", async () => {
    const { manager } = createTestManager();

    const layerKey = "checkout_experiments";

    // Find user IDs matching different bucket allocations deterministically
    let userA = "";
    for (let i = 0; i < 1000; i++) {
      const u = `user_a_${i}`;
      if (getBucket(u, layerKey) < 50) {
        userA = u;
        break;
      }
    }

    let userB = "";
    for (let i = 0; i < 1000; i++) {
      const u = `user_b_${i}`;
      if (getBucket(u, layerKey) >= 50) {
        userB = u;
        break;
      }
    }

    expect(userA).not.toBe("");
    expect(userB).not.toBe("");

    // Create exclusion layer
    const layer: ExclusionLayer = {
      key: layerKey,
      flagKeys: ["experiment_a", "experiment_b"],
      allocations: [
        { flagKey: "experiment_a", startBucket: 0, endBucket: 50 },
        { flagKey: "experiment_b", startBucket: 50, endBucket: 100 },
      ],
    };
    await manager.createExclusionLayer(layer);

    // Create flags on this exclusion layer
    await manager.create({
      key: "experiment_a",
      type: "boolean",
      defaultValue: false,
      exclusionLayer: layerKey,
    });
    await manager.create({
      key: "experiment_b",
      type: "boolean",
      defaultValue: false,
      exclusionLayer: layerKey,
    });

    await manager.addRule("experiment_a", {
      priority: 1,
      value: true,
      conditions: {},
    });
    await manager.addRule("experiment_b", {
      priority: 1,
      value: true,
      conditions: {},
    });

    // userA should be allowed in experiment_a, but excluded from experiment_b
    const resA1 = await manager.evaluate("experiment_a", { userId: userA });
    expect(resA1.value).toBe(true);
    expect(resA1.reason).toBe("rule_match");

    const resB1 = await manager.evaluate("experiment_b", { userId: userA });
    expect(resB1.value).toBe(false);
    expect(resB1.reason).toBe("exclusion_group_miss");
    expect(resB1.enabled).toBe(false);

    // userB should be allowed in experiment_b, but excluded from experiment_a
    const resA6 = await manager.evaluate("experiment_a", { userId: userB });
    expect(resA6.value).toBe(false);
    expect(resA6.reason).toBe("exclusion_group_miss");

    const resB6 = await manager.evaluate("experiment_b", { userId: userB });
    expect(resB6.value).toBe(true);
    expect(resB6.reason).toBe("rule_match");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Environment Scoping
// ═══════════════════════════════════════════════════════════════════════════

describe("Environment-Scoped Flags & SDK Keys", () => {
  it("auto-injects environment into evaluation context", async () => {
    const { manager } = createTestManager({ environment: "production" });

    await manager.create({
      key: "env_scoped",
      type: "boolean",
      defaultValue: false,
    });

    await manager.addRule("env_scoped", {
      priority: 1,
      value: true,
      conditions: {
        all: [{ dimension: "environment", op: "eq", value: "production" }],
      },
    });

    expect(await manager.isEnabled("env_scoped", {})).toBe(true);
  });

  it("filters evaluateAll output based on environment scoping", async () => {
    const { manager } = createTestManager({ environment: "production" });

    await manager.create({
      key: "flag_any",
      type: "boolean",
      defaultValue: true,
    });

    await manager.create({
      key: "flag_prod",
      type: "boolean",
      defaultValue: true,
      environments: ["production"],
    });

    await manager.create({
      key: "flag_staging",
      type: "boolean",
      defaultValue: true,
      environments: ["staging"],
    });

    const flags = await manager.evaluateAll({});
    expect(flags.flag_any).toBe(true);
    expect(flags.flag_prod).toBe(true);
    expect(flags.flag_staging).toBeUndefined();
  });
});
