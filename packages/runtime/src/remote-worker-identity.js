const SCHEMA_VERSION = '0.1.0';
export const REMOTE_WORKER_IDENTITY_SCHEMA_VERSION = SCHEMA_VERSION;

export class RemoteWorkerIdentityRegistry {
  #workers = new Map();
  #sequence = 0;

  register(workerId) {
    if (typeof workerId !== 'string' || !workerId.trim()) throw new TypeError('workerId must be a non-empty string');
    const previous = this.#workers.get(workerId);
    const incarnation = `${workerId}-inc-${++this.#sequence}`;
    const worker = Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      workerId,
      workerInstanceId: incarnation,
      incarnation,
      generation: (previous?.generation ?? 0) + 1,
      heartbeatSequence: 0,
    });
    this.#workers.set(workerId, worker);
    return structuredClone(worker);
  }

  heartbeat(workerId, workerInstanceId, sequence) {
    const worker = this.#workers.get(workerId);
    if (!worker) return { state: 'not_found', code: 'WORKER_NOT_FOUND' };
    if (worker.workerInstanceId !== workerInstanceId) return { state: 'rejected', code: 'STALE_WORKER_INSTANCE' };
    if (!Number.isSafeInteger(sequence) || sequence <= worker.heartbeatSequence) {
      return { state: 'rejected', code: 'STALE_HEARTBEAT_SEQUENCE', lastAcceptedSequence: worker.heartbeatSequence };
    }
    const next = Object.freeze({ ...worker, heartbeatSequence: sequence });
    this.#workers.set(workerId, next);
    return { state: 'accepted', worker: structuredClone(next) };
  }

  get(workerId) { const worker = this.#workers.get(workerId); return worker ? structuredClone(worker) : null; }
  list() { return [...this.#workers.values()].map(structuredClone); }
}
