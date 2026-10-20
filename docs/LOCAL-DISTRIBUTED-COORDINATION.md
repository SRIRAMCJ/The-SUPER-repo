# Local coordination boundary

`DistributedCapabilityGate` coordinates registered node identities, capability assignments, leases, fencing tokens, and idempotent executions **within one Node.js process**. `RemoteExecutionTransport` is a bounded dispatch adapter around that gate; it invokes a supplied handler in the same process. Neither class communicates over a network or persists leases or results across restarts.

Use a single shared gate instance for all callers that need its fencing and deduplication guarantees. A timeout returns promptly and aborts the handler's signal, but cannot undo external side effects or forcibly stop a handler that ignores abort. The old handler's terminal result is withheld when its lease is stale; downstream side effects require their own fencing.

Cross-process coordination requires a shared durable authority and a real transport. Do not treat independent instances as a distributed lock or use these classes as a remote security boundary.
