# SUPER repository reconciliation — 2026-10-06

## Authority and scope

The user-designated historical source is preserved verbatim at
[SUPER_REPO_MASTER_MEMORY.md](../history/SUPER_REPO_MASTER_MEMORY.md).
It records intent and history; the checked-out code and current CI establish implementation status.
The other supplied documents describe the broader domain vision and the earlier development process.
No restart, architecture replacement, bulk import, or PR merge was performed.

Inspected baseline: `main` at `e0bd692ef34ba49847e8f709035728706543a8d4`
(`feat(runtime): add durable vertical mission recovery (#105)`).
Live inspection found 35 open PRs before this reconciliation PR.
Their exact heads and bases are recorded in [the PR snapshot](open-pr-snapshot-2026-10-06.json).
This is a source review and local verification, not a production-readiness certification or an exhaustive audit of every branch.

## Verified baseline

[Main CI run 35735230087](https://github.com/SRIRAMCJ/The-SUPER-repo/actions/runs/35735230087)
failed in runtime tests: **194 tests, 177 passed, 17 failed** on Node 22.23.2.
Repository analyst and CLI jobs were skipped after that failure.
A fresh local checkout reproduced the same totals on Node 24.19.0.

| Suite | Baseline local pass/fail | This change local pass/fail |
| --- | --- | --- |
| Core | Not separately rerun | 13 / 0 |
| Runtime | 177 / 17 | 183 / 15 |
| Repository analyst | Not separately rerun | 3 / 0 |
| CLI | Not separately rerun | 2 / 0 |

Four added EventBus tests plus two repaired pre-existing tests account for the runtime change.
The targeted events, observability, and vertical-mission suite passes **15/15**.
The full suite remains red. File-level loader failures count as failed tests; these numbers do not imply all tests inside those files ran.

## Historical claims reconciled

| Area | Current classification | Evidence and next requirement |
| --- | --- | --- |
| Language strategy | Historical plan differs from code | Executable implementation is JavaScript ESM with Node tests. Preserve it; adopt TypeScript incrementally only with a migration reason. |
| Architecture foundation | PARTIALLY COMPLETE | `packages/core`, schemas, registries, runtime modules, and software-domain registration exist. Folder counts are not capability counts. |
| Repository analyst and CLI | COMPLETE within tested scope | Real local analysis and `super analyze`; 3 analyst and 2 CLI tests pass. CLI is not yet a general mission/harness interface. |
| Control plane | BROKEN in tested contracts | `control-plane.js`, `gateway.js`, operations and command bus exist; health, lifecycle history, cancellation-response and diagnostics assertions fail. It is not yet the complete mission/worker authority described in memory. |
| Mission persistence and recovery | PARTIALLY COMPLETE | `mission-store.js`, `vertical-mission.js`, task-graph persistence and resume exist on main after #105. Recovery fencing and crash-safety remain in open #106–108. |
| Event history | COMPLETE within repair scope | Bounded in-memory retention and isolated snapshots now tested. This is not durable observability or a distributed event log. |
| Agent planning/admission | BROKEN | Missing-capability and governance planning checks, stale-plan handling, output contract and retry recovery tests fail. |
| Teams | PARTIALLY COMPLETE | Team and parallel coordinator implementations exist; multi-output synthesis test fails. |
| Models | PARTIALLY COMPLETE | Provider registry, model runtime, router and execution kernel exist. No live paid-provider execution was verified. |
| Memory | BROKEN in restore path | `memory-capability.js` generates IDs differently from restore validation; snapshot restore test fails. |
| Tool runtime | IMPLEMENTED BUT UNVERIFIED as a suite | Test file imports undeclared `vitest`, while workspace uses `node --test`. Restore executable tests before claiming tool guarantees. |
| Durable idempotency | BROKEN on main | Test imports `DurableIdempotencyStore` and `RuntimeRequestGuard`, which main does not export. Related implementation exists on other branches. |
| Distributed workers, remote sandbox, fencing | NOT VERIFIED ON MAIN | Remote backend additions were reverted on main; substantial branch-only work exists. Inspect and reconcile it, do not recreate from memory or treat PR titles as proof. |
| Evaluation/evolution | PARTIALLY COMPLETE | Benchmark, governance, evaluation and evolution modules/tests exist. These do not demonstrate trained reinforcement-learning policies or real-world superiority. |
| Studio, broad domain ecosystem, end-to-end engineering harness | MISSING as a verified product | `apps/cli` is the executable app inspected. Reference lists and directory scaffolds do not establish working integrations. |

## PR topology and integration order

- #106 targets main; #107 targets #106's branch; #108 targets #107's branch.
  Together they change five files relative to main, adding recovery fencing,
  fsync-based persistence hardening and restart tests. Review in that order.
- #103 and #104 are older integration/reconciliation candidates; #102 is older
  mission recovery work. Compare their content against merged #105 before closing,
  rebasing or merging anything.
- #91–99 form a dependent remote/durability/coordination/observability chain.
- #54–69 form another dependent admission/idempotency/observability chain.
- #50–53 remain open. Their existence contradicts any assumption that historical
  security/distributed/operations discussions automatically describe merged main.
- An open PR is not necessarily missing code: squash merges and reconciliation may
  duplicate content. Check ancestry and diffs, then run tests on each integration boundary.

## Repair delivered here

Restores EventBus constructor options, contract validation and bounded history,
following the existing branch work in `9e323b6` / `a84b04d` (not present on main).
Retains the branch design's 10,000-event default and optional filtered history limit.
Adds deep isolation between the emitter, retained history, returned value and each
listener; preserves explicit metadata; avoids double wildcard delivery.
Listener exceptions still propagate and the event remains recorded.

This bounds event count, not individual payload bytes. History is in-memory and
must not be treated as a durable audit ledger. Payloads must be structured-cloneable.

## Remaining baseline failures and required work

| Failure group | Required next action and verification |
| --- | --- |
| Admission (2) | Correct clock contract and reconcile wrapped task output; run admission and task-graph integration tests. |
| Orchestrator recovery (1) | Trace retryable task result through recovery and bounded attempts; verify transient/permanent failures. |
| Planning (2) | Wire capability availability and governance denial into plan status; prove denial prevents execution. |
| Command bus (1) | Resolve `INVALID_INPUT` versus `COMMAND_FAILED` contract without weakening validation. |
| Control plane (2) | Correct terminal event matching and health-window semantics; test completed, failed and old events. |
| Durable idempotency (1 loader failure) | Reconcile existing branch implementation with main and exports; verify concurrent claims and restart replay. |
| Gateway (1) | Reconcile cancellation response shape with caller contract and test through HTTP. |
| Lifecycle (1) | Decide immutable versus isolated-mutable snapshot contract; retain state isolation and align tests. |
| Memory (1) | Accept valid generated record identities, validate restore atomically and prove failed restore preserves prior data. |
| Operations (1) | Reconcile optional state-store diagnostic severity and expected readiness policy. |
| Team (1) | Trace synthesis execution result and failure propagation; test multiple successful outputs. |
| Tool runtime (1 loader failure) | Port tests to Node's runner or explicitly install/configure a single runner; fix test ID reuse and verify policy, concurrent IDs, cancellation and timeout. |

Some failures are implementation defects; some may be stale test expectations.
Confirm the intended contract before changing either. Do not skip failing tests to obtain green CI.

## Next implementation sequence

1. Recover a green main baseline in small reviewed changes, reusing existing branch fixes.
2. Integrate #106–108 after contract, crash and stale-owner tests pass; then reconcile
   the older remote stack into an isolated integration branch. Verify real worker death,
   reassignment, expired fencing tokens and duplicate side-effect prevention end to end.
3. Deliver one complete engineering mission: inspect repo → plan → authorize → edit
   in an isolated checkout → test → review → produce patch/PR artifact → resume after restart.
4. Add provider-neutral harness adapters and versioned skills through current registries,
   with capability checks, provenance, budgets and contract tests.
5. Add domain packs and controlled learning only after that mission is reproducible.

“World's best” is an ambition, not a verified result. Track held-out task success,
regression rate, recovery correctness, policy bypasses, latency, token cost and human
interventions against fixed baselines before making comparative claims.
