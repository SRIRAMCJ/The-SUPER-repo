export const softwareCapabilities = [
  {
    id: "software.repository-analysis",
    version: "1.0.0",
    domain: "software",
    kind: "workflow",
    name: "Repository Analysis",
    description: "Analyze repository structure, dependencies, git state, documentation, tests, security, and architecture.",
    requires: ["filesystem", "terminal", "git"]
  },
  {
    id: "software.code-review",
    version: "1.0.0",
    domain: "software",
    kind: "skill",
    name: "Code Review",
    description: "Produce structured, actionable findings from source changes.",
    requires: ["software.repository-analysis"]
  },
  {
    id: "software.architecture-analysis",
    version: "1.0.0",
    domain: "software",
    kind: "skill",
    name: "Architecture Analysis",
    description: "Analyze software structure, dependencies, boundaries, and architectural risks.",
    requires: ["software.repository-analysis"]
  },
  {
    id: "software.testing-analysis",
    version: "1.0.0",
    domain: "software",
    kind: "skill",
    name: "Testing Analysis",
    description: "Analyze test structure and identify missing or weak validation paths.",
    requires: ["software.repository-analysis"]
  }
];
