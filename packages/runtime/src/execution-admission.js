const SCHEMA_VERSION = '0.2.0';

export class RuntimeExecutionAdmission {
  constructor({ shutdown, resources = null, policy = null, clock = () => new Date(), idFactory = defaultId, maxHistory = 256 } = {}) {
    if (!shutdown || typeof shutdown.admit !== 'function' || typeof shutdown.release !== 'function' || typeof shutdown.isAdmitted !== 'function') throw new TypeError('shutdown must expose admit(), release(), and isAdmitted()');
    if (resources && (typeof resources.admit !== 'function' || typeof resources.release !== 'function')) throw new TypeError('resources must expose admit() and release()');
    if (policy && typeof policy.evaluate !== 'function') throw new TypeError('policy must expose evaluate()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    this.shutdown = shutdown; this.resources = resources; this.policy = policy; this.clock = clock; this.idFactory = idFactory; this.maxHistory = maxHistory; this.#history = [];
  }
  #history;

  async admit({ executionId = this.idFactory('execution'), resources = {}, metadata = {}, context = {}, signal } = {}) {
    validateExecutionId(executionId);
    if (signal?.aborted) throw admissionError('EXECUTION_CANCELLED', 'Execution was cancelled before admission', true);
    const operation = { id: context.operationId ?? metadata.operationId ?? 'runtime.execute', classification: context.classification ?? metadata.classification ?? 'control', permissions: context.permissions ?? metadata.permissions ?? [] };
    let decision = null;
    if (this.policy) {
      decision = await this.policy.evaluate(operation, { ...sanitize(context), ...sanitize(metadata), correlationId: context.correlationId ?? metadata.correlationId ?? this.idFactory('correlation') });
      if (!decision.allowed) {
        this.#record({ executionId, action: 'admit', status: 'denied', reason: 'policy_denied', decisionId: decision.decisionId });
        const error = admissionError('POLICY_ADMISSION_DENIED', 'Execution admission denied by runtime policy', false);
        error.decisionId = decision.decisionId; error.policy = clone(decision); throw error;
      }
    }
    const admission = this.shutdown.admit({ executionId, metadata: sanitize(metadata) });
    try {
      if (signal?.aborted) throw admissionError('EXECUTION_CANCELLED', 'Execution was cancelled during admission', true);
      const resource = this.resources ? this.resources.admit({ executionId, request: resources }) : null;
      if (resource && !resource.allowed) {
        this.shutdown.release(executionId, { reason: 'resource_denied' });
        const error = admissionError('RESOURCE_ADMISSION_DENIED', `Resource admission denied for ${executionId}`, true);
        error.resource = clone(resource); error.decisionId = decision?.decisionId;
        this.#record({ executionId, action: 'admit', status: 'denied', reason: 'resource_denied', decisionId: decision?.decisionId });
        throw error;
      }
      const result = freeze({ schemaVersion: SCHEMA_VERSION, type: 'execution-admission', executionId, admittedAt: this.clock().toISOString(), shutdown: admission, resources: resource, policy: decision, metadata: sanitize(metadata) });
      this.#record({ executionId, action: 'admit', status: 'allowed', decisionId: decision?.decisionId });
      return result;
    } catch (error) {
      if (this.shutdown.isAdmitted(executionId)) this.shutdown.release(executionId, { reason: 'admission_rollback' });
      throw error;
    }
  }

  release(executionId, { resources = {}, reason = 'completed' } = {}) {
    validateExecutionId(executionId);
    const resource = this.resources ? this.resources.release(executionId, resources) : null;
    const released = this.shutdown.release(executionId, { reason });
    this.#record({ executionId, action: 'release', status: released ? 'released' : 'not_admitted', reason: sanitizeReason(reason) });
    return freeze({ schemaVersion: SCHEMA_VERSION, type: 'execution-release', executionId, released, resources: resource });
  }

  async execute({ executionId, resources = {}, metadata = {}, context = {}, signal, handler } = {}) {
    validateExecutionId(executionId); if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    const admission = await this.admit({ executionId, resources, metadata, context, signal });
    try {
      if (signal?.aborted) throw admissionError('EXECUTION_CANCELLED', 'Execution was cancelled after admission', true);
      const result = await handler({ executionId, signal, admission });
      return freeze({ schemaVersion: SCHEMA_VERSION, type: 'execution-admission-result', executionId, status: 'succeeded', result: clone(result), decisionId: admission.policy?.decisionId ?? null });
    } catch (error) {
      const normalized = normalizeError(error);
      return freeze({ schemaVersion: SCHEMA_VERSION, type: 'execution-admission-result', executionId, status: normalized.code === 'EXECUTION_CANCELLED' || error?.name === 'AbortError' ? 'cancelled' : 'failed', error: normalized, decisionId: admission.policy?.decisionId ?? null });
    } finally { this.release(executionId, { resources, reason: 'execution_finished' }); }
  }

  forceStop({ reason = 'forced' } = {}) {
    const executions = typeof this.shutdown.activeExecutions === 'function' ? this.shutdown.activeExecutions() : [];
    const released = [];
    for (const executionId of executions) {
      const allocation = this.resources?.allocation?.(executionId)?.allocation ?? {};
      if (this.resources && Object.values(allocation).some((value) => value > 0)) { this.resources.release(executionId, allocation); released.push({ executionId, resources: allocation }); }
    }
    const shutdown = this.shutdown.forceStop({ reason });
    this.#record({ action: 'force_stop', status: 'stopped', reason: sanitizeReason(reason), executions, released });
    return freeze({ schemaVersion: SCHEMA_VERSION, type: 'runtime-execution-force-stop', state: shutdown.state, executions, released, shutdown });
  }

  history() { return Object.freeze(this.#history.map(clone)); }
  snapshot() { return freeze({ schemaVersion: SCHEMA_VERSION, type: 'runtime-execution-admission', generatedAt: this.clock().toISOString(), history: this.#history, shutdown: this.shutdown.state(), resources: this.resources?.snapshot?.() ?? null, policy: this.policy?.snapshot?.() ?? null }); }
  #record(value) { this.#history.push(freeze({ schemaVersion: SCHEMA_VERSION, id: this.idFactory('admission-event'), timestamp: this.clock().toISOString(), ...value })); while (this.#history.length > this.maxHistory) this.#history.shift(); }
}

function validateExecutionId(value) { if (typeof value !== 'string' || !value.trim()) throw admissionError('EXECUTION_ID_INVALID', 'executionId must be a non-empty string'); }
function sanitize(value) { return value && typeof value === 'object' ? redact(structuredClone(value)) : {}; }
function redact(value) { if (Array.isArray(value)) return value.map(redact); if (!value || typeof value !== 'object') return value; const output = {}; for (const [key, child] of Object.entries(value)) output[key] = /pass(word)?|secret|token|api[_-]?key|private[_-]?key/i.test(key) ? '[REDACTED]' : redact(child); return output; }
function sanitizeReason(value) { return typeof value === 'string' && value ? value : 'unspecified'; }
function admissionError(code, message, retryable = false) { return Object.assign(new Error(message), { code, retryable }); }
function normalizeError(error) { return { code: error?.code ?? 'EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function defaultId(prefix) { return `${prefix}-${Date.now().toString(36)}`; }
export { SCHEMA_VERSION as RUNTIME_EXECUTION_ADMISSION_SCHEMA_VERSION };
