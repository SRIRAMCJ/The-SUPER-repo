# SUPER implementation phases

This is a delivery sequence, not a claim that the full platform is complete. Each module is finished only when it is integrated on `main`, tested in CI, documented, and checked for failure behavior, security, and performance appropriate to its scope. Build original implementations from the repository's contracts; reference repositories inform design but are not cloned into SUPER.

| Phase | Modules | Completion evidence |
| --- | --- | --- |
| 1. Runtime operations | Readiness, configuration, resource admission, safe shutdown, supervision and failover (reconcile #52–53) | Real lifecycle wiring, bounded checks, concurrent admission tests, restart/failure tests, measured overhead |
| 2. Request safety | Trusted identity, rate limits, durable idempotency and atomic single-flight (#54–57) | Multi-process and crash tests, explicit replay and rejection contracts, bounded memory |
| 3. Observability | Event transport, durable log, checkpoints, synchronization, gap repair and integrity (#58–69) | Replay and corruption tests, convergence after partitions, retention and throughput evidence |
| 4. Remote execution | Durability, protocol, identity, attestation, effect ledger and coordination (#91–97) | Authenticated cross-process workers, lease fencing at the side-effect boundary, fault injection, latency budgets |
| 5. Mission integration | Recovery and observability integration; reconcile #98–104 | End-to-end mission tests through interruption, restart, duplicate delivery and verification |
| 6. Tool and reverse engineering fabric | Governed filesystem, terminal, Git/GitHub, browser, HTTP, MCP and dedicated investigators for new target types | Permission and sandbox tests, provenance and evidence checks, resource bounds for each adapter |
| 7. Knowledge and intelligence | Durable memory, retrieval, document/code graphs, real model/harness adapters | Evaluated answer quality, source provenance, privacy and provider interoperability |
| 8. Platform and evolution | Studio, workflows, plugins, domain packs, experiment and promotion systems | Usable vertical workflows, benchmark regressions, rollback, security and accessibility gates |

Work on a module in focused PRs rather than merging a historical stack wholesale. If an older PR's behavior is fully replaced and verified, close it with its replacement linked. Do not equate passing unit tests with cross-process guarantees or production readiness.

Current phase 1 progress: local coordination is integrated through #121 and bounded readiness through #122. Resource reservations are the next slice; execution admission wiring, measured resource enforcement, safe shutdown, and failover remain pending.

`RuntimeResourceGovernance` tracks in-process reservations. Its `cpuMs`, `memoryBytes`, and `networkRequests` values represent requested budgets, not measured consumption or OS-enforced limits. A later execution-admission module must reserve before dispatch and release in `finally`; sandbox and worker limits must enforce actual usage. Do not use independent instances as a shared quota.
