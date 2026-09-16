# Software Engineering Domain

The first SUPER domain pack. It is intentionally small and executable: the pack describes capabilities that can be registered into the core catalog rather than creating an inventory of empty folders.

## Capabilities

- `software.repository-analysis` — inspect a repository and produce structured findings.
- `software.code-review` — inspect changed source and produce actionable review findings.
- `software.architecture-analysis` — identify structural and dependency-level concerns.
- `software.testing-analysis` — inspect test coverage, test structure, and missing validation paths.

The domain is designed to plug into the existing Agent, Workflow, Verification, Audit, Memory, and Team runtime layers.

## Expansion rule

New agents, skills, commands, tools, workflows, and teams should only be added when they have an executable implementation, tests, and a clear registry identity. Empty taxonomy directories are deliberately avoided.
