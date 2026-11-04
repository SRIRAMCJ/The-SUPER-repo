# Phase 4 cross-host deployment check

Run this only after deploying **two different workers on separate hosts**. They must use the same PostgreSQL nonce, idempotency, and audit stores, the same high-entropy HMAC signing key, and distinct node IDs. Both bridges need TLS 1.3, client certificate allowlisting and worker-specific pinned server certificates. Configure each worker with a governed echo capability whose response is the supplied object. Use a dedicated database/test namespace and budget for the retained audit records. Do not run the check against user-facing effect handlers.

Provide a private JSON configuration file (never commit it):

```json
{
  "hmacKeyFile": "/secure/hmac.key",
  "caFile": "/secure/ca.crt",
  "clientKeyFile": "/secure/client.key",
  "clientCertFile": "/secure/client.crt",
  "capabilityId": "echo",
  "maxP95Ms": 100,
  "samples": 200,
  "concurrency": 8,
  "nodes": [
    {"host":"worker-a.example","port":8443,"servername":"worker-a.example","nodeId":"node-a","serverFingerprint256":"AA:..."},
    {"host":"worker-b.example","port":8443,"servername":"worker-b.example","nodeId":"node-b","serverFingerprint256":"BB:..."}
  ]
}
```

Run `node scripts/verify-phase4-hosts.mjs /secure/phase4-config.json` from a client on a third host. A successful report verifies pinned TLS dispatch to each node, shared request single-flight across distinct node IDs, and bounded client-observed loopback-independent p95 at the specified load. The requested p95 is a deployment acceptance criterion, not a repo default. Host identity and physical separation must be independently checked by the operator. This does not simulate network partitions or prove arbitrary external effect fencing. Capture the report, host topology, PostgreSQL deployment version, and repeated runs for the Phase 4 gate.
