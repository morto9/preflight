import type postgres from "postgres";
import type { Tx } from "@/lib/adapters/postgres";
import type { ActionCtx, Impact } from "@/lib/actions/types";
import type { CustomerPurgeParams } from "@/lib/plan/schema";
import { z } from "zod";

type Params = z.infer<typeof CustomerPurgeParams>;

/**
 * Deleting dormant customers.
 *
 * This action exists because it fails in a different way from a refund. A
 * refund is blocked by a policy someone wrote down. A purge is blocked by the
 * shape of the data itself: it drags dependent rows out with it, and some of
 * those rows are legally retained. Neither fact is visible in the request, and
 * both are discovered by actually attempting the delete.
 */

export type PurgeTarget = {
  customerId: string;
  name: string;
  email: string;
  tier: string;
  lastOrderAt: string | null;
  /** Rows that would follow this customer out of the database. */
  orderCount: number;
  ledgerCount: number;
  notificationCount: number;
  /** Invoices are ON DELETE RESTRICT, so these block a hard delete outright. */
  invoiceCount: number;
  excluded: boolean;
};

export async function resolveTargets(
  sql: postgres.Sql,
  ctx: ActionCtx,
  params: Params
): Promise<PurgeTarget[]> {
  const s = params.selector;

  const rows = await sql`
    select
      c.id, c.name, c.email, c.tier, c.last_order_at,
      (select count(*) from preflight.orders o        where o.customer_id = c.id)        as order_count,
      (select count(*) from preflight.invoices i      where i.customer_id = c.id)        as invoice_count,
      (select count(*) from preflight.notifications n where n.customer_id = c.id)        as notification_count,
      (select count(*)
         from preflight.ledger_entries l
         join preflight.orders o2 on o2.id = l.order_id
        where o2.customer_id = c.id)                                                     as ledger_count
    from preflight.customers c
    where c.tenant_id = ${ctx.tenantId}
      and c.archived_at is null
      and (c.last_order_at is null or c.last_order_at < ${s.inactiveSince}::timestamptz)
      ${s.tier ? sql`and c.tier = ${s.tier}` : sql``}
    order by c.name`;

  const excluded = new Set(params.excludeCustomerIds);

  return rows.map((r) => {
    const customerId = String(r.id);
    return {
      customerId,
      name: String(r.name),
      email: String(r.email),
      tier: String(r.tier),
      lastOrderAt: r.last_order_at ? new Date(r.last_order_at as string).toISOString() : null,
      orderCount: Number(r.order_count),
      ledgerCount: Number(r.ledger_count),
      notificationCount: Number(r.notification_count),
      invoiceCount: Number(r.invoice_count),
      excluded: excluded.has(customerId),
    };
  });
}

/**
 * The database half of the write, identical in simulation and execution.
 *
 * A hard delete is issued as a real DELETE. If a targeted customer has retained
 * invoices, Postgres raises a foreign-key violation and the dry run reports it
 * with the offending constraint named, before anyone commits anything.
 */
export async function applyDbEffects(
  tx: Tx,
  _ctx: ActionCtx,
  targets: PurgeTarget[],
  params: Params
): Promise<{ customers: number }> {
  const acting = targets.filter((t) => !t.excluded);
  if (acting.length === 0) return { customers: 0 };

  const ids = acting.map((t) => t.customerId);

  if (params.strategy === "hard_delete") {
    await tx`delete from preflight.customers where id = any(${ids}::uuid[])`;
  } else {
    await tx`
      update preflight.customers
         set archived_at = now()
       where id = any(${ids}::uuid[])`;
  }

  return { customers: acting.length };
}

export function buildImpacts(targets: PurgeTarget[], params: Params): Impact[] {
  const hard = params.strategy === "hard_delete";

  return targets.map((t) => {
    const dependents = t.orderCount + t.ledgerCount + t.notificationCount;

    return {
      id: t.customerId,
      label: t.name,
      who: `${t.email} · ${t.tier}`,
      from: "active",
      to: t.excluded ? "active" : hard ? "deleted" : "archived",
      delta: t.excluded
        ? "—"
        : hard
          ? `${dependents} dependent row(s) go too`
          : "reversible",
      before: {
        status: "active",
        orders: t.orderCount,
        invoices: t.invoiceCount,
        lastOrder: t.lastOrderAt?.slice(0, 10) ?? "never",
      },
      after: {
        status: t.excluded ? "active" : hard ? "deleted" : "archived",
        orders: t.excluded ? t.orderCount : hard ? 0 : t.orderCount,
        invoices: t.invoiceCount,
        lastOrder: t.lastOrderAt?.slice(0, 10) ?? "never",
      },
      skipped: t.excluded ? "deselected by operator" : undefined,
    };
  });
}

/** Customers whose retained invoices make a hard delete impossible. */
export function blockedByInvoice(targets: PurgeTarget[]) {
  return targets
    .filter((t) => !t.excluded && t.invoiceCount > 0)
    .map((t) => ({ customerId: t.customerId, name: t.name, invoices: t.invoiceCount }));
}

/** What a hard delete would take with it, by table. */
export function cascadeCounts(targets: PurgeTarget[]): Record<string, number> {
  const acting = targets.filter((t) => !t.excluded);
  const sum = (f: (t: PurgeTarget) => number) => acting.reduce((n, t) => n + f(t), 0);

  const counts: Record<string, number> = {
    orders: sum((t) => t.orderCount),
    ledger_entries: sum((t) => t.ledgerCount),
    notifications: sum((t) => t.notificationCount),
  };

  for (const k of Object.keys(counts)) if (counts[k] === 0) delete counts[k];
  return counts;
}
