# Fault Injection and Recovery

This runtime primitive provides deterministic failure injection and explicit recovery attempts.

## Fault injection
Scenarios can target a phase (before, during, after), match execution context, use a bounded trigger count, and use deterministic probability through an injected random source.

## Recovery
Recovery is single-flight per logical key, bounded by an attempt count, and records attempt/final outcomes. Callers own the actual recovery operation.

## Safety
Fault injection is an explicit test/chaos primitive and must be enabled deliberately. It is not part of the normal production execution path unless configured.

## Scope
This does not claim automatic recovery of arbitrary external side effects. Durable state, idempotent effects, fencing, and downstream transaction semantics remain required.

## Execution semantics
Registered faults are executable through `withFaultInjection`: the `before` and `after` phases are evaluated automatically, while `during` faults are evaluated at explicit `checkpoint('during')` calls supplied to the operation. Faults may use the built-in `throw` behavior, an Error instance, or a synchronous/asynchronous fault function.\n\nFault triggering remains bounded by scenario limits and is deterministic when callers inject a random source into `FaultInjectionEngine.evaluate`. Context fingerprints use recursive canonical key ordering so equivalent nested objects hash consistently.\n