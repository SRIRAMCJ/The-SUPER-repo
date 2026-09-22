const SCHEMA_VERSION = '0.2.0';

export const EXECUTION_BACKEND_SCHEMA_VERSION = SCHEMA_VERSION;

export class ExecutionBackendRegistry {
  #backends = new Map();

  register(id, backend) {
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('Backend id must be a non-empty string');
    if (!backend || typeof backend.execute !== 'function') throw new TypeError('Execution backend must expose execute()');
    if (this.#backends.has(id)) throw new Error(`Execution backend already registered: ${id}`);
    this.#backends.set(id, backend);
    return id;
  }

  resolve(id) { return this.#backends.get(id) ?? null; }

  require(id) {
    const backend = this.resolve(id);
    if (!backend) throw Object.assign(new Error(`Execution backend not found: ${id}`), { code: 'EXECUTION_BACKEND_UNAVAILABLE', retryable: false });
    return backend;
  }

  list() { return Object.freeze([...this.#backends.keys()]); }
}

export class SandboxExecutionBackend {
  constructor({ sandbox } = {}) {
    if (!sandbox || typeof sandbox.execute !== 'function') throw new TypeError('SandboxExecutionBackend requires an ExecutionSandbox');
    this.sandbox = sandbox;
  }

  async execute({ executionId, input = {}, context = {}, capability }) {
    const execution = capability?.execution;
    if (!execution || typeof execution !== 'object') return failed(executionId, 'SANDBOX_CONFIG_MISSING', 'Sandbox execution requires capability.execution');
    const command = execution.command;
    const args = execution.args ?? [];
    if (typeof command !== 'string' || !command.trim()) return failed(executionId, 'INVALID_COMMAND', 'Sandbox execution requires capability.execution.command');
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return failed(executionId, 'INVALID_ARGUMENTS', 'Sandbox execution args must be an array of strings');

    const timeoutMs = minTimeout(context.timeoutMs, execution.timeoutMs);
    const result = await this.sandbox.execute(command, args, {
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

    if (result.status !== 'succeeded') {
      return {
        executionId,
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
        backend: 'sandbox',
        record: result,
      };
    }

    try {
      const output = execution.output === 'text' ? result.stdout : JSON.parse(result.stdout);
      return {
        executionId,
        status: 'succeeded',
        output,
        backend: 'sandbox',
        record: result,
      };
    } catch (error) {
      return failed(executionId, 'SANDBOX_OUTPUT_INVALID', error instanceof Error ? error.message : String(error), result);
    }
  }
}

function minTimeout(parent, declared) {
  if (parent === undefined || parent === null) return declared;
  if (!Number.isFinite(parent) || parent < 1) throw Object.assign(new Error('timeoutMs must be a positive finite number'), { code: 'INVALID_TIMEOUT', retryable: false });
  if (declared === undefined || declared === null) return parent;
  if (!Number.isFinite(declared) || declared < 1) throw Object.assign(new Error('execution.timeoutMs must be a positive finite number'), { code: 'INVALID_TIMEOUT', retryable: false });
  return Math.min(parent, declared);
}

function failed(executionId, code, message, record = undefined) {
  return {
    executionId,
    status: 'failed',
    error: { code, message, retryable: false },
    backend: 'sandbox',
    ...(record ? { record } : {}),
  };
}
