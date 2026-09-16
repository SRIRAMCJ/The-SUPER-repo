import { createExecutionId } from './events.js';

export class ExecutionEngine {
  constructor({ registry, events = null, verifier = null, policy = null, clock = () => new Date() }) {
    if (!registry) throw new TypeError('ExecutionEngine requires a capability registry');
    this.registry = registry;
    this.events = events;
    this.verifier = verifier;
    this.policy = policy;
    this.clock = clock;
  }

  async execute(capabilityId, input = {}, context = {}) {
    const entry = this.registry.require(capabilityId);
    const { manifest, handler } = entry;
    const executionId = createExecutionId();
    const startedAt = this.clock().toISOString();

    if (this.policy) {
      const decision = this.policy.authorize(manifest, context);
      if (!decision.allowed) {
        const error = { code:'POLICY_DENIED', message:decision.reason, retryable:false };
        this.#emit({ type:'execution.denied', executionId, capabilityId, status:'denied', error });
        this.#emit({ type:'execution.failed', executionId, capabilityId, status:'failed', error });
        return { executionId, capabilityId, status:'failed', startedAt, finishedAt:this.clock().toISOString(), error };
      }
    }

    this.#emit({ type:'execution.started', executionId, capabilityId, status:'started', data:{ input, context } });
    try {
      const controller = new AbortController();
      const timeoutMs = Number.isFinite(manifest.timeoutSeconds) ? manifest.timeoutSeconds * 1000 : null;
      const handlerPromise = Promise.resolve().then(() => handler(input, {
        executionId,
        capability: manifest,
        context,
        signal: controller.signal,
        emit: (data) => this.#emit({ type:'execution.progress', executionId, capabilityId, status:'progress', data })
      }));
      const output = timeoutMs ? await withTimeout(handlerPromise, timeoutMs, controller, manifest.id) : await handlerPromise;
      const verification = this.verifier
        ? await this.verifier.verify({ capability: manifest, input, output, context })
        : { verified: true, checks: 0, failures: [] };
      this.#emit({ type:'execution.verified', executionId, capabilityId, status: verification.verified ? 'verified' : 'rejected', data: verification });
      if (!verification.verified) {
        const error = { code:'VERIFICATION_FAILED', message:'Execution output failed verification', retryable:false, details:verification.failures };
        this.#emit({ type:'execution.failed', executionId, capabilityId, status:'failed', error });
        return { executionId, capabilityId, status:'failed', startedAt, finishedAt:this.clock().toISOString(), error, verification };
      }
      this.#emit({ type:'execution.completed', executionId, capabilityId, status:'completed', data:{ output } });
      return { executionId, capabilityId, status:'succeeded', startedAt, finishedAt:this.clock().toISOString(), output, verification };
    } catch (error) {
      const normalized = normalizeError(error);
      this.#emit({ type:'execution.failed', executionId, capabilityId, status:'failed', error:normalized });
      return { executionId, capabilityId, status:'failed', startedAt, finishedAt:this.clock().toISOString(), error:normalized };
    }
  }

  #emit(event) { return this.events?.emit(event); }
}

async function withTimeout(promise, timeoutMs, controller, capabilityId) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error(`Execution timed out after ${timeoutMs}ms: ${capabilityId}`), { code:'EXECUTION_TIMEOUT', retryable:true }));
    }, timeoutMs);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

function normalizeError(error) {
  return { code:error?.code ?? 'EXECUTION_ERROR', message:error instanceof Error ? error.message : String(error), retryable:Boolean(error?.retryable) };
}
