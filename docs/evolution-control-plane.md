# Evolution Control Plane

The `EvolutionControlPlane` coordinates governed rollout of an already accepted evolution proposal through the existing `AdaptationEngine`.

## Lifecycle

`Accepted Proposal → Control Policy → Canary → Health Check → Progressive → Health Check → Full → Health Check → Complete`

A failed adaptation or unhealthy health check can trigger rollback of all adaptations already applied by the control run, in reverse order.

## Safety boundaries

- The control plane never creates, accepts, or invents evolution proposals.
- Policy authorization occurs before rollout begins.
- Each stage delegates mutation to the existing `AdaptationEngine`.
- Adaptation verification remains enforced by `AdaptationEngine`.
- Rollout health is supplied by an explicit caller-provided `healthCheck` contract.
- Rollback is explicit and bounded to adaptations created by the current control run.
- Control state is persisted through the existing `ExecutionStateStore`.
- Lifecycle events are emitted through the existing `EventBus` and classified by `ExecutionAudit`.

## Rollout contract

Stages require unique IDs and monotonically increasing fractions in `(0, 1]`. The final stage must have fraction `1`.

A health check must return `{ healthy: boolean }` and may include a machine-readable `code` and human-readable `reason` when unhealthy.

## Failure behavior

With `rollbackOnFailure: true` (the default), a failed stage or unhealthy health check rolls back prior adaptations in reverse order. If every rollback succeeds, the control result is `rolled_back`; otherwise it is `failed` and includes `rollbackErrors`.

Setting `rollbackOnFailure: false` leaves applied adaptations in place and returns a failed control result. This should only be used when the caller has an explicit recovery strategy.

## Persistence

Control executions use the existing state-store schema with `type: evolution-control`, retaining stage progress, adaptation IDs, and append-only history. No second persistence subsystem is introduced.
