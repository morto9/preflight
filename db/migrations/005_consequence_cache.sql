-- Consequence predictions, cached by the facts they were derived from.
--
-- The free Gemini tier allows 20 requests per day per model for the whole
-- project, not per visitor. The demo is preset-driven, so fifty reviewers
-- clicking the same preset were asking the model the same question fifty
-- times and exhausting the day's quota in an afternoon.
--
-- The key is a hash of the aggregate facts the prompt actually uses -- row
-- counts, money, verdict, invariant outcomes -- not of the whole report, so
-- the same preset run in two different sandboxes shares one answer.
create table if not exists preflight.consequence_cache (
  key          text primary key,
  model        text,
  consequences jsonb not null,
  hits         integer not null default 0,
  created_at   timestamptz not null default now()
);
