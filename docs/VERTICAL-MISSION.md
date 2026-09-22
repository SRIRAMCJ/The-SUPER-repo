# SUPER Vertical Mission Runtime

This is the first complete end-to-end mission slice. It composes the existing planning, admission, orchestration, verification, artifact and reporting layers.

Lifecycle:

Mission request → planning → admission → execution → verification → artifact delivery → mission report.

Contracts:
- Planning must return an executable agent plan.
- Admission must explicitly return ready before execution.
- Orchestration owns agent execution and recovery.
- Verification is an independent success gate.
- Artifact delivery happens only after successful execution and verification.
- Every terminal mission produces a structured mission report.
- Errors are normalized into stable machine-readable codes.

The runtime is provider-neutral. Model, tool, browser and remote execution remain injected capabilities rather than being hidden assumptions.
