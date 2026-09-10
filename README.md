# Preflight

**A simulation gate for agent writes.** Nothing reaches a real system without a
proven diff, a policy check, and a rollback receipt.

Built for the [Simulate Before You Act](https://build.doo.ooo/challenges/simulate-before-act)
challenge.

---

## The idea in one paragraph

A confirmation dialog shows you an *intent*. "Refund the March batch — are you
sure?" tells you nothing about whether that is twelve orders or twelve hundred,
whether it breaches a ceiling, or what it cascades into. Preflight instead
**performs the write for real**, against the real database, inside a transaction
that is guaranteed to roll back — then shows you the row-level diff, the rows
nobody asked for, the policy verdict, and the exact steps that would undo it.
Every claim on screen is labelled **PROVEN** or **PREDICTED**, because those are
different kinds of knowledge and conflating them is how safety theatre happens.

## What is actually real here

| Piece | Real? |
|---|---|
| The database | Real Postgres (Supabase), real transactions, real triggers, real constraint violations |
| The money | Real Stripe **test mode** charges and refunds, with idempotency keys |
| The diff | Produced by executing the write and rolling it back — not by describing it |
| The rollback | Compensating steps derived from audit pre-images captured during the write |
| The consequence model | Gemini. Advisory only, clearly labelled, never blocks |

The only thing deliberately not real is that Stripe runs in test mode, because
this application moves money and there is a hard refusal on any key that does not
begin `sk_test_`.

## Why this is not a dressed-up confirm dialog

The challenge disqualifies "an *are you sure?* dialog dressed up as simulation."
Concretely:

- The numbers come from Postgres actually doing the work. `applyDbEffects()` is
  called by the simulation and by the executor **with no branch on mode**.
- The simulation **blocks** plans and offers a one-click fix. It changes the
  decision rather than narrating it.
- It surfaces effects nobody asked for — the ledger rows written by cascade.
- It reports real constraint violations, quoting the failing row, before commit.
- The gate is enforced **by Postgres**, not by convention. An ungated `UPDATE`
  raises `PREFLIGHT: ungated UPDATE on preflight.orders blocked`.

## Quickstart

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL at minimum
npm run db:migrate
npm run db:seed
npm run dev
```

`DATABASE_URL` **must** be a Supabase Supavisor pooler URL (port 6543). Vercel has
no IPv6 and Supabase free-tier direct connections are IPv6-only, so the direct
connection string will fail in production.

Stripe and Gemini keys are optional. Without Stripe, refunds run in ledger-only
mode and the UI says so rather than pretending. Without Gemini, the preset intents
still work and consequences fall back to a rule-based summary.

```bash
npm test                       # 13 tests, against the real database
npx tsx scripts/failure-test.ts   # the divergence demo
npx tsx scripts/happy-path.ts     # blocked → tweak → execute → roll back
```

## How it works

`intent → simulate → present → execute / rollback`. Full diagram and the table of
database-enforced guarantees: **[docs/architecture.md](docs/architecture.md)**.

The short version: a natural-language intent is compiled to an `ActionPlan` and
hashed. Simulation opens a transaction, runs the real statements, reads Stripe for
ground truth, asserts invariants against the post-state, then rolls back. Approval
mints a single-use token bound to that plan hash. Execution runs in stages behind a
canary, verifying reality against the forecast **before and after** each stage, and
a divergence trips a breaker that Postgres itself then enforces.

## The failure test

**[docs/failure-test.md](docs/failure-test.md)** — after approval, a support agent
refunds $15 of one order straight from the Stripe dashboard. The forecast is now
stale and nothing could have simulated that, because it had not happened yet. The
canary catches it, **$0.00 moves**, and thirteen orders are never reached.

## Two-year thesis

**[docs/thesis.md](docs/thesis.md)** (294 words).

## Demo walkthrough script

**[docs/demo-script.md](docs/demo-script.md)**.

---

## Notes

### AI tools used

Built with Claude (Claude Code) doing the implementation end to end — schema
design, the gateway, the UI, and the docs — driven by an approved written plan.
Gemini 2.5 Flash runs inside the product itself as the planner and the consequence
model. Model choice was researched against live free-tier limits rather than
assumed; Gemini won on free-tier request volume and structured-output support.

### Key decisions

- **The gate is a database trigger, not a code convention.** Enforcing it in
  application code means one forgotten route silently removes the guarantee. A
  statement-level trigger on every business table makes that a raised exception
  instead of a shipped bug.
- **Rollback is derived, not authored.** Compensation comes mechanically from
  audit-log pre-images (`INSERT → delete`, `UPDATE → restore`, `DELETE →
  reinsert`), so it is general across actions and provably matches what changed —
  including rows touched only by cascade.
- **Verify before acting, not only after.** Catching drift at the canary means
  nothing irreversible has happened. Post-execution verification is kept for
  effects only visible afterwards.
- **The LLM never blocks.** Blocking belongs to invariants that have evidence. A
  model's opinion is displayed, scored for confidence, and ignored by the gate.
- **Set-based writes.** Row-by-row statements made a simulation take 27s over a
  long-haul connection; batching to three statements cut it to ~6s and sandbox
  provisioning from 39s to 9s.

### Out of scope

No authentication or RBAC — a single demo operator persona. No general-purpose
policy DSL; invariants are TypeScript. `customers.purge` and `notify.broadcast`
are modelled in the schema, the plan types, and the policy engine, but only
`refund.bulk` is wired end to end through the gateway — the hero action was
finished properly in preference to leaving three actions half-connected. Real
money is never moved: Stripe test mode only. The verifier covers drift, row-count
and target-set divergence; it does not model concurrent DDL or replication lag.
