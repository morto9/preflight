-- The gate, enforced by Postgres itself.
--
-- The central claim of this project is that a write cannot reach the business
-- tables without going through simulation and approval. Enforcing that in
-- application code alone would be a convention -- someone adds a route that
-- forgets to call the gateway and the guarantee evaporates. So it is enforced
-- one layer lower, by triggers on the tables themselves.

-- ---------------------------------------------------------------------------
-- Gate state. `set_config(..., true)` is TRANSACTION-LOCAL, so the gate resets
-- on commit or rollback and can never leak across a pooled connection.
-- ---------------------------------------------------------------------------
create or replace function preflight.current_gate() returns text
language sql stable as $fn$
  select nullif(current_setting('preflight.gate', true), '')
$fn$;

create or replace function preflight.open_gate(p_gate text) returns void
language plpgsql as $fn$
begin
  if p_gate is null or p_gate = '' then
    raise exception 'PREFLIGHT: a gate value is required';
  end if;
  perform set_config('preflight.gate', p_gate, true);
end $fn$;

-- ---------------------------------------------------------------------------
-- Opening the gate for REAL execution requires burning a single-use approval.
--
-- The UPDATE ... WHERE consumed_at IS NULL ... RETURNING is atomic, so the
-- single-use guarantee holds under concurrency. It is not a read-then-write
-- race in application code.
-- ---------------------------------------------------------------------------
create or replace function preflight.open_gate_with_approval(
  p_run_id    uuid,
  p_token_hash text,
  p_plan_hash  text
) returns uuid
language plpgsql as $fn$
declare
  v_id uuid;
begin
  update preflight.approvals
     set consumed_at = now()
   where run_id      = p_run_id
     and token_hash  = p_token_hash
     and plan_hash   = p_plan_hash      -- approval is bound to the exact simulated plan
     and consumed_at is null            -- single use
     and expires_at  > now()            -- and not stale
  returning id into v_id;

  if v_id is null then
    raise exception
      'PREFLIGHT: no valid unconsumed approval for run % bound to plan %',
      p_run_id, left(p_plan_hash, 12)
      using errcode = 'P0001',
            hint = 'Approval missing, expired, already used, or the plan changed after it was approved.';
  end if;

  perform set_config('preflight.gate', v_id::text, true);
  return v_id;
end $fn$;

-- ---------------------------------------------------------------------------
-- The guard. Fires once per statement, before anything is touched.
-- ---------------------------------------------------------------------------
create or replace function preflight.assert_gated() returns trigger
language plpgsql as $fn$
begin
  if preflight.current_gate() is null then
    raise exception
      'PREFLIGHT: ungated % on preflight.% blocked', TG_OP, TG_TABLE_NAME
      using errcode = 'P0001',
            hint = 'Writes must pass through Gateway.simulate() or Gateway.execute().';
  end if;
  return null;
end $fn$;

-- ---------------------------------------------------------------------------
-- The observer. Fires per row, AFTER the change -- so it also records rows
-- touched by ON DELETE CASCADE, which is how the dry-run discovers
-- second-order effects instead of guessing at them.
-- ---------------------------------------------------------------------------
create or replace function preflight.record_audit() returns trigger
language plpgsql as $fn$
declare
  v_tenant text;
  v_before jsonb;
  v_after  jsonb;
  v_pk     text;
begin
  if TG_OP = 'DELETE' then
    v_before := to_jsonb(OLD); v_after := null;
    v_tenant := OLD.tenant_id; v_pk := OLD.id::text;
  elsif TG_OP = 'UPDATE' then
    v_before := to_jsonb(OLD); v_after := to_jsonb(NEW);
    v_tenant := NEW.tenant_id; v_pk := NEW.id::text;
  else
    v_before := null; v_after := to_jsonb(NEW);
    v_tenant := NEW.tenant_id; v_pk := NEW.id::text;
  end if;

  insert into preflight.audit_log
    (tenant_id, table_name, op, row_pk, before_row, after_row, gate)
  values
    (v_tenant, TG_TABLE_NAME, TG_OP, v_pk, v_before, v_after, preflight.current_gate());

  return null;
end $fn$;

-- ---------------------------------------------------------------------------
-- Everything the current transaction has changed. The dry-run calls this just
-- before rolling back, which is how a simulation reports real effects.
-- ---------------------------------------------------------------------------
create or replace function preflight.tx_audit() returns setof preflight.audit_log
language sql stable as $fn$
  select * from preflight.audit_log where txid = txid_current() order by id
$fn$;

-- ---------------------------------------------------------------------------
-- Attach both triggers to every business table.
-- `tenants` is deliberately excluded: provisioning a sandbox is a control-plane
-- operation, not a business write.
-- ---------------------------------------------------------------------------
do $do$
declare
  t text;
begin
  foreach t in array array[
    'customers', 'orders', 'refunds', 'ledger_entries', 'notifications', 'invoices'
  ]
  loop
    execute format('drop trigger if exists gate_guard on preflight.%I', t);
    execute format(
      'create trigger gate_guard before insert or update or delete on preflight.%I
         for each statement execute function preflight.assert_gated()', t);

    execute format('drop trigger if exists audit_rows on preflight.%I', t);
    execute format(
      'create trigger audit_rows after insert or update or delete on preflight.%I
         for each row execute function preflight.record_audit()', t);
  end loop;
end $do$;
