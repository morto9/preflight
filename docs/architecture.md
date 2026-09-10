# Architecture

## intent → simulate → present → execute / rollback

```
[1] INTENT
    "refund everyone hit by the March defect batch"
        │
        ▼  Gemini planner, output validated by Zod before it goes anywhere
    ActionPlan { tool, params, selector }
    planHash = sha256(canonical(plan))          ← the identity of this decision


[2] SIMULATE                          Gateway.simulate()
    │
    ├─ Resolver          selector ──► concrete rows (real query, real ids)
    │
    ├─ Layer A  PROVEN   BEGIN
    │                      open_gate('simulate')
    │                      ▸ run the REAL write statements
    │                      ▸ per-row audit trigger records every change,
    │                        INCLUDING rows touched only by cascade
    │                      ▸ real CHECK / FK violations surface here
    │                    ROLLBACK                    ← nothing is persisted
    │
    ├─ Layer B  PROVEN   read Stripe, the source of truth
    │                    reconcile against our cached mirror → drift
    │
    ├─ Layer C  PROVEN   invariants asserted on the state the database
    │                    actually reached: refund ≤ captured − refunded,
    │                    daily ceiling, mirror agrees with Stripe
    │                    every blocking invariant carries a REMEDY patch
    │
    └─ Layer D  PREDICTED  Gemini reasons about effects the database cannot
                           see. Advisory only. It can never block.


[3] PRESENT                            SimulationReport
    row-level before→after diff · blast radius · money · policy verdict
    · rollback path · PROVEN vs PREDICTED on every claim
        │
        ├── Approve   → single-use token, 5 min TTL, bound to planHash
        ├── Tweak     → apply a remedy → re-simulate → NEW planHash,
        │               which silently voids any prior approval
        └── Reject


[4] EXECUTE                            Gateway.execute()
    stages: canary(1) → batch(5) → batch(5) → …

    for each stage:
      (a) VERIFY BEFORE   re-read Stripe, compare against the FORECAST
                          ── diverged? halt. Nothing irreversible has happened.
      (b) MOVE MONEY      real Stripe refunds, idempotency key = (run, order)
      (c) WRITE           the same applyDbEffects() the simulation ran
      (d) RECEIPT         pre-images + compensating steps + external effects
      (e) VERIFY AFTER    row counts and Stripe totals vs expectation
                          ── diverged? halt.

    HALT ⇒ preflight.halt_run() moves the run out of `executing`, and
           Postgres then refuses open_gate_for_stage() for every remaining
           stage. Halting is enforced, not merely obeyed.


[5] ROLLBACK
    compensating steps derived mechanically from audit pre-images:
        INSERT → delete      UPDATE → restore prior row      DELETE → reinsert
    applied newest-stage-first, single-use per receipt
    external effects (a completed Stripe refund) reported as IRREVERSIBLE
```

## Why the gate has teeth

Enforcing "everything goes through the gateway" in application code is a
convention. Someone adds a route, forgets, and the guarantee is gone with no
error. So it is enforced one layer lower:

| Guarantee | Enforced by |
|---|---|
| No ungated write reaches a business table | `gate_guard` statement trigger on all six tables |
| Second-order effects are observed, not guessed | `audit_rows` row trigger, which also fires on cascade |
| An approval fits exactly one plan | `plan_hash` equality inside `open_gate_with_approval` |
| An approval is used at most once | atomic `UPDATE … WHERE consumed_at IS NULL … RETURNING` |
| A halted run cannot continue | run-status check in `open_gate_for_stage` |
| A receipt cannot be replayed | `applied` check in `open_gate_for_rollback` |
| No double refund on retry | Stripe idempotency key derived from `(run_id, order_id)` |

`tests/gate.test.ts` proves each of these against the real database.

## The layer boundaries that matter

**What the simulation proves.** The database half is not a model of the write —
it *is* the write, executed and rolled back. `applyDbEffects()` is called by the
simulation and by the executor with no branch on mode. That is why the diff is a
preview rather than a description.

**What it cannot prove.** You cannot dry-run a real Stripe refund. So the money
side is read (proven) but not performed (predicted) during simulation. This
boundary is drawn explicitly in the UI, and it is the reason step 4 exists at
all: the verifier is not decoration, it covers precisely the gap simulation
leaves behind.
