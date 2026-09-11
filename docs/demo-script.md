# 90-second walkthrough script

Open the live demo. Wait for the sandbox to finish provisioning before recording
— it creates real Stripe test charges and takes a few seconds.

---

**0:00 — 0:10 · The claim**

> "This is Preflight. It sits in front of an agent's writes. Before anything
> touches a real system, it performs the write for real, inside a transaction
> that rolls back, and shows you exactly what would have happened."

Point at the three badges: **Stripe test mode · live**, **Gemini**, **Postgres ·
real transactions**.

---

**0:10 — 0:30 · Simulation that changes the decision**

Click **"Refund the March defect batch."**

> "Fourteen orders, twenty-three sixty-five. And it's blocked — not by a rule
> someone wrote about this request, but by checking the state the database
> actually reached: this exceeds the daily refund ceiling by three hundred and
> sixty-five dollars."

Point at **EFFECTS THE REQUEST NEVER MENTIONED — 12 rows written to
preflight.ledger_entries.**

> "Nobody asked for ledger rows. The simulation found them because the write
> really ran."

---

**0:30 — 0:45 · Proven versus predicted**

Worth noting on camera: the left column appears in about a second, and the
right one fills in a few seconds later.

> "Everything on the left is measured. On the right is a model's guess at what
> happens *outside* the database — customer emails from Stripe, cash-flow
> reporting. It's labelled as a prediction and it can never block anything.
> Notice which one arrived first: the evidence doesn't wait on the opinion.
> That distinction is the whole product."

---

**0:45 — 1:00 · Tweak in one step**

Click **"Exclude the 2 largest refund(s)."**

> "The block came with a fix. One click, re-simulated: twelve orders, seventeen
> seventy-five, and the plan hash changed — so any approval for the old plan is
> already dead."

Click **Approve**.

---

**1:00 — 1:25 · The failure test**

Click **"Failure test: change Stripe behind our back."**

> "Now a support agent refunds fifteen dollars of one of these orders straight
> from the Stripe dashboard. Our forecast is stale and nothing here knows it. No
> amount of simulating could have prevented this — it hadn't happened yet."

Click **Execute for real.**

> "Halted at the canary. Zero dollars moved. Thirteen orders never touched."

Point at the predicted-versus-actual diff.

> "It expected zero already refunded; Stripe says fifteen. And the halt isn't a
> break in a loop — Postgres now refuses to open the gate for any remaining
> stage."

---

**1:25 — 1:30 · Close**

> "Simulation reduces risk. It never eliminates it. That's why there's a verifier
> downstream — and why 'undo' was never enough."

---

## Notes for recording

- Reset the sandbox first so the totals start clean.
- The blocked → tweak → approve beat is the strongest fifteen seconds; do not rush it.
- Cross-cut to the Stripe test dashboard if you have ten spare seconds — the
  refunds are genuinely there.

## Optional: the second action

If you have time for a longer cut, `Delete dormant customers` is the strongest
non-money beat. It gets refused by a real foreign key rather than by a policy,
and the diff shows dependent rows leaving with the customer:

> "This one isn't blocked by a rule someone wrote. It's blocked by the data.
> Postgres names the constraint, and the simulation found six dependent rows
> nobody asked to delete. One click archives instead."
