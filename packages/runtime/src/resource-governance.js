const SCHEMA_VERSION = '0.1.0';
const RESOURCE_KEYS = Object.freeze(['cpuMs', 'memoryBytes', 'concurrency', 'networkRequests']);

export class RuntimeResourceGovernance {
  #allocations = new Map();
  #history = [];

  constructor({ limits = {}, clock = () => new Date(), maxHistory = 500 } = {}) {
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    this.clock = clock;
    this.maxHistory = maxHistory;
    this.limits = normalizeLimits(limits);
  }

  configure(limits) { this.limits = normalizeLimits(limits); return this.snapshot(); }

  admit({ executionId, request = {} } = {}) {
    validateId(executionId);
    const normalized = normalizeRequest(request);
    const current = this.#allocations.get(executionId) ?? zero();
    for (const key of RESOURCE_KEYS) {
      const limit = this.limits[key];
      if (limit !== null && current[key] + normalized[key] > limit) {
        const decision = this.#record({ executionId, action: 'admit', status: 'denied', resource: key, requested: normalized[key], available: Math.max(0, limit - current[key]) });
        return freeze({ schemaVersion: SCHEMA_VERSION, ...decision, allowed: false });
      }
    }
    const next = add(current, normalized);
    this.#allocations.set(executionId, next);
    const decision = this.#record({ executionId, action: 'admit', status: 'allowed', allocation: next });
    return freeze({ schemaVersion: SCHEMA_VERSION, ...decision, allowed: true, allocation: next });
  }

  release(executionId, usage = {}) {
    validateId(executionId);
    const current = this.#allocations.get(executionId) ?? zero();
    const next = subtract(current, normalizeRequest(usage));
    this.#allocations.set(executionId, next);
    this.#record({ executionId, action: 'release', status: 'released', allocation: next });
    return freeze({ schemaVersion: SCHEMA_VERSION, executionId, allocation: next });
  }

  allocation(executionId) { validateId(executionId); return freeze({ schemaVersion: SCHEMA_VERSION, executionId, allocation: this.#allocations.get(executionId) ?? zero() }); }
  history() { return Object.freeze(this.#history.map(clone)); }
  snapshot() { return freeze({ schemaVersion: SCHEMA_VERSION, type: 'runtime-resource-governance', generatedAt: this.clock().toISOString(), limits: this.limits, allocations: Object.fromEntries([...this.#allocations].map(([id, value]) => [id, value])) }); }
  #record(value) { const record = freeze({ ...value, recordedAt: this.clock().toISOString() }); this.#history.push(record); while (this.#history.length > this.maxHistory) this.#history.shift(); return record; }
}

function normalizeLimits(input) { const result = {}; for (const key of RESOURCE_KEYS) { const value = input[key]; if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) throw new TypeError(`${key} limit must be a non-negative finite number`); result[key] = value ?? null; } return freeze(result); }
function normalizeRequest(input) { const result = {}; for (const key of RESOURCE_KEYS) { const value = input[key] ?? 0; if (!Number.isFinite(value) || value < 0) throw new TypeError(`${key} must be a non-negative finite number`); result[key] = value; } return result; }
function zero() { return { cpuMs: 0, memoryBytes: 0, concurrency: 0, networkRequests: 0 }; }
function add(a, b) { return Object.fromEntries(RESOURCE_KEYS.map((key) => [key, a[key] + b[key]])); }
function subtract(a, b) { return Object.fromEntries(RESOURCE_KEYS.map((key) => [key, Math.max(0, a[key] - b[key])])); }
function validateId(value) { if (typeof value !== 'string' || !value.trim()) throw new TypeError('executionId must be a non-empty string'); }
function clone(value) { return structuredClone(value); }
function freeze(value) { return Object.freeze(structuredClone(value)); }
export { SCHEMA_VERSION as RESOURCE_GOVERNANCE_SCHEMA_VERSION, RESOURCE_KEYS as RESOURCE_GOVERNANCE_KEYS };
