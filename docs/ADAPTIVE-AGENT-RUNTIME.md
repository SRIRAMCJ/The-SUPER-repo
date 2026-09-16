# SUPER Adaptive Agent Runtime

`AdaptiveAgentRuntime` is the integration boundary between deterministic agent planning, model routing, model generation, execution, and reflection.

## Execution contract

```text
Request
  -> Agent Planner
  -> Model Router (optional)
  -> Model Runtime (optional)
  -> Agent Runtime
  -> Verification / existing mission pipeline
  -> Reflection
  -> Structured Result
```

The model layer is optional. If no model router/runtime is supplied, the same agent runtime can execute deterministically.

## Model context

When generation is enabled, the model result is injected into the agent execution context under `context.model`. This keeps provider-specific response handling outside the agent contract.

## Quality boundary

Reflection is evaluated after agent execution. A rejected reflection changes the adaptive result to `failed`, while preserving the original execution result and reflection details for auditability.

## Design constraints

- No provider SDK is hard-coded into the runtime.
- Model routing remains deterministic and inspectable.
- Model execution is optional rather than mandatory.
- Reflection does not replace deterministic verification.
- Failures are returned as structured results.
- The adaptive layer composes existing runtime primitives rather than duplicating them.
