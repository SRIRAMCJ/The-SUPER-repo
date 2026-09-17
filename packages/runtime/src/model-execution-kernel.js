const SCHEMA_VERSION = '0.1.0';
const VALID_MODES = new Set(['chat', 'completion', 'embedding', 'multimodal']);

export class ModelExecutionKernel {
  constructor({ providers, router = null, policy = null, events = null, clock = () => new Date(), idFactory = defaultExecutionId, maxRetries = 2, defaultTimeoutMs = null, maxExecutions = 1000 } = {}) {
    if (!providers || typeof providers.resolve !== 'function' || typeof providers.require !== 'function') throw new TypeError('ModelExecutionKernel requires ModelProviderRegistry');
    if (router && typeof router.route !== 'function') throw new TypeError('router must expose route()');
    if (policy && typeof policy.authorize !== 'function') throw new TypeError('policy must expose authorize()');
    if (events && typeof events.emit !== 'function') throw new TypeError('events must expose emit()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new TypeError('maxRetries must be a non-negative integer');
    if (defaultTimeoutMs !== null && (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0)) throw new TypeError('defaultTimeoutMs must be null or positive');
    if (!Number.isInteger(maxExecutions) || maxExecutions < 1) throw new TypeError('maxExecutions must be a positive integer');
    this.providers = providers; this.router = router; this.policy = policy; this.events = events;
    this.clock = clock; this.idFactory = idFactory; this.maxRetries = maxRetries; this.defaultTimeoutMs = defaultTimeoutMs; this.maxExecutions = maxExecutions;
    this.executions = new Map();
  }

  listProviders() {
    return Object.freeze(this.providers.list().map((provider) => Object.freeze({ id: provider.id, capabilities: [...(provider.capabilities ?? [])], status: provider.status ?? 'unknown' })));
  }

  getExecution(executionId) { return this.executions.has(executionId) ? clone(this.executions.get(executionId)) : null; }

  async generate(request = {}, context = {}) {
    const normalized = normalizeRequest(request);
    const executionId = context.executionId ?? this.idFactory(normalized.model ?? 'auto');
    const correlationId = context.correlationId ?? executionId;
    if (this.executions.has(executionId)) return failureRecord({ executionId, correlationId, request: normalized, code: 'MODEL_EXECUTION_ID_CONFLICT', message: `Execution already exists: ${executionId}` });
    const startedAt = this.clock().toISOString();
    const route = normalized.provider ? null : this.#route(normalized);
    const providerId = normalized.provider ?? route?.selection?.provider;
    const model = normalized.model ?? route?.selection?.modelId;
    if (!providerId) return this.#finish({ executionId, correlationId, status: 'failed', startedAt, request: normalized, route, error: { code: 'MODEL_ROUTE_NOT_FOUND', message: 'No provider/model satisfies the request', retryable: false } });
    let provider;
    try { provider = this.providers.require(providerId); } catch (error) { return this.#finish({ executionId, correlationId, status: 'failed', startedAt, request: normalized, route, error: normalizeError(error) }); }
    if (!model) return this.#finish({ executionId, correlationId, status: 'failed', startedAt, request: normalized, provider: providerId, route, error: { code: 'MODEL_REQUIRED', message: 'Model is required when routing does not select one', retryable: false } });
    if (provider.status === 'disabled' || provider.status === 'deprecated') return this.#finish({ executionId, correlationId, status: 'failed', startedAt, request: normalized, provider: providerId, model, route, error: { code: 'MODEL_PROVIDER_UNAVAILABLE', message: `Model provider is unavailable: ${providerId}`, retryable: false } });
    if (this.policy) {
      const decision = await this.policy.authorize({ id: `${providerId}/${model}`, name: model, risk: normalized.risk ?? 'medium', permissions: normalized.permissions ?? [] }, context);
      if (!decision?.allowed) return this.#finish({ executionId, correlationId, status: 'rejected', startedAt, request: normalized, provider: providerId, model, route, error: { code: 'MODEL_POLICY_DENIED', message: decision?.reason ?? 'Model execution denied by policy', retryable: false } });
    }

    const parentSignal = context.signal;
    if (parentSignal?.aborted) return this.#finish({ executionId, correlationId, status: 'cancelled', startedAt, request: normalized, provider: providerId, model, route, error: cancellationError(parentSignal.reason) });
    const attempts = [];
    this.#emit({ type: 'model.execution.started', executionId, correlationId, status: 'running', data: { provider: providerId, model, route } });
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      const attemptStarted = this.clock().toISOString();
      const controller = new AbortController();
      const detach = linkAbort(parentSignal, controller);
      try {
        const result = await withTimeout(Promise.resolve().then(() => provider.generate({ ...normalized, provider: providerId, model, signal: controller.signal, executionId, correlationId })), normalized.timeoutMs ?? this.defaultTimeoutMs, controller, providerId, model);
        const finishedAt = this.clock().toISOString();
        const output = { provider: providerId, model, attempt, startedAt: attemptStarted, finishedAt, result: clone(result) };
        attempts.push(output);
        const execution = { schemaVersion: SCHEMA_VERSION, type: 'model-execution', executionId, correlationId, status: 'succeeded', provider: providerId, model, mode: normalized.mode, startedAt, finishedAt, attempts, route };
        this.#store(execution); this.#emit({ type: 'model.execution.completed', executionId, correlationId, status: 'succeeded', data: execution });
        return freezeDeep(clone(execution));
      } catch (error) {
        const normalizedError = normalizeError(error, controller.signal);
        attempts.push({ attempt, startedAt: attemptStarted, finishedAt: this.clock().toISOString(), error: normalizedError });
        this.#emit({ type: 'model.execution.attempt_failed', executionId, correlationId, status: 'failed', data: { attempt, provider: providerId, model }, error: normalizedError });
        if (!normalizedError.retryable || attempt > this.maxRetries || parentSignal?.aborted || controller.signal.aborted && normalizedError.code !== 'MODEL_EXECUTION_TIMEOUT') {
          return this.#finish({ executionId, correlationId, status: normalizedError.code === 'MODEL_EXECUTION_CANCELLED' ? 'cancelled' : 'failed', startedAt, request: normalized, provider: providerId, model, route, attempts, error: normalizedError });
        }
      } finally { detach(); }
    }
  }

  #route(request) { return this.router?.route({ capability: request.capability, mode: request.mode, minimumContextWindow: request.minimumContextWindow, preferredProvider: request.preferredProvider, costSensitive: request.costSensitive }) ?? null; }

  #finish({ executionId, correlationId, status, startedAt, request, provider = null, model = null, route = null, attempts = [], error = null }) {
    const finishedAt = this.clock().toISOString();
    const execution = { schemaVersion: SCHEMA_VERSION, type: 'model-execution', executionId, correlationId, status, provider, model, mode: request.mode, startedAt, finishedAt, attempts, route, ...(error ? { error } : {}) };
    this.#store(execution);
    this.#emit({ type: status === 'cancelled' ? 'model.execution.cancelled' : status === 'rejected' ? 'model.execution.rejected' : 'model.execution.failed', executionId, correlationId, status, data: execution, error });
    return freezeDeep(clone(execution));
  }

  #store(execution) { this.executions.set(execution.executionId, clone(execution)); while (this.executions.size > this.maxExecutions) this.executions.delete(this.executions.keys().next().value); }
  #emit(event) { this.events?.emit({ ...event, schemaVersion: SCHEMA_VERSION, timestamp: this.clock().toISOString() }); }
}

function normalizeRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Model request must be an object');
  if (request.provider !== undefined && (typeof request.provider !== 'string' || !request.provider.trim())) throw new TypeError('Model provider must be a non-empty string');
  if (request.model !== undefined && (typeof request.model !== 'string' || !request.model.trim())) throw new TypeError('Model must be a non-empty string');
  if (request.mode !== undefined && !VALID_MODES.has(request.mode)) throw new TypeError(`Unsupported model mode: ${request.mode}`);
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) throw new TypeError('timeoutMs must be positive');
  return { ...request, mode: request.mode ?? 'chat' };
}

function normalizeError(error, signal) {
  if (signal?.aborted) {
    const code = signal.reason?.code === 'MODEL_EXECUTION_TIMEOUT' ? 'MODEL_EXECUTION_TIMEOUT' : 'MODEL_EXECUTION_CANCELLED';
    return { code, message: signal.reason?.message ?? (code === 'MODEL_EXECUTION_TIMEOUT' ? 'Model execution timed out' : 'Model execution cancelled'), retryable: code === 'MODEL_EXECUTION_TIMEOUT' };
  }
  return { code: error?.code ?? 'MODEL_EXECUTION_ERROR', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) };
}
function cancellationError(reason) { return { code: 'MODEL_EXECUTION_CANCELLED', message: reason?.message ?? String(reason ?? 'Model execution cancelled'), retryable: false }; }
function linkAbort(parent, controller) { if (!parent?.addEventListener) return () => {}; const onAbort = () => controller.abort(parent.reason); parent.addEventListener('abort', onAbort, { once: true }); if (parent.aborted) controller.abort(parent.reason); return () => parent.removeEventListener('abort', onAbort); }
async function withTimeout(promise, timeoutMs, controller, provider, model) {
  if (!timeoutMs) return promise;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { const error = Object.assign(new Error(`Model execution timed out: ${provider}/${model}`), { code: 'MODEL_EXECUTION_TIMEOUT', retryable: true }); controller.abort(error); reject(error); }, timeoutMs); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function freezeDeep(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freezeDeep(child); return Object.freeze(value); }
function failureRecord({ executionId, correlationId, request, code, message }) { return { schemaVersion: SCHEMA_VERSION, type: 'model-execution', executionId, correlationId, status: 'failed', provider: null, model: request.model ?? null, mode: request.mode, startedAt: null, finishedAt: null, attempts: [], route: null, error: { code, message, retryable: false } }; }
function defaultExecutionId(model) { return `model-exec-${model}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

export { SCHEMA_VERSION as MODEL_EXECUTION_SCHEMA_VERSION };
