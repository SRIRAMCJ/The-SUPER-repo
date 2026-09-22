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