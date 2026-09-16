export class ExecutionAudit {
  constructor({ events = null, clock = () => new Date() } = {}) {
    this.events = events;
    this.clock = clock;
    this.records = new Map();
    this.unsubscribe = events?.on('*', (event) => this.recordEvent(event));
  }

  recordEvent(event) {
    const executionId = event.executionId;
    if (!executionId) return;
    const record = this.records.get(executionId) ?? {
      executionId,
      capabilityId: event.capabilityId,
      startedAt: null,
      finishedAt: null,
      status: 'unknown',
      events: []
    };
    record.capabilityId ??= event.capabilityId;
    record.events.push(event);
    if (event.type === 'execution.started') {
      record.startedAt = event.timestamp;
      record.status = 'running';
    } else if (event.type === 'execution.completed') {
      record.finishedAt = event.timestamp;
      record.status = 'succeeded';
    } else if (event.type === 'execution.failed') {
      record.finishedAt = event.timestamp;
      record.status = 'failed';
      record.error = event.error;
    }
    this.records.set(executionId, record);
  }

  get(executionId) {
    const record = this.records.get(executionId);
    return record ? structuredClone(record) : null;
  }

  list() { return [...this.records.values()].map((record) => structuredClone(record)); }

  close() { this.unsubscribe?.(); }
}

export class MemoryStore {
  #items = [];

  append(record) {
    if (!record || typeof record !== 'object') throw new TypeError('Memory record must be an object');
    const item = Object.freeze(structuredClone({ ...record, recordedAt: record.recordedAt ?? new Date().toISOString() }));
    this.#items.push(item);
    return item;
  }

  query(predicate = () => true) {
    return this.#items.filter(predicate).map((item) => structuredClone(item));
  }

  size() { return this.#items.length; }
}
