import { installProcessShutdown } from './process-shutdown.js';

// Opt-in deployment composition. The caller owns the stable incident identity
// and the recovery effect adapter; this host only schedules and drains them.
export class RuntimeDeploymentHost {
  #running = false;
  #pending = null;
  #timer = null;
  #controller = null;
  #signals = null;
  #operation = null;

  constructor({ coordinator, failover, incidentId, name, intervalMs = 1000, pollTimeoutMs = 1000, attemptTimeoutMs = 65_000, onResult = () => {}, processRef, signalDeadlineMs = 30_000 } = {}) {
    if (!coordinator || typeof coordinator.start !== 'function' || typeof coordinator.shutdown !== 'function' || !coordinator.admission) throw new TypeError('coordinator with admission is required');
    if (!failover || typeof failover.attempt !== 'function' || typeof incidentId !== 'function' || typeof onResult !== 'function') throw new TypeError('failover, incidentId and onResult are required');
    if (typeof name !== 'string' || !name.trim() || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || !Number.isSafeInteger(pollTimeoutMs) || pollTimeoutMs < 1 || !Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs < 1) throw new TypeError('name and positive polling deadlines are required');
    this.coordinator = coordinator;
    this.admission = coordinator.admission;
    this.failover = failover;
    this.incidentId = incidentId;
    this.name = name;
    this.intervalMs = intervalMs;
    this.pollTimeoutMs = pollTimeoutMs;
    this.attemptTimeoutMs = attemptTimeoutMs;
    this.onResult = onResult;
    this.processRef = processRef;
    this.signalDeadlineMs = signalDeadlineMs;
  }

  async start() {
    if (this.#operation || this.#running) throw new Error('Deployment host already starting or running');
    this.#operation = 'start';
    try {
      await this.coordinator.start();
      this.#controller = new AbortController();
      this.#running = true;
      if (this.processRef) this.#signals = installProcessShutdown({ coordinator: this, processRef: this.processRef, deadlineMs: this.signalDeadlineMs });
      this.#schedule(0);
    } catch (error) {
      this.#running = false;
      this.#signals?.dispose(); this.#signals = null;
      if (this.coordinator.lifecycle.getState().state === 'running') await this.coordinator.shutdown();
      throw error;
    } finally { this.#operation = null; }
  }

  shutdown(options) {
    if (this.#operation === 'shutdown') return this.#pending;
    if (this.#operation) throw new Error('Deployment host operation in progress');
    this.#operation = 'shutdown';
    this.#running = false;
    clearTimeout(this.#timer);
    this.#controller?.abort();
    // coordinator.shutdown closes admission synchronously.
    let draining;
    try { draining = this.coordinator.shutdown(options); }
    catch (error) { this.#operation = null; throw error; }
    const active = this.#pending;
    const operation = (async () => {
      try { await active; return await draining; }
      finally { this.#signals?.dispose(); this.#signals = null; this.#operation = null; this.#pending = null; }
    })();
    this.#pending = operation;
    return operation;
  }

  #schedule(delay) {
    if (this.#running) this.#timer = setTimeout(() => { this.#pending = this.#tick(); }, delay);
  }

  async #tick() {
    try {
      const id = await boundedIncident(this.incidentId, this.#controller.signal, this.pollTimeoutMs);
      if (this.#running && typeof id === 'string' && id.trim()) {
        const result = await boundedCall(() => this.failover.attempt(this.name, id, { signal: this.#controller.signal }), this.#controller.signal, this.attemptTimeoutMs, 'RECOVERY_ATTEMPT_TIMEOUT');
        this.#emit(result);
      }
    } catch (error) {
      if (error?.code === 'RECOVERY_ATTEMPT_TIMEOUT') {
        this.#running = false;
        this.admission.forceStop();
      }
      this.#emit({ status: 'error', error });
    }
    finally { this.#schedule(this.intervalMs); }
  }

  #emit(result) { try { this.onResult(result); } catch { /* Observer failure must not stop supervision. */ } }
}

async function boundedIncident(provider, signal, timeoutMs) {
  return boundedCall(() => provider({ signal }), signal, timeoutMs);
}

async function boundedCall(work, signal, timeoutMs, timeoutCode = 'INCIDENT_TIMEOUT') {
  let timer, abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(Object.assign(new Error('Incident polling cancelled'), { code: 'INCIDENT_CANCELLED' }));
    signal.addEventListener('abort', abort, { once: true });
  });
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(timeoutCode), { code: timeoutCode })), timeoutMs); });
  try {
    if (signal.aborted) abort();
    return await Promise.race([Promise.resolve().then(work), cancelled, timeout]);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
