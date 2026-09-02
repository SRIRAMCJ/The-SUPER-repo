# Root Tree

The repository is intentionally organized into five planes plus domain and delivery surfaces.

```text
The-SUPER-repo/
├── .github/                         # CI/CD, issues, PRs, release automation
│   ├── ISSUE_TEMPLATE/
│   ├── PULL_REQUEST_TEMPLATE/
│   └── workflows/
│
├── apps/                            # Product applications
│   ├── cli/                         # Terminal interface
│   ├── control-plane/               # Operational dashboard
│   └── studio/                      # Visual agent/workflow/skill studio
│
├── packages/                        # Executable platform libraries
│   ├── core/                        # IDs, events, errors, result contracts
│   ├── runtime/                     # Execution kernel and lifecycle
│   ├── agents/                      # Agent registry/loader/execution
│   ├── skills/                      # Skill registry/loader/composition
│   ├── commands/                    # Command registry/router
│   ├── tools/                       # Universal tool fabric
│   ├── workflows/                   # Workflow engine and scheduler
│   ├── teams/                       # Multi-agent coordination
│   ├── models/                      # Provider abstraction and routing
│   ├── context/                     # Context selection/compression/budgets
│   ├── memory/                      # Memory interfaces and stores
│   ├── knowledge/                   # Graph/vector/document intelligence
│   ├── learning/                    # Feedback/evolution engine
│   ├── evaluation/                  # Evaluation runtime
│   ├── security/                    # Policy/sandbox/audit/security runtime
│   ├── observability/               # Logs/traces/metrics/events
│   ├── plugins/                     # Plugin lifecycle and discovery
│   ├── integrations/                # External service adapters
│   ├── artifacts/                   # Versioned artifact management
│   └── schemas/                     # Shared machine-readable contracts
│
├── agents/                          # Canonical specialist catalog (250+ target)
├── skills/                          # Canonical reusable expertise catalog (500–1500+ target)
├── commands/                        # Canonical user-facing commands (150–300+ target)
├── workflows/                       # Mission/workflow definitions
├── teams/                           # Reusable agent-team definitions
├── tools/                           # Tool definitions, adapters and policies
├── mcp/                             # MCP manifests, servers, examples and policy
├── hooks/                           # Lifecycle and event hooks
├── rules/                           # Baseline and domain guidance
├── policies/                        # Security, authorization, governance and safety
│
├── domains/                         # Domain capability packs
│   ├── software/
│   ├── web/
│   ├── mobile/
│   ├── ai/
│   ├── ml/
│   ├── data/
│   ├── finance/
│   ├── science/
│   ├── healthcare/
│   ├── cybersecurity/
│   ├── robotics/
│   ├── electronics/
│   ├── electrical/
│   ├── cad/
│   ├── blender/
│   ├── 3d/
│   ├── media/
│   ├── content/
│   ├── marketing/
│   ├── seo/
│   ├── geo/
│   ├── business/
│   └── education/
│
├── memory/                          # Persistent stores
│   ├── working/
│   ├── session/
│   ├── episodic/
│   ├── semantic/
│   ├── procedural/
│   ├── project/
│   ├── team/
│   ├── retrieval/
│   ├── compression/
│   └── pruning/
│
├── knowledge/                       # Knowledge layer
│   ├── graph/
│   ├── vector/
│   ├── documents/
│   ├── retrieval/
│   └── indexing/
│
├── learning/                        # Continuous improvement
│   ├── feedback/
│   ├── instincts/
│   ├── evolution/
│   ├── experiments/
│   └── pruning/
│
├── models/                          # Model catalog and routing policy
│   ├── providers/
│   ├── routing/
│   ├── fallback/
│   ├── benchmarks/
│   ├── capabilities/
│   └── cost/
│
├── integrations/                    # Service connectors
│   ├── github/
│   ├── gitlab/
│   ├── jira/
│   ├── linear/
│   ├── slack/
│   ├── notion/
│   ├── google/
│   ├── microsoft/
│   ├── cloud/
│   └── custom/
│
├── ui/                              # Shared UI assets/components
├── evaluation/                      # Evaluation suites and harnesses
├── benchmarks/                      # Benchmark datasets and runners
├── security/                        # Security scanners, controls and audit tooling
├── experiments/                     # Research/autoresearch workspace
├── datasets/                        # Public/local datasets used by tests and evaluation
├── templates/                       # Scaffolds for all extensible capabilities
├── generators/                      # Factories for agents, skills, tools, commands, etc.
├── examples/                        # Runnable end-to-end examples
├── tests/                           # Repository-level tests
├── scripts/                         # Setup, build, validation, migration, release scripts
├── docs/                            # Human-facing documentation
├── config/                          # Default/example configuration
└── vendor/                          # Audited third-party assets permitted by license
```
