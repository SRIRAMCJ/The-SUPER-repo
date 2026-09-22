# Remote Execution Durability

The remote runtime uses three protections beyond the worker scheduler:

- **Durable lease snapshots** preserve lease state and fencing counters across runtime restarts.
- **Worker incarnations** distinguish a restarted worker from an older process using the same worker ID and reject stale heartbeat sequences.
- **Single-flight recovery** ensures concurrent heartbeat/recovery paths cannot reassign the same execution twice.

The durable store contract is intentionally small:

```js
load() -> snapshot | null
save(snapshot) -> snapshot
```

`FileRemoteExecutionStore` writes through a temporary file and atomic rename. Production deployments can provide a transactional database-backed implementation with the same contract.

A remote lease now carries `workerInstanceId` when available. Validation can therefore reject both stale fencing tokens and stale worker incarnations.

Recovery is keyed by `executionId`; concurrent failover attempts share one promise and only one scheduler reassignment is allowed to run.

This layer is a durability primitive, not a claim that the in-memory transport is a production network transport. Authentication, protocol negotiation, and a real RPC adapter remain separate concerns.
