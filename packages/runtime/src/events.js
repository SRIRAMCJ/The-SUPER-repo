const SCHEMA_VERSION = '0.1.0';

export function createExecutionId() {
  return `exec_${Date.now()}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export class EventBus {
  #listeners = new Map();
  #history = [];

  constructor({ maxHistory = 10000, clock = () => new Date(), idFactory = () => `evt_${crypto.randomUUID().replaceAll('-', '')}` } = {}) {
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    this.maxHistory = maxHistory;
    this.clock = clock;
    this.idFactory = idFactory;
  }

  on(type, listener) {
    if (typeof type !== 'string' || !type) throw new TypeError('Event listener type must be a non-empty string');
    if (typeof listener !== 'function') throw new TypeError('Event listener must be a function');
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  emit(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('Event must be an object');
    if (typeof event.type !== 'string' || !event.type) throw new TypeError('Event requires a non-empty type');
    const normalized = Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      id: event.id ?? this.idFactory(),
      timestamp: event.timestamp ?? this.clock().toISOString(),
      ...event
    });
    this.#history.push(normalized);
    if (this.#history.length > this.maxHistory) this.#history.splice(0, this.#history.length - this.maxHistory);
    for (const listener of this.#listeners.get(normalized.type) ?? []) listener(normalized);
    for (const listener of this.#listeners.get('*') ?? []) listener(normalized);
    return normalized;
  }

  history(filter = {}, limit = this.maxHistory) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new TypeError('Event history filter must be an object');
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Event history limit must be a positive integer');
    return Object.freeze(this.#history
      .filter((event) => Object.entries(filter).every(([key, value]) => event[key] === value))
      .slice(-limit)
      .map((event) => structuredClone(event)));
  }
}

export { SCHEMA_VERSION as EVENT_SCHEMA_VERSION };
