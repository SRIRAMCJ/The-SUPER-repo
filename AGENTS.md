# SUPER Repo — Agent Instructions

## Purpose

This repository is the foundation for an extensible AI operating environment. Keep the architecture coherent while the executable runtime, agents, skills, commands, workflows, tools, memory, knowledge, evaluation, security, and domain systems are built incrementally.

## Core rules

1. Prefer real executable capability over catalog size.
2. Treat `packages/` as the implementation layer and root capability directories as canonical catalogs.
3. Keep agent, skill, command, tool, workflow, team, model, memory, and policy contracts versioned and schema-validated.
4. Do not introduce provider-specific assumptions into shared core interfaces.
5. Security and permissions are part of execution, not post-processing.
6. Important behavior requires tests and evaluation evidence.
7. Never add placeholder implementations merely to increase counts.
8. Preserve project and user data; do not overwrite human-authored instructions without explicit policy.
9. Record provenance for external data and reusable knowledge.
10. Keep changes focused and reviewable.

## Five planes

- Intelligence: agents, skills, models, context, memory, knowledge.
- Execution: tools, MCP, browser, terminal, filesystem, integrations, artifacts.
- Orchestration: missions, tasks, teams, workflows, scheduling, delegation, recovery.
- Trust: policy, permissions, sandboxing, security, audit, verification, evaluation.
- Evolution: feedback, experiments, benchmarks, learning, skill/agent evolution.

## Capability lifecycle

DISCOVER → LOAD → VALIDATE → AUTHORIZE → PREPARE → EXECUTE → OBSERVE → VALIDATE OUTPUT → RECORD → EVALUATE → RETURN.

## Before adding a new capability

Check existing agents, skills, tools, workflows, and packages for overlap. Extend an existing abstraction when practical. Add new abstractions only when the capability boundary is genuinely different.

## Quality gates

Before merge, run the smallest relevant tests plus repository-wide validation when the change affects shared runtime contracts. Security-sensitive changes require security review and regression coverage.
