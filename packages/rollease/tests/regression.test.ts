// ============================================================================
// Regression tests for previously fixed bugs
// ============================================================================
// Covers: RBAC wiring, scrubContext top-level fields, createRelease action,
// rejectRelease RBAC gating, exposure dedup wiring, metrics wiring,
// tenant adapter optional methods, evaluateAllDetailed trace, env filter consistency.

import { describe, expect, it, vi } from "vitest";
import { FlagManager } from "../src/engine/manager";
import { MemoryDbAdapter } from "../src/db/memory";
import { noopLogger } from "../src/core/logger";
import { createDefaultRBACPolicy, createRBACHook } from "../src/core/rbac";
import { createPrometheusAdapter } from "../src/core/metrics";
import { createExposureTracker } from "../src/core/exposure";
import { createTenantAdapter } from "../src/core/tenant";
import type { AuditActor, FlagContext, FlagResult } from "../src/core/types";

const ACTOR: AuditActor = { id: "u1", type: "user", name: "Alice" };

function mkManager(opts?: ConstructorParameters<typeof FlagManager>[0]) {
  const db = new MemoryDbAdapter();
  return { db, manager: new FlagManager({ db, logger: noopLogger, ...opts }) };
}

// ─────────────────────────────────────────────────────────────────────────────
// scrubContext — top-level FlagContext fields are now scrubbed
// ─────────────────────────────────────────────────────────────────────────────

describe("scrubContext — top-level fields", () => {
  it("redacts listed top-level fields in impressions", async () => {
    const impressions: { userId: string }[] = [];
    const db = new MemoryDbAdapter();
    // Intercept trackImpression
    (db as unknown as { trackImpression: (p: { userId: string }) => Promise<void> }).trackImpression = async (p) => {
      impressions.push(p);
    };
    const manager = new FlagManager({
      db,
      logger: noopLogger,
      privacy: { privateAttributes: ["userId"] },
      impressions: { enabled: true, sampleRate: 1 },
    });

    await manager.create({ key: "pii_flag", type: "boolean", defaultValue: true });
    await manager.evaluate("pii_flag", { userId: "secret-user-id" });
    await new Promise((r) => setTimeout(r, 50));

    // The userId in the impression should be redacted
    expect(impressions).toHaveLength(1);
    expect(impressions[0].userId).toBe("[REDACTED]");
  });

  it("redacts region in hook context when region is private", async () => {
    const hookContexts: FlagContext[] = [];
    const db = new MemoryDbAdapter();
    const manager = new FlagManager({
      db,
      logger: noopLogger,
      privacy: { privateAttributes: ["region"] },
      hooks: {
        onBeforeEvaluation: (ctx) => {
          hookContexts.push(ctx.context);
        },
      },
    });

    await manager.create({ key: "region_flag", type: "boolean", defaultValue: true });
    await manager.evaluate("region_flag", { userId: "u1", region: "eu-west" });

    expect(hookContexts).toHaveLength(1);
    expect(hookContexts[0].region).toBe("[REDACTED]");
  });

  it("ctx.attributes scrubbing still works alongside top-level scrubbing", async () => {
    const hookContexts: FlagContext[] = [];
    const db = new MemoryDbAdapter();
    const manager = new FlagManager({
      db,
      logger: noopLogger,
      privacy: { privateAttributes: ["email", "userId"] },
      hooks: {
        onBeforeEvaluation: (ctx) => {
          hookContexts.push(ctx.context);
        },
      },
    });

    await manager.create({ key: "scrub_flag", type: "boolean", defaultValue: true });
    await manager.evaluate("scrub_flag", {
      userId: "u1",
      attributes: { email: "alice@example.com", score: 99 },
    });

    expect(hookContexts[0].userId).toBe("[REDACTED]");
    expect(hookContexts[0].attributes?.email).toBe("[REDACTED]");
    expect(hookContexts[0].attributes?.score).toBe(99); // not in privateAttributes
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RBAC — createRelease now fires "release.created" action
// ─────────────────────────────────────────────────────────────────────────────

describe("RBAC — createRelease action", () => {
  it("createRelease fires release.created hook action", async () => {
    const hookActions: string[] = [];
    const { manager } = mkManager({
      hooks: {
        onBeforeMutation: (ctx) => {
          hookActions.push(ctx.action);
        },
      },
    });

    await manager.create({ key: "f1", type: "boolean", defaultValue: false });
    await manager.createRelease({
      name: "My Release",
      changes: [{ flagKey: "f1", action: "enable", value: true }],
    });

    expect(hookActions).toContain("release.created");
    expect(hookActions).not.toContain("release.deployed");
  });

  it("editor role (has release.create) can create a release via RBAC hook", async () => {
    const policy = createDefaultRBACPolicy({ u_admin: "admin", u_editor: "editor" });
    const hook = createRBACHook(policy);
    const { manager } = mkManager({
      hooks: { onBeforeMutation: hook },
    });

    const adminActor: AuditActor = { id: "u_admin", type: "user", name: "Admin" };
    await manager.create({
      key: "editor_flag",
      type: "boolean",
      defaultValue: false,
      actor: adminActor,
    });

    const editorActor: AuditActor = { id: "u_editor", type: "user", name: "Editor" };
    // editor has release.create → should NOT throw
    await expect(
      manager.createRelease({
        name: "Editor Release",
        changes: [{ flagKey: "editor_flag", action: "enable", value: true }],
        actor: editorActor,
      })
    ).resolves.toBeDefined();
  });

  it("viewer role (lacks release.create) cannot create a release", async () => {
    const policy = createDefaultRBACPolicy({ u_viewer: "viewer" });
    const hook = createRBACHook(policy);
    const { manager } = mkManager({
      hooks: { onBeforeMutation: hook },
    });

    const viewerActor: AuditActor = { id: "u_viewer", type: "user", name: "Viewer" };
    await expect(
      manager.createRelease({
        name: "Viewer Release",
        changes: [],
        actor: viewerActor,
      })
    ).rejects.toThrow(/does not have permission.*release.create/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RBAC — rejectRelease is now gated by release.reject permission
// ─────────────────────────────────────────────────────────────────────────────

describe("RBAC — rejectRelease permission", () => {
  it("viewer role cannot reject a release", async () => {
    const adminActor: AuditActor = { id: "u_admin", type: "user", name: "Admin" };
    const policy = createDefaultRBACPolicy({ u_admin: "admin", u_viewer: "viewer" });
    const hook = createRBACHook(policy);
    const { manager } = mkManager({
      hooks: { onBeforeMutation: hook },
    });

    await manager.create({ key: "r_flag", type: "boolean", defaultValue: false, actor: adminActor });
    const release = await manager.createRelease({
      name: "Protected",
      requiresApproval: true,
      changes: [{ flagKey: "r_flag", action: "enable", value: true }],
      actor: adminActor,
    });

    const viewerActor: AuditActor = { id: "u_viewer", type: "user", name: "Viewer" };
    await expect(
      manager.rejectRelease(release.id, "u_viewer", { reason: "No", actor: viewerActor })
    ).rejects.toThrow(/does not have permission.*release.reject/i);
  });

  it("editor role can reject a release (has release.reject)", async () => {
    const adminActor: AuditActor = { id: "u_admin", type: "user", name: "Admin" };
    const editorActor: AuditActor = { id: "u_editor", type: "user", name: "Editor" };
    const policy = createDefaultRBACPolicy({ u_admin: "admin", u_editor: "editor" });
    const hook = createRBACHook(policy);
    const { manager } = mkManager({
      hooks: { onBeforeMutation: hook },
    });

    await manager.create({ key: "r2_flag", type: "boolean", defaultValue: false, actor: adminActor });
    const release = await manager.createRelease({
      name: "Protected",
      requiresApproval: true,
      changes: [{ flagKey: "r2_flag", action: "enable", value: true }],
      actor: adminActor,
    });

    const rejected = await manager.rejectRelease(release.id, "u_editor", {
      reason: "Looks risky",
      actor: editorActor,
    });
    expect(rejected.approvalStatus).toBe("rejected");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exposure dedup — wired into manager impression tracking
// ─────────────────────────────────────────────────────────────────────────────

describe("Exposure dedup — manager integration", () => {
  it("suppresses duplicate impressions within the window", async () => {
    const trackedImpressions: string[] = [];
    const db = new MemoryDbAdapter();
    (db as unknown as { trackImpression: (p: { flagKey: string }) => Promise<void> }).trackImpression = async (p) => {
      trackedImpressions.push(p.flagKey);
    };

    const manager = new FlagManager({
      db,
      logger: noopLogger,
      impressions: {
        enabled: true,
        sampleRate: 1,
        dedupe: { windowMs: 60_000, keyFields: ["flagKey", "userId", "value"] },
      },
    });

    await manager.create({ key: "dedup_flag", type: "boolean", defaultValue: true });

    // Evaluate 3 times — only the first should produce an impression
    await manager.evaluate("dedup_flag", { userId: "u1" });
    await manager.evaluate("dedup_flag", { userId: "u1" });
    await manager.evaluate("dedup_flag", { userId: "u1" });
    await new Promise((r) => setTimeout(r, 50));

    expect(trackedImpressions).toHaveLength(1);
    expect(trackedImpressions[0]).toBe("dedup_flag");
  });

  it("different users each get their own impression", async () => {
    const trackedImpressions: string[] = [];
    const db = new MemoryDbAdapter();
    (db as unknown as { trackImpression: (p: { userId: string }) => Promise<void> }).trackImpression = async (p) => {
      trackedImpressions.push(p.userId);
    };

    const manager = new FlagManager({
      db,
      logger: noopLogger,
      impressions: {
        enabled: true,
        sampleRate: 1,
        dedupe: { windowMs: 60_000 },
      },
    });

    await manager.create({ key: "dedup2", type: "boolean", defaultValue: true });

    await manager.evaluate("dedup2", { userId: "alice" });
    await manager.evaluate("dedup2", { userId: "bob" });
    await manager.evaluate("dedup2", { userId: "alice" }); // duplicate — suppressed
    await new Promise((r) => setTimeout(r, 50));

    expect(trackedImpressions).toHaveLength(2);
    expect(trackedImpressions).toContain("alice");
    expect(trackedImpressions).toContain("bob");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Metrics — wired into FlagManager
// ─────────────────────────────────────────────────────────────────────────────

describe("Metrics adapter — FlagManager integration", () => {
  it("increments rollease_evaluations_total on each evaluate()", async () => {
    const metrics = createPrometheusAdapter();
    const { manager } = mkManager({ metrics });

    await manager.create({ key: "m_flag", type: "boolean", defaultValue: true });
    await manager.evaluate("m_flag", { userId: "u1" });
    await manager.evaluate("m_flag", { userId: "u2" });

    const output = metrics.serialize();
    expect(output).toContain("rollease_evaluations_total");
  });

  it("increments cache hit counters", async () => {
    const metrics = createPrometheusAdapter();
    const { manager } = mkManager({ metrics });

    await manager.create({ key: "cache_flag", type: "boolean", defaultValue: true });
    // First eval — cache miss; second eval — L1 cache hit
    await manager.evaluate("cache_flag", {});
    await manager.evaluate("cache_flag", {});

    const output = metrics.serialize();
    expect(output).toContain("rollease_cache_hits_total");
    expect(output).toContain("rollease_cache_misses_total");
  });

  it("getMetrics() returns Prometheus text format", async () => {
    const metrics = createPrometheusAdapter();
    const { manager } = mkManager({ metrics });

    await manager.create({ key: "gm_flag", type: "boolean", defaultValue: true });
    await manager.evaluate("gm_flag", {});

    const text = manager.getMetrics();
    expect(text).toContain("# TYPE rollease_evaluations_total counter");
    expect(text).toContain("rollease_evaluations_total");
  });

  it("getMetrics() returns empty string when no metrics adapter", () => {
    const { manager } = mkManager();
    expect(manager.getMetrics()).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tenant adapter — optional method forwarding
// ─────────────────────────────────────────────────────────────────────────────

describe("TenantAdapter — optional method forwarding", () => {
  it("forwards touchFlagEvaluation with namespaced key", async () => {
    const innerDb = new MemoryDbAdapter();
    const touched: string[] = [];
    (innerDb as unknown as { touchFlagEvaluation: (k: string) => Promise<void> }).touchFlagEvaluation = async (k) => {
      touched.push(k);
    };

    const tenantDb = createTenantAdapter(innerDb, { tenantId: "acme" });
    await tenantDb.touchFlagEvaluation!("my-flag");

    expect(touched).toHaveLength(1);
    expect(touched[0]).toBe("acme:my-flag");
  });

  it("forwards getUserAssignments with namespaced keys and un-namespaces results", async () => {
    const innerDb = new MemoryDbAdapter();
    const origGetAssignments = innerDb.getUserAssignments?.bind(innerDb);
    const calls: { flagKeys: string[]; userId: string }[] = [];
    innerDb.getUserAssignments = async (flagKeys, userId) => {
      calls.push({ flagKeys, userId });
      // Simulate results with namespaced keys
      const result: Record<string, string> = {};
      for (const k of flagKeys) {
        result[k] = "variant-a";
      }
      return result;
    };

    const tenantDb = createTenantAdapter(innerDb, { tenantId: "acme" });
    const result = await tenantDb.getUserAssignments!(["flag-x", "flag-y"], "u1");

    expect(calls[0].flagKeys).toEqual(["acme:flag-x", "acme:flag-y"]);
    // Results should be un-namespaced back
    expect(result["flag-x"]).toBe("variant-a");
    expect(result["flag-y"]).toBe("variant-a");
    expect("acme:flag-x" in result).toBe(false);
  });

  it("forwards listScheduledReleases to inner adapter", async () => {
    const innerDb = new MemoryDbAdapter();
    let called = false;
    innerDb.listScheduledReleases = async () => {
      called = true;
      return [];
    };

    const tenantDb = createTenantAdapter(innerDb, { tenantId: "acme" });
    const releases = await tenantDb.listScheduledReleases!();

    expect(called).toBe(true);
    expect(releases).toEqual([]);
  });

  it("forwards approveRelease to inner adapter", async () => {
    const innerDb = new MemoryDbAdapter();
    const approved: { id: string; approverId: string }[] = [];
    innerDb.approveRelease = async (id, approverId) => {
      approved.push({ id, approverId });
      return { id, name: "test", status: "pending" as const, changes: [], approvalStatus: "approved" as const, approvals: [approverId], createdAt: new Date() };
    };

    const tenantDb = createTenantAdapter(innerDb, { tenantId: "acme" });
    await tenantDb.approveRelease!("release-1", "user-1");

    expect(approved).toHaveLength(1);
    expect(approved[0]).toEqual({ id: "release-1", approverId: "user-1" });
  });

  it("forwards rejectRelease to inner adapter", async () => {
    const innerDb = new MemoryDbAdapter();
    const rejected: { id: string; rejectorId: string; reason?: string }[] = [];
    innerDb.rejectRelease = async (id, rejectorId, reason) => {
      rejected.push({ id, rejectorId, reason });
      return { id, name: "test", status: "pending" as const, changes: [], approvalStatus: "rejected" as const, approvals: [], rejectionReason: reason, createdAt: new Date() };
    };

    const tenantDb = createTenantAdapter(innerDb, { tenantId: "acme" });
    await tenantDb.rejectRelease!("release-2", "user-2", "Not ready");

    expect(rejected[0]).toEqual({ id: "release-2", rejectorId: "user-2", reason: "Not ready" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateAllDetailed — trace option
// ─────────────────────────────────────────────────────────────────────────────

describe("evaluateAllDetailed — trace option", () => {
  it("populates trace on each flag when trace: true", async () => {
    const { manager } = mkManager();

    await manager.create({ key: "t1", type: "boolean", defaultValue: true });
    await manager.create({ key: "t2", type: "boolean", defaultValue: false });

    const result = await manager.evaluateAllDetailed({}, { trace: true });

    expect(result.t1.trace).toBeDefined();
    expect(result.t1.trace!.steps.length).toBeGreaterThan(0);
    expect(result.t2.trace).toBeDefined();
  });

  it("does not populate trace when trace option is omitted", async () => {
    const { manager } = mkManager();
    await manager.create({ key: "nt", type: "boolean", defaultValue: true });

    const result = await manager.evaluateAllDetailed({});
    expect(result.nt.trace).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Environment filter — consistency between evaluate and evaluateAll
// ─────────────────────────────────────────────────────────────────────────────

describe("Environment filter — single evaluate consistency", () => {
  it("single evaluate() returns missingFlagResult for out-of-scope environment flags", async () => {
    const { manager } = mkManager();

    await manager.create({
      key: "prod_only",
      type: "boolean",
      defaultValue: true,
      environments: ["production"],
    });

    // Evaluate in staging context — flag is scoped to production only
    const result = await manager.evaluate("prod_only", { environment: "staging" });
    expect(result.value).toBeUndefined();
    expect(result.reason).toBe("default");
  });

  it("single evaluate() returns result for matching environment", async () => {
    const { manager } = mkManager();

    await manager.create({
      key: "prod_flag",
      type: "boolean",
      defaultValue: true,
      environments: ["production"],
    });

    const result = await manager.evaluate("prod_flag", { environment: "production" });
    expect(result.value).toBe(true);
  });

  it("single evaluate() returns result when no environment scope set", async () => {
    const { manager } = mkManager();

    await manager.create({
      key: "any_flag",
      type: "boolean",
      defaultValue: true,
    });

    // No environments restriction — works in any context
    const result = await manager.evaluate("any_flag", { environment: "staging" });
    expect(result.value).toBe(true);
  });
});
