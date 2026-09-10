# Simulation-gated agents: a two-year view

**"Undo" was never a safety feature.** It was a coping mechanism calibrated to human
speed. A person issues one refund, notices the mistake, and reverses it. An agent
issues eight hundred in four seconds, and by the time anyone notices, the reversal
is not an undo — it is an incident.

The reflex response has been the confirmation dialog. It fails for a reason that
should be obvious: it asks a human to approve an action while showing them only the
*intent*. "Refund the March batch — are you sure?" is not information. The operator
has no idea whether that is twelve orders or twelve hundred, whether it trips a
ceiling, or whether it cascades into records nobody mentioned. Confirmation theatre
converts a technical risk into a human liability, which is worse than leaving it
unmanaged, because now someone clicked.

The pattern that replaces it is already standard elsewhere. Terraform shows a plan.
Databases have transactions. Deployments have canaries. What is missing is not the
idea but the plumbing: agents write through APIs that offer no dry-run, so the
industry substitutes a language model's *description* of consequences for a
*measurement* of them. Those are not the same epistemic object, and conflating them
is the field's central unforced error.

Within two years I expect the dry-run to become an API design expectation — every
serious write endpoint shipping a preview mode, the way every serious endpoint now
ships pagination. Agent frameworks will treat "can this be simulated?" as a
capability check.

The harder lesson takes longer: **simulation reduces risk, it never eliminates it.**
A forecast is made at a moment, and the world moves. Anyone shipping this pattern
without staged execution and a downstream verifier has built a more sophisticated
way to be confidently wrong.

*(294 words)*
