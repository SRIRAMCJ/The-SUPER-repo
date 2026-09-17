# Learning & Evolution Runtime

The Learning/Evolution runtime converts evaluation evidence into governed improvement proposals. It is deliberately separated from autonomous production mutation.

## Lifecycle

```text
Evaluation Run
    ↓
Failure-Pattern Signals
    ↓
Versioned Evolution Proposal
    ↓
Policy Authorization
    ├── rejected
    └── accepted
         ↓
Auditable State History
         ↓
Rollback (new revision)
```

## `EvolutionEngine`

`EvolutionEngine` reuses the existing `ExecutionStateStore`, `PolicyEngine`, and `EventBus`.

### Proposal generation

`propose(evaluationRun, metadata)` validates the evaluation result and groups failed cases deterministically by capability and failed assertion names. Each group becomes a `failure-pattern` signal containing the affected case IDs, occurrence count, and an `investigate-and-improve` action.

A completely successful evaluation produces a `no_change` proposal with no signals.

### Governance

`accept(proposalId, context, expectedVersion)` requires the proposal to be in `proposed` state and passes the proposal's risk/permissions through the existing policy engine. Critical-risk proposals therefore retain the existing explicit-approval requirement.

`reject(...)` records an explicit rejection without deleting the proposal.

### Concurrency and recovery

Proposal state uses the existing optimistic-concurrency `version` supplied by `ExecutionStateStore`. Evolution's own `revision` is a business/audit revision and is distinct from the store version.

`rollback(proposalId, targetRevision, expectedVersion)` never rewrites history. It appends a new rollback revision that restores the selected historical status.

### Events

The engine emits:

- `evolution.proposal.created`
- `evolution.proposal.accepted`
- `evolution.proposal.rejected`
- `evolution.proposal.rolled_back`

## Safety boundary

The current engine **does not directly modify capabilities, models, prompts, code, or production configuration**. Acceptance is a governed state transition representing authorization to pursue an improvement. A future execution layer can consume accepted proposals under the same policy, verification, audit, and recovery controls.

## Relationship to existing runtime

The intended progression is:

`Execution → Evaluation → Benchmark → Regression → Governance → Learning/Evolution`

This keeps learning evidence-based and makes evolution observable, versioned, policy-controlled, and reversible.