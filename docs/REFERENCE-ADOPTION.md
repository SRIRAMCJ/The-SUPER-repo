# Reference adoption program

`reference-adoption.json` inventories the 27 projects requested for SUPER. `super references [--phase=1..8] [--json]` queries it. A `reference` entry is a design and evaluation candidate, not an installed dependency, agent, skill, or integration. Existing references to Codex and Graphify are deduplicated in this catalog. No upstream repository is cloned or copied.

## Delivery order and proof

| Phase | Work | Required evidence |
| --- | --- | --- |
| 3 | Phoenix and Langfuse trace interoperability | Redacted export, trace correlation, bounded overhead |
| 5 | Agents SDK, LangGraph, Microsoft Agent Framework, Ruflo; defensive prompt-injection corpus | Versioned harness contracts, deterministic replay, resume and adversarial tests |
| 6 | Coding, browser, MCP, web reach, skills, link and security adapters | Scoped credentials, sandboxing, provenance, cancellation, language coverage, real tasks |
| 7 | Research and Graphify-inspired knowledge | Source attribution, retrieval precision, privacy, benchmarked answer quality |
| 8 | DeepEval, design, tutoring, creation, SEO and market domains | Domain evaluations, artifact verification, safety and accessibility checks |

For each candidate: inspect its current license and revision, define an original SUPER contract, implement one narrow vertical task, add denial and failure tests, compare quality and cost against a baseline, then promote only if measured. Python-based projects can inform adapters without converting SUPER's JavaScript runtime into a Python dependency. If a language-specific executable adds real value, run it as a separately governed worker. Never execute remote installer scripts or imported prompts as trusted policy.

The jailbreak collection is scoped to **defensive tests of instruction-boundary behavior**. Its contents must not become a default system prompt or a behavior-override feature. Link extraction must respect source access and provenance. Trading starts with research/backtesting and paper execution; any live effect requires explicit broker authorization and a fenced commit boundary.

These entries are backlog, not a claim to outperform their sources. A claim of improvement requires reproducible comparisons on matched tasks and disclosed hardware, model, latency, cost, and correctness metrics.
