export function createExecutionId() {
  return `exec_${Date.now()}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export class EventBus {
  #listeners = new Map();
  #history = [];
  on(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }
  emit(event) {
    const normalized = Object.freeze({ schemaVersion:'0.1.0', id:event.id ?? `evt_${crypto.randomUUID().replaceAll('-', '')}`, timestamp:event.timestamp ?? new Date().toISOString(), ...event });
    this.#history.push(normalized);
    for (const listener of this.#listeners.get(normalized.type) ?? []) listener(normalized);
    for (const listener of this.#listeners.get('*') ?? []) listener(normalized);
    return normalized;
  }
  history(filter = {}) { return this.#history.filter((event) => Object.entries(filter).every(([key,value]) => event[key] === value)); }
}
