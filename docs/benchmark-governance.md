# Benchmark Governance

`BenchmarkGovernanceEngine` turns benchmark regression results into a versioned promotion boundary.

## Lifecycle

`Benchmark Run → Regression Gates → Governance Evaluation → Promotion / Rejection → Versioned Baseline`

The engine stores one current baseline per `benchmarkSuiteId`, keeps an append-only in-state history, supports optimistic-concurrency protected promotion and rollback, and emits lifecycle events when an `EventBus` is supplied.

## Persistence

The engine accepts the existing `ExecutionStateStore` contract. `FileExecutionStateStore` can therefore provide durable JSON persistence without introducing a second persistence subsystem.

## Safety properties

- candidates are validated before comparison;
- failed regression gates never mutate the baseline;
- promotion can require an expected state-store version;
- rollback creates a new revision instead of rewriting history;
- benchmark runs and regression decisions remain the source of truth for promotion;
- metadata is cloned before persistence to avoid caller mutation.

`baselineVersion` is the governance revision. The inherited state-store `version` remains the optimistic-concurrency version.
