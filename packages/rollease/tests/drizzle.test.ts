import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/core/errors";
import {
  ROLLEASE_DRIZZLE_REQUIRED_COLUMNS,
  createDrizzleAdapter,
  type DrizzleHelpers,
  type DrizzleTableMap,
} from "../src/db/drizzle";

type Row = Record<string, any>;
type Predicate = (row: Row) => boolean;
type Order = { field: string; direction: "asc" | "desc" };

class FakeDrizzleDb {
  private rowsByTable = new Map<object, Row[]>();

  select() {
    return {
      from: (table: object) => new FakeSelectQuery(() => this.rows(table)),
    };
  }

  insert(table: object) {
    return {
      values: (values: Row) => new FakeInsertQuery(this.rows(table), values),
    };
  }

  update(table: object) {
    return {
      set: (values: Row) => new FakeUpdateQuery(this.rows(table), values),
    };
  }

  delete(table: object) {
    return new FakeDeleteQuery(
      () => this.rows(table),
      (rows) => this.rowsByTable.set(table, rows)
    );
  }

  private rows(table: object) {
    if (!this.rowsByTable.has(table)) {
      this.rowsByTable.set(table, []);
    }
    return this.rowsByTable.get(table)!;
  }
}

class FakeSelectQuery {
  private predicate?: Predicate;
  private orders: Order[] = [];
  private maxRows?: number;

  constructor(private readonly getRows: () => Row[]) {}

  where(condition: Predicate) {
    this.predicate = condition;
    return this;
  }

  orderBy(...orders: Order[]) {
    this.orders = orders;
    return this;
  }

  limit(count: number) {
    this.maxRows = count;
    return this;
  }

  async execute() {
    let rows = [...this.getRows()];
    if (this.predicate) {
      rows = rows.filter(this.predicate);
    }
    for (const order of this.orders) {
      rows.sort((a, b) => {
        if (a[order.field] === b[order.field]) return 0;
        const result = a[order.field] > b[order.field] ? 1 : -1;
        return order.direction === "desc" ? -result : result;
      });
    }
    return this.maxRows === undefined ? rows : rows.slice(0, this.maxRows);
  }

  then(onfulfilled?: any, onrejected?: any) {
    return this.execute().then(onfulfilled, onrejected);
  }
}

class FakeInsertQuery {
  constructor(
    private readonly rows: Row[],
    private readonly values: Row
  ) {}

  async returning() {
    const row = { ...this.values };
    this.rows.push(row);
    return [row];
  }

  then(onfulfilled?: any, onrejected?: any) {
    return this.returning().then(onfulfilled, onrejected);
  }
}

class FakeUpdateQuery {
  private predicate?: Predicate;

  constructor(
    private readonly rows: Row[],
    private readonly values: Row
  ) {}

  where(condition: Predicate) {
    this.predicate = condition;
    return this;
  }

  async returning() {
    const updated: Row[] = [];
    for (const row of this.rows) {
      if (!this.predicate || this.predicate(row)) {
        Object.assign(row, this.values);
        updated.push(row);
      }
    }
    return updated;
  }

  then(onfulfilled?: any, onrejected?: any) {
    return this.returning().then(onfulfilled, onrejected);
  }
}

class FakeDeleteQuery {
  private predicate?: Predicate;

  constructor(
    private readonly getRows: () => Row[],
    private readonly setRows: (rows: Row[]) => void
  ) {}

  where(condition: Predicate) {
    this.predicate = condition;
    return this;
  }

  async returning() {
    const rows = this.getRows();
    const deleted = rows.filter((row) => !this.predicate || this.predicate(row));
    this.setRows(rows.filter((row) => this.predicate && !this.predicate(row)));
    return deleted;
  }

  then(onfulfilled?: any, onrejected?: any) {
    return this.returning().then(onfulfilled, onrejected);
  }
}

const helpers: DrizzleHelpers = {
  eq: (column, value) => (row: Row) => row[(column as { name: string }).name] === value,
  and: (...conditions) => (row: Row) =>
    conditions.every((condition) => (condition as Predicate)(row)),
  asc: (column) => ({ field: (column as { name: string }).name, direction: "asc" }),
  desc: (column) => ({ field: (column as { name: string }).name, direction: "desc" }),
};

describe("DrizzleDbAdapter", () => {
  it("should persist flags, rules, assignments, segments, releases, and history", async () => {
    const adapter = createDrizzleAdapter({
      db: new FakeDrizzleDb(),
      tables: makeTables(),
      helpers,
    });

    await adapter.createFlag({
      key: "checkout.drizzle-flow",
      type: "boolean",
      defaultValue: false,
      namespace: "checkout",
      rollout: { percentage: 10, sticky: true, hashKey: "userId" },
    });

    await adapter.setRollout("checkout.drizzle-flow", { percentage: 60 });
    expect((await adapter.getFlag("checkout.drizzle-flow"))?.rollout?.percentage).toBe(60);

    const rule = await adapter.addRule("checkout.drizzle-flow", {
      priority: 2,
      value: true,
      conditions: { any: [{ dimension: "userType", op: "eq", value: "beta" }] },
    });
    await adapter.addRule("checkout.drizzle-flow", {
      priority: 1,
      value: false,
      conditions: {},
    });

    expect((await adapter.listRules("checkout.drizzle-flow"))[0].priority).toBe(1);
    await adapter.updateRule("checkout.drizzle-flow", rule.id, { priority: 0 });
    expect((await adapter.listRules("checkout.drizzle-flow"))[0].id).toBe(rule.id);

    await adapter.setUserAssignment("checkout.drizzle-flow", "user-1", "variant-b");
    expect(await adapter.getUserAssignment("checkout.drizzle-flow", "user-1")).toBe(
      "variant-b"
    );

    await adapter.createSegment({
      key: "beta-users",
      rules: { any: [{ dimension: "segment", op: "in", value: ["beta-users"] }] },
    });
    await adapter.addRule("checkout.drizzle-flow", {
      priority: 3,
      value: true,
      conditions: { any: [{ dimension: "segment", op: "in", value: ["beta-users"] }] },
    });
    expect((await adapter.getSegmentUsage("beta-users")).length).toBe(1);

    const release = await adapter.createRelease({
      name: "Drizzle Launch",
      changes: [{ flagKey: "checkout.drizzle-flow", action: "kill" }],
    });
    await adapter.deployRelease(release.id, "alice");
    expect((await adapter.getFlag("checkout.drizzle-flow"))?.status).toBe("killed");
    await adapter.rollbackRelease(release.id, "bob", "rollback");
    expect((await adapter.getFlag("checkout.drizzle-flow"))?.status).toBe("active");

    await adapter.trackImpression({
      flagKey: "checkout.drizzle-flow",
      userId: "user-1",
      value: true,
      variant: null,
      reason: "rule_match",
    });

    expect((await adapter.getHistory("checkout.drizzle-flow")).length).toBeGreaterThan(0);
  });

  it("should validate required Drizzle table columns", () => {
    expect(() =>
      createDrizzleAdapter({
        db: new FakeDrizzleDb(),
        tables: makeTables({
          Flag: ROLLEASE_DRIZZLE_REQUIRED_COLUMNS.Flag.filter(
            (column) => column !== "defaultValue"
          ),
        }),
        helpers,
      })
    ).toThrow(ValidationError);
  });
});

function makeTables(
  overrides: Partial<Record<keyof typeof ROLLEASE_DRIZZLE_REQUIRED_COLUMNS, string[]>> = {}
): DrizzleTableMap {
  return Object.fromEntries(
    Object.entries(ROLLEASE_DRIZZLE_REQUIRED_COLUMNS).map(([name, columns]) => [
      name,
      Object.fromEntries(
        (overrides[name as keyof typeof overrides] ?? columns).map((column) => [
          column,
          { name: column },
        ])
      ),
    ])
  ) as DrizzleTableMap;
}
