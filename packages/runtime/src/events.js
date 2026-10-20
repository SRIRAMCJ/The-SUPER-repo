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
    if (typeof type !== 'string' || !type.trim()) throw new TypeError('Event type must be a non-empty string');
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }
  emit(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('Event must be an object');
    if (typeof event.type !== 'string' || !event.type.trim()) throw new TypeError('Event requires a non-empty string type');
    const normalized = { ...structuredClone(event), schemaVersion: event.schemaVersion ?? '0.1.0', id: event.id ?? this.idFactory(), timestamp: event.timestamp ?? this.clock().toISOString() };
    this.#history.push(normalized);
    if (this.#history.length > this.maxHistory) this.#history.splice(0, this.#history.length - this.maxHistory);
    for (const listener of this.#listeners.get(normalized.type) ?? []) listener(structuredClone(normalized));
    if (normalized.type !== '*') for (const listener of this.#listeners.get('*') ?? []) listener(structuredClone(normalized));
    return structuredClone(normalized);
  }
  history(filter = {}, limit = this.maxHistory) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new TypeError('Event history filter must be an object');
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Event history limit must be a positive integer');
    return this.#history.filter((event) => Object.entries(filter).every(([key,value]) => event[key] === value)).slice(-limit).map((event) => structuredClone(event));
  }
}
