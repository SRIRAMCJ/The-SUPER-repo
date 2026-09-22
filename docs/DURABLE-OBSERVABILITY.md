# Durable Runtime Observability

The runtime already provides local lifecycle metrics and traces. This layer adds a durable, correlation-aware event pipeline beneath those views.

## Guarantees
- Monotonic per-source event sequence.
- Idempotent event admission by event ID.
- Trace, span, parent-span, mission, and execution correlation.
- Per-event SHA-256 integrity.
- Deterministic retained-range digest.
- Restart replay with corruption detection.
- Bounded retention without resetting the authoritative sequence.
- File-backed cross-process serialization and fsync before acknowledgement.

## Scope
This is an event persistence primitive. It does not claim telemetry-vendor integration, distributed consensus, or arbitrary external transaction guarantees.

## Retention
Retention limits the queryable retained window; the authoritative sequence remains monotonic. Future synchronization layers can use checkpoints and retained ranges to detect missing history.