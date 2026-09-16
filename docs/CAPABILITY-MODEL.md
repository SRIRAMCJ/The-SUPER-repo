# SUPER Capability Model

SUPER treats every executable feature as a typed, discoverable capability.

## Capability Graph

```text
Mission
  └── Workflow / Tasks
        ├── Agents
        │     └── Skills
        ├── Tools
        ├── Models
        ├── Knowledge / Memory
        └── Policies
```

## Common Metadata

Capabilities should expose, as applicable:

- stable identifier and human-readable name
- semantic version
- capability type
- description and intended use
- inputs and outputs
- dependencies
- required tools
- model requirements/capabilities
- permissions
- risk level
- supported environments
- lifecycle state
- owner/provenance
- tests/evaluations

## Discovery

Registries index capabilities by type, tags, domain, compatibility, permissions, cost, quality, and availability. Discovery must be deterministic enough to explain why a capability was selected.

## Selection

Routers may consider intent, required capability, constraints, model/tool compatibility, security policy, cost, latency, historical evaluation, and user preferences. Selection must remain observable and auditable.

## Composition

Capabilities communicate through typed contracts rather than ad-hoc prompt conventions. Composition should support sequential, parallel, conditional, iterative, and human-gated execution.

## Trust Metadata

A capability must declare the permissions it requests and the side effects it can cause. Runtime policy may reduce or deny those permissions.

## Compatibility

Capability schemas must support explicit versioning and migration. Breaking changes require a new major contract or an explicit migration path.
