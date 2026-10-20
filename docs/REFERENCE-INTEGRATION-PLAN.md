# Reference integration plan

This plan extends the existing [reference inventory](REFERENCE-PROJECTS.md).
References are candidates, not installed capabilities. The master historical prompt
explicitly asks for original implementation and licensed reuse, not blind copying.

## Sources inspected on 2026-10-06

README review only; no upstream source-code or license-compliance audit is claimed.

| Source | Observed feature | Proposed SUPER boundary |
| --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | Plugin-oriented architecture; developer preview | Versioned harness adapter; isolate upstream breaking changes from SUPER contracts. |
| [LangChain](https://github.com/langchain-ai/langchain) | Model/tool interfaces; links to LangGraph and Deep Agents | Optional provider/retrieval adapters; preserve SUPER's orchestration authority. |
| [Codex](https://github.com/openai/codex) | Local coding-agent CLI | Engineering harness process adapter after protocol inspection and contract tests. |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Terminal agent, tools, MCP and checkpointing | A second harness for interoperability and resume tests. |
| [ComfyUI](https://github.com/Comfy-Org/ComfyUI) | Reusable node workflows and API integration | External media worker adapter with GPU budget and artifact validation. |
| [autoresearch](https://github.com/karpathy/autoresearch) | Bounded experiments, evaluation and keep/discard loop | Isolated experiment runner with fixed budget, held-out evaluation and explicit promotion. |

These are architectural choices for SUPER, not claims that upstream software already
meets SUPER's contracts. Do not adopt upstream instructions that bypass SUPER permissions.

## Remaining supplied references: discovery backlog

The full list remains in REFERENCE-PROJECTS.md. The following grouping describes
intended evaluation, not a claim that every repository has been reviewed.

| Capability family | Candidate references | Admission evidence required |
| --- | --- | --- |
| Agent orchestration and coding | ponytail, odysseus, paperclip, code-buddy, dominations, Agent-Team-Plugins | Protocol, lifecycle, permissions, cancellation and trace interoperability. |
| Knowledge and efficiency | graphify, rtk, caveman, Scrapling | Provenance, reproducible retrieval/output compression, access rules, accuracy and latency evaluation. |
| Skills and registries | agent-skills, antigravity-skills, tons-of-skills-marketplace, awesome-agent-skills, claude-skill-registry, claude-skills, API-skills topic | Versioned manifest, license, exact source revision, required capabilities, executable validation and deduplication. |
| UI/design | ui-ux-pro-max-skill, awesome-design-md, open-design, MengTo/skills, claudedesignskills | Design-task evaluations, accessible output and framework compatibility. |
| 3D/CAD | cad-agent, three-agent-skills, blender-skills | Isolated application adapter, bounded resources and artifact validation. |
| Finance/science/data | finance-skills, scientific-agent-skills, claude-equity-research, claude-data-analysis, csv-data-summarizer | Dataset provenance, reproducibility, domain-specific correctness and uncertainty checks. |
| Documents/content/media | claude-office-skills, anthropics/skills, content-creator, content-research-writer, claude-blog, media-skills, contentlead | Exact skill license, dependency audit, file-format validation and rendered artifact tests. |
| AI/ML and local models | LLMs-from-scratch, claude-cookbooks, Claude-Ollama-Skill, generative-ai topic, MLOps article | Reproducible examples, model compatibility, offline tests and evaluation datasets. |
| DevOps and security | devops-skills, azure-devops-skills, hackingtool | Explicit scoped capabilities, sandboxing, authorized test environments and failure tests. |

GitHub topics and articles are discovery resources, not packages. Deduplicate repeated
URLs before review. Pin each accepted source by revision and record its license and
attribution; no upstream implementation was imported in this change.

## Contracts to implement after baseline recovery

A harness adapter should expose prepare, execute, cancel, inspect and resume with
versioned task/result envelopes. It must report execution and correlation IDs,
provider/model identity where applicable, token/cost/time budgets, artifacts and
normalized errors. Workers execute; the control plane owns admission and lifecycle.

A skill package should declare provenance, revision, dependencies, capabilities,
input/output schemas and evaluations. Installation must not implicitly authorize
execution. Prefer a small number of working skills over a large untested catalog.

Learning should begin with recorded feedback and replayable evaluations. A later
reinforcement-learning system needs an explicit environment, action space, reward,
trajectory dataset, trainer, held-out evaluation and rollback. Existing evolution
heuristics do not establish that reinforcement learning is implemented. Promotion
must depend on correctness, security and cost evidence, with human review where required.
