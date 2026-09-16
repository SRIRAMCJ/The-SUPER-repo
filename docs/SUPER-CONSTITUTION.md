# SUPER Constitution

**Status:** Architecture Lock — v0.1

## 1. Purpose

SUPER is an extensible, provider-agnostic AI execution platform that turns user intent into verified outcomes through capabilities such as agents, skills, tools, commands, workflows, teams, memory, knowledge, models, integrations, and evaluation.

SUPER is an executable system, not a catalog of prompts or a collection of placeholder files.

## 2. Core Principles

1. **Execution over inventory** — every published capability must be real, testable, and usable.
2. **Contracts before scale** — schemas and runtime contracts govern all capability types.
3. **Provider agnostic** — core behavior must not depend on one model vendor or harness.
4. **Secure by default** — permissions, validation, isolation, auditability, and human approval are first-class execution concerns.
5. **Verification is mandatory** — important outputs require explicit validation appropriate to the task.
6. **Observable execution** — executions emit structured events and useful telemetry without exposing secrets.
7. **Composable capabilities** — agents, skills, tools, workflows, and teams must compose through stable contracts.
8. **Human agency** — high-impact actions require appropriate user authorization and the system must make consequential actions understandable.
9. **Reproducibility** — configuration, capability versions, model choices, inputs, and execution metadata should be recordable.
10. **No fake completeness** — missing functionality must be represented as missing, never disguised by empty or decorative implementations.
11. **Progressive autonomy** — autonomy increases only where safety, verification, and reliability justify it.
12. **License and provenance awareness** — external projects are references and sources of ideas; code and content must be used according to their licenses.

## 3. Capability Definitions

- **Agent:** A specialized reasoning/execution role that pursues a defined objective using permitted capabilities.
- **Skill:** A reusable procedural capability or domain workflow that can be loaded and composed.
- **Tool:** A bounded interface to an external or local operation such as filesystem, terminal, Git, browser, API, or database access.
- **Command:** A user-facing invocation that maps intent to a controlled operation or workflow.
- **Workflow:** A deterministic or adaptive composition of capabilities.
- **Team:** A coordinated group of agents with roles, communication, delegation, and completion rules.
- **Mission:** A user-level objective that may contain planning, tasks, delegation, execution, verification, and artifacts.
- **Model:** A reasoning or generation provider exposed through a normalized capability interface.
- **Artifact:** A durable output such as code, document, dataset, report, image, configuration, or structured result.
- **Plugin:** An extension that adds capabilities without modifying the core runtime.

## 4. Universal Execution Lifecycle

All executable capabilities should follow the common lifecycle where applicable:

`DISCOVER → LOAD → VALIDATE → AUTHORIZE → PREPARE → EXECUTE → OBSERVE → VALIDATE OUTPUT → RECORD → EVALUATE → RETURN`

A capability may omit a stage only when its contract explicitly defines why the stage is unnecessary.

## 5. Architecture Boundaries

SUPER is organized into five primary planes:

### Intelligence Plane
Agents, skills, commands, models, planning, routing, research, and reasoning.

### Execution Plane
Tools, workflows, missions, tasks, teams, integrations, browser/computer use, and artifacts.

### Trust Plane
Security, permissions, policy, sandboxing, audit, verification, evaluation, and human approval.

### Knowledge Plane
Context, memory, documents, retrieval, vector stores, knowledge graphs, and project intelligence.

### Evolution Plane
Feedback, experiments, benchmarks, regression evaluation, learning, optimization, and capability evolution.

## 6. Capability Lifecycle

Every capability should progress through:

`DESIGN → SPECIFY → IMPLEMENT → VALIDATE → REGISTER → RELEASE → OBSERVE → IMPROVE → DEPRECATE`

Registry metadata must distinguish lifecycle state from implementation availability.

## 7. Quality Gates

A capability is not considered production-ready until its applicable gates pass:

- schema/contract validation
- functional tests
- failure-path tests
- security checks
- permission checks
- observability checks
- documentation checks
- evaluation/benchmark checks where applicable
- provenance/license checks for external material

## 8. Autonomy Rules

SUPER should prefer the least-privileged execution path that can complete the mission. Actions involving external side effects, destructive operations, credentials, sensitive data, financial/legal consequences, or irreversible changes require policy-controlled authorization.

## 9. Evolution Rules

Learning systems may recommend improvements, generate experiments, and update candidate capabilities, but promotion into trusted production behavior must pass explicit validation and policy gates.

## 10. Repository Rules

- `packages/` contains implementation/runtime infrastructure.
- Root capability directories contain canonical catalogs or distributable definitions.
- Schemas are versioned and validated.
- Tests and evaluations are part of the product, not optional documentation.
- Generated files must be identifiable and reproducible.
- Secrets, credentials, private data, and machine-local state must never be committed.

## 11. Definition of Done

A feature is complete only when it is implemented, integrated, testable, observable, documented, and protected by appropriate security and quality gates.
