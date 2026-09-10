# The failure test

> *A simulation under-predicts a side effect. Show the safety net.*

## Why this particular failure

The tempting demo is "our cached copy of Stripe was stale." That one is fake,
because the simulation reads Stripe directly (Layer B) and would catch it. Any
failure the simulation can catch is not a failure of simulation.

The honest failure lives in the **window between approval and execution**. A plan
is simulated at 10:02 and approved at 10:03. At 10:04, a support agent refunds
$15 of one of those orders from the Stripe dashboard — the single most ordinary
thing a support agent does all day. The forecast is now wrong, and **no amount of
simulating beforehand could have prevented it**, because the event had not
happened yet.

That is the point worth making. Simulation is a measurement taken at a moment,
and moments pass.

## Reproducing it

In the live demo, after approving a plan, press
**"Failure test: change Stripe behind our back"**, then **Execute for real**.

From a clone:

```bash
npm run db:migrate && npm run db:seed
npx tsx scripts/failure-test.ts
```

## What actually happens

```
=== 1. SIMULATE ===
verdict=ready  orders=14  total=$2,365.00
stripe drift detected at simulate time: 0        ← the forecast was correct

=== 2. APPROVE ===
approval d6af058d … expires 19:20:51Z

=== 3. INJECT DRIFT (out-of-band Stripe refund) ===
Someone refunded $15.00 of NW-1041 directly in Stripe (re_3UEDRG…).
Our database still believes nothing has changed.

=== 4. EXECUTE ===
status=halted
halt reason: Stripe no longer matches the state this plan was approved against.
             Nothing was refunded in this stage.
refunded: 0 order(s), $0.00
orders never touched: 13

stages:
  1 canary halted      NW-1041
  2 batch  not_reached NW-1042, NW-1043, NW-1044, NW-1045, NW-1046
  3 batch  not_reached NW-1047, NW-1048, NW-1049, NW-1050, NW-1051
  4 batch  not_reached NW-1052, NW-1053, NW-1054

divergences:
  [critical] stripe_drift
    NW-1041: this plan was approved on the basis that $0.00 had been refunded,
    and forecast a $185.00 refund. Stripe now reports $15.00 refunded, leaving
    $170.00 refundable. The charge changed after approval, so the forecast is
    stale.

run status in database: halted
refund rows actually written: 0 ($0.00)

=== 5. IS THE BREAKER REAL? ===
  Postgres refuses another stage: PREFLIGHT: run … is halted, further stages refused
```

**$0.00 moved. Thirteen orders never reached.**

## Why it is caught before the money moves, not after

Each stage verifies twice. The check that catches this one runs *before* the
stage acts, so the canary never issues its refund. Post-execution verification
still exists — it covers effects that only become visible after the fact, such as
row counts exceeding what the forecast accounted for — but catching drift early
is strictly better than catching it late, and the design should prefer it.

## Three classes of divergence, all implemented

| Class | Detected by | Severity |
|---|---|---|
| `stripe_drift` — source of truth moved after approval | pre-stage verifier | critical, halts |
| `row_count` — execution wrote rows the forecast never accounted for | post-stage verifier | critical if more than forecast |
| target-set change — the plan's rows changed between simulate and execute | pre-execution set comparison | critical, halts before stage 1 |

## Bugs this design caught during development

Worth recording, because they are evidence the net is load-bearing rather than
decorative:

1. **The verifier was comparing Stripe against itself.** Execution re-reads Stripe
   before it starts, so the "already refunded" figure silently became the *new*
   truth and drift could never be detected. Fixed by comparing against the stored
   forecast, which is why `SimulationReport.forecast` exists.

2. **`row_count` divergence fired on every run.** The expected counts were passed
   as an empty array, so every legitimate execution reported "the simulation
   changed 0 rows" and halted. A circuit breaker that always trips is worse than
   none, because people learn to ignore it.

3. **The simulation caught a bug in the seed script.** Sandbox provisioning
   created Stripe charges at full value but wrote the pre-existing partial refunds
   only to the local mirror, so every sandbox began life already drifted. The
   `refund_never_exceeds_capture` constraint rejected it during a dry run, before
   any money moved.
