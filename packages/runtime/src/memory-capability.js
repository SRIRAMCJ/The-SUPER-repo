const SCHEMA_VERSION = '0.1.0';
const DEFAULT_MAX_ENTRIES = 10000;

export class MemoryCapability {
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES, clock = () => new Date(), idFactory = defaultId } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive integer');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    this.maxEntries = maxEntries;
    this.clock = clock;
    this.idFactory = idFactory;
    this.records = new Map();
  }

  set(namespace, key, value, options = {}) {
    const identity = normalizeIdentity(namespace, key);
    const now = this.clock().toISOString();
    const current = this.records.get(identity.id);
    if (options.expectedVersion !== undefined && options.expectedVersion !== (current?.version ?? null)) {
      throw memoryError('MEMORY_VERSION_CONFLICT', `Memory version conflict for ${identity.id}`, true);
    }
    const ttlMs = normalizeTtl(options.ttlMs);
    const record = Object.freeze(structuredClone({
      schemaVersion: SCHEMA_VERSION,
      id: current?.id ?? this.idFactory(identity.namespace, identity.key),
      namespace: identity.namespace,
      key: identity.key,
      value,
      version: (current?.version ?? 0) + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      expiresAt: ttlMs === null ? null : new Date(this.clock().getTime() + ttlMs).toISOString(),
      metadata: options.metadata ?? {}
    }));
    this.records.set(identity.id, record);
    this.#evict();
    return clone(record);
  }

  compareAndSet(namespace, key, expectedVersion, value, options = {}) {
    return this.set(namespace, key, value, { ...options, expectedVersion });
  }

  get(namespace, key) {
    const identity = normalizeIdentity(namespace, key);
    const record = this.records.get(identity.id);
    if (!record) return null;
    if (isExpired(record, this.clock())) {
      this.records.delete(identity.id);
      return null;
    }
    return clone(record);
  }

  has(namespace, key) { return this.get(namespace, key) !== null; }

  delete(namespace, key, options = {}) {
    const identity = normalizeIdentity(namespace, key);
    const current = this.records.get(identity.id);
    if (!current) return false;
    if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
      throw memoryError('MEMORY_VERSION_CONFLICT', `Memory version conflict for ${identity.id}`, true);
    }
    return this.records.delete(identity.id);
  }

  list(namespace = null) {
    const normalizedNamespace = namespace === null ? null : normalizeNamespace(namespace);
    this.#purgeExpired();
    return [...this.records.values()]
      .filter((record) => normalizedNamespace === null || record.namespace === normalizedNamespace)
      .map(clone);
  }

  clear(namespace = null) {
    if (namespace === null) { const count = this.records.size; this.records.clear(); return count; }
    const normalized = normalizeNamespace(namespace);
    let count = 0;
    for (const [id, record] of this.records) if (record.namespace === normalized) { this.records.delete(id); count += 1; }
    return count;
  }

  snapshot() {
    this.#purgeExpired();
    return Object.freeze(structuredClone({ schemaVersion: SCHEMA_VERSION, type: 'memory-capability', size: this.records.size, records: [...this.records.values()] }));
  }

  restore(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== SCHEMA_VERSION || !Array.isArray(snapshot.records)) throw new TypeError('Invalid memory snapshot');
    this.records.clear();
    for (const record of snapshot.records) {
      const identity = normalizeIdentity(record.namespace, record.key);
      if (typeof record.id !== 'string' || !record.id.trim() || record.namespace !== identity.namespace || record.key !== identity.key || !Number.isInteger(record.version) || record.version < 1) throw new TypeError(`Invalid memory record: ${identity.id}`);
      this.records.set(identity.id, Object.freeze(structuredClone(record)));
    }
    this.#purgeExpired();
    this.#evict();
    return this.snapshot();
  }

  #purgeExpired() { for (const [id, record] of this.records) if (isExpired(record, this.clock())) this.records.delete(id); }
  #evict() { while (this.records.size > this.maxEntries) this.records.delete(this.records.keys().next().value); }
}

function normalizeNamespace(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Memory namespace must be a non-empty string');
  return value.trim();
}

function normalizeIdentity(namespace, key) {
  const normalizedNamespace = normalizeNamespace(namespace);
  if (typeof key !== 'string' || !key.trim()) throw new TypeError('Memory key must be a non-empty string');
  const normalizedKey = key.trim();
  return { namespace: normalizedNamespace, key: normalizedKey, id: `${normalizedNamespace}:${normalizedKey}` };
}

function normalizeTtl(ttlMs) {
  if (ttlMs === undefined || ttlMs === null) return null;
  if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new TypeError('ttlMs must be a positive finite number');
  return ttlMs;
}

function isExpired(record, now) { return record.expiresAt !== null && new Date(record.expiresAt).getTime() <= now.getTime(); }
function clone(value) { return structuredClone(value); }
function defaultId(namespace, key) { return `mem_${namespace}_${key}`; }
function memoryError(code, message, retryable) { return Object.assign(new Error(message), { code, retryable }); }

export { SCHEMA_VERSION as MEMORY_CAPABILITY_SCHEMA_VERSION };
