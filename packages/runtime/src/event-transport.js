// Ordered, bounded in-process transport. Publishing completes after every
// subscriber settles; a failing subscriber cannot suppress the others.
export class RuntimeEventTransport {
  #subscribers = new Set();
  #queue = [];
  #running = false;
  #closed = false;
  #waiters = [];

  constructor({ maxPending = 1024, maxSubscribers = 64 } = {}) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || !Number.isSafeInteger(maxSubscribers) || maxSubscribers < 1) throw new TypeError('Transport limits must be positive integers');
    Object.assign(this, { maxPending, maxSubscribers });
  }

  subscribe(listener) {
    if (this.#closed) throw new Error('Transport is closed');
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (this.#subscribers.size >= this.maxSubscribers) throw Object.assign(new Error('Subscriber capacity exhausted'), { code: 'EVENT_SUBSCRIBER_CAPACITY' });
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  publish(event) {
    if (this.#closed) return Promise.reject(Object.assign(new Error('Transport is closed'), { code: 'EVENT_TRANSPORT_CLOSED' }));
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string' || !event.type.trim()) return Promise.reject(new TypeError('Event requires a type'));
    if (this.#queue.length + Number(this.#running) >= this.maxPending) return Promise.reject(Object.assign(new Error('Event capacity exhausted'), { code: 'EVENT_TRANSPORT_CAPACITY' }));
    const copy = structuredClone(event);
    return new Promise((resolve, reject) => {
      this.#queue.push({ event: copy, resolve, reject });
      if (!this.#running) void this.#drain();
    });
  }

  async #drain() {
    this.#running = true;
    while (this.#queue.length) {
      const item = this.#queue.shift();
      const outcomes = await Promise.allSettled([...this.#subscribers].map((listener) => Promise.resolve().then(() => listener(structuredClone(item.event)))));
      const errors = outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => outcome.reason);
      if (errors.length) item.reject(new AggregateError(errors, 'Event delivery failed'));
      else item.resolve();
    }
    this.#running = false;
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  drain() { return !this.#running ? Promise.resolve() : new Promise((resolve) => this.#waiters.push(resolve)); }
  async close() { this.#closed = true; await this.drain(); this.#subscribers.clear(); }
  snapshot() { return { type: 'runtime-event-transport', pending: this.#queue.length + Number(this.#running), subscribers: this.#subscribers.size, closed: this.#closed, maxPending: this.maxPending }; }
}
