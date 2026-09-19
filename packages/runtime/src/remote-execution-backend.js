import { RemoteExecutionRecovery } from './remote-execution-recovery.js';

const SCHEMA_VERSION = '0.2.0';
export const REMOTE_EXECUTION_BACKEND_SCHEMA_VERSION = SCHEMA_VERSION;

export class RemoteExecutionBackend {
  constructor({ transport, scheduler = null, backendId = 'remote', maxRecoveryAttempts = 1 } = {}) {
    if (!transport || typeof transport.execute !== 'function') throw new TypeError('RemoteExecutionBackend requires a transport with execute()');
    if (scheduler && typeof scheduler.schedule !== 'function') throw new TypeError('scheduler must expose schedule()');
    if (!Number.isInteger(maxRecoveryAttempts) || maxRecoveryAttempts < 1) throw new TypeError('maxRecoveryAttempts must be a positive integer');
    if (typeof backendId !== 'string' || !backendId.trim()) throw new TypeError('backendId must be a non-empty string');
    this.transport = transport;
    this.scheduler = scheduler;
    this.backendId = backendId;
    this.maxRecoveryAttempts = maxRecoveryAttempts;
    this.recovery = scheduler ? new RemoteExecutionRecovery({ scheduler, transport, maxAttempts: maxRecoveryAttempts }) : null;
  }

  async execute({ executionId, input = {}, context = {}, capability } = {}) {
    if (typeof executionId !== 'string' || !executionId.trim()) return failed(executionId, 'INVALID_EXECUTION_ID', 'Remote execution requires an execution id');
    const request = {
      schemaVersion: SCHEMA_VERSION,
      executionId,
      command: input.command ?? capability?.execution?.command ?? null,
      args: input.args ?? capability?.execution?.args ?? [],
      input: structuredClone(input),
      capability: capability ? structuredClone(capability) : null,
      timeoutMs: context.timeoutMs ?? null,
    };
    if (request.command !== null && (typeof request.command !== 'string' || !request.command)) return failed(executionId, 'INVALID_COMMAND', 'Remote execution command must be a non-empty string');
    if (!Array.isArray(request.args) || request.args.some((arg) => typeof arg !== 'string')) return failed(executionId, 'INVALID_ARGUMENTS', 'Remote execution args must be an array of strings');

    if (this.recovery) {
      try {
        const capabilityId = capability?.id ?? capability?.name ?? null;
        const result = await this.recovery.execute({
          executionId,
          capabilityId,
          input: { ...structuredClone(input), command: request.command, args: request.args },
          context,
          capability: request.capability,
        });
        if (result.state === 'failed' && result.error) return {
          executionId,
          status: 'failed',
          backend: this.backendId,
          ...(result.attempt !== undefined ? { attempt: result.attempt } : {}),
          error: structuredClone(result.error),
        };
        return normalizeResult(executionId, this.backendId, result);
      } catch (error) {
        if (context.signal?.aborted) return { executionId, status: 'cancelled', backend: this.backendId, error: { code: 'CANCELLED', message: errorMessage(context.signal.reason ?? error), retryable: true } };
        return { executionId, status: 'failed', backend: this.backendId, error: { code: error?.code ?? 'REMOTE_EXECUTION_FAILED', message: errorMessage(error), retryable: error?.retryable === true } };
      }
    }

    try {
      const result = await this.transport.execute(request, { signal: context.signal, timeoutMs: context.timeoutMs });
      return normalizeResult(executionId, this.backendId, result);
    } catch (error) {
      if (context.signal?.aborted) return { executionId, status: 'cancelled', backend: this.backendId, error: { code: 'CANCELLED', message: errorMessage(context.signal.reason ?? error), retryable: true } };
      return { executionId, status: 'failed', backend: this.backendId, error: { code: error?.code ?? 'REMOTE_EXECUTION_FAILED', message: errorMessage(error), retryable: error?.retryable === true } };
    }
  }
}

function normalizeResult(executionId, backend, result) {
  if (!result || typeof result !== 'object') return failed(executionId, 'INVALID_REMOTE_RESULT', 'Remote execution transport returned an invalid result');
  const status = result.status ?? (result.ok === true ? 'succeeded' : 'failed');
  if (!['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status)) return failed(executionId, 'INVALID_REMOTE_STATUS', 'Remote execution transport returned an unsupported status');
  return {
    executionId,
    status,
    backend,
    ...(result.output !== undefined ? { output: structuredClone(result.output) } : {}),
    ...(result.error ? { error: structuredClone(result.error) } : {}),
    ...(result.record ? { record: structuredClone(result.record) } : {}),
    ...(result.remoteExecutionId ? { remoteExecutionId: result.remoteExecutionId } : {}),
    ...(result.workerId ? { workerId: result.workerId } : {}),
    ...(result.leaseId ? { leaseId: result.leaseId } : {}),
    ...(result.fencingToken ? { fencingToken: result.fencingToken } : {}),
    ...(result.attempt !== undefined ? { attempt: result.attempt } : {}),
  };
}
function failed(executionId, code, message) { return { executionId, status: 'failed', backend: 'remote', error: { code, message, retryable: false } }; }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
