import { createExecutionId } from './events.js';

export class ExecutionEngine {
  constructor({ registry, events = null, clock = () => new Date() }) {
    if (!registry) throw new TypeError('ExecutionEngine requires a capability registry');
    this.registry = registry;
    this.events = events;
    this.clock = clock;
  }

  async execute(capabilityId, input = {}, context = {}) {
    const entry = this.registry.require(capabilityId);
    const { manifest, handler } = entry;
    const executionId = createExecutionId();
    const startedAt = this.clock().toISOString();
    this.#emit({ type:'execution.started', executionId, capabilityId, status:'started', data:{ input, context } });
    try {
      const output = await handler(input, { executionId, capability: manifest, context, emit: (data) => this.#emit({ type:'execution.progress', executionId, capabilityId, status:'progress', data }) });
      this.#emit({ type:'execution.completed', executionId, capabilityId, status:'completed', data:{ output } });
      return { executionId, capabilityId, status:'succeeded', startedAt, finishedAt:this.clock().toISOString(), output };
    } catch (error) {
      const normalized = normalizeError(error);
      this.#emit({ type:'execution.failed', executionId, capabilityId, status:'failed', error:normalized });
      return { executionId, capabilityId, status:'failed', startedAt, finishedAt:this.clock().toISOString(), error:normalized };
    }
  }

  #emit(event) { return this.events?.emit(event); }
}

function normalizeError(error) {
  return { code:error?.code ?? 'EXECUTION_ERROR', message:error instanceof Error ? error.message : String(error), retryable:Boolean(error?.retryable) };
}
