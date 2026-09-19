const SCHEMA_VERSION = '0.1.0';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export const REMOTE_EXECUTION_TRANSPORT_SCHEMA_VERSION = SCHEMA_VERSION;

export class InMemoryRemoteExecutionTransport {
  #workers = new Map();
  #leases = new Map();
  #clock;
  #leaseTtlMs;
  #nextId = 0;

  constructor({ clock = () => Date.now(), leaseTtlMs = 30_000 } = {}) {
    if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) throw new TypeError('leaseTtlMs must be positive');
    this.#clock = clock;
    this.#leaseTtlMs = leaseTtlMs;
  }

  registerWorker({ workerId, execute } = {}) {
    if (typeof workerId !== 'string' || !workerId.trim()) throw new TypeError('workerId must be a non-empty string');
    if (typeof execute !== 'function') throw new TypeError('worker execute handler is required');
    if (this.#workers.has(workerId)) throw Object.assign(new Error(`Worker already registered: ${workerId}`), { code: 'WORKER_ALREADY_REGISTERED' });
    this.#workers.set(workerId, { workerId, execute, registeredAt: this.#clock(), lastHeartbeatAt: this.#clock() });
    return this.#workerSnapshot(this.#workers.get(workerId));
  }

  heartbeat(workerId) {
    const worker = this.#workers.get(workerId);
    if (!worker) throw Object.assign(new Error(`Worker not found: ${workerId}`), { code: 'WORKER_NOT_FOUND' });
    worker.lastHeartbeatAt = this.#clock();
    return this.#workerSnapshot(worker);
  }

  unregisterWorker(workerId) {
    this.#workers.delete(workerId);
    for (const [id, lease] of this.#leases) {
      if (lease.workerId === workerId && !TERMINAL.has(lease.status)) this.#leases.delete(id);
    }
  }

  listWorkers() {
    const now = this.#clock();
    return Object.freeze([...this.#workers.values()].map((worker) => Object.freeze({
      ...this.#workerSnapshot(worker),
      healthy: now - worker.lastHeartbeatAt <= this.#leaseTtlMs,
    })));
  }

  async execute(request, { signal } = {}) {
    const worker = this.#selectWorker();
    if (!worker) throw Object.assign(new Error('No healthy remote worker available'), { code: 'NO_HEALTHY_WORKER', retryable: true });

    const remoteExecutionId = `rex-${++this.#nextId}`;
    const lease = { remoteExecutionId, executionId: request.executionId, workerId: worker.workerId, status: 'running', startedAt: this.#clock() };
    this.#leases.set(remoteExecutionId, lease);

    let abortHandler;
    try {
      if (signal?.aborted) throw Object.assign(new Error('Remote execution cancelled'), { code: 'CANCELLED', retryable: true });
      abortHandler = () => { lease.status = 'cancelled'; lease.completedAt = this.#clock(); };
      signal?.addEventListener('abort', abortHandler, { once: true });
      const result = await worker.execute(structuredClone(request), { signal });
      if (lease.status === 'cancelled') return { remoteExecutionId, status: 'cancelled', error: { code: 'CANCELLED', message: 'Remote execution cancelled', retryable: true } };
      const normalized = normalizeWorkerResult(result);
      lease.status = normalized.status;
      lease.completedAt = this.#clock();
      return { ...normalized, remoteExecutionId };
    } catch (error) {
      if (lease.status === 'cancelled' || signal?.aborted) {
        lease.status = 'cancelled';
        lease.completedAt = this.#clock();
        return { remoteExecutionId, status: 'cancelled', error: { code: 'CANCELLED', message: errorMessage(error), retryable: true } };
      }
      lease.status = 'failed';
      lease.completedAt = this.#clock();
      throw error;
    } finally {
      if (abortHandler) signal?.removeEventListener('abort', abortHandler);
    }
  }

  inspect(remoteExecutionId) {
    const lease = this.#leases.get(remoteExecutionId);
    if (!lease) return null;
    return Object.freeze({ ...lease });
  }

  #selectWorker() {
    const now = this.#clock();
    return [...this.#workers.values()].find((worker) => now - worker.lastHeartbeatAt <= this.#leaseTtlMs) ?? null;
  }

  #workerSnapshot(worker) {
    return { workerId: worker.workerId, registeredAt: worker.registeredAt, lastHeartbeatAt: worker.lastHeartbeatAt };
  }
}

function normalizeWorkerResult(result) {
  if (!result || typeof result !== 'object') throw Object.assign(new Error('Worker returned invalid result'), { code: 'INVALID_WORKER_RESULT', retryable: false });
  const status = result.status ?? (result.ok === true ? 'succeeded' : 'failed');
  if (!TERMINAL.has(status)) throw Object.assign(new Error('Worker returned unsupported status'), { code: 'INVALID_WORKER_STATUS', retryable: false });
  return { status, ...(result.output !== undefined ? { output: structuredClone(result.output) } : {}), ...(result.error ? { error: structuredClone(result.error) } : {}) };
}

function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
