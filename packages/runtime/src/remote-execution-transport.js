const SCHEMA_VERSION = '0.2.0';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
export const REMOTE_EXECUTION_TRANSPORT_SCHEMA_VERSION = SCHEMA_VERSION;

export class InMemoryRemoteExecutionTransport {
  #workers = new Map(); #leases = new Map(); #clock; #leaseTtlMs; #nextId = 0; #registry; #leaseManager;
  constructor({ clock = () => Date.now(), leaseTtlMs = 30_000, workerRegistry = null, leaseManager = null } = {}) {
    if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) throw new TypeError('leaseTtlMs must be positive');
    if (workerRegistry && typeof workerRegistry.resolveCapability !== 'function') throw new TypeError('workerRegistry must expose resolveCapability()');
    if (leaseManager && (typeof leaseManager.acquire !== 'function' || typeof leaseManager.validate !== 'function')) throw new TypeError('leaseManager must expose acquire() and validate()');
    this.#clock = clock; this.#leaseTtlMs = leaseTtlMs; this.#registry = workerRegistry; this.#leaseManager = leaseManager;
  }

  registerWorker({ workerId, execute, capabilities = [] } = {}) {
    if (typeof workerId !== 'string' || !workerId.trim()) throw new TypeError('workerId must be a non-empty string');
    if (typeof execute !== 'function') throw new TypeError('worker execute handler is required');
    if (this.#workers.has(workerId)) throw Object.assign(new Error(`Worker already registered: ${workerId}`), { code: 'WORKER_ALREADY_REGISTERED' });
    if (this.#registry) {
      const registration = this.#registry.register({ workerId, capabilities });
      if (registration.state === 'conflict') throw Object.assign(new Error(`Worker already registered: ${workerId}`), { code: 'WORKER_ALREADY_REGISTERED' });
    }
    this.#workers.set(workerId, { workerId, execute, registeredAt: this.#clock(), lastHeartbeatAt: this.#clock() });
    return this.#workerSnapshot(this.#workers.get(workerId));
  }

  heartbeat(workerId, { capabilities } = {}) {
    const worker = this.#workers.get(workerId);
    if (!worker) throw Object.assign(new Error(`Worker not found: ${workerId}`), { code: 'WORKER_NOT_FOUND' });
    worker.lastHeartbeatAt = this.#clock();
    this.#registry?.heartbeat(workerId, { capabilities });
    return this.#workerSnapshot(worker);
  }

  unregisterWorker(workerId) {
    this.#workers.delete(workerId); this.#registry?.remove(workerId);
    const now = this.#clock();
    for (const [id, lease] of this.#leases) {
      if (lease.workerId !== workerId || TERMINAL.has(lease.status)) continue;
      lease.status = 'failed'; lease.completedAt = now; lease.error = { code: 'WORKER_UNREGISTERED', message: 'Remote worker was unregistered', retryable: true };
      if (this.#leaseManager) this.#leaseManager.fence(lease.leaseId, 'worker unregistered', lease.fencingToken);
      this.#leases.set(id, lease);
    }
  }

  listWorkers() {
    const now = this.#clock();
    return Object.freeze([...this.#workers.values()].map((worker) => Object.freeze({
      ...this.#workerSnapshot(worker), healthy: now - worker.lastHeartbeatAt <= this.#leaseTtlMs,
    })));
  }

  async execute(request, { signal, workerId = null, leaseId = null, fencingToken = null } = {}) {
    const worker = this.#resolveWorker(request, workerId);
    if (!worker) throw Object.assign(new Error('No healthy remote worker available'), { code: 'NO_HEALTHY_WORKER', retryable: true });
    const ownership = this.#ensureLease(request.executionId, worker.workerId, leaseId, fencingToken);
    if (!ownership.ok) throw Object.assign(new Error(ownership.error.message), { code: ownership.error.code, retryable: true });
    const remoteExecutionId = `rex-${++this.#nextId}`;
    const lease = { remoteExecutionId, executionId: request.executionId, workerId: worker.workerId, leaseId: ownership.lease.leaseId, fencingToken: ownership.lease.fencingToken, status: 'running', startedAt: this.#clock() };
    this.#leases.set(remoteExecutionId, lease);
    let abortHandler;
    try {
      if (signal?.aborted) throw Object.assign(new Error('Remote execution cancelled'), { code: 'CANCELLED', retryable: true });
      abortHandler = () => { lease.status = 'cancelled'; lease.completedAt = this.#clock(); };
      signal?.addEventListener('abort', abortHandler, { once: true });
      const result = await worker.execute(structuredClone(request), { signal, workerId: worker.workerId, leaseId: lease.leaseId, fencingToken: lease.fencingToken });
      if (lease.status === 'cancelled') return this.#terminal(lease, 'cancelled', { code: 'CANCELLED', message: 'Remote execution cancelled', retryable: true });
      const validation = this.#validateLease(lease);
      if (!validation.ok) throw Object.assign(new Error(validation.error.message), { code: validation.error.code, retryable: true });
      const normalized = normalizeWorkerResult(result);
      lease.status = normalized.status; lease.completedAt = this.#clock();
      if (this.#leaseManager && normalized.status === 'succeeded') this.#leaseManager.release(lease.leaseId, 'released');
      return { ...normalized, remoteExecutionId, workerId: worker.workerId, leaseId: lease.leaseId, fencingToken: lease.fencingToken };
    } catch (error) {
      if (lease.status === 'cancelled' || signal?.aborted) {
        lease.status = 'cancelled'; lease.completedAt = this.#clock();
        this.#leaseManager?.release(lease.leaseId, 'cancelled');
        return this.#terminal(lease, 'cancelled', { code: 'CANCELLED', message: errorMessage(error), retryable: true });
      }
      lease.status = 'failed'; lease.completedAt = this.#clock();
      const retryable = error?.retryable === true || ['STALE_FENCING_TOKEN','LEASE_NOT_ACTIVE','LEASE_EXPIRED','WORKER_UNHEALTHY'].includes(error?.code);
      if (this.#leaseManager && retryable) this.#leaseManager.fence(lease.leaseId, error?.message ?? 'remote execution lost');
      else this.#leaseManager?.release(lease.leaseId, 'released');
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { retryable });
    } finally { if (abortHandler) signal?.removeEventListener('abort', abortHandler); }
  }

  inspect(remoteExecutionId) { const lease=this.#leases.get(remoteExecutionId); return lease ? Object.freeze({...lease}) : null; }

  #resolveWorker(request, requestedWorkerId) {
    if (requestedWorkerId) {
      const worker=this.#workers.get(requestedWorkerId);
      if (!worker || this.#clock()-worker.lastHeartbeatAt>this.#leaseTtlMs) return null;
      const registered=this.#registry?.get?.(requestedWorkerId);
      if (registered?.state==='unhealthy') return null;
      const capabilityId=request.capability?.id ?? request.capability?.name;
      if (capabilityId && registered && !registered.capabilities.includes(capabilityId)) return null;
      return worker;
    }
    const capabilityId=request.capability?.id ?? request.capability?.name;
    if (this.#registry && capabilityId) {
      const selected=this.#registry.resolveCapability(capabilityId);
      return selected ? this.#workers.get(selected.workerId) ?? null : null;
    }
    const now=this.#clock();
    return [...this.#workers.values()].find(w=>now-w.lastHeartbeatAt<=this.#leaseTtlMs) ?? null;
  }

  #ensureLease(executionId, workerId, leaseId, fencingToken) {
    if (!this.#leaseManager) {
      const legacy=leaseId ? this.#leases.get(leaseId) : null;
      if (legacy) return {ok:true,lease:legacy};
      const lease={leaseId:`local-${executionId}`,fencingToken:'local',executionId,workerId,status:'active'};
      return {ok:true,lease};
    }
    if (leaseId) {
      const validation=this.#leaseManager.validate(leaseId,fencingToken,workerId);
      return validation.state==='valid' ? {ok:true,lease:validation.lease} : {ok:false,error:{code:validation.code,message:validation.code}};
    }
    const acquired=this.#leaseManager.acquire({executionId,workerId});
    return acquired.state==='acquired' ? {ok:true,lease:acquired.lease} : {ok:false,error:{code:acquired.code,message:acquired.code}};
  }

  #validateLease(lease) {
    if (!this.#leaseManager) return {ok:true};
    const result=this.#leaseManager.validate(lease.leaseId,lease.fencingToken,lease.workerId);
    return result.state==='valid' ? {ok:true} : {ok:false,error:{code:result.code,message:result.code}};
  }

  #terminal(lease,status,error) { return {remoteExecutionId:lease.remoteExecutionId,status,error,workerId:lease.workerId,leaseId:lease.leaseId,fencingToken:lease.fencingToken}; }
  #workerSnapshot(worker) { return {workerId:worker.workerId,registeredAt:worker.registeredAt,lastHeartbeatAt:worker.lastHeartbeatAt}; }
}

function normalizeWorkerResult(result) {
  if (!result || typeof result !== 'object') throw Object.assign(new Error('Worker returned invalid result'), { code: 'INVALID_WORKER_RESULT', retryable: false });
  const status=result.status ?? (result.ok===true?'succeeded':'failed');
  if (!TERMINAL.has(status)) throw Object.assign(new Error('Worker returned unsupported status'), { code:'INVALID_WORKER_STATUS', retryable:false });
  return {status,...(result.output!==undefined?{output:structuredClone(result.output)}:{}),...(result.error?{error:structuredClone(result.error)}:{})};
}
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
