# SUPER Repo — Repository Map

This document defines the intended root tree. Directories are created with their purpose documented here; implementation lands incrementally behind schemas, tests, security, and evaluation gates.

```text
The-SUPER-repo/
├── .github/                         # GitHub automation, templates, governance
│   ├── ISSUE_TEMPLATE/
│   ├── PULL_REQUEST_TEMPLATE/
│   └── workflows/
├── apps/                            # User-facing applications
│   ├── cli/
│   ├── control-plane/
│   └── studio/
├── packages/                        # Reusable runtime libraries
│   ├── core/
│   ├── runtime/
│   ├── agents/
│   ├── skills/
│   ├── commands/
│   ├── tools/
│   ├── workflows/
│   ├── teams/
│   ├── models/
│   ├── context/
│   ├── memory/
│   ├── knowledge/
│   ├── learning/
│   ├── evaluation/
│   ├── security/
│   ├── observability/
│   ├── plugins/
│   ├── integrations/
│   ├── artifacts/
│   └── schemas/
├── agents/                          # Canonical agent definitions
├── skills/                          # Canonical skill definitions
├── commands/                        # Canonical user command definitions
├── workflows/                       # Declarative mission/workflow definitions
├── teams/                           # Reusable multi-agent team definitions
├── tools/                           # Tool contracts and implementations
├── mcp/                             # MCP servers, manifests, policies, examples
├── hooks/                           # Lifecycle/event hooks
├── rules/                           # Engineering and domain guidance
├── policies/                        # Security, permissions, governance policies
├── domains/                         # Domain-specific agents, skills, tools, workflows
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
├── memory/                          # Persistent memory stores and services
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
├── knowledge/                       # Knowledge, graph, vector, indexing and retrieval
│   ├── graph/
│   ├── vector/
│   ├── documents/
│   ├── retrieval/
│   └── indexing/
├── learning/                        # Continuous improvement and evolution
│   ├── feedback/
│   ├── instincts/
│   ├── evolution/
│   ├── experiments/
│   └── pruning/
├── models/                          # Provider adapters and model routing
│   ├── providers/
│   ├── routing/
│   ├── fallback/
│   ├── benchmarks/
│   ├── capabilities/
│   └── cost/
├── integrations/                    # External services
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
├── ui/                              # Shared UI/control-plane assets and components
├── evaluation/                      # Evaluation harnesses and reports
├── benchmarks/                      # Reproducible benchmark suites
├── security/                        # Security scanners, controls, audit utilities
├── experiments/                     # Research and autoresearch experiments
├── datasets/                        # Evaluation/training/reference datasets
├── templates/                       # Agent, skill, tool, workflow, plugin templates
├── generators/                      # Factories and code/content generators
├── examples/                        # End-to-end examples
├── tests/                           # Cross-package and system-level tests
├── scripts/                         # Development, release, validation, migration scripts
├── docs/                            # Architecture and contributor documentation
├── config/                          # Example/default configuration
└── vendor/                          # Carefully audited third-party assets only
```

## Canonical vs implementation surfaces

- `agents/`, `skills/`, `commands/`, `workflows/`, `teams/`, `tools/` are the human-discoverable capability catalog.
- `packages/` contains executable reusable implementation libraries.
- `apps/` contains end-user applications.
- `domains/` organizes specialized capability bundles.
- `vendor/` is restricted to audited third-party material that can legally be distributed.

## Empty-directory policy

Git does not track empty directories. Each directory will receive a small `README.md`/`README` or a real implementation file when activated so the tree remains explicit without fake runtime code.
