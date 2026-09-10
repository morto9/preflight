-- Staged execution, rollback, and a circuit breaker with database-level teeth.
--
-- Execution is deliberately not one transaction. A canary stage commits first
-- so that reality can be re-read and compared against the forecast before the
-- rest of the batch proceeds. That means later stages need a way to reopen the
-- gate WITHOUT a fresh single-use token -- but only while the run is still
-- allowed to continue.

-- ---------------------------------------------------------------------------
-- First stage: burn the single-use approval and move the run into `executing`.
-- ---------------------------------------------------------------------------
create or replace function preflight.open_gate_with_approval(
  p_run_id     uuid,
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
     and plan_hash   = p_plan_hash      -- bound to the exact simulated plan
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

  update preflight.runs
     set status = 'executing', updated_at = now()
   where id = p_run_id;

  perform set_config('preflight.gate', v_id::text, true);
  return v_id;
end $fn$;

-- ---------------------------------------------------------------------------
-- Subsequent stages. The status check is the circuit breaker's teeth: once the
-- verifier halts a run, Postgres itself refuses every remaining stage. Halting
-- is not merely a `break` in application control flow.
-- ---------------------------------------------------------------------------
create or replace function preflight.open_gate_for_stage(
  p_run_id      uuid,
  p_approval_id uuid
) returns void
language plpgsql as $fn$
declare
  v_status text;
begin
  select r.status into v_status
    from preflight.runs r
    join preflight.approvals a on a.run_id = r.id
   where r.id = p_run_id
     and a.id = p_approval_id
     and a.consumed_at is not null;

  if v_status is null then
    raise exception
      'PREFLIGHT: no consumed approval % for run %', p_approval_id, p_run_id
      using errcode = 'P0001';
  end if;

  if v_status <> 'executing' then
    raise exception
      'PREFLIGHT: run % is %, further stages refused', p_run_id, v_status
      using errcode = 'P0001',
            hint = 'The circuit breaker halts a run by moving it out of the executing state.';
  end if;

  perform set_config('preflight.gate', p_approval_id::text, true);
end $fn$;

-- ---------------------------------------------------------------------------
-- Rollback needs to write to business tables too, so it needs its own gate --
-- scoped to one unapplied receipt, so a receipt can never be replayed twice.
-- ---------------------------------------------------------------------------
create or replace function preflight.open_gate_for_rollback(
  p_run_id     uuid,
  p_receipt_id uuid
) returns void
language plpgsql as $fn$
declare
  v_applied boolean;
begin
  select applied into v_applied
    from preflight.receipts
   where id = p_receipt_id and run_id = p_run_id;

  if v_applied is null then
    raise exception 'PREFLIGHT: receipt % not found for run %', p_receipt_id, p_run_id
      using errcode = 'P0001';
  end if;

  if v_applied then
    raise exception 'PREFLIGHT: receipt % has already been rolled back', p_receipt_id
      using errcode = 'P0001',
            hint = 'Compensating writes are single-use, exactly like approvals.';
  end if;

  perform set_config('preflight.gate', 'rollback:' || p_receipt_id::text, true);
end $fn$;

-- ---------------------------------------------------------------------------
-- The breaker. Control-plane only, so it needs no gate.
-- ---------------------------------------------------------------------------
create or replace function preflight.halt_run(p_run_id uuid, p_reason text)
returns void
language plpgsql as $fn$
begin
  update preflight.runs
     set status = 'halted', updated_at = now()
   where id = p_run_id;
end $fn$;
