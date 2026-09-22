const SCHEMA_VERSION = '0.1.0';
export const REMOTE_RECOVERY_COORDINATOR_SCHEMA_VERSION = SCHEMA_VERSION;

export class RemoteRecoveryCoordinator {
  #inFlight = new Map();

  async run(executionId, operation) {
    if (typeof executionId !== 'string' || !executionId.trim()) throw new TypeError('executionId is required');
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    const existing = this.#inFlight.get(executionId);
    if (existing) return existing;
    const promise = Promise.resolve().then(operation).finally(() => {
      if (this.#inFlight.get(executionId) === promise) this.#inFlight.delete(executionId);
    });
    this.#inFlight.set(executionId, promise);
    return promise;
  }

  has(executionId) { return this.#inFlight.has(executionId); }
  size() { return this.#inFlight.size; }
}
