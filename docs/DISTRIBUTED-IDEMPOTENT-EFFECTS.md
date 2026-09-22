# Distributed Idempotent Effects

PR #96 adds a durable effect ledger above request-level idempotency.

## Guarantees

The ledger provides one durable logical owner per effect key at a time, committed-result replay, deterministic SHA-256 request fingerprints, scope binding, claim-token fencing, retry classification, and explicit recovery of expired claims.

Protocol: claim -> pending -> commit|fail.

Each record binds an effect key to execution ID, operation, worker identity, capability fingerprint, request fingerprint, claim token, generation, result/error, and expiry.

## Exactly-once boundary

This is exactly-once logical admission and committed-result replay, not a universal exactly-once guarantee for arbitrary external systems.

A crash can occur after an external side effect succeeds but before commit is recorded. That state is fundamentally ambiguous unless the downstream system has its own idempotency/transaction boundary. Integrations should therefore pass the stable effect key to downstream systems that support idempotency.

The ledger must not blindly re-execute an expired unknown external effect. Expired claims enter explicit recovery, after which a new fenced generation may be claimed.

## Failure semantics

- fingerprint or scope mismatch: conflict
- committed record: replay
- active pending record: in progress
- stale claim token: fenced
- retryable failure: reclaimable
- permanent failure: terminal until expiry
- expired pending claim: explicit recovery

The file-backed implementation uses an exclusive lock directory and fsync-backed append journal records.

## Non-goals

This is not a consensus protocol, Byzantine fault-tolerant store, or cross-provider transaction coordinator.

## Verification

Regression coverage includes duplicate claims, scope/fingerprint conflicts, concurrency, stale fencing, recovery, retry classification, restart durability, filesystem locking, and deterministic fingerprints.
