# Distributed Coordination Kernel

The runtime now has a durable coordination primitive for exclusive ownership of shared resources.

## Guarantees

- Single-owner acquisition for a resource.
- Monotonic fencing tokens on every new acquisition.
- Owner/request/token-bound renew and release.
- Lease expiry and safe reacquisition.
- Administrative fencing to invalidate a worker.
- File-backed journal with cross-process lock serialization.
- Canonical coordination fingerprints.

## Fencing contract

Every acquired lease receives a monotonically increasing `fencingToken`. Consumers performing writes against a shared resource must carry that token and reject stale tokens. The kernel cannot make arbitrary downstream systems fencing-aware; integration adapters are responsible for enforcing the token at the resource boundary.

## Durability

The file-backed implementation journals each state mutation and fsyncs the journal before returning. The lock directory provides cross-process serialization for the local filesystem deployment model.

## Scope

This PR provides the coordination kernel primitive. It does not claim distributed consensus, leader election across unreliable networks, or transactional guarantees across external databases/services. Those require explicit coordination backends and integration contracts.
