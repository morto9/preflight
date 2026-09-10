-- A per-sandbox daily cap on model calls.
--
-- The live demo is a public link, so free-text intents must not be able to
-- exhaust the API quota. Preset intents never reach the model at all; this
-- only bounds the typed ones.

create table if not exists preflight.ai_usage (
  tenant_id text not null,
  day       date not null default current_date,
  calls     integer not null default 0,
  primary key (tenant_id, day)
);

/**
 * Increments and returns whether the call is allowed. Atomic, so concurrent
 * requests cannot both slip past the cap.
 */
create or replace function preflight.claim_ai_call(p_tenant text, p_cap integer)
returns boolean
language plpgsql as $fn$
declare
  v_calls integer;
begin
  insert into preflight.ai_usage (tenant_id, day, calls)
  values (p_tenant, current_date, 1)
  on conflict (tenant_id, day)
    do update set calls = preflight.ai_usage.calls + 1
  returning calls into v_calls;

  return v_calls <= p_cap;
end $fn$;
