# SUPER System Design

## System Flow

```text
User Intent
    ↓
Intent Normalization
    ↓
Mission Creation
    ↓
Planning
    ↓
Capability Discovery
    ↓
Agent / Skill / Tool / Model Selection
    ↓
Policy + Authorization
    ↓
Execution Runtime
    ↓
Observation + Events
    ↓
Verification
    ↓
Artifacts + Report
    ↓
Memory / Knowledge / Learning
```

## Core Runtime Components

- `AgentRuntime` — loads and executes agent contracts.
- `SkillRuntime` — loads reusable procedures.
- `ToolRuntime` — executes bounded tools with permissions and timeouts.
- `CommandRuntime` — maps user commands to controlled operations.
- `WorkflowRuntime` — executes capability graphs.
- `MissionRuntime` — manages long-running user objectives.
- `ModelRuntime` — normalizes model providers and routing.
- `ContextRuntime` — builds task-specific context.
- `MemoryRuntime` — manages durable and session memory.
- `KnowledgeRuntime` — retrieval and knowledge graph operations.
- `EvaluationRuntime` — quality and regression evaluation.
- `SecurityRuntime` — policy, authorization, isolation, and audit.

## Event Model

Runtime components communicate through typed events. Events should support correlation IDs, timestamps, actor/capability IDs, mission/task IDs, severity, structured payloads, and redacted execution metadata.

## Failure Model

Failures are typed and observable. The system should distinguish validation failure, authorization denial, unavailable capability, tool failure, provider failure, timeout, malformed output, verification failure, and policy violation. Recovery strategies must be explicit rather than silently retrying unsafe operations.

## Provider Boundary

Model providers, external APIs, and harness-specific behavior belong behind adapters. The core runtime should operate against normalized interfaces.

## First Vertical Slice

The first end-to-end implementation will be repository analysis:

`mission → planner → repository analyst → repository/code tools → structured findings → verification → report`

This slice becomes the reference implementation for the rest of the platform.
