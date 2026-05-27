import { describe, expect, it } from "vitest";
import {
  ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS,
  ValidationError,
  createMemoryAdapter,
  createRollease,
  validateSequelizeAdapterModels,
} from "../src";
import {
  createSignedFlagPayload,
  readSignedFlagPayload,
} from "../src/frameworks/next";

const SECRET = "example-secret-at-least-16";

describe("SDK Usage Examples", () => {
  it("quickstart: create a client, define a flag, and evaluate it", async () => {
    const rollease = createRollease({
      db: createMemoryAdapter(),
      secret: SECRET,
      cache: { driver: "memory", ttl: 30 },
    });

    await rollease.flags.create({
      key: "checkout.new-flow",
      type: "boolean",
      defaultValue: false,
      description: "Roll out the new checkout UI",
    });

    expect(
      await rollease.flags.isEnabled("checkout.new-flow", {
        userId: "user_123",
        environment: "production",
      })
    ).toBe(false);

    await rollease.flags.addRule("checkout.new-flow", {
      priority: 1,
      value: true,
      conditions: {
        all: [
          { dimension: "environment", op: "eq", value: "production" },
          { dimension: "userType", op: "eq", value: "beta" },
        ],
      },
    });

    expect(
      await rollease.flags.isEnabled("checkout.new-flow", {
        userId: "user_123",
        environment: "production",
        userType: "beta",
      })
    ).toBe(true);

    const detailed = await rollease.flags.evaluateAllDetailed({
      userId: "user_123",
      environment: "production",
      userType: "beta",
    });

    expect(detailed["checkout.new-flow"].reason).toBe("rule_match");
    await rollease.close();
  });

  it("multivariate: assign a sticky variant and read typed values", async () => {
    const db = createMemoryAdapter();
    const rollease = createRollease({ db, secret: SECRET });

    await rollease.flags.create({
      key: "pricing.layout",
      type: "multivariate",
      defaultValue: { columns: 1 },
      variants: [
        { key: "control", value: { columns: 1 }, weight: 50 },
        { key: "card-grid", value: { columns: 3 }, weight: 50 },
      ],
    });

    await db.setUserAssignment("pricing.layout", "user_abc", "card-grid");

    const variant = await rollease.flags.getVariant("pricing.layout", {
      userId: "user_abc",
    });
    const value = await rollease.flags.getValue<{ columns: number }>(
      "pricing.layout",
      { userId: "user_abc" }
    );

    expect(variant.key).toBe("card-grid");
    expect(value.columns).toBe(3);
  });

  it("release workflow: preview, deploy, rollback", async () => {
    const rollease = createRollease({
      db: createMemoryAdapter(),
      secret: SECRET,
    });

    await rollease.flags.create({
      key: "ops.kill-switch-demo",
      type: "boolean",
      defaultValue: false,
    });

    const release = await rollease.flags.createRelease({
      name: "Enable kill switch demo",
      environment: "staging",
      changes: [
        { flagKey: "ops.kill-switch-demo", action: "enable", value: true },
      ],
    });

    const preview = await rollease.flags.previewRelease(release.id);
    expect(preview).toEqual([
      {
        flagKey: "ops.kill-switch-demo",
        before: { value: false, status: "active" },
        after: { value: true, status: "active" },
      },
    ]);

    await rollease.flags.deployRelease(release.id, { deployedBy: "alice" });
    expect(await rollease.flags.getValue("ops.kill-switch-demo", {})).toBe(true);

    await rollease.flags.rollbackRelease(release.id, {
      rolledBackBy: "alice",
      reason: "example rollback",
    });
    expect(await rollease.flags.getValue("ops.kill-switch-demo", {})).toBe(false);
  });

  it("server transport: sign pre-evaluated flags before handoff", async () => {
    const rollease = createRollease({
      db: createMemoryAdapter(),
      secret: SECRET,
    });

    await rollease.flags.create({
      key: "nav.redesign",
      type: "boolean",
      defaultValue: true,
    });

    const flags = await rollease.flags.evaluateAll({
      userId: "user_123",
      environment: "production",
    });

    const envelope = await createSignedFlagPayload(flags, SECRET);

    expect(await readSignedFlagPayload(envelope, SECRET)).toEqual({
      "nav.redesign": true,
    });
    expect(await readSignedFlagPayload(`${envelope}.tampered`, SECRET)).toBeNull();
  });

  it("adapter validation: validate passed Sequelize model columns", () => {
    const compatibleModels = Object.fromEntries(
      Object.entries(ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS).map(
        ([modelName, columns]) => [
          modelName,
          {
            rawAttributes: Object.fromEntries(
              columns.map((column) => [column, {}])
            ),
          },
        ]
      )
    );

    expect(() => validateSequelizeAdapterModels(compatibleModels)).not.toThrow();

    const brokenModels = {
      ...compatibleModels,
      Flag: {
        rawAttributes: {
          id: {},
          key: {},
        },
      },
    };

    expect(() => validateSequelizeAdapterModels(brokenModels)).toThrow(
      ValidationError
    );
  });
});
