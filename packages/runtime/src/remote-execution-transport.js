import { createProtocolEnvelope, RemoteProtocolSession, REMOTE_EXECUTION_PROTOCOL_VERSION } from './remote-execution-protocol.js';
import { RemoteAuthenticationSession } from './remote-execution-auth.js';

const SCHEMA_VERSION = '0.3.0';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export const REMOTE_EXECUTION_TRANSPORT_SCHEMA_VERSION = SCHEMA_VERSION;

export class InMemoryRemoteExecutionTransport {
  #workers = new Map();
  #leases = new Map();
  #clock;
  #leaseTtlMs;
  #nextId = 0;
  #registry;
  #leaseManager;
  #protocolSessions = new Map();
  #supportedProtocolVersions;
  #authSession;

  constructor({ clock = () => Date.now(), leaseTtlMs = 30_000, workerRegistry = null, leaseManager = null, supportedProtocolVersions = [REMOTE_EXECUTION_PROTOCOL_VERSION], authKeyRing = null, authMaxClockSkewMs = undefined } = {}) {
    if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) throw new TypeError('leaseTtlMs must be positive');
    if (workerRegistry && typeof workerRegistry.resolveCapability !== 'function') throw new TypeError('workerRegistry must expose resolveCapability()');
    if (leaseManager && (typeof leaseManager.acquire !== 'function' || typeof leaseManager.validate !== 'function')) throw new TypeError('leaseManager must expose acquire() and validate()');
    this.#clock = clock;
    this.#leaseTtlMs = leaseTtlMs;
    this.#registry = workerRegistry;
    if (!Array.isArray(supportedProtocolVersions) || supportedProtocolVersions.length === 0) throw new TypeError('supportedProtocolVersions must be non-empty');
    this.#leaseManager = leaseManager;
    this.#supportedProtocolVersions = [...new Set(supportedProtocolVersions)];
    this.#authSession = authKeyRing ? new RemoteAuthenticationSession({ keyRing: authKeyRing, clock: this.#clock, ...(authMaxClockSkewMs !== undefined ? { maxClockSkewMs: authMaxClockSkewMs } : {}) }) : null;
  }

  registerWorker({ workerId, execute, capabilities = [], protocolVersions = this.#supportedProtocolVersions, identity = null, authentication = null } = {}) {
    if (typeof workerId !== 'string' || !workerId.trim()) throw new TypeError('workerId must be a non-empty string');
    if (typeof execute !== 'function') throw new TypeError('worker execute handler is required');
    if (!Array.isArray(capabilities) || capabilities.some((value) => typeof value !== 'string' || !value.trim())) throw new TypeError('capabilities must be an array of non-empty strings');
    if (this.#workers.has(workerId)) throw Object.assign(new Error(`Worker already registered: ${workerId}`), { code: 'WORKER_ALREADY_REGISTERED' });
    if (this.#registry) {
      const registration = this.#registry.register({ workerId, capabilities });
      if (registration.state === 'conflict') throw Object.assign(new Error(`Worker already registered: ${workerId}`), { code: 'WORKER_ALREADY_REGISTERED' });
    }
    const session = new RemoteProtocolSession({ supportedVersions: this.#supportedProtocolVersions, clock: this.#clock });
    const negotiation = session.negotiate(protocolVersions);
    if (negotiation.state !== 'negotiated') throw Object.assign(new Error('No compatible remote protocol version'), { code: negotiation.code });
    if (this.#authSession) this.#authenticateWorkerRegistration({ workerId, identity, authentication, protocolVersion: negotiation.protocolVersion, capabilities });
    this.#protocolSessions.set(workerId, session);
    this.#workers.set(workerId, {
      workerId,
      execute,
      capabilities: [...new Set(capabilities)].sort(),
      registeredAt: this.#clock(),
      lastHeartbeatAt: this.#clock(),
    });
    return this.#workerSnapshot(this.#workers.get(workerId));
  }

  heartbeat(workerId, { capabilities, identity = null, authentication = null, requestId = `heartbeat-${workerId}-${this.#clock()}` } = {}) {
    const worker = this.#workers.get(workerId);
    if (!worker) throw Object.assign(new Error(`Worker not found: ${workerId}`), { code: 'WORKER_NOT_FOUND' });
    if (this.#authSession) {
      if (!identity || identity.principalId !== workerId || identity.role !== 'worker') throw Object.assign(new Error('Worker identity does not match heartbeat'), { code: 'INVALID_WORKER_IDENTITY' });
      const envelope = createProtocolEnvelope({ requestId, method: 'heartbeat', payload: { workerId, capabilities }, timestamp: this.#clock() });
      const protocolSession = this.#protocolSessions.get(workerId);
      const protocolAcceptance = protocolSession?.accept(envelope);
      if (protocolAcceptance && !protocolAcceptance.ok) throw Object.assign(new Error(protocolAcceptance.code), { code: protocolAcceptance.code, retryable: protocolAcceptance.retryable });
      const result = this.#authSession.authenticate({ identity, envelope, signature: authentication?.signature, nonce: authentication?.nonce });
      if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code, retryable: result.retryable === true });
      const authorization = this.#authSession.authorize({ identity, method: envelope.method });
      if (!authorization.ok) throw Object.assign(new Error(authorization.code), { code: authorization.code });
    }
    worker.lastHeartbeatAt = this.#clock();
    if (capabilities !== undefined) {
      if (!Array.isArray(capabilities) || capabilities.some((value) => typeof value !== 'string' || !value.trim())) throw new TypeError('capabilities must be an array of non-empty strings');
      worker.capabilities = [...new Set(capabilities)].sort();
    }
    this.#registry?.heartbeat(workerId, { capabilities });
    return this.#workerSnapshot(worker);
  }

  unregisterWorker(workerId) {
    this.#workers.delete(workerId);
    this.#protocolSessions.delete(workerId);
    this.#registry?.remove(workerId);
    const now = this.#clock();
    for (const [id, lease] of this.#leases) {
      if (lease.workerId !== workerId || TERMINAL.has(lease.status)) continue;
      lease.status = 'failed';
      lease.completedAt = now;
      lease.error = { code: 'WORKER_UNREGISTERED', message: 'Remote worker was unregistered', retryable: true };
      if (this.#leaseManager) this.#leaseManager.fence(lease.leaseId, 'worker unregistered', lease.fencingToken);
      this.#leases.set(id, lease);
    }
  }

  listWorkers() {
    const now = this.#clock();
    return Object.freeze([...this.#workers.values()].map((worker) => Object.freeze({
      ...this.#workerSnapshot(worker),
      healthy: now - worker.lastHeartbeatAt <= this.#leaseTtlMs,
    })));
  }

  async execute(request, { signal, workerId = null, leaseId = null, fencingToken = null } = {}) {
    const worker = this.#resolveWorker(request, workerId);
    if (!worker) throw Object.assign(new Error('No healthy remote worker available'), { code: 'NO_HEALTHY_WORKER', retryable: true });

    const session = this.#protocolSessions.get(worker.workerId);
    const envelope = createProtocolEnvelope({
      requestId: request.requestId ?? `req-${request.executionId}-${this.#nextId + 1}`,
      method: 'execute',
      executionId: request.executionId,
      payload: stripAuthentication(request),
      timestamp: this.#clock(),
      deadlineAt: request.deadlineAt ?? null,
      traceId: request.traceId ?? null,
    });
    if (this.#authSession) this.#authenticateControllerRequest(request.authentication, envelope);
    const protocolAcceptance = session?.accept(envelope);
    if (protocolAcceptance && !protocolAcceptance.ok) throw Object.assign(new Error(protocolAcceptance.code), { code: protocolAcceptance.code, retryable: protocolAcceptance.retryable });
    const ownership = this.#ensureLease(request.executionId, worker.workerId, leaseId, fencingToken);
    if (!ownership.ok) throw Object.assign(new Error(ownership.error.message), { code: ownership.error.code, retryable: true });

    const remoteExecutionId = `rex-${++this.#nextId}`;
    const lease = {
      remoteExecutionId,
      executionId: request.executionId,
      workerId: worker.workerId,
      leaseId: ownership.lease.leaseId,
      fencingToken: ownership.lease.fencingToken,
      status: 'running',
      startedAt: this.#clock(),
    };
    this.#leases.set(remoteExecutionId, lease);

    let abortHandler;
    try {
      if (signal?.aborted) throw Object.assign(new Error('Remote execution cancelled'), { code: 'CANCELLED', retryable: true });
      abortHandler = () => {
        lease.status = 'cancelled';
        lease.completedAt = this.#clock();
      };
      signal?.addEventListener('abort', abortHandler, { once: true });

      const result = await worker.execute(structuredClone(envelope.payload), {
        signal,
        workerId: worker.workerId,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
      });

      if (lease.status === 'cancelled') {
        this.#leaseManager?.release(lease.leaseId, 'cancelled');
        return this.#terminal(lease, 'cancelled', { code: 'CANCELLED', message: 'Remote execution cancelled', retryable: true });
      }

      const validation = this.#validateLease(lease);
      if (!validation.ok) throw Object.assign(new Error(validation.error.message), { code: validation.error.code, retryable: true });

      const normalized = normalizeWorkerResult(result);
      lease.status = normalized.status;
      lease.completedAt = this.#clock();
      if (this.#leaseManager && normalized.status === 'succeeded') this.#leaseManager.release(lease.leaseId, 'released');
      return {
        ...normalized,
        remoteExecutionId,
        workerId: worker.workerId,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
      };
    } catch (error) {
      if (lease.status === 'cancelled' || signal?.aborted) {
        lease.status = 'cancelled';
        lease.completedAt = this.#clock();
        this.#leaseManager?.release(lease.leaseId, 'cancelled');
        return this.#terminal(lease, 'cancelled', { code: 'CANCELLED', message: errorMessage(error), retryable: true });
      }
      lease.status = 'failed';
      lease.completedAt = this.#clock();
      const retryable = error?.retryable === true || ['STALE_FENCING_TOKEN', 'LEASE_NOT_ACTIVE', 'LEASE_EXPIRED', 'WORKER_UNHEALTHY'].includes(error?.code);
      if (this.#leaseManager && retryable) this.#leaseManager.fence(lease.leaseId, error?.message ?? 'remote execution lost');
      else this.#leaseManager?.release(lease.leaseId, 'released');
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { retryable });
    } finally {
      if (abortHandler) signal?.removeEventListener('abort', abortHandler);
    }
  }

  #authenticateWorkerRegistration({ workerId, identity, authentication, protocolVersion, capabilities }) {
    if (!identity || identity.principalId !== workerId || identity.role !== 'worker') throw Object.assign(new Error('Worker identity does not match registration'), { code: 'INVALID_WORKER_IDENTITY' });
    const envelope = createProtocolEnvelope({
      protocolVersion,
      requestId: `register-${workerId}`,
      method: 'heartbeat',
      payload: { workerId, capabilities },
      timestamp: this.#clock(),
    });
    const result = this.#authSession.authenticate({ identity, envelope, signature: authentication?.signature, nonce: authentication?.nonce });
    if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code, retryable: result.retryable === true });
    const authorization = this.#authSession.authorize({ identity, method: envelope.method });
    if (!authorization.ok) throw Object.assign(new Error(authorization.code), { code: authorization.code });
  }

  #authenticateControllerRequest(authentication, envelope) {
    if (!authentication?.identity || authentication.identity.role !== 'controller') throw Object.assign(new Error('Controller authentication is required'), { code: 'AUTHENTICATION_REQUIRED' });
    const result = this.#authSession.authenticate({ identity: authentication.identity, envelope, signature: authentication.signature, nonce: authentication.nonce });
    if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code, retryable: result.retryable === true });
    const authorization = this.#authSession.authorize({ identity: authentication.identity, method: envelope.method });
    if (!authorization.ok) throw Object.assign(new Error(authorization.code), { code: authorization.code });
  }

  inspect(remoteExecutionId) {
    const lease = this.#leases.get(remoteExecutionId);
    return lease ? Object.freeze({ ...lease }) : null;
  }

  #resolveWorker(request, requestedWorkerId) {
    const capabilityId = request?.capability?.id ?? request?.capability?.name;
    if (requestedWorkerId) {
      const worker = this.#workers.get(requestedWorkerId);
      if (!worker || this.#clock() - worker.lastHeartbeatAt > this.#leaseTtlMs) return null;
      const registered = this.#registry?.get?.(requestedWorkerId);
      if (registered?.state === 'unhealthy') return null;
      if (capabilityId && !worker.capabilities.includes(capabilityId)) return null;
      return worker;
    }
    if (this.#registry && capabilityId) {
      const selected = this.#registry.resolveCapability(capabilityId);
      return selected ? this.#workers.get(selected.workerId) ?? null : null;
    }
    const now = this.#clock();
    return [...this.#workers.values()].find((worker) => now - worker.lastHeartbeatAt <= this.#leaseTtlMs) ?? null;
  }

  #ensureLease(executionId, workerId, leaseId, fencingToken) {
    if (!this.#leaseManager) {
      const lease = leaseId ? this.#leases.get(leaseId) : null;
      if (lease) return { ok: true, lease };
      return {
        ok: true,
        lease: { leaseId: `local-${executionId}`, fencingToken: 'local', executionId, workerId, status: 'active' },
      };
    }
    if (leaseId) {
      const validation = this.#leaseManager.validate(leaseId, fencingToken, workerId);
      return validation.state === 'valid'
        ? { ok: true, lease: validation.lease }
        : { ok: false, error: { code: validation.code, message: validation.code } };
    }
    const acquired = this.#leaseManager.acquire({ executionId, workerId });
    return acquired.state === 'acquired'
      ? { ok: true, lease: acquired.lease }
      : { ok: false, error: { code: acquired.code, message: acquired.code } };
  }

  #validateLease(lease) {
    if (!this.#leaseManager) return { ok: true };
    const result = this.#leaseManager.validate(lease.leaseId, lease.fencingToken, lease.workerId);
    return result.state === 'valid'
      ? { ok: true }
      : { ok: false, error: { code: result.code, message: result.code } };
  }

  #terminal(lease, status, error) {
    return {
      remoteExecutionId: lease.remoteExecutionId,
      status,
      error,
      workerId: lease.workerId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
    };
  }

  #workerSnapshot(worker) {
    return {
      workerId: worker.workerId,
      capabilities: [...worker.capabilities],
      registeredAt: worker.registeredAt,
      lastHeartbeatAt: worker.lastHeartbeatAt,
    };
  }
}

function stripAuthentication(request) {
  const { authentication: _authentication, ...payload } = request ?? {};
  return payload;
}

function normalizeWorkerResult(result) {
  if (!result || typeof result !== 'object') throw Object.assign(new Error('Worker returned invalid result'), { code: 'INVALID_WORKER_RESULT', retryable: false });
  const status = result.status ?? (result.ok === true ? 'succeeded' : 'failed');
  if (!TERMINAL.has(status)) throw Object.assign(new Error('Worker returned unsupported status'), { code: 'INVALID_WORKER_STATUS', retryable: false });
  return {
    status,
    ...(result.output !== undefined ? { output: structuredClone(result.output) } : {}),
    ...(result.error ? { error: structuredClone(result.error) } : {}),
  };
}

function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
