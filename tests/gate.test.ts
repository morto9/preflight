import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { dryRun, withGate } from "@/lib/adapters/postgres";
import { resetTenant } from "@/lib/sandbox";
import { simulate, execute, rollback } from "@/lib/gateway";
import { createApproval } from "@/lib/gateway/approval";
import { ActionPlan, planHash } from "@/lib/plan/schema";
import { DEFECT_BATCH } from "@/lib/constants";
import { buildCompensation } from "@/lib/gateway/compensate";

const TENANT = "test_gate";
const sql = db();

const plan = (over: Record<string, unknown> = {}) =>
  ActionPlan.parse({
    tool: "refund.bulk",
    params: {
      selector: { defectBatch: DEFECT_BATCH },
      mode: "full",
      reason: "requested_by_customer",
      excludeOrderIds: [],
      dailyCapCents: 1_000_000,
      ...over,
    },
  });

beforeAll(async () => {
  await resetTenant(TENANT, "vitest");
}, 120_000);

afterAll(async () => {
  await withGate("test-teardown", async (tx) => {
    await tx`delete from preflight.tenants where id = ${TENANT}`;
  });
  await sql.end();
});

/* ------------------------------------------------------------------------ */

describe("the gate", () => {
  it("Postgres refuses an ungated write, not application code", async () => {
    await expect(
      sql`update preflight.orders set amount_refunded_cents = 1 where tenant_id = ${TENANT}`
    ).rejects.toThrow(/ungated UPDATE on preflight.orders blocked/);
  });

  it("refuses an ungated delete too", async () => {
    await expect(
      sql`delete from preflight.customers where tenant_id = ${TENANT}`
    ).rejects.toThrow(/PREFLIGHT: ungated DELETE/);
  });

  it("allows the write once the gate is open", async () => {
    const before = await refundedTotal();
    await withGate("test", async (tx) => {
      await tx`
        update preflight.orders set amount_refunded_cents = amount_refunded_cents
         where tenant_id = ${TENANT}`;
    });
    expect(await refundedTotal()).toBe(before);
  });
});

describe("the dry run", () => {
  it("leaves no trace whatsoever", async () => {
    const before = await fingerprint();

    const result = await dryRun(async (tx) => {
      await tx`
        update preflight.orders
           set amount_refunded_cents = amount_cents, status = 'refunded'
         where tenant_id = ${TENANT}`;
      return true;
    });

    expect(result.ok).toBe(true);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(await fingerprint()).toEqual(before);
  });

  it("reports a real constraint violation instead of throwing", async () => {
    const result = await dryRun(async (tx) => {
      // Refunding more than was captured violates a CHECK constraint.
      await tx`
        update preflight.orders
           set amount_refunded_cents = amount_cents + 1
         where tenant_id = ${TENANT}`;
      return true;
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe("23514");
    expect(result.failure?.constraint).toBe("refund_never_exceeds_capture");
  });

  it("observes rows changed by cascade that the statement never named", async () => {
    const result = await dryRun(async (tx) => {
      await tx`delete from preflight.customers
                where tenant_id = ${TENANT} and email = 'hugo@northwind.test'`;
      return true;
    });

    const tables = new Set(result.changes.map((c) => c.table_name));
    expect(tables.has("customers")).toBe(true);
    // Hugo's orders and their ledger entries go with him, unnamed by the delete.
    expect(tables.has("orders")).toBe(true);
    expect(tables.has("ledger_entries")).toBe(true);
  });
});

describe("approval binding", () => {
  it("a plan hash changes when any parameter changes", () => {
    const a = planHash(plan());
    const b = planHash(plan({ dailyCapCents: 999_999 }));
    expect(a).not.toBe(b);
  });

  it("is stable regardless of key order", () => {
    const a = ActionPlan.parse({
      tool: "refund.bulk",
      params: {
        mode: "full",
        selector: { defectBatch: DEFECT_BATCH },
        reason: "requested_by_customer",
        excludeOrderIds: [],
        dailyCapCents: 500_00,
      },
    });
    const b = ActionPlan.parse({
      tool: "refund.bulk",
      params: {
        dailyCapCents: 500_00,
        excludeOrderIds: [],
        reason: "requested_by_customer",
        selector: { defectBatch: DEFECT_BATCH },
        mode: "full",
      },
    });
    expect(planHash(a)).toBe(planHash(b));
  });

  it("refuses execution when the approval is bound to a different plan", async () => {
    const sim = await simulate({ tenantId: TENANT, plan: plan() });
    const grant = await createApproval({
      runId: sim.runId,
      planHash: planHash(plan({ dailyCapCents: 12_345 })), // a different plan
    });

    await expect(execute({ runId: sim.runId, token: grant.token })).rejects.toThrow(
      /no valid unconsumed approval/
    );
  });

  it("burns the approval so it cannot be used twice", async () => {
    const sim = await simulate({ tenantId: TENANT, plan: plan() });
    const grant = await createApproval({ runId: sim.runId, planHash: sim.planHash });

    const first = await execute({ runId: sim.runId, token: grant.token });
    expect(first.status).toBe("completed");

    // The run is terminal now, and the token is spent.
    await expect(execute({ runId: sim.runId, token: grant.token })).rejects.toThrow();

    await rollback(sim.runId);
  });

  it("refuses an expired approval", async () => {
    const sim = await simulate({ tenantId: TENANT, plan: plan() });
    const grant = await createApproval({
      runId: sim.runId,
      planHash: sim.planHash,
      ttlSeconds: -1,
    });

    await expect(execute({ runId: sim.runId, token: grant.token })).rejects.toThrow(
      /no valid unconsumed approval/
    );
  });
});

describe("rollback", () => {
  it("restores the exact prior state", async () => {
    const before = await fingerprint();

    const sim = await simulate({ tenantId: TENANT, plan: plan() });
    const grant = await createApproval({ runId: sim.runId, planHash: sim.planHash });

    const run = await execute({ runId: sim.runId, token: grant.token });
    expect(run.status).toBe("completed");
    expect(await fingerprint()).not.toEqual(before);

    const back = await rollback(sim.runId);
    expect(back.rowsRestored).toBeGreaterThan(0);
    expect(await fingerprint()).toEqual(before);
  });

  it("derives compensation from pre-images, in reverse order", () => {
    const steps = buildCompensation([
      { id: "1", tenant_id: TENANT, table_name: "orders", op: "UPDATE", row_pk: "o1",
        before_row: { id: "o1", amount_refunded_cents: 0 }, after_row: { id: "o1", amount_refunded_cents: 500 }, gate: "x" },
      { id: "2", tenant_id: TENANT, table_name: "refunds", op: "INSERT", row_pk: "r1",
        before_row: null, after_row: { id: "r1" }, gate: "x" },
    ]);

    // Newest change is undone first.
    expect(steps[0]).toEqual({ op: "delete", table: "refunds", pk: "r1" });
    expect(steps[1]).toMatchObject({ op: "restore", table: "orders", pk: "o1" });
  });
});

/* ------------------------------------------------------------------------ */

/** A cheap whole-tenant state fingerprint. */
async function fingerprint() {
  const [row] = await sql`
    select
      (select coalesce(sum(amount_refunded_cents), 0) from preflight.orders where tenant_id = ${TENANT}) as refunded,
      (select count(*) from preflight.orders where tenant_id = ${TENANT}) as orders,
      (select count(*) from preflight.refunds where tenant_id = ${TENANT}) as refunds,
      (select count(*) from preflight.ledger_entries where tenant_id = ${TENANT}) as ledger,
      (select count(*) from preflight.customers where tenant_id = ${TENANT}) as customers`;
  return {
    refunded: Number(row.refunded),
    orders: Number(row.orders),
    refunds: Number(row.refunds),
    ledger: Number(row.ledger),
    customers: Number(row.customers),
  };
}

async function refundedTotal() {
  const [row] = await sql`
    select coalesce(sum(amount_refunded_cents), 0) as t
      from preflight.orders where tenant_id = ${TENANT}`;
  return Number(row.t);
}
