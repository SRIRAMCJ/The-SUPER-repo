export class ExecutionCancellationRegistry {
  #entries = new Map();

  register(executionId, controller) {
    if (!executionId || !controller) throw new TypeError('Cancellation registration requires executionId and controller');
    if (this.#entries.has(executionId)) throw Object.assign(new Error(`Execution is already registered: ${executionId}`), { code: 'EXECUTION_ALREADY_REGISTERED', retryable: false });
    let rejectCancellation;
    const promise = new Promise((_, reject) => { rejectCancellation = reject; });
    promise.catch(() => {});
    this.#entries.set(executionId, { controller, rejectCancellation });
    return promise;
  }

  cancel(executionId, reason = 'Execution cancelled') {
    const entry = this.#entries.get(executionId);
    if (!entry) return false;
    const error = Object.assign(new Error(reason), { code: 'EXECUTION_CANCELLED', retryable: false });
    entry.controller.abort(error);
    entry.rejectCancellation(error);
    return true;
  }

  has(executionId) {
    return this.#entries.has(executionId);
  }

  unregister(executionId) {
    return this.#entries.delete(executionId);
  }
}
