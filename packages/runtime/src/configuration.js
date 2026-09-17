const SCHEMA_VERSION = '0.1.0';
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|private[_-]?key/i;

export class RuntimeConfigurationKernel {
  #snapshot;
  #history = [];

  constructor({ initial = {}, schema = null, clock = () => Date.now(), idFactory = () => crypto.randomUUID(), historyLimit = 128 } = {}) {
    if (!isObject(initial)) throw new TypeError('initial configuration must be an object');
    if (schema !== null && typeof schema !== 'function') throw new TypeError('schema must be a validation function');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(historyLimit) || historyLimit < 1) throw new TypeError('historyLimit must be a positive integer');
    this.schema = schema;
    this.clock = clock;
    this.idFactory = idFactory;
    this.historyLimit = historyLimit;
    this.#snapshot = this.#build(initial, 'bootstrap', null);
  }

  current() { return structuredClone(this.#snapshot); }

  history() { return Object.freeze(this.#history.map((entry) => structuredClone(entry))); }

  reload(next, { source = 'runtime', expectedVersion = null, metadata = {} } = {}) {
    if (!isObject(next)) throw configurationError('INVALID_CONFIGURATION', 'configuration must be an object');
    if (expectedVersion !== null && expectedVersion !== this.#snapshot.version) throw configurationError('CONFIGURATION_CONFLICT', 'configuration version conflict');
    const candidate = this.#build(next, source, metadata);
    const previous = this.#snapshot;
    this.#snapshot = candidate;
    this.#history.push(freeze({ id: this.idFactory('config-change'), timestamp: this.clock(), fromVersion: previous.version, toVersion: candidate.version, source: candidate.source, status: 'applied', metadata: sanitizeMetadata(metadata) }));
    while (this.#history.length > this.historyLimit) this.#history.shift();
    return this.current();
  }

  #build(value, source, metadata) {
    const candidate = structuredClone(value);
    if (this.schema) {
      let valid = false;
      try { valid = this.schema(structuredClone(candidate)) === true; } catch (error) { throw configurationError('CONFIGURATION_INVALID', error instanceof Error ? error.message : String(error)); }
      if (!valid) throw configurationError('CONFIGURATION_INVALID', 'configuration failed schema validation');
    }
    return freeze({ schemaVersion: SCHEMA_VERSION, version: this.idFactory('config'), source: sanitizeSource(source), loadedAt: this.clock(), values: redactSecrets(candidate), metadata: sanitizeMetadata(metadata) });
  }
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sanitizeSource(source) { return typeof source === 'string' && source.length > 0 ? source : 'runtime'; }
function sanitizeMetadata(metadata) { return isObject(metadata) ? redactSecrets(metadata) : {}; }
function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!isObject(value)) return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) result[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactSecrets(child);
  return result;
}
function freeze(value) {
  const clone = structuredClone(value);
  const deep = (item) => { if (!item || typeof item !== 'object' || Object.isFrozen(item)) return item; for (const child of Object.values(item)) deep(child); return Object.freeze(item); };
  return deep(clone);
}
function configurationError(code, message) { return Object.assign(new Error(message), { code, retryable: code === 'CONFIGURATION_CONFLICT' }); }

export { SCHEMA_VERSION as RUNTIME_CONFIGURATION_SCHEMA_VERSION };
