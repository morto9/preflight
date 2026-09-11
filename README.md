# Preflight

**A simulation gate for agent writes.** Nothing reaches a real system without a
proven diff, a policy check, and a rollback receipt.

**[Live demo](https://preflight-dun.vercel.app)** ·
**[Repo](https://github.com/morto9/preflight)**

Built for the [Simulate Before You Act](https://build.doo.ooo/challenges/simulate-before-act)
challenge.

> The demo gives every visitor their own sandbox with its own real Stripe test
> charges, so several people can use it at once without colliding. Provisioning
> takes a few seconds on first load because those charges are genuinely created.

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
- Every row in the diff is a checkbox. Untick anything, re-simulate, and the
  plan hash changes -- which silently voids any approval already granted for
  the previous version.
- It surfaces effects nobody asked for — the ledger rows written by cascade.
- It reports real constraint violations, quoting the failing row, before commit.
- The gate is enforced **by Postgres**, not by convention. An ungated `UPDATE`
  raises `PREFLIGHT: ungated UPDATE on preflight.orders blocked`.
- Execution is streamed, so the canary running, the verifier checking and the
  breaker tripping happen in front of you rather than behind a spinner. The
  stages that never ran are visibly queued, not merely absent afterwards.
- "42 rows changed" expands into the actual rows, showing only the fields that
  differ. Every run is kept, with its verdict and plan hash.
- Light and dark are both first-class, following the system by default with an
  explicit override that persists. The light scale is re-chosen rather than
  inverted, and every pairing clears 4.5:1 in both themes.
- Works on a phone. The diff becomes cards below 640px rather than a table you
  scroll sideways, because the before/after pair is the whole point of a row
  and splitting it across a scroll defeats it. Nothing on the page exceeds the
  viewport at 375px.

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
npm test                          # 18 tests, against the real database
npx tsx scripts/failure-test.ts   # the divergence demo
npx tsx scripts/happy-path.ts     # blocked → tweak → execute → roll back
npx tsx scripts/purge.ts          # the second gated action
```

## Two gated actions, two ways to be wrong

The actions are deliberately unalike, because the interesting claim is that
simulation catches *different kinds* of surprise.

**`refund.bulk`** moves real money through Stripe. It is blocked by a policy
somebody wrote down — a daily refund ceiling — and the interesting failure is
temporal: the forecast goes stale between approval and execution.

**`customers.purge`** is blocked by the shape of the data itself. Nothing in
"delete customers who haven't ordered since 2024" tells you that it drags 6
dependent rows out with it, or that one of those customers has a retained
invoice. The dry run discovers both:

```
[block] The database refused this write
        violates foreign key constraint "invoices_customer_id_fkey"
        Key (id)=(ffc3b033…) is still referenced from table "invoices"
[block] Customers with retained invoices → remedy: Archive instead of deleting
[warn]  Deleting 2 customer(s) also removes 6 dependent record(s)
        that were never named in the request  {orders: 3, ledger_entries: 3}
```

One click on the remedy switches the strategy to a reversible archive, and the
plan goes green.

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
Gemini runs inside the product itself as the planner and the consequence model,
chosen for native structured output (`responseSchema`) against a Zod-mirrored
plan schema. It was *not* the right call on request volume: I picked it partly
on a widely-repeated free-tier figure that turned out to be about seventy times
the enforced one. Groq offers materially more free daily requests, and the
provider seam is deliberately narrow enough to swap.

### On the Gemini free tier

Worth knowing before you rely on it: the free tier meters **20 requests per day
per model, for the whole project** -- not per user, and not the four figures
some secondary sources claim. A preset-driven demo exhausts that in an
afternoon, after which the predicted panel silently thins out.

Three things address it. Predictions are cached against a hash of the aggregate
facts the prompt uses, so every visitor running the same preset shares one
answer instead of spending a request each. Quota is per model, so the client
walks a chain and moves on when one is spent. And when it genuinely runs out,
the panel says so rather than quietly serving a weaker answer.

Attaching billing is not automatically the escape hatch. Doing it here moved
the key onto AI Studio's **prepaid** plan, which gives up free-tier access and
then refuses every request -- `Your prepayment credits are depleted` -- until
credit is actually loaded. That is strictly worse than the free tier it
replaced, and it fails identically across every model, so the per-model chain
cannot route around it either.

Which is why the fallback now names the state it is in. `QuotaExhausted`
carries the 429 body and classifies it as depleted credit, a spent daily cap,
or a rate limit, because an operator does something different about each and
"quota exceeded" flattens all three into a shrug.

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
policy DSL; invariants are TypeScript. `notify.broadcast` is modelled in the
schema, plan types and policy engine but is not wired through the gateway; the
two actions that are wired were finished properly in preference to leaving three
half-connected. Real money is never moved: Stripe test mode only. The verifier
covers drift, row-count and target-set divergence; it does not model concurrent
DDL or replication lag.
