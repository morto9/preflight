-- Preflight schema.
-- Everything lives in the `preflight` schema, which Supabase does NOT expose via
-- PostgREST (only `public` and `graphql_public` are). The app reaches it over a
-- direct Postgres connection, so there is no accidental REST surface.

create schema if not exists preflight;

-- ---------------------------------------------------------------------------
-- Sandbox tenancy: every visitor to the live demo gets an isolated dataset so
-- concurrent reviewers never collide.
-- ---------------------------------------------------------------------------
create table if not exists preflight.tenants (
  id            text primary key,
  label         text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

-- ===========================================================================
-- BUSINESS DOMAIN -- the "real system" being gated
-- ===========================================================================

create table if not exists preflight.customers (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       text not null references preflight.tenants(id) on delete cascade,
  email           text not null,
  name            text not null,
  tier            text not null default 'standard',
  unsubscribed_at timestamptz,
  archived_at     timestamptz,               -- soft archive: the "tweak" outcome of a purge
  last_order_at   timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists preflight.orders (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                text not null references preflight.tenants(id) on delete cascade,
  customer_id              uuid not null references preflight.customers(id) on delete cascade,
  reference                text not null,
  stripe_payment_intent_id text,
  stripe_charge_id         text,
  amount_cents             integer not null check (amount_cents >= 0),
  currency                 text not null default 'usd',
  -- The CACHED MIRROR of the refund state Stripe owns. Stripe is the source of
  -- truth; this column is what the simulation reads when it forecasts cheaply.
  -- The failure test exists precisely because this can go stale.
  amount_refunded_cents    integer not null default 0 check (amount_refunded_cents >= 0),
  status                   text not null default 'paid',
  defect_batch             text,
  created_at               timestamptz not null default now(),
  constraint refund_never_exceeds_capture
    check (amount_refunded_cents <= amount_cents)
);

create table if not exists preflight.refunds (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        text not null references preflight.tenants(id) on delete cascade,
  order_id         uuid not null references preflight.orders(id) on delete cascade,
  stripe_refund_id text,
  amount_cents     integer not null check (amount_cents > 0),
  status           text not null default 'succeeded',
  reason           text,
  run_id           uuid,
  created_at       timestamptz not null default now()
);

create table if not exists preflight.ledger_entries (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    text not null references preflight.tenants(id) on delete cascade,
  order_id     uuid references preflight.orders(id) on delete cascade,
  kind         text not null,                 -- charge | refund | fee | adjustment
  amount_cents integer not null,              -- signed
  memo         text,
  run_id       uuid,
  created_at   timestamptz not null default now()
);

create table if not exists preflight.notifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   text not null references preflight.tenants(id) on delete cascade,
  customer_id uuid not null references preflight.customers(id) on delete cascade,
  channel     text not null default 'email',
  subject     text,
  body        text,
  status      text not null default 'queued',
  run_id      uuid,
  created_at  timestamptz not null default now()
);

-- Exists so that `customers.purge` has a real dependent-record blast radius.
-- ON DELETE RESTRICT means purging an invoiced customer raises a REAL
-- constraint violation that the dry-run surfaces before anyone commits.
create table if not exists preflight.invoices (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    text not null references preflight.tenants(id) on delete cascade,
  customer_id  uuid not null references preflight.customers(id) on delete restrict,
  number       text not null,
  amount_cents integer not null,
  issued_at    timestamptz not null default now()
);

-- ===========================================================================
-- OBSERVATION -- how the dry-run sees effects it did not explicitly write
-- ===========================================================================
-- Every row change on a business table lands here, INCLUDING rows changed by
-- ON DELETE CASCADE. That is how the simulation observes second-order effects
-- rather than guessing at them.
create table if not exists preflight.audit_log (
  id          bigserial primary key,
  tenant_id   text,
  table_name  text not null,
  op          text not null,
  row_pk      text,
  before_row  jsonb,
  after_row   jsonb,
  gate        text,
  txid        bigint not null default txid_current(),
  created_at  timestamptz not null default now()
);

-- ===========================================================================
-- CONTROL PLANE -- the gate itself
-- ===========================================================================

create table if not exists preflight.runs (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  text not null references preflight.tenants(id) on delete cascade,
  intent     text,
  plan       jsonb not null,
  plan_hash  text not null,
  simulation jsonb,
  status     text not null default 'simulated',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists preflight.approvals (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references preflight.runs(id) on delete cascade,
  -- Binds the approval to the EXACT plan that was simulated. Tweak the plan and
  -- the hash changes, which silently kills this approval.
  plan_hash   text not null,
  token_hash  text not null,
  approved_by text not null default 'demo-operator',
  approved_at timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  note        text
);

create table if not exists preflight.receipts (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references preflight.runs(id) on delete cascade,
  stage             integer not null,
  -- Captured during simulation, so rollback is data rather than inference.
  pre_images        jsonb not null,
  compensating      jsonb not null,
  external_effects  jsonb not null default '[]'::jsonb,
  applied           boolean not null default false,
  applied_at        timestamptz,
  created_at        timestamptz not null default now()
);

create table if not exists preflight.divergences (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid not null references preflight.runs(id) on delete cascade,
  stage      integer not null,
  kind       text not null,
  predicted  jsonb not null,
  actual     jsonb not null,
  detail     text,
  severity   text not null default 'critical',
  halted     boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists customers_tenant_idx     on preflight.customers(tenant_id);
create index if not exists orders_tenant_idx        on preflight.orders(tenant_id);
create index if not exists orders_customer_idx      on preflight.orders(customer_id);
create index if not exists orders_defect_batch_idx  on preflight.orders(tenant_id, defect_batch);
create index if not exists refunds_order_idx        on preflight.refunds(order_id);
create index if not exists ledger_order_idx         on preflight.ledger_entries(order_id);
create index if not exists notifications_tenant_idx on preflight.notifications(tenant_id);
create index if not exists invoices_customer_idx    on preflight.invoices(customer_id);
create index if not exists audit_txid_idx           on preflight.audit_log(txid);
create index if not exists runs_tenant_idx          on preflight.runs(tenant_id, created_at desc);
create index if not exists approvals_run_idx        on preflight.approvals(run_id);
create index if not exists receipts_run_idx         on preflight.receipts(run_id);
create index if not exists divergences_run_idx      on preflight.divergences(run_id);
