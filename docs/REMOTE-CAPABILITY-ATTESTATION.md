# Remote Capability Attestation

PR #94 binds an authenticated remote worker identity to a canonical capability contract.

## Trust model

A worker registration is accepted only when the authenticated worker identity and capability attestation agree on:

- principal ID
- role
- worker instance ID
- authentication key
- capability set
- supported protocol versions
- attestation lifetime
- deterministic capability fingerprint
- HMAC-SHA256 signature

The attestation nonce is included in the signature material, preventing the nonce from being swapped independently of the signed manifest.

## Canonical fingerprint

The capability fingerprint is SHA-256 over the canonical representation of:

```
{
  schemaVersion,
  capabilities: sorted unique capabilities,
  protocolVersions: sorted unique protocol versions
}
```

Capability ordering therefore does not change the fingerprint, while capability or protocol changes do.

Duplicate entries are rejected rather than silently normalized.

## Runtime enforcement

When remote authentication is enabled, capability attestation is required by default.

Registration validates the attestation before the worker is inserted into the worker registry.

Heartbeat validation prevents an authenticated worker from silently changing its capability set. A valid refreshed attestation may replace the previous attestation.

Before execution, the runtime re-validates the worker attestation and fails closed on:

- missing attestation
- expired or not-yet-valid attestation
- unknown signing key
- invalid signature
- identity mismatch
- capability fingerprint mismatch
- capability drift
- protocol mismatch

This closes the trust gap between authenticated identity and executable capability.

## Key rotation

Attestations use the existing provider-neutral authentication key ring. New attestations can be signed with a rotated key while older keys remain valid until explicitly retired.

## Remaining production boundary

The current implementation is provider-neutral and in-memory at the transport layer. Distributed attestation replay state, external secret storage, and network transport remain later production-runtime layers.
