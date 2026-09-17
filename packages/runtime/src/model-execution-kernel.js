const SCHEMA_VERSION = '0.1.0';

export class ModelExecutionKernel {
  constructor({ providers, router = null, policy = null, events = null, clock = () => new Date(), idFactory = defaultExecutionId, maxRetries = 2, defaultTimeoutMs = null } = {}) {
    if (!providers || typeof providers.resolve !== 'function' || typeof providers.require !== 'function') throw new TypeError('ModelExecutionKernel requires ModelProviderRegistry');
    if (router && typeof router.route !== 'function') throw new TypeError('router must expose route()');
    if (policy && typeof policy.authorize !== 'function') throw new TypeError('policy must expose authorize()');
    if (events && typeof events.emit !== 'function') throw new TypeError('events must expose emit()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new TypeError('maxRetries must be a non-negative integer');
    if (defaultTimeoutMs !== null && (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0)) throw new TypeError('defaultTimeoutMs must be null or positive');
    this.providers = providers;
    this.router = router;
    this.policy = policy;
    this.events = events;
    this.clock = clock;
    this.idFactory = idFactory;
    this.maxRetries = maxRetries;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.executions = new Map();
  }

  listProviders() { return Object.freeze(this.providers.list().map((provider) => ({ id: provider.id, capabilities: provider.capabilities ?? [], status: provider.status ?? 'unknown' }))); }

  getExecution(executionId) { const execution = this.executions.get(executionId); return execution ? clone(execution) : null; }

  async generate(request = {}, context = {}) {
    const normalized = normalizeRequest(request);
    const executionId = context.executionId ?? this.idFactory(normalized.model ?? 'auto');
    const correlationId = context.correlationId ?? executionId;
    const startedAt = this.clock().toISOString();
    const route = normalized.provider ? null : this.#route(normalized);
    const providerId = normalized.provider ?? route?.selection?.provider;
    if (!providerId) return this.#finish({ executionId, correlationId, status: 'failed', startedAt, request: normalized, route, error: { code: 'MODEL_ROUTE_NOT_FOUND', message: 'No provider/model satisfies the request', retryable: false } });
    let provider;
    try { provider = this.providers.require(providerId); } catch (error) { return this.#finish({ executionId, correlationId, status: 'failed', startedAt, request: normalized, route, error: normalizeError(error) }); }
    const model = normalized.model ?? route?.selection?.modelId;
    if (!model) return this.#finish({ executionId, correlationId, status: 'failed', startedAt, request: normalized, route, error: { code: 'MODEL_REQUIRED', message: 'Model is required when routing does not select one', retryable: false } });
    if (provider.status === 'disabled' || provider.status === 'deprecated') return this.#finish({ executionId, correlationId, status: 'failed', startedAt, request: normalized, route, error: { code: 'MODEL_PROVIDER_UNAVAILABLE', message: `Model provider is unavailable: ${providerId}`, retryable: false } });
    if (this.policy) {
      const decision = await this.policy.authorize({ id: `${providerId}/${model}`, name: model, risk: normalized.risk ?? 'medium', permissions: normalized.permissions ?? [] }, context);
      if (!decision?.allowed) return this.#finish({ executionId, correlationId, status: 'rejected', startedAt, request: normalized, route, error: { code: 'MODEL_POLICY_DENIED', message: decision?.reason ?? 'Model execution denied by policy', retryable: false } });
    }

    const controller = new AbortController();
    if (context.signal?.addEventListener) {
      if (context.signal.aborted) controller.abort(context.signal.reason);
      else context.signal.addEventListener('abort', () => controller.abort(context.signal.reason), { once: true });
    }
    const timeoutMs = normalized.timeoutMs ?? this.defaultTimeoutMs;
    const attempts = [];
    this.#emit({ type: 'model.execution.started', executionId, correlationId, status: 'running', data: { provider: providerId, model, route } });
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      const attemptStarted = this.clock().toISOString();
      try {
        const result = await withTimeout(Promise.resolve().then(() => provider.generate({ ...normalized, provider: providerId, model, signal: controller.signal, executionId, correlationId })), timeoutMs, controller, providerId, model);
        const finishedAt = this.clock().toISOString();
        const output = normalizeOutput(result, providerId, model, attempt, attemptStarted, finishedAt);
        attempts.push(output);
        const execution = { schemaVersion: SCHEMA_VERSION, type: 'model-execution', executionId, correlationId, status: 'succeeded', provider: providerId, model, mode: normalized.mode, startedAt, finishedAt, attempts, route };
        this.executions.set(executionId, structuredClone(execution));
        this.#emit({ type: 'model.execution.completed', executionId, correlationId, status: 'succeeded', data: execution });
        return freezeDeep(execution);
      } catch (error) {
        const normalizedError = normalizeError(error);
        attempts.push({ attempt, startedAt: attemptStarted, finishedAt: this.clock().toISOString(), error: normalizedError });
        this.#emit({ type: 'model.execution.attempt_failed', executionId, correlationId, status: 'failed', data: { attempt, provider: providerId, model }, error: normalizedError });
        if (!normalizedError.retryable || attempt > this.maxRetries || controller.signal.aborted) {
          return this.#finish({ executionId, correlationId, status: normalizedError.code === 'MODEL_EXECUTION_CANCELLED' ? 'cancelled' : 'failed', startedAt, request: normalized, provider: providerId, model, route, attempts, error: normalizedError });
        }
      }
    }
  }

  #route(request) {
    if (!this.router) return null;
    return this.router.route({ capability: request.capability, mode: request.mode, minimumContextWindow: request.minimumContextWindow, preferredProvider: request.preferredProvider, costSensitive: request.costSensitive });
  }

  #finish({ executionId, correlationId, status, startedAt, request, provider = null, model = null, route = null, attempts = [], error = null }) {
    const finishedAt = this.clock().toISOString();
    const execution = freezeDeep({ schemaVersion: SCHEMA_VERSION, type: 'model-execution', executionId, correlationId, status, provider, model, mode: request.mode, startedAt, finishedAt, attempts, route, ...(error ? { error } : {}) });
    this.executions.set(executionId, structuredClone(execution));
    this.#emit({ type: status === 'cancelled' ? 'model.execution.cancelled' : status === 'rejected' ? 'model.execution.rejected' : 'model.execution.failed', executionId, correlationId, status, data: execution, error });
    return execution;
  }

  #emit(event) { this.events?.emit({ schemaVersion: SCHEMA_VERSION, timestamp: this.clock().toISOString(), ...event }); }
}

function normalizeRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Model request must be an object');
  if (request.provider !== undefined && (typeof request.provider !== 'string' || !request.provider)) throw new TypeError('Model provider must be a non-empty string');
  if (request.model !== undefined && (typeof request.model !== 'string' || !request.model)) throw new TypeError('Model must be a non-empty string');
  if (request.mode !== undefined && !new Set(['chat', 'completion', 'embedding', 'multimodal']).has(request.mode)) throw new TypeError(`Unsupported model mode: ${request.mode}`);
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) throw new TypeError('timeoutMs must be positive');
  return { ...request, mode: request.mode ?? 'chat' };
}

function normalizeOutput(result, provider, model, attempt, startedAt, finishedAt) { return { provider, model, attempt, startedAt, finishedAt, result: clone(result) }; }
function normalizeError(error) { return { code: error?.code ?? 'MODEL_EXECUTION_ERROR', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
async function withTimeout(promise, timeoutMs, controller, provider, model) {
  if (!timeoutMs) return promise;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(Object.assign(new Error(`Model execution timed out: ${provider}/${model}`), { code: 'MODEL_EXECUTION_TIMEOUT', retryable: true })); reject(Object.assign(new Error(`Model execution timed out: ${provider}/${model}`), { code: 'MODEL_EXECUTION_TIMEOUT', retryable: true })); }, timeoutMs); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function freezeDeep(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freezeDeep(child); return Object.freeze(value); }
function defaultExecutionId(model) { return `model-exec-${model}-${Date.now().toString(36)}`; }

export { SCHEMA_VERSION as MODEL_EXECUTION_SCHEMA_VERSION };
