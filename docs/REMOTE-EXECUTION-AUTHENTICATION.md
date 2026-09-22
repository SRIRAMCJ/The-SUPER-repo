# Remote Execution Identity & Authentication

## Purpose

PR #93 establishes the remote execution trust boundary on top of the protocol and transport contract.

The runtime now separates:

- **identity** — who a remote principal is;
- **authentication** — whether the principal controls the credential identified by `keyId`;
- **authorization** — which protocol methods a role may invoke;
- **replay protection** — nonce uniqueness within an authentication session;
- **credential lifecycle** — expiry, clock skew, rotation, and retirement.

## Identity contract

A remote identity contains:

- `principalId`
- `role`: `controller` or `worker`
- `instanceId`
- `issuedAt`
- `expiresAt`
- `keyId`

Credentials are short-lived by default and are rejected outside the configured clock-skew window.

## Authentication

The provider-neutral reference implementation uses HMAC-SHA256 through `RemoteAuthKeyRing`.

The key ring supports:

1. active-key selection;
2. key rotation;
3. overlap during migration;
4. explicit retirement of old keys.

Secrets remain runtime configuration. They are not stored in protocol envelopes.

Signed material is canonicalized before signing so semantically equivalent object key ordering cannot produce different signatures. The authentication object also carries the exact signed protocol envelope; the transport rejects any mismatch between that envelope and the request being executed.

## Authorization

The reference policy is intentionally explicit:

| Role | Allowed methods |
| --- | --- |
| controller | execute, cancel, inspect |
| worker | heartbeat |

The transport verifies role authorization after authentication and before execution.

## Replay protection

Each authenticated request carries a nonce. A nonce can only be accepted once per authentication session.

This is deliberately session-local in PR #93, with a bounded nonce cache to prevent unbounded memory growth. Durable/distributed replay state belongs to the later idempotency layer.

## Transport integration

When `authKeyRing` is supplied to `InMemoryRemoteExecutionTransport`:

- worker registration requires a valid worker identity and signed heartbeat registration envelope;
- worker heartbeats require worker authentication;
- execute requests require controller authentication;
- authentication metadata is excluded from the signed protocol payload to avoid circular signatures;
- tampering with the execution payload invalidates the signature.

Controller identities can be explicitly allowlisted through the transport trust configuration. Worker identities may bootstrap through possession of a valid worker credential and are then bound to the authenticated session. Without `authKeyRing`, the existing protocol-only development mode remains available.

## Security boundary

Authentication does not replace capability manifests, leases, fencing, protocol negotiation, or execution policy. It composes with them:

`identity -> authenticate -> authorize -> protocol validate -> lease/fence -> execute`

This preserves the existing fail-closed execution path while establishing a cryptographic principal boundary.

## Next layer

The remaining distributed-runtime gap is canonical capability attestation/fingerprinting. That layer should bind an authenticated worker identity to the exact capability set and execution contract it is trusted to perform.
