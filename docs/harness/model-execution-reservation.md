# Model execution ID reservation

The model kernel reserves an execution ID before routing, policy checks, or provider dispatch. A second request using that ID receives `MODEL_EXECUTION_ID_CONFLICT` while the first is pending.

Timeout cancels the attempt signal and returns a failed execution. A provider that ignores cancellation may still run; the kernel keeps its ID reserved until the provider settles and does not start a retry alongside that outstanding attempt. This prevents a late result or a bounded execution-history eviction from admitting overlapping work under the same ID. It does not forcibly stop a provider or undo external side effects.
