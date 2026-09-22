import { ExecutionSandbox } from './sandbox.js';

const SCHEMA_VERSION = '0.2.0';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const SANDBOX_BACKEND = 'sandbox';

export class ToolRuntime {
  #records = new Map();

  constructor({
    registry,
    policyEngine = null,
    sandbox = null,
    clock = () => new Date(),
    maxRecords = 1000,
    idFactory = defaultExecutionId,
  } = {}) {
    if (!registry || typeof registry.require !== 'function') throw new TypeError('ToolRuntime requires a capability registry');
    if (policyEngine && typeof policyEngine.authorize !== 'function') throw new TypeError('policyEngine must expose authorize()');
    if (sandbox !== null && !(sandbox instanceof ExecutionSandbox) && typeof sandbox.execute !== 'function') throw new TypeError('sandbox must expose execute()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords must be a positive integer');
    this.registry = registry;
    this.policyEngine = policyEngine;
    this.sandbox = sandbox;
    this.clock = clock;
    this.maxRecords = maxRecords;
    this.idFactory = idFactory;
  }

  async execute(toolId, input = {}, context = {}) {
    const executionId = context.executionId ?? this.idFactory(toolId);
    if (this.#records.has(executionId)) return this.#record(failure('EXECUTION_CONFLICT', `Execution already exists: ${executionId}`, executionId, this.clock));

    let entry;
    try { entry = this.registry.require(toolId); }
    catch (_error) { return this.#record(failure('TOOL_UNAVAILABLE', 'Tool capability is unavailable', executionId, this.clock)); }

    if (entry.manifest.kind !== 'tool') return this.#record(failure('INVALID_TOOL_KIND', `Capability is not a tool: ${toolId}`, executionId, this.clock));

    const policy = this.policyEngine?.authorize(
      { id: toolId, name: entry.manifest.name, risk: entry.manifest.risk ?? 'none', permissions: entry.manifest.permissions ?? [] },
      context,
    );
    if (policy && policy.allowed !== true) return this.#record(failure('FORBIDDEN', policy.reason ?? 'Tool execution denied', executionId, this.clock));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return this.#record(failure('INVALID_INPUT', 'Tool input must be an object', executionId, this.clock));

    let execution;
    try { execution = normalizeExecution(entry.manifest.execution); }
    catch (error) { return this.#record(failure(error.code ?? 'INVALID_EXECUTION_CONFIG', error instanceof Error ? error.message : String(error), executionId, this.clock)); }
    if (execution.backend === SANDBOX_BACKEND) return this.#executeSandbox(entry, toolId, input, context, executionId, execution);
    if (execution.backend !== 'in-process') return this.#record(failure('INVALID_EXECUTION_BACKEND', `Unsupported tool execution backend: ${execution.backend}`, executionId, this.clock));

    return this.#executeHandler(entry, input, context, executionId);
  }

  async #executeSandbox(entry, toolId, input, context, executionId, execution) {
    if (!this.sandbox) return this.#record(failure('SANDBOX_UNAVAILABLE', 'Tool requires sandbox execution but no sandbox is configured', executionId, this.clock));
    if (typeof execution.command !== 'string' || !execution.command.trim()) {
      return this.#record(failure('SANDBOX_COMMAND_MISSING', `Sandbox command is missing for tool: ${toolId}`, executionId, this.clock));
    }

    const startedAt = this.clock().toISOString();
    let timeoutMs;
    try { timeoutMs = minTimeout(context.timeoutMs, execution.timeoutMs); }
    catch (error) { return this.#record(failure(error.code ?? 'INVALID_TIMEOUT', error instanceof Error ? error.message : String(error), executionId, this.clock)); }
    const sandboxResult = await this.sandbox.execute(execution.command, execution.args, {
      executionId,
      signal: context.signal,
      timeoutMs,
      maxOutputBytes: execution.maxOutputBytes,
      maxInputBytes: execution.maxInputBytes,
      cwd: execution.cwd,
      env: execution.env,
      policy: execution.policy,
      stdin: JSON.stringify(input),
    });

    if (sandboxResult.status !== 'succeeded') {
      const code = sandboxResult.error?.code ?? mapSandboxStatus(sandboxResult.status);
      return this.#record({
        schemaVersion: SCHEMA_VERSION,
        executionId,
        status: code === 'CANCELLED' ? 'cancelled' : code === 'TIMED_OUT' ? 'timed_out' : 'failed',
        startedAt,
        completedAt: this.clock().toISOString(),
        backend: SANDBOX_BACKEND,
        error: { code, message: sandboxResult.error?.message ?? `Sandbox execution ${sandboxResult.status}` },
        sandbox: structuredClone(sandboxResult),
      });
    }

    try {
      const output = execution.output === 'text' ? sandboxResult.stdout : JSON.parse(sandboxResult.stdout);
      return this.#record({
        schemaVersion: SCHEMA_VERSION,
        executionId,
        status: 'succeeded',
        startedAt,
        completedAt: this.clock().toISOString(),
        backend: SANDBOX_BACKEND,
        output: structuredClone(output),
        sandbox: structuredClone(sandboxResult),
      });
    } catch (error) {
      return this.#record({
        schemaVersion: SCHEMA_VERSION,
        executionId,
        status: 'failed',
        startedAt,
        completedAt: this.clock().toISOString(),
        backend: SANDBOX_BACKEND,
        error: { code: 'SANDBOX_OUTPUT_INVALID', message: error instanceof Error ? error.message : String(error) },
        sandbox: structuredClone(sandboxResult),
      });
    }
  }

  async #executeHandler(entry, input, context, executionId) {
    const controller = new AbortController();
    const parentSignal = context.signal;
    let detach = null;
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort(parentSignal.reason);
      else {
        const abort = () => controller.abort(parentSignal.reason);
        parentSignal.addEventListener('abort', abort, { once: true });
        detach = () => parentSignal.removeEventListener('abort', abort);
      }
    }
    const timeoutMs = normalizeTimeout(context.timeoutMs);
    let timer = null;
    if (timeoutMs !== null) timer = setTimeout(() => controller.abort(new Error('Tool execution timed out')), timeoutMs);
    const startedAt = this.clock().toISOString();

    try {
      const value = await entry.handler(input, { ...context, executionId, signal: controller.signal, tool: structuredClone(entry.manifest) });
      if (controller.signal.aborted) return this.#record(failure(isTimeout(controller.signal.reason) ? 'TIMED_OUT' : 'CANCELLED', errorMessage(controller.signal.reason), executionId, this.clock, startedAt));
      return this.#record(success(executionId, startedAt, this.clock().toISOString(), value));
    } catch (error) {
      const code = controller.signal.aborted ? (isTimeout(controller.signal.reason) ? 'TIMED_OUT' : 'CANCELLED') : 'TOOL_FAILED';
      return this.#record(failure(code, errorMessage(error), executionId, this.clock, startedAt));
    } finally {
      if (timer) clearTimeout(timer);
      detach?.();
    }
  }

  getExecution(executionId) {
    const record = this.#records.get(executionId);
    return record ? structuredClone(record) : null;
  }

  listExecutions(limit = this.maxRecords) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
    return [...this.#records.values()].slice(-limit).map((record) => structuredClone(record));
  }

  #record(record) {
    this.#records.set(record.executionId, Object.freeze(structuredClone(record)));
    while (this.#records.size > this.maxRecords) this.#records.delete(this.#records.keys().next().value);
    return structuredClone(record);
  }
}

function normalizeExecution(execution) {
  if (execution === undefined || execution === null) return { backend: 'in-process' };
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) throw new TypeError('Tool execution configuration must be an object');
  const backend = execution.backend ?? 'in-process';
  const args = execution.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new TypeError('Tool execution args must be an array of strings');
  const output = execution.output ?? 'json';
  if (!['json', 'text'].includes(output)) throw new TypeError('Tool execution output must be json or text');
  return {
    backend,
    command: execution.command,
    args: [...args],
    output,
    timeoutMs: execution.timeoutMs,
    maxOutputBytes: execution.maxOutputBytes,
    maxInputBytes: execution.maxInputBytes,
    cwd: execution.cwd,
    env: execution.env,
    policy: execution.policy,
  };
}

function minTimeout(parent, declared) {
  if (parent === undefined || parent === null) return declared;
  if (!Number.isFinite(parent) || parent < 1) throw new TypeError('timeoutMs must be a positive finite number');
  if (declared === undefined || declared === null) return parent;
  if (!Number.isFinite(declared) || declared < 1) throw new TypeError('execution.timeoutMs must be a positive finite number');
  return Math.min(parent, declared);
}

function success(executionId, startedAt, completedAt, output) {
  return { schemaVersion: SCHEMA_VERSION, executionId, status: 'succeeded', startedAt, completedAt, output: structuredClone(output) };
}

function failure(code, message, executionId, clock, startedAt = null) {
  return {
    schemaVersion: SCHEMA_VERSION,
    executionId,
    status: code === 'CANCELLED' ? 'cancelled' : code === 'TIMED_OUT' ? 'timed_out' : 'failed',
    error: { code, message },
    startedAt,
    completedAt: clock().toISOString(),
  };
}

function normalizeTimeout(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 1) throw new TypeError('timeoutMs must be a positive finite number');
  return value;
}

function isTimeout(reason) {
  return reason instanceof Error && /timed out/i.test(reason.message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function mapSandboxStatus(status) {
  return status === 'cancelled' ? 'CANCELLED' : status === 'timed_out' ? 'TIMED_OUT' : 'SANDBOX_FAILED';
}

function defaultExecutionId(toolId) {
  return `tool_${toolId.replaceAll('/', '_')}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export { SCHEMA_VERSION as TOOL_RUNTIME_SCHEMA_VERSION, TERMINAL as TOOL_TERMINAL_STATES };
