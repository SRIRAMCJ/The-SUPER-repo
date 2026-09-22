# Durable Execution State Machine

PR #95 introduces an explicit durable lifecycle over the existing versioned execution-state store.

## Lifecycle

`created -> admitted -> prepared -> running -> succeeded|failed|cancelled|timed_out`

Recoverable failures transition through:

`failed|timed_out -> recovered`

A recovered execution can re-enter preparation or running through an explicit transition rather than mutating state implicitly.

## Safety properties

- Every transition is validated against a deterministic transition graph.
- Terminal states cannot be advanced.
- Every mutation carries an incrementing state version.
- Mutations use optimistic concurrency via expectedVersion.
- Transition records retain from/to state, timestamp and reason.
- Error information is persisted with the state.
- Recovery is explicit and restricted to retryable failure states.
- The machine uses the existing ExecutionStateStore abstraction, including FileExecutionStateStore persistence.

This is the runtime state-machine foundation for the next distributed idempotency and coordination layers.
