const SCHEMA_VERSION = '0.1.0';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export class ToolRuntime {
  #records = new Map();

  constructor({ registry, policyEngine = null, clock = () => new Date(), maxRecords = 1000, idFactory = defaultExecutionId } = {}) {
    if (!registry || typeof registry.require !== 'function') throw new TypeError('ToolRuntime requires a capability registry');
    if (policyEngine && typeof policyEngine.authorize !== 'function') throw new TypeError('policyEngine must expose authorize()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords must be a positive integer');
    this.registry = registry; this.policyEngine = policyEngine; this.clock = clock; this.maxRecords = maxRecords; this.idFactory = idFactory;
  }

  async execute(toolId, input = {}, context = {}) {
    const executionId = context.executionId ?? this.idFactory(toolId);
    if (this.#records.has(executionId)) return failure('EXECUTION_CONFLICT', `Execution already exists: ${executionId}`, executionId);
    let entry;
    try { entry = this.registry.require(toolId); } catch (_error) { return this.#record(failure('TOOL_UNAVAILABLE', 'Tool capability is unavailable', executionId)); }
    if (entry.manifest.kind !== 'tool') return this.#record(failure('INVALID_TOOL_KIND', `Capability is not a tool: ${toolId}`, executionId));
    const policy = this.policyEngine?.authorize({ id: toolId, name: entry.manifest.name, risk: entry.manifest.risk ?? 'none', permissions: entry.manifest.permissions ?? [] }, context);
    if (policy && policy.allowed !== true) return this.#record(failure('FORBIDDEN', policy.reason ?? 'Tool execution denied', executionId));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return this.#record(failure('INVALID_INPUT', 'Tool input must be an object', executionId));

    const controller = new AbortController();
    const parentSignal = context.signal;
    let detach = null;
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort(parentSignal.reason);
      else { const abort = () => controller.abort(parentSignal.reason); parentSignal.addEventListener('abort', abort, { once: true }); detach = () => parentSignal.removeEventListener('abort', abort); }
    }
    const timeoutMs = normalizeTimeout(context.timeoutMs);
    let timer = null;
    if (timeoutMs !== null) timer = setTimeout(() => controller.abort(new Error('Tool execution timed out')), timeoutMs);
    const startedAt = this.clock().toISOString();
    try {
      const value = await entry.handler(input, { ...context, executionId, signal: controller.signal, tool: structuredClone(entry.manifest) });
      if (controller.signal.aborted) return this.#record(failure(isTimeout(controller.signal.reason) ? 'TIMED_OUT' : 'CANCELLED', errorMessage(controller.signal.reason), executionId, startedAt));
      return this.#record(success(executionId, startedAt, this.clock().toISOString(), value));
    } catch (error) {
      const code = controller.signal.aborted ? (isTimeout(controller.signal.reason) ? 'TIMED_OUT' : 'CANCELLED') : 'TOOL_FAILED';
      return this.#record(failure(code, errorMessage(error), executionId, startedAt));
    } finally { if (timer) clearTimeout(timer); detach?.(); }
  }

  getExecution(executionId) { const record = this.#records.get(executionId); return record ? structuredClone(record) : null; }
  listExecutions(limit = this.maxRecords) { if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer'); return [...this.#records.values()].slice(-limit).map((record) => structuredClone(record)); }

  #record(record) {
    this.#records.set(record.executionId, Object.freeze(structuredClone(record)));
    while (this.#records.size > this.maxRecords) this.#records.delete(this.#records.keys().next().value);
    return structuredClone(record);
  }
}

function success(executionId, startedAt, completedAt, output) { return { schemaVersion: SCHEMA_VERSION, executionId, status: 'succeeded', startedAt, completedAt, output: structuredClone(output) }; }
function failure(code, message, executionId, startedAt = null) { return { schemaVersion: SCHEMA_VERSION, executionId, status: code === 'CANCELLED' ? 'cancelled' : code === 'TIMED_OUT' ? 'timed_out' : 'failed', error: { code, message }, startedAt, completedAt: new Date().toISOString() }; }
function normalizeTimeout(value) { if (value === undefined || value === null) return null; if (!Number.isFinite(value) || value < 1) throw new TypeError('timeoutMs must be a positive finite number'); return value; }
function isTimeout(reason) { return reason instanceof Error && /timed out/i.test(reason.message); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function defaultExecutionId(toolId) { return `tool_${toolId.replaceAll('/', '_')}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`; }

export { SCHEMA_VERSION as TOOL_RUNTIME_SCHEMA_VERSION, TERMINAL as TOOL_TERMINAL_STATES };
