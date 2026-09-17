# Runtime Observability

`ObservabilityEngine` provides an executable, dependency-free observability layer for SUPER's event-driven runtime.

## What it does

- Subscribes to the runtime `EventBus` wildcard stream.
- Retains bounded, metadata-only event records rather than execution payloads.
- Tracks execution counters for started, completed, failed, denied, and progress events.
- Correlates `*.started` and terminal `*.completed` / `*.failed` / `*.cancelled` / `*.rolled_back` / `*.rejected` events into trace spans by `executionId`.
- Calculates deterministic duration metrics from event timestamps.
- Tracks currently active executions.
- Exposes filtered events, traces, metrics, and a complete bounded snapshot.
- Supports explicit `close()` to unsubscribe from the event bus.

## Security and retention

Observability intentionally projects only event metadata into its retained event stream. Event `data` and `error` payloads are not copied into retained event records. Event and trace retention is bounded by `maxEvents` and `maxTraces` to prevent unbounded in-memory growth.

This is a local runtime observability primitive, not a replacement for an external metrics or tracing backend. A future exporter can consume `getMetrics()`, `getTraces()`, or `snapshot()` without coupling the runtime to a vendor.

## Example

```js
const events = new EventBus();
const observability = new ObservabilityEngine({ eventBus: events });

// Existing runtime components emit through EventBus.
const metrics = observability.getMetrics();
const traces = observability.getTraces({ executionId });
```

The implementation is intentionally provider-agnostic and does not add telemetry dependencies to the runtime package.
