# SUPER Repo Architecture

## North star

SUPER Repo is an executable, modular AI operating environment. Agents, skills, commands, tools, workflows, teams, models, memory, knowledge, evaluation, security, and learning are first-class components connected through stable contracts.

## Planes

### Intelligence plane
Agents, skills, models, reasoning, context, memory, knowledge.

### Execution plane
Tools, MCP, browser, terminal, filesystem, Git/GitHub, integrations, artifacts.

### Orchestration plane
Missions, tasks, teams, workflows, scheduling, delegation, handoffs, checkpoints, recovery.

### Trust plane
Authentication, authorization, permissions, sandboxing, policies, verification, evaluation, audit.

### Evolution plane
Feedback, experiments, benchmarks, learning, skill generation, agent generation, optimization.

## Reference flow

```text
Human
  ↓
Mission Engine
  ↓
Intent Engine
  ↓
Planning Engine
  ↓
Orchestrator
  ↓
Agent / Skill / Tool / Model selection
  ↓
Execution Runtime
  ↓
Observation + Artifacts
  ↓
Verification
  ↓
Security Gate
  ↓
Quality Gate
  ↓
Delivery
  ↓
Memory + Knowledge
  ↓
Evaluation + Learning
  ↓
Evolution
```

## Design constraints

- Core interfaces must remain provider-agnostic.
- High-risk operations default to denial until authorized.
- Every important execution is observable and resumable where possible.
- Catalog objects are backed by machine-readable contracts.
- Capability counts must reflect working, documented capabilities.
- Experimental features must be clearly labeled and isolated from stable defaults.
