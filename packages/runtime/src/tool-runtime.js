const SCHEMA_VERSION = '0.1.0';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export class ToolRuntime {
  #records = new Map();
  #active = new Set();

  constructor({ registry, policyEngine = null, securityGate = null, resourceGovernance = null, clock = () => new Date(), maxRecords = 1000, idFactory = defaultExecutionId } = {}) {
    if (!registry || typeof registry.require !== 'function') throw new TypeError('ToolRuntime requires a capability registry');
    if (policyEngine && typeof policyEngine.authorize !== 'function') throw new TypeError('policyEngine must expose authorize()');
    if (securityGate && typeof securityGate.authorize !== 'function') throw new TypeError('securityGate must expose authorize()');
    if (resourceGovernance && (typeof resourceGovernance.admit !== 'function' || typeof resourceGovernance.release !== 'function')) throw new TypeError('resourceGovernance must expose admit() and release()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords must be a positive integer');
    this.registry = registry; this.policyEngine = policyEngine; this.securityGate = securityGate; this.resourceGovernance = resourceGovernance; this.clock = clock; this.maxRecords = maxRecords; this.idFactory = idFactory;
  }

  async execute(toolId, input = {}, context = {}) {
    const executionId = context.executionId ?? this.idFactory(toolId);
    if (this.#active.has(executionId) || this.#records.has(executionId)) return failure('EXECUTION_CONFLICT', `Execution already exists: ${executionId}`, executionId);
    const timeoutMs = normalizeTimeout(context.timeoutMs);
    this.#active.add(executionId);
    let detach = () => {};
    let timer;
    let removeAbort = () => {};
    let handlerPending = false;
    let callerFinished = false;
    let startedAt = null;
    let reserved = false;
    const releaseReservation = () => { if (reserved) { reserved = false; this.resourceGovernance.release(executionId); } };
    const controller = new AbortController();
    try {
      let entry;
      try { entry = this.registry.require(toolId); } catch (error) { return this.#record(failure('TOOL_UNAVAILABLE', errorMessage(error), executionId)); }
      if (entry.manifest.kind !== 'tool') return this.#record(failure('INVALID_TOOL_KIND', `Capability is not a tool: ${toolId}`, executionId));
      if (this.securityGate) {
        const security = this.securityGate.authorize({ ...entry.manifest, id: toolId }, context);
        if (security?.then) Promise.resolve(security).catch(() => {});
        if (security?.allowed !== true) return this.#record(failure(security?.decision === 'invalid' ? 'SECURITY_INVALID_CONTEXT' : 'SECURITY_DENIED', security?.reason ?? 'Security gate denied tool execution', executionId));
      }
      if (this.policyEngine) {
        const policy = this.policyEngine.authorize(entry.manifest, context);
        if (policy?.then) Promise.resolve(policy).catch(() => {});
        if (policy?.allowed !== true) return this.#record(failure('FORBIDDEN', policy?.reason ?? 'Tool execution denied', executionId));
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return this.#record(failure('INVALID_INPUT', 'Tool input must be an object', executionId));
      const parentSignal = context.signal;
      if (parentSignal?.aborted) return this.#record(failure('CANCELLED', 'Tool cancelled before dispatch', executionId));
      if (this.resourceGovernance) {
        const decision = this.resourceGovernance.admit({ executionId, request: entry.manifest.resourceRequest ?? { concurrency: 1 } });
        if (decision?.allowed !== true) return this.#record(failure('RESOURCE_DENIED', `Tool resource reservation denied: ${decision?.resource ?? 'unknown'}`, executionId));
        reserved = true;
      }
      if (parentSignal) {
        const abort = () => controller.abort(Object.assign(new Error('Tool execution cancelled'), { code: 'CANCELLED' }));
        parentSignal.addEventListener('abort', abort, { once: true });
        detach = () => parentSignal.removeEventListener('abort', abort);
      }
      const cancelled = new Promise((_, reject) => {
        const abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abort, { once: true });
        removeAbort = () => controller.signal.removeEventListener('abort', abort);
      });
      if (timeoutMs !== null) timer = setTimeout(() => controller.abort(Object.assign(new Error('Tool execution timed out'), { code: 'TIMED_OUT' })), timeoutMs);
      startedAt = this.clock().toISOString();
      handlerPending = true;
      const invocation = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return entry.handler(input, { ...context, executionId, signal: controller.signal, tool: structuredClone(entry.manifest) });
      });
      const settle = () => { handlerPending = false; releaseReservation(); if (callerFinished) this.#active.delete(executionId); };
      // Keep an uncooperative handler's ID reserved even after the caller times out.
      invocation.then(settle, settle);
      const value = await Promise.race([invocation, cancelled]);
      if (controller.signal.aborted) throw controller.signal.reason;
      return this.#record(success(executionId, startedAt, this.clock().toISOString(), value));
    } catch (error) {
      const code = controller.signal.aborted ? (controller.signal.reason?.code === 'TIMED_OUT' ? 'TIMED_OUT' : 'CANCELLED') : 'TOOL_FAILED';
      return this.#record(failure(code, errorMessage(error), executionId, startedAt));
    } finally {
      callerFinished = true;
      clearTimeout(timer); detach(); removeAbort();
      if (!handlerPending) { releaseReservation(); this.#active.delete(executionId); }
    }
  }

  getExecution(executionId) { const record = this.#records.get(executionId); return record ? structuredClone(record) : null; }
  listExecutions(limit = this.maxRecords) { if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer'); return [...this.#records.values()].slice(-limit).map((record) => structuredClone(record)); }
  #record(record) {
    this.#records.set(record.executionId, structuredClone(record));
    while (this.#records.size > this.maxRecords) this.#records.delete(this.#records.keys().next().value);
    return structuredClone(record);
  }
}
function success(executionId, startedAt, completedAt, output) { return { schemaVersion: SCHEMA_VERSION, executionId, status: 'succeeded', startedAt, completedAt, output: structuredClone(output) }; }
function failure(code, message, executionId, startedAt = null) { return { schemaVersion: SCHEMA_VERSION, executionId, status: code === 'CANCELLED' ? 'cancelled' : code === 'TIMED_OUT' ? 'timed_out' : 'failed', error: { code, message }, startedAt, completedAt: new Date().toISOString() }; }
function normalizeTimeout(value) { if (value === undefined || value === null) return null; if (!Number.isFinite(value) || value < 1) throw new TypeError('timeoutMs must be a positive finite number'); return value; }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function defaultExecutionId(toolId) { return `tool_${toolId.replaceAll('/', '_')}_${crypto.randomUUID()}`; }
export { SCHEMA_VERSION as TOOL_RUNTIME_SCHEMA_VERSION, TERMINAL as TOOL_TERMINAL_STATES };
