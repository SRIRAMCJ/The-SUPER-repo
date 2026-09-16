# SUPER Capability Schemas

This directory defines the versioned, language-neutral contracts used by SUPER capabilities.

## Design rules

- JSON Schema Draft 2020-12.
- Every capability has a stable `$id` and explicit `schemaVersion`.
- Runtime behavior must be validated against these contracts; schemas are not documentation-only.
- `additionalProperties: false` is used at stable contract boundaries to prevent silent drift.
- Extensibility belongs in explicitly defined metadata/extension fields rather than arbitrary top-level keys.
- Security-sensitive declarations are explicit: permissions, risk, provenance, and lifecycle metadata.
- Inputs and outputs are represented as contracts so capabilities can be composed without provider-specific assumptions.

## Initial contract set

- `capability.schema.json` — common capability metadata.
- `agent.schema.json`
- `skill.schema.json`
- `tool.schema.json`
- `command.schema.json`
- `workflow.schema.json`
- `team.schema.json`
- `mission.schema.json`
- `model.schema.json`
- `memory.schema.json`
- `artifact.schema.json`
- `plugin.schema.json`
- `policy.schema.json`
- `evaluation.schema.json`
- `benchmark.schema.json`
- `event.schema.json`
- `execution.schema.json`

The first implementation should remain provider-agnostic and domain-neutral. Provider adapters and domain-specific schemas can extend these contracts later without changing the core protocol.
