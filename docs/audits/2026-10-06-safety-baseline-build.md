# Runtime safety baseline build — 2026-10-06

## Result

This integration branch combines the EventBus repair from draft PR #109 and the
planning/admission repair from draft PR #110, then fixes the reproduced policy,
execution, registry, memory and storage defects from the foundation audit. It also
restores and hardens the durable idempotency boundary from the existing runtime
branch history.

The complete configured test command is green locally on Node 24.19.0:

| Suite | Passed | Failed |
| --- | ---: | ---: |
| Core | 13 | 0 |
| Runtime | 234 | 0 |
| Repository analyst | 3 | 0 |
| CLI | 2 | 0 |
| Total | 252 | 0 |

GitHub CI uses Node 22 and remains authoritative after publication.

## Fixed behavior

- Policy decisions fail closed when a policy throws, returns malformed data, or
  returns a Promise to the synchronous authorization interface. Promise rejections
  are observed so they do not become unhandled rejections.
- Capability registry callers receive isolated manifests and cannot replace stored
  handlers or mutate stored permissions through resolved/listed values.
- Tool execution reserves IDs before dispatch, rejects concurrent/replayed IDs,
  handles cancellation and timeout independently of handler cooperation, and keeps
  an uncooperative timed-out handler's ID reserved until it settles.
- Execution handlers are never invoked when the parent signal is already cancelled
  or cancellation occurs from the synchronous start-event boundary.
- Memory and execution-state restores validate into temporary maps and publish only
  after the full snapshot succeeds. Custom record IDs survive round trips.
- Mission and file execution stores share first-load work, keep corrupt data errors
  sticky, serialize operations per instance, roll memory back after failed writes,
  and atomically replace JSON files after file fsync.
- Runtime control-plane event matching and failure-window handling are corrected.
  Expired and future failure events do not poison current health.
- Plan step execution receives unique child execution IDs, allowing multiple agents
  to execute the same capabilities concurrently without false cancellation conflicts.
- Retryable nested task failures reach orchestration recovery, while terminal session
  transitions remain consistent.
- Command, gateway, lifecycle and operations tests now reflect their documented
  structured contracts.
- A root `npm test` command runs all four configured suites.

## Durable idempotency build

`DurableIdempotencyStore` and `RuntimeRequestGuard` are restored from existing branch
work and revised before integration:

- directory-lock claims serialize separate instances and Node processes;
- monotonic elapsed time controls lock acquisition timeout even with a fixed app clock;
- locks are never removed merely because their wall-clock age appears stale;
- every claim has an unpredictable ownership token;
- an expired owner cannot complete a replacement claim;
- pending claims are never silently evicted at capacity;
- completion requires matching key, fingerprint and claim token;
- request identity uses host-supplied `clientKey`, not an untrusted identity header;
- cache keys are SHA-256 hashes of full principal/method/path/query/idempotency-key tuples;
- query strings participate in request identity and request fingerprints;
- in-memory and durable modes both single-flight pending requests;
- compacted journals are fsynced and atomically replaced.

This directory-lock protocol is intended for processes sharing one reliable local
filesystem. It is not a network/distributed consensus lock, does not fence a process
that loses access while continuing external side effects, and is not the final HA
control-plane store.

## Persistence limits

`FileMissionStore` and `FileExecutionStateStore` provide per-instance serialization
and atomic replacement. Multiple independent writer instances can still overwrite
one another because the JSON format has no cross-process compare-and-swap protocol.
They must not be described as a distributed authoritative store. The recovery/fencing
PR chain (#106–108) should be reviewed against this branch, then tested with crash,
multi-process conflict and stale-owner failure injection before merge.

The EventBus remains bounded in memory rather than durable. The plan fingerprint is
a diagnostic checksum rather than cryptographic authentication. Non-cooperative
handlers can continue consuming resources after their caller receives cancellation;
the runtime prevents ID reuse but cannot forcibly terminate arbitrary in-process code.
Strong isolation requires a worker process or sandbox boundary.

## Source and PR relationship

This branch is based on `main` at `e0bd692` and includes the content of draft PRs
#109 and #110. It supersedes their combination for verification, but does not merge,
close or alter those PRs. The durable-idempotency implementation was reconciled from
existing runtime branch history rather than recreated without reference.
