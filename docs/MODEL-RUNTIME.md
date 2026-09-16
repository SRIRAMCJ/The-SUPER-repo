# SUPER Model Runtime

The model layer is provider-agnostic. Runtime orchestration depends on a small provider contract rather than a vendor SDK.

## Provider contract

A provider exposes an `id` and an async `generate(request)` operation. `ModelRuntime` validates the request, resolves the provider, executes it, and returns provider/model/mode/latency metadata.

## Routing

`ModelRouter` performs deterministic capability routing. A route can constrain capability, mode, context-window size, preferred provider, and cost sensitivity. Ties are resolved by stable model id ordering.

The router does not call an LLM. A model-backed planner can implement the same routing boundary later without changing execution semantics.

## Reflection

`ReflectionEngine` runs independent critics after execution. Critics return `accepted`, `warning`, or `rejected`, and the engine aggregates them into a structured reflection result.

Reflection stays separate from generation and deterministic verification, allowing quality controls to remain available when no external model is configured.
