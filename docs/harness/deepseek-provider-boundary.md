# Provider boundary review

Reference: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), public architecture documentation, reviewed 2026-10-12. Its capability seams distinguish a service definition, a provider, and a consumer. SUPER already has a model provider registry and two model consumers, so this build strengthens that boundary instead of importing another plugin host.

Provider registration captures metadata and the `generate` handler. Registry reads return isolated metadata snapshots; changing a caller's object or a returned view cannot change which provider the runtime dispatches. ModelRuntime owns provenance fields (`provider`, `model`, `mode`, and `latencyMs`) even if provider output contains fields with those names. It rejects non-object responses.

This is not dynamic plugin loading, process isolation, or a guarantee against arbitrary code inside a registered provider. A trusted host must still control which provider functions are registered. Future provider types can be added only with a concrete consumer, authorization boundary, and tests.
