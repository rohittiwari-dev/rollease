import { describe, expect, it } from "vitest";
import {
  ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS,
  SequelizeDbAdapter,
  createSequelizeAdapter,
} from "../src/db/sequelize";
import { FlagConflictError, ValidationError } from "../src/core/errors";

class FakeModel {
  rows: Record<string, any>[] = [];
  rawAttributes: Record<string, unknown>;

  constructor(attributes: Record<string, unknown> = {}) {
    this.rawAttributes = attributes;
  }

  async create(values: Record<string, unknown>) {
    const row = { ...values };
    this.rows.push(row);
    return row;
  }

  async findOne(options: { where: Record<string, unknown> }) {
    return this.rows.find((row) => matches(row, options.where)) ?? null;
  }

  async findAll(options?: {
    where?: Record<string, unknown>;
    order?: Array<[string, "ASC" | "DESC"]>;
  }) {
    let rows = [...this.rows];
    if (options?.where) {
      rows = rows.filter((row) => matches(row, options.where!));
    }
    for (const [field, direction] of options?.order ?? []) {
      rows.sort((a, b) => {
        const left = a[field];
        const right = b[field];
        if (left === right) return 0;
        const result = left > right ? 1 : -1;
        return direction === "DESC" ? -result : result;
      });
    }
    return rows;
  }

  async update(
    values: Record<string, unknown>,
    options: { where: Record<string, unknown> }
  ) {
    for (const row of this.rows) {
      if (matches(row, options.where)) {
        Object.assign(row, values);
      }
    }
  }

  async destroy(options: { where: Record<string, unknown> }) {
    this.rows = this.rows.filter((row) => !matches(row, options.where));
  }
}

class FakeSequelize {
  models = new Map<string, FakeModel>();
  synced = 0;
  closed = 0;

  define(_name: string, _attributes: unknown, options?: { tableName?: string }) {
    const model = new FakeModel(_attributes as Record<string, unknown>);
    this.models.set(options?.tableName ?? _name, model);
    return model;
  }

  async sync() {
    this.synced += 1;
  }

  async close() {
    this.closed += 1;
  }
}

const sequelizeModule = {
  DataTypes: {
    STRING: "STRING",
    TEXT: "TEXT",
    JSON: "JSON",
    BOOLEAN: "BOOLEAN",
    FLOAT: "FLOAT",
    INTEGER: "INTEGER",
    DATE: "DATE",
  },
};

describe("SequelizeDbAdapter", () => {
  it("should persist flags, rules, assignments, segments, releases, and history", async () => {
    const sequelize = new FakeSequelize();
    const adapter = new SequelizeDbAdapter({
      sequelize,
      sequelizeModule,
      sync: true,
    });

    const flag = await adapter.createFlag({
      key: "checkout.new-flow",
      type: "boolean",
      defaultValue: false,
      namespace: "checkout",
      tags: ["web"],
      rollout: { percentage: 10, sticky: true, hashKey: "userId" },
    });

    expect(flag.key).toBe("checkout.new-flow");
    expect(sequelize.synced).toBe(1);
    await expect(
      adapter.createFlag({
        key: "checkout.new-flow",
        type: "boolean",
        defaultValue: false,
      })
    ).rejects.toThrow(FlagConflictError);

    await adapter.setRollout("checkout.new-flow", { percentage: 50 });
    expect((await adapter.getFlag("checkout.new-flow"))?.rollout?.percentage).toBe(50);

    const rule = await adapter.addRule("checkout.new-flow", {
      priority: 2,
      value: true,
      conditions: { any: [{ dimension: "userType", op: "eq", value: "beta" }] },
    });
    await adapter.addRule("checkout.new-flow", {
      priority: 1,
      value: false,
      conditions: {},
    });
    expect((await adapter.listRules("checkout.new-flow"))[0].priority).toBe(1);

    await adapter.updateRule("checkout.new-flow", rule.id, { priority: 0 });
    expect((await adapter.listRules("checkout.new-flow"))[0].id).toBe(rule.id);

    await adapter.setUserAssignment("checkout.new-flow", "user-1", "treatment");
    expect(await adapter.getUserAssignment("checkout.new-flow", "user-1")).toBe("treatment");

    await adapter.createSegment({
      key: "beta-users",
      rules: { any: [{ dimension: "segment", op: "in", value: ["beta-users"] }] },
    });
    await adapter.addRule("checkout.new-flow", {
      priority: 3,
      value: true,
      conditions: { any: [{ dimension: "segment", op: "in", value: ["beta-users"] }] },
    });
    expect(await adapter.getSegment("beta-users")).toBeDefined();
    expect((await adapter.getSegmentUsage("beta-users")).length).toBe(1);

    const release = await adapter.createRelease({
      name: "Launch",
      changes: [{ flagKey: "checkout.new-flow", action: "kill" }],
    });
    await adapter.deployRelease(release.id, "alice");
    expect((await adapter.getFlag("checkout.new-flow"))?.status).toBe("killed");
    await adapter.rollbackRelease(release.id, "bob", "rollback");
    expect((await adapter.getFlag("checkout.new-flow"))?.status).toBe("active");

    await adapter.trackImpression({
      flagKey: "checkout.new-flow",
      userId: "user-1",
      value: true,
      variant: null,
      reason: "rule_match",
    });

    const active = await adapter.getAllActiveFlags({ namespace: "checkout" });
    expect(active.length).toBe(1);

    const history = await adapter.getHistory("checkout.new-flow");
    expect(history.length).toBeGreaterThan(0);

    await adapter.close();
    expect(sequelize.closed).toBe(1);
  });

  it("should reject unsafe regex rules", async () => {
    const adapter = createSequelizeAdapter({
      sequelize: new FakeSequelize(),
      sequelizeModule,
    });

    await adapter.createFlag({
      key: "flag",
      type: "boolean",
      defaultValue: false,
    });

    await expect(
      adapter.addRule("flag", {
        priority: 1,
        value: true,
        conditions: { any: [{ dimension: "email", op: "regex", value: "(a+)+$" }] },
      })
    ).rejects.toThrow(ValidationError);
  });

  it("should use passed models and validate their columns", async () => {
    const sequelize = new FakeSequelize();
    const models = makePassedModels();
    const adapter = createSequelizeAdapter({
      sequelize,
      sequelizeModule,
      models,
    });

    await adapter.createFlag({
      key: "model-backed",
      type: "boolean",
      defaultValue: false,
    });

    expect(models.Flag.rows.length).toBe(1);
    expect(sequelize.models.size).toBe(0);
  });

  it("should fail fast when passed models are missing required columns", async () => {
    const models = makePassedModels({
      Flag: ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS.Flag.filter(
        (column) => column !== "defaultValue"
      ),
    });
    const adapter = createSequelizeAdapter({
      sequelize: new FakeSequelize(),
      sequelizeModule,
      models,
    });

    await expect(
      adapter.createFlag({
        key: "broken-model",
        type: "boolean",
        defaultValue: false,
      })
    ).rejects.toThrow(ValidationError);
  });
});

function matches(row: Record<string, any>, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function makePassedModels(
  overrides: Partial<Record<keyof typeof ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS, string[]>> = {}
) {
  return Object.fromEntries(
    Object.entries(ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS).map(([name, columns]) => [
      name,
      new FakeModel(
        Object.fromEntries((overrides[name as keyof typeof overrides] ?? columns).map((column) => [
          column,
          {},
        ]))
      ),
    ])
  ) as Record<keyof typeof ROLLEASE_SEQUELIZE_REQUIRED_COLUMNS, FakeModel>;
}
