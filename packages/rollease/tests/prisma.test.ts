import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/core/errors";
import {
  ROLLEASE_PRISMA_DEFAULT_DELEGATES,
  ROLLEASE_PRISMA_DEFAULT_MODELS,
  ROLLEASE_PRISMA_REQUIRED_FIELDS,
  createPrismaAdapter,
  validatePrismaModelFields,
  type PrismaClientLike,
} from "../src/db/prisma";

class FakePrismaDelegate {
  rows: Record<string, any>[] = [];

  async create(args: { data: Record<string, unknown> }) {
    const row = { ...args.data };
    this.rows.push(row);
    return row;
  }

  async findFirst(args: { where: Record<string, unknown> }) {
    return this.rows.find((row) => matches(row, args.where)) ?? null;
  }

  async findMany(args?: {
    where?: Record<string, unknown>;
    orderBy?: Array<Record<string, "asc" | "desc">>;
  }) {
    let rows = [...this.rows];
    if (args?.where) {
      rows = rows.filter((row) => matches(row, args.where!));
    }
    for (const order of args?.orderBy ?? []) {
      const [[field, direction]] = Object.entries(order);
      rows.sort((a, b) => {
        if (a[field] === b[field]) return 0;
        const result = a[field] > b[field] ? 1 : -1;
        return direction === "desc" ? -result : result;
      });
    }
    return rows;
  }

  async updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }) {
    let count = 0;
    for (const row of this.rows) {
      if (matches(row, args.where)) {
        Object.assign(row, args.data);
        count += 1;
      }
    }
    return { count };
  }

  async deleteMany(args: { where: Record<string, unknown> }) {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !matches(row, args.where));
    return { count: before - this.rows.length };
  }
}

describe("PrismaDbAdapter", () => {
  it("should persist flags, rules, assignments, releases, and history", async () => {
    const prisma = makePrismaClient();
    const adapter = createPrismaAdapter({
      prisma,
      validateModelFields: true,
      disconnectOnClose: true,
    });

    await adapter.createFlag({
      key: "checkout.prisma-flow",
      type: "boolean",
      defaultValue: false,
      namespace: "checkout",
      rollout: { percentage: 5, sticky: true, hashKey: "userId" },
    });

    await adapter.setRollout("checkout.prisma-flow", { percentage: 75 });
    expect((await adapter.getFlag("checkout.prisma-flow"))?.rollout?.percentage).toBe(75);

    const rule = await adapter.addRule("checkout.prisma-flow", {
      priority: 2,
      value: true,
      conditions: { any: [{ dimension: "plan", op: "eq", value: "pro" }] },
    });
    await adapter.addRule("checkout.prisma-flow", {
      priority: 1,
      value: false,
      conditions: {},
    });
    expect((await adapter.listRules("checkout.prisma-flow"))[0].priority).toBe(1);

    await adapter.updateRule("checkout.prisma-flow", rule.id, { priority: 0 });
    expect((await adapter.listRules("checkout.prisma-flow"))[0].id).toBe(rule.id);

    await adapter.setUserAssignment("checkout.prisma-flow", "user-1", "variant-a");
    expect(await adapter.getUserAssignment("checkout.prisma-flow", "user-1")).toBe(
      "variant-a"
    );

    const release = await adapter.createRelease({
      name: "Prisma Launch",
      changes: [{ flagKey: "checkout.prisma-flow", action: "kill" }],
    });
    await adapter.deployRelease(release.id, "alice");
    expect((await adapter.getFlag("checkout.prisma-flow"))?.status).toBe("killed");
    await adapter.rollbackRelease(release.id, "bob", "rollback");
    expect((await adapter.getFlag("checkout.prisma-flow"))?.status).toBe("active");

    await adapter.trackImpression({
      flagKey: "checkout.prisma-flow",
      userId: "user-1",
      value: true,
      variant: null,
      reason: "rule_match",
    });

    expect((await adapter.getHistory("checkout.prisma-flow")).length).toBeGreaterThan(0);
    await adapter.close();
    expect(prisma.disconnects).toBe(1);
  });

  it("should validate required Prisma delegates", () => {
    const prisma = makePrismaClient();
    delete prisma.rolleaseFlag;

    expect(() => createPrismaAdapter({ prisma })).toThrow(ValidationError);
  });

  it("should validate Prisma runtime model fields when requested", () => {
    const prisma = makePrismaClient({
      Flag: ROLLEASE_PRISMA_REQUIRED_FIELDS.Flag.filter(
        (field) => field !== "defaultValue"
      ),
    });

    expect(() => validatePrismaModelFields({ prisma })).toThrow(ValidationError);
  });
});

function makePrismaClient(
  fieldOverrides: Partial<Record<keyof typeof ROLLEASE_PRISMA_REQUIRED_FIELDS, string[]>> = {}
): PrismaClientLike & { disconnects: number } {
  const client: PrismaClientLike & { disconnects: number } = {
    disconnects: 0,
    async $disconnect() {
      this.disconnects += 1;
    },
    _runtimeDataModel: {
      models: Object.fromEntries(
        Object.entries(ROLLEASE_PRISMA_DEFAULT_MODELS).map(([name, modelName]) => {
          const fields =
            fieldOverrides[name as keyof typeof ROLLEASE_PRISMA_REQUIRED_FIELDS] ??
            ROLLEASE_PRISMA_REQUIRED_FIELDS[
              name as keyof typeof ROLLEASE_PRISMA_REQUIRED_FIELDS
            ];
          return [modelName, { fields: fields.map((field) => ({ name: field })) }];
        })
      ),
    },
  };

  for (const delegateName of Object.values(ROLLEASE_PRISMA_DEFAULT_DELEGATES)) {
    client[delegateName] = new FakePrismaDelegate();
  }

  return client;
}

function matches(row: Record<string, any>, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}
