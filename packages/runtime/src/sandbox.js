import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const SANDBOX_SCHEMA_VERSION = '0.1.0';
export const SANDBOX_TERMINAL_STATES = Object.freeze(['succeeded', 'failed', 'cancelled', 'timed_out']);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_MAX_RECORDS = 500;
const SAFE_ENV = new Set(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL']);

export class ExecutionSandbox {
  #records = new Map();

  constructor({
    clock = () => new Date(),
    idFactory = () => `sandbox-${randomUUID()}`,
    maxRecords = DEFAULT_MAX_RECORDS,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    defaultMaxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  } = {}) {
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords must be a positive integer');
    if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs < 1) throw new TypeError('defaultTimeoutMs must be positive');
    if (!Number.isInteger(defaultMaxOutputBytes) || defaultMaxOutputBytes < 1) throw new TypeError('defaultMaxOutputBytes must be positive');
    this.clock = clock;
    this.idFactory = idFactory;
    this.maxRecords = maxRecords;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.defaultMaxOutputBytes = defaultMaxOutputBytes;
  }

  async execute(command, args = [], options = {}) {
    const executionId = options.executionId ?? this.idFactory();
    if (this.#records.has(executionId)) return this.#record(failure(executionId, 'EXECUTION_CONFLICT', 'Sandbox execution id already exists', this.clock));

    try {
      validateCommand(command, args);
      const policy = normalizePolicy(options.policy);
      validatePolicy(policy, options);
      const timeoutMs = normalizePositive(options.timeoutMs ?? this.defaultTimeoutMs, 'timeoutMs');
      const maxOutputBytes = normalizePositiveInteger(options.maxOutputBytes ?? this.defaultMaxOutputBytes, 'maxOutputBytes');
      const cwd = validateCwd(options.cwd);
      const env = buildEnvironment(options.env, policy);
      return await this.#spawn({ executionId, command, args, cwd, env, policy, timeoutMs, maxOutputBytes, signal: options.signal });
    } catch (error) {
      return this.#record(failure(executionId, error.code ?? 'SANDBOX_INVALID', error instanceof Error ? error.message : String(error), this.clock));
    }
  }

  getExecution(executionId) {
    const record = this.#records.get(executionId);
    return record ? structuredClone(record) : null;
  }

  listExecutions(limit = this.maxRecords) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
    return [...this.#records.values()].slice(-limit).map((item) => structuredClone(item));
  }

  async #spawn({ executionId, command, args, cwd, env, policy, timeoutMs, maxOutputBytes, signal }) {
    const startedAt = this.clock().toISOString();
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutChunks = [];
    let stderrChunks = [];
    let outputBytes = 0;
    let outputLimit = false;
    let settled = false;
    let closed = false;
    let terminationReason = null;
    let timer = null;
    let detach = null;

    const terminate = (_reason, code) => {
      if (settled) return;
      settled = true;
      terminationReason = code;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { if (!closed) child.kill('SIGKILL'); } catch {} }, 100).unref?.();
    };

    if (signal) {
      const abort = () => terminate(signal.reason, 'CANCELLED');
      if (signal.aborted) abort();
      else {
        signal.addEventListener('abort', abort, { once: true });
        detach = () => signal.removeEventListener('abort', abort);
      }
    }
    timer = setTimeout(() => terminate(new Error('Sandbox execution timed out'), 'TIMED_OUT'), timeoutMs);

    const collect = (chunk, target) => {
      if (outputLimit) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (outputBytes + buffer.length > maxOutputBytes) {
        const remaining = Math.max(0, maxOutputBytes - outputBytes);
        if (remaining) {
          const partial = buffer.subarray(0, remaining);
          (target === 'stdout' ? stdoutChunks : stderrChunks).push(partial);
        }
        outputBytes = maxOutputBytes;
        outputLimit = true;
        terminate(new Error('Sandbox output limit exceeded'), 'OUTPUT_LIMIT');
        return;
      }
      outputBytes += buffer.length;
      (target === 'stdout' ? stdoutChunks : stderrChunks).push(buffer);
    };

    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));

    return new Promise((resolve) => {
      child.once('error', (error) => {
        if (timer) clearTimeout(timer);
        detach?.();
        if (!settled) settled = true;
        resolve(this.#record(failure(executionId, 'SPAWN_FAILED', error.message, this.clock, {
          stdout: decode(stdoutChunks),
          stderr: decode(stderrChunks),
        })));
      });
      child.once('close', (exitCode, signalName) => {
        closed = true;
        if (timer) clearTimeout(timer);
        detach?.();
        const completedAt = this.clock().toISOString();
        const status = settled
          ? (outputLimit ? 'failed' : inferTerminal(terminationReason))
          : exitCode === 0 ? 'succeeded' : 'failed';
        const error = status === 'succeeded' ? null : {
          code: outputLimit ? 'OUTPUT_LIMIT' : status === 'cancelled' ? 'CANCELLED' : status === 'timed_out' ? 'TIMED_OUT' : 'PROCESS_EXIT',
          message: outputLimit ? 'Sandbox output limit exceeded' : `Sandbox process exited with code ${exitCode}${signalName ? ` (${signalName})` : ''}`,
        };
        resolve(this.#record({
          schemaVersion: SANDBOX_SCHEMA_VERSION,
          executionId,
          status,
          startedAt,
          completedAt,
          command,
          args: structuredClone(args),
          policy: structuredClone(policy),
          exitCode,
          signal: signalName,
          stdout: decode(stdoutChunks),
          stderr: decode(stderrChunks),
          ...(error ? { error } : {}),
        }));
      });
    });
  }

  #record(record) {
    this.#records.set(record.executionId, Object.freeze(structuredClone(record)));
    while (this.#records.size > this.maxRecords) this.#records.delete(this.#records.keys().next().value);
    return structuredClone(record);
  }
}

function normalizePolicy(policy = {}) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new TypeError('policy must be an object');
  return {
    filesystem: policy.filesystem ?? 'none',
    network: policy.network === true,
    environment: policy.environment ?? 'safe',
  };
}

function validatePolicy(policy, options) {
  if (!['none', 'workspace', 'read-only'].includes(policy.filesystem)) throw codeError('INVALID_FILESYSTEM_POLICY', 'filesystem must be none, workspace, or read-only');
  if (!['safe', 'inherit'].includes(policy.environment)) throw codeError('INVALID_ENVIRONMENT_POLICY', 'environment must be safe or inherit');
  if (policy.filesystem !== 'none') throw codeError('FILESYSTEM_ISOLATION_UNAVAILABLE', 'The process backend cannot enforce OS-level filesystem isolation');
  if (options.cwd !== undefined && options.cwd !== null && policy.filesystem === 'none') throw codeError('FILESYSTEM_DENIED', 'cwd is not permitted when filesystem access is disabled');
  if (policy.network) throw codeError('NETWORK_ISOLATION_UNAVAILABLE', 'The process backend cannot enforce OS-level network isolation');
}

function validateCommand(command, args) {
  if (typeof command !== 'string' || !command || command.includes('\0')) throw codeError('INVALID_COMMAND', 'command must be a non-empty string');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw codeError('INVALID_ARGUMENTS', 'args must be an array of strings');
}

function validateCwd(cwd) {
  if (cwd === undefined || cwd === null) return undefined;
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) throw codeError('INVALID_CWD', 'cwd must be a valid path');
  return cwd;
}

function buildEnvironment(overrides, policy) {
  if (overrides !== undefined && (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))) throw new TypeError('env must be an object');
  const base = policy.environment === 'inherit' ? { ...process.env } : Object.fromEntries([...SAFE_ENV].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw codeError('INVALID_ENVIRONMENT_KEY', `Invalid environment key: ${key}`);
    if (typeof value !== 'string') throw codeError('INVALID_ENVIRONMENT_VALUE', `Environment value must be a string: ${key}`);
    base[key] = value;
  }
  return base;
}

function decode(chunks) {
  return Buffer.concat(chunks).toString('utf8');
}

function normalizePositive(value, name) {
  if (!Number.isFinite(value) || value < 1) throw new TypeError(`${name} must be a positive finite number`);
  return value;
}

function normalizePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function codeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function failure(executionId, code, message, clock, output = {}) {
  return {
    schemaVersion: SANDBOX_SCHEMA_VERSION,
    executionId,
    status: 'failed',
    startedAt: null,
    completedAt: clock().toISOString(),
    error: { code, message },
    ...output,
  };
}

function inferTerminal(terminationReason) {
  if (terminationReason === 'CANCELLED') return 'cancelled';
  if (terminationReason === 'TIMED_OUT') return 'timed_out';
  return 'failed';
}
