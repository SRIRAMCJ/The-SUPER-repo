const SCHEMA_VERSION = '0.1.0';

export class RuntimeCommandBus {
  constructor({ controlPlane, operations, authorize = () => true, clock = () => new Date(), correlationId = defaultCorrelationId } = {}) {
    if (!controlPlane || typeof controlPlane.getHealth !== 'function') throw new TypeError('RuntimeCommandBus requires a compatible control plane');
    if (!operations || typeof operations.getOperations !== 'function' || typeof operations.diagnostics !== 'function') throw new TypeError('RuntimeCommandBus requires RuntimeOperations');
    if (typeof authorize !== 'function') throw new TypeError('authorize must be a function');
    if (typeof clock !== 'function' || typeof correlationId !== 'function') throw new TypeError('clock and correlationId must be functions');
    this.controlPlane = controlPlane; this.operations = operations; this.authorize = authorize; this.clock = clock; this.correlationId = correlationId;
  }
  list() { return Object.freeze(this.operations.getOperations().map((operation) => Object.freeze({ ...operation, command: operation.id, input: inputSchema(operation.id) }))); }
  async execute(command, input = {}, context = {}) {
    const definition = this.operations.getOperations().find((item) => item.id === command);
    const correlation = typeof context.correlationId === 'string' && context.correlationId.trim() ? context.correlationId : this.correlationId();
    const startedAt = this.clock();
    if (!definition) return failure('COMMAND_NOT_FOUND', `Unknown runtime command: ${command}`, correlation, startedAt, this.clock());
    if (!input || typeof input !== 'object' || Array.isArray(input)) return failure('INVALID_INPUT', 'Command input must be an object', correlation, startedAt, this.clock());
    try { if (!await this.authorize({ command: definition, input, context, correlationId: correlation })) return failure('FORBIDDEN', `Runtime command denied: ${command}`, correlation, startedAt, this.clock()); } catch (error) { return failure('AUTHORIZATION_ERROR', error instanceof Error ? error.message : String(error), correlation, startedAt, this.clock()); }
    try { validateInput(command, input); } catch (error) { return failure('INVALID_INPUT', error instanceof Error ? error.message : String(error), correlation, startedAt, this.clock()); }
    try { return success(await this.dispatch(command, input, { ...context, correlationId: correlation, signal: context.signal }), correlation, startedAt, this.clock()); } catch (error) { return failure('COMMAND_FAILED', error instanceof Error ? error.message : String(error), correlation, startedAt, this.clock()); }
  }
  async dispatch(command, input, context = {}) {
    const cp = this.controlPlane;
    switch (command) {
      case 'runtime.health': return cp.getHealth();
      case 'runtime.metrics': return cp.observability.getMetrics();
      case 'runtime.traces': return cp.observability.getTraces(filter(input));
      case 'runtime.events': return cp.observability.getEvents(filter(input));
      case 'runtime.executions': return cp.getExecutions(executionFilter(input));
      case 'runtime.evolution': return cp.getEvolution();
      case 'runtime.recovery': return cp.getRecovery();
      case 'runtime.snapshot': return cp.snapshot();
      case 'runtime.diagnostics': return this.operations.diagnostics();
      case 'runtime.cancel': return cp.cancelExecution(input.executionId, input.reason);
      case 'runtime.recover': return cp.recover({ ...input, signal: context.signal, readinessCorrelationId: context.correlationId });
      default: throw new Error(`Unsupported runtime command: ${command}`);
    }
  }
}
function inputSchema(command) {
  if (command === 'runtime.cancel') return { type: 'object', required: ['executionId'], properties: { executionId: 'string', reason: 'string?' } };
  if (command === 'runtime.recover') return { type: 'object', properties: { reason: 'string?', deadlineMs: 'non-negative-integer?', pollMs: 'non-negative-integer?' } };
  if (command === 'runtime.traces' || command === 'runtime.events') return { type: 'object', properties: { executionId: 'string?', type: 'string?', status: 'string?' } };
  if (command === 'runtime.executions') return { type: 'object', properties: { executionId: 'string?', type: 'string?', status: 'string?', limit: 'positive-integer?' } };
  return { type: 'object', properties: {} };
}
function validateInput(command, input) {
  if (command === 'runtime.cancel' && (typeof input.executionId !== 'string' || !input.executionId.trim())) throw new TypeError('executionId must be a non-empty string');
  if (command === 'runtime.cancel' && input.reason !== undefined && typeof input.reason !== 'string') throw new TypeError('reason must be a string');
  for (const key of ['deadlineMs', 'pollMs']) if (input[key] !== undefined && (!Number.isInteger(input[key]) || input[key] < 0)) throw new TypeError(`${key} must be a non-negative integer`);
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) throw new TypeError('limit must be a positive integer');
  for (const key of ['executionId', 'type', 'status', 'reason']) if (input[key] !== undefined && typeof input[key] !== 'string') throw new TypeError(`${key} must be a string`);
}
function filter(input) { const result = {}; for (const key of ['executionId', 'type', 'status']) if (input[key] !== undefined) result[key] = input[key]; return result; }
function executionFilter(input) { const result = filter(input); if (input.limit !== undefined) result.limit = input.limit; return result; }
function success(data, correlationId, startedAt, completedAt) { return Object.freeze({ schemaVersion: SCHEMA_VERSION, ok: true, correlationId, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()), data: structuredClone(data) }); }
function failure(code, message, correlationId, startedAt, completedAt) { return Object.freeze({ schemaVersion: SCHEMA_VERSION, ok: false, correlationId, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()), error: { code, message } }); }
function defaultCorrelationId() { return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`; }
