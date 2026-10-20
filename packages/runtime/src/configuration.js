import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = '0.1.0';
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|private[_-]?key/i;
const UNSAFE_KEY = new Set(['__proto__', 'prototype', 'constructor']);

// Public runtime configuration contains non-secret settings only. Credentials belong in a separate provider.
export class RuntimeConfigurationKernel {
  #snapshot;
  #history = [];

  constructor({ initial = {}, schema = null, clock = () => Date.now(), idFactory = randomUUID, historyLimit = 128 } = {}) {
    if (schema !== null && typeof schema !== 'function') throw new TypeError('schema must be a validation function');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) throw new TypeError('historyLimit must be a positive integer');
    this.schema = schema;
    this.clock = clock;
    this.idFactory = idFactory;
    this.historyLimit = historyLimit;
    this.#snapshot = this.#build(initial, 'bootstrap', {}, 1);
  }

  current() { return structuredClone(this.#snapshot); }
  history() { return deepFreeze(structuredClone(this.#history)); }

  reload(next, { source = 'runtime', expectedVersion = null, metadata = {} } = {}) {
    if (expectedVersion !== null && expectedVersion !== this.#snapshot.version) throw configurationError('CONFIGURATION_CONFLICT', 'configuration version conflict');
    const previous = this.#snapshot;
    const candidate = this.#build(next, source, metadata, previous.version + 1);
    const entry = deepFreeze({ id: this.idFactory(), timestamp: timestamp(this.clock()), fromVersion: previous.version,
      toVersion: candidate.version, source: candidate.source, status: 'applied', metadata: structuredClone(candidate.metadata) });
    this.#snapshot = candidate;
    this.#history.push(entry);
    if (this.#history.length > this.historyLimit) this.#history.shift();
    return this.current();
  }

  #build(value, source, metadata, version) {
    if (!isObject(value) || !isObject(metadata)) throw configurationError('INVALID_CONFIGURATION', 'configuration and metadata must be objects');
    let candidate;
    try { candidate = structuredClone(value); assertSafe(candidate); assertSafe(metadata); }
    catch (error) { throw configurationError('CONFIGURATION_INVALID', error instanceof Error ? error.message : String(error)); }
    if (this.schema) {
      let valid;
      try { valid = this.schema(structuredClone(candidate)); }
      catch (error) { throw configurationError('CONFIGURATION_INVALID', error instanceof Error ? error.message : String(error)); }
      if (valid && typeof valid.then === 'function') {
        Promise.resolve(valid).catch(() => {});
        throw configurationError('CONFIGURATION_INVALID', 'schema validation must be synchronous');
      }
      if (valid !== true) throw configurationError('CONFIGURATION_INVALID', 'configuration failed schema validation');
    }
    const loadedAt = timestamp(this.clock());
    return deepFreeze({ schemaVersion: SCHEMA_VERSION, version, source: typeof source === 'string' && source ? source : 'runtime',
      loadedAt, values: candidate, metadata: structuredClone(metadata) });
  }
}

function assertSafe(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new TypeError('Cyclic configuration is not supported');
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) || UNSAFE_KEY.has(key)) throw new TypeError(`Unsupported configuration key: ${key}`);
    assertSafe(child, seen);
  }
  seen.delete(value);
}
function timestamp(value) { if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString(); if (Number.isFinite(value)) return value; throw configurationError('CONFIGURATION_INVALID', 'clock must return a finite timestamp'); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function deepFreeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }
function configurationError(code, message) { return Object.assign(new Error(message), { code, retryable: code === 'CONFIGURATION_CONFLICT' }); }
export { SCHEMA_VERSION as RUNTIME_CONFIGURATION_SCHEMA_VERSION };
