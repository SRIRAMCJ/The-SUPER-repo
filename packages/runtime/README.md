# Runtime Control Plane

`RuntimeControlPlane` is the operational read/control boundary for SUPER runtime state. It composes the existing `ObservabilityEngine`, `ExecutionStateStore`, and `EvolutionControlPlane` rather than introducing parallel telemetry or persistence systems.

## Operational view

```text
EventBus
   │
   ▼
ObservabilityEngine
   │
   ├── health
   ├── execution history
   ├── metrics
   ├── traces
   └── events
          │
          ▼
RuntimeControlPlane
   │
   ├── unified snapshot
   └── evolution view
```

The control plane is intentionally provider-agnostic. It can later back a CLI, HTTP API, TUI, web console, or remote control service without moving runtime ownership into the presentation layer.

### Design constraints

- No second event bus.
- No second persistence store.
- No duplicated observability counters.
- Health is deterministic and derived from observed runtime facts.
- Evolution state is read through the existing state/control boundaries.
- Control actions remain explicit; unsupported actions return structured results rather than being simulated.
