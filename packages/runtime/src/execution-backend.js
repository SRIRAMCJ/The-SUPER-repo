const SCHEMA_VERSION = '0.1.0';

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
    const command = input.command ?? capability?.execution?.command;
    const args = input.args ?? capability?.execution?.args ?? [];
    if (typeof command !== 'string' || !command) return failed(executionId, 'INVALID_COMMAND', 'Sandbox execution requires input.command or capability.execution.command');
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return failed(executionId, 'INVALID_ARGUMENTS', 'Sandbox execution args must be an array of strings');

    const suppliedOptions = input.options && typeof input.options === 'object' && !Array.isArray(input.options) ? input.options : {};
    const result = await this.sandbox.execute(command, args, {
      ...suppliedOptions,
      executionId,
      signal: context.signal,
      timeoutMs: context.timeoutMs ?? suppliedOptions.timeoutMs,
      policy: suppliedOptions.policy ?? capability?.execution?.policy,
    });

    return {
      executionId,
      status: result.status,
      output: { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.exitCode ?? null, signal: result.signal ?? null },
      ...(result.error ? { error: result.error } : {}),
      backend: 'sandbox',
      record: result,
    };
  }
}

function failed(executionId, code, message) {
  return { executionId, status: 'failed', error: { code, message, retryable: false }, backend: 'sandbox' };
}
