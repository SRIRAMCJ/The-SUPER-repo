export class SharedContext {
  constructor(initial = {}, { clock = () => new Date() } = {}) {
    if (!initial || typeof initial !== 'object' || Array.isArray(initial)) throw new TypeError('SharedContext initial value must be an object');
    this.clock = clock;
    this.version = 0;
    this.values = structuredClone(initial);
    this.history = [];
  }

  snapshot() {
    return { version: this.version, values: structuredClone(this.values) };
  }

  get(key, fallback = undefined) {
    return Object.prototype.hasOwnProperty.call(this.values, key) ? structuredClone(this.values[key]) : fallback;
  }

  set(key, value, { expectedVersion = this.version, actor = 'system' } = {}) {
    return this.commit({ [key]: value }, { expectedVersion, actor });
  }

  commit(patch = {}, { expectedVersion = this.version, actor = 'system', reason = 'update' } = {}) {
    if (expectedVersion !== this.version) {
      const error = new Error(`Shared context version conflict: expected ${expectedVersion}, current ${this.version}`);
      error.code = 'CONTEXT_VERSION_CONFLICT';
      error.retryable = true;
      throw error;
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Shared context patch must be an object');
    this.values = { ...this.values, ...structuredClone(patch) };
    this.version += 1;
    const record = { version: this.version, actor, reason, timestamp: this.clock().toISOString(), keys: Object.keys(patch) };
    this.history.push(record);
    return this.snapshot();
  }

  historySince(version = 0) {
    return this.history.filter((entry) => entry.version > version).map((entry) => structuredClone(entry));
  }
}
