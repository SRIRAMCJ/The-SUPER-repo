// Coordinates one lifecycle and its in-process execution admission gate.
export class RuntimeShutdownCoordinator {
  #operation = null;
  #operationName = null;

  constructor({ lifecycle, admission } = {}) {
    if (!lifecycle || typeof lifecycle.start !== 'function' || typeof lifecycle.drain !== 'function' || typeof lifecycle.stop !== 'function' || typeof lifecycle.getState !== 'function') throw new TypeError('lifecycle must expose start(), drain(), stop(), and getState()');
    if (!admission || typeof admission.state !== 'function' || typeof admission.snapshot !== 'function' || typeof admission.activeExecutions !== 'function' || typeof admission.beginDrain !== 'function' || typeof admission.waitForDrain !== 'function' || typeof admission.forceStop !== 'function' || typeof admission.reopen !== 'function') throw new TypeError('admission must expose the shutdown gate interface');
    if (admission.activeExecutions().length || !['accepting', 'stopped'].includes(admission.state())) throw new Error('Coordinator requires an idle admission gate');
    this.lifecycle = lifecycle;
    this.admission = admission;
    // Do not admit work before lifecycle startup finishes.
    admission.forceStop();
  }

  snapshot() { return Object.freeze({ lifecycle: this.lifecycle.getState(), admission: this.admission.snapshot(), operation: this.#operationName }); }

  start() {
    if (this.#operation) throw new Error(`Runtime operation in progress: ${this.#operationName}`);
    if (this.admission.state() !== 'stopped' || this.admission.activeExecutions().length) throw new Error('Admission must be stopped and idle before start');
    this.#operationName = 'start';
    this.#operation = (async () => {
      try {
        await this.lifecycle.start();
        this.admission.reopen();
        return this.snapshot();
      } finally { this.#operation = null; this.#operationName = null; }
    })();
    return this.#operation;
  }

  shutdown({ deadlineMs = 30_000, signal } = {}) {
    if (this.#operation) {
      if (this.#operationName === 'shutdown') return this.#operation;
      throw new Error(`Runtime operation in progress: ${this.#operationName}`);
    }
    // This synchronous close is the admission boundary, before any lifecycle await.
    this.admission.beginDrain({ deadlineMs });
    this.#operationName = 'shutdown';
    this.#operation = (async () => {
      try {
        if (this.lifecycle.getState().state === 'running') await this.lifecycle.drain();
        await this.admission.waitForDrain({ signal });
        if (this.lifecycle.getState().state !== 'stopped') await this.lifecycle.stop();
        return this.snapshot();
      } finally { this.#operation = null; this.#operationName = null; }
    })();
    return this.#operation;
  }
}
