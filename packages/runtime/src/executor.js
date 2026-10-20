import { createExecutionId } from './events.js';
import { ExecutionCancellationRegistry } from './cancellation.js';

export class ExecutionEngine {
  constructor({ registry, events = null, verifier = null, policy = null, shutdownAdmission = null, clock = () => new Date(), cancellation = new ExecutionCancellationRegistry() }) {
    if (!registry) throw new TypeError('ExecutionEngine requires a capability registry');
    if (shutdownAdmission && (typeof shutdownAdmission.admit !== 'function' || typeof shutdownAdmission.release !== 'function')) throw new TypeError('shutdownAdmission must expose admit() and release()');
    this.registry = registry;
    this.events = events;
    this.verifier = verifier;
    this.policy = policy;
    this.clock = clock;
    this.cancellation = cancellation;
    this.shutdownAdmission = shutdownAdmission;
  }

  cancel(executionId, reason = 'Execution cancelled') {
    return this.cancellation.cancel(executionId, reason);
  }

  async execute(capabilityId, input = {}, context = {}) {
    const entry = this.registry.require(capabilityId);
    const { manifest, handler } = entry;
    const executionId = context.executionId ?? createExecutionId();
    const startedAt = this.clock().toISOString();

    if (this.policy) {
      const decision = this.policy.authorize(manifest, context);
      if (!decision.allowed) {
        const error = { code:'POLICY_DENIED', message:decision.reason, retryable:false };
        this.#emit({ type:'execution.denied', executionId, capabilityId, status:'denied', error });
        this.#emit({ type:'execution.failed', executionId, capabilityId, status:'failed', error });
        return { executionId, capabilityId, status:'failed', startedAt, finishedAt:this.clock().toISOString(), error };
      }
    }

    if (context.signal?.aborted) {
      const error = { code: 'EXECUTION_CANCELLED', message: 'Execution cancelled before dispatch', retryable: false };
      return { executionId, capabilityId, status: 'failed', startedAt, finishedAt: this.clock().toISOString(), error };
    }
    let shutdownLease = null;
    if (this.shutdownAdmission) {
      try { shutdownLease = this.shutdownAdmission.admit(executionId); }
      catch (error) {
        const failure = { code: error.code ?? 'ADMISSION_CLOSED', message: error.message, retryable: true };
        this.#emit({ type: 'execution.denied', executionId, capabilityId, status: 'denied', error: failure });
        return { executionId, capabilityId, status: 'failed', startedAt, finishedAt: this.clock().toISOString(), error: failure };
      }
    }
    let handlerPending = false;
    let callerFinished = false;
    const releaseAdmission = () => { if (shutdownLease) { this.shutdownAdmission.release(shutdownLease); shutdownLease = null; } };
    const controller = new AbortController();
    let cancellation;
    let removeExternalAbort = null;
    try {
      cancellation = this.cancellation.register(executionId, controller);
      this.#emit({ type:'execution.started', executionId, capabilityId, status:'started', data:{ input, context } });
      const externalCancellation = externalSignalPromise(context.signal, controller, cancellationReason(context.signal));
      removeExternalAbort = externalCancellation.cleanup;
      const timeoutMs = Number.isFinite(manifest.timeoutSeconds) ? manifest.timeoutSeconds * 1000 : null;
      handlerPending = true;
      const handlerPromise = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason ?? Object.assign(new Error('Execution cancelled'), { code: 'EXECUTION_CANCELLED' });
        return handler(input, {
        executionId,
        capability: manifest,
        context,
        signal: controller.signal,
        emit: (data) => this.#emit({ type:'execution.progress', executionId, capabilityId, status:'progress', data })
        });
      });
      const settle = () => { handlerPending = false; if (callerFinished) releaseAdmission(); };
      handlerPromise.then(settle, settle);
      const output = timeoutMs
        ? await withTimeout(handlerPromise, timeoutMs, controller, manifest.id, cancellation, externalCancellation.promise)
        : await Promise.race([handlerPromise, cancellation, externalCancellation.promise]);
      const verification = this.verifier
        ? await this.verifier.verify({ capability: manifest, input, output, context })
        : { verified: true, checks: 0, failures: [] };
      this.#emit({ type:'execution.verified', executionId, capabilityId, status: verification.verified ? 'verified' : 'rejected', data: verification });
      if (!verification.verified) {
        const error = { code:'VERIFICATION_FAILED', message:'Execution output failed verification', retryable:false, details:verification.failures };
        this.#emit({ type:'execution.failed', executionId, capabilityId, status:'failed', error });
        return { executionId, capabilityId, status:'failed', startedAt, finishedAt:this.clock().toISOString(), error, verification };
      }
      this.#emit({ type:'execution.completed', executionId, capabilityId, status:'completed', data:{ output } });
      return { executionId, capabilityId, status:'succeeded', startedAt, finishedAt:this.clock().toISOString(), output, verification };
    } catch (error) {
      const normalized = normalizeError(error);
      this.#emit({ type:'execution.failed', executionId, capabilityId, status:'failed', error:normalized });
      return { executionId, capabilityId, status:'failed', startedAt, finishedAt:this.clock().toISOString(), error:normalized };
    } finally {
      callerFinished = true;
      if (!handlerPending) releaseAdmission();
      removeExternalAbort?.();
      if (cancellation) this.cancellation.unregister(executionId);
    }
  }

  #emit(event) { return this.events?.emit(event); }
}

function externalSignalPromise(signal, controller, reason) {
  if (!signal || typeof signal.addEventListener !== 'function') return { promise: new Promise(() => {}), cleanup: () => {} };
  let rejectSignal;
  const promise = new Promise((_, reject) => { rejectSignal = reject; });
  const abort = () => {
    const error = cancellationReason(signal) ?? reason ?? Object.assign(new Error('Execution cancelled by parent'), { code:'EXECUTION_CANCELLED', retryable:false });
    controller.abort(error);
    rejectSignal(error);
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return { promise, cleanup: () => signal.removeEventListener('abort', abort) };
}

function cancellationReason(signal) {
  if (!signal?.reason) return null;
  return typeof signal.reason?.code === 'string' ? signal.reason : Object.assign(new Error(String(signal.reason)), { code:'EXECUTION_CANCELLED', retryable:false });
}

async function withTimeout(promise, timeoutMs, controller, capabilityId, cancellation, externalCancellation) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error(`Execution timed out after ${timeoutMs}ms: ${capabilityId}`), { code:'EXECUTION_TIMEOUT', retryable:true }));
    }, timeoutMs);
  });
  try { return await Promise.race([promise, timeout, cancellation, externalCancellation]); }
  finally { clearTimeout(timer); }
}

function normalizeError(error) {
  return { code:error?.code ?? 'EXECUTION_ERROR', message:error instanceof Error ? error.message : String(error), retryable:Boolean(error?.retryable) };
}
