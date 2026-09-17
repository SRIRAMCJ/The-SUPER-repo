const SCHEMA_VERSION = '0.2.0';
const RESOURCE_KEYS = Object.freeze(['cpuMs', 'memoryBytes', 'concurrency', 'networkRequests']);

export class RuntimeResourceGovernance {
  #allocations = new Map();
  #totals = zero();
  #history = [];

  constructor({ limits = {}, executionLimits = {}, clock = () => new Date(), maxHistory = 500 } = {}) {
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    this.clock = clock;
    this.maxHistory = maxHistory;
    this.limits = normalizeLimits(limits);
    this.executionLimits = normalizeLimits(executionLimits);
  }

  configure(limits, executionLimits = this.executionLimits) {
    const nextLimits = normalizeLimits(limits);
    const nextExecutionLimits = normalizeLimits(executionLimits);
    assertWithinLimits(this.#totals, nextLimits, 'global');
    for (const [executionId, allocation] of this.#allocations) assertWithinLimits(allocation, nextExecutionLimits, executionId);
    this.limits = nextLimits;
    this.executionLimits = nextExecutionLimits;
    return this.snapshot();
  }

  admit({ executionId, request = {} } = {}) {
    validateId(executionId);
    const normalized = normalizeRequest(request);
    const current = this.#allocations.get(executionId) ?? zero();
    const next = add(current, normalized);
    const globalViolation = firstViolation(this.#totals, normalized, this.limits);
    const executionViolation = firstViolation(current, normalized, this.executionLimits);
    const violation = globalViolation ?? executionViolation;
    if (violation) {
      const decision = this.#record({ executionId, action: 'admit', status: 'denied', resource: violation.resource, scope: violation.scope, requested: violation.requested, available: violation.available });
      return freeze({ schemaVersion: SCHEMA_VERSION, ...decision, allowed: false });
    }
    this.#allocations.set(executionId, next);
    this.#totals = add(this.#totals, normalized);
    const decision = this.#record({ executionId, action: 'admit', status: 'allowed', allocation: next, totals: this.#totals });
    return freeze({ schemaVersion: SCHEMA_VERSION, ...decision, allowed: true, allocation: next, totals: this.#totals });
  }

  release(executionId, usage = {}) {
    validateId(executionId);
    const current = this.#allocations.get(executionId) ?? zero();
    const requested = normalizeRequest(usage);
    const released = minVector(current, requested);
    const next = subtract(current, released);
    this.#allocations.set(executionId, next);
    this.#totals = subtract(this.#totals, released);
    this.#record({ executionId, action: 'release', status: 'released', allocation: next, totals: this.#totals });
    return freeze({ schemaVersion: SCHEMA_VERSION, executionId, allocation: next, totals: this.#totals });
  }

  allocation(executionId) { validateId(executionId); return freeze({ schemaVersion: SCHEMA_VERSION, executionId, allocation: this.#allocations.get(executionId) ?? zero(), totals: this.#totals }); }
  totals() { return freeze({ schemaVersion: SCHEMA_VERSION, totals: this.#totals }); }
  history() { return Object.freeze(this.#history.map(clone)); }
  snapshot() { return freeze({ schemaVersion: SCHEMA_VERSION, type: 'runtime-resource-governance', generatedAt: this.clock().toISOString(), limits: this.limits, executionLimits: this.executionLimits, totals: this.#totals, allocations: Object.fromEntries([...this.#allocations].map(([id, value]) => [id, value])) }); }
  #record(value) { const record = freeze({ ...value, recordedAt: this.clock().toISOString() }); this.#history.push(record); while (this.#history.length > this.maxHistory) this.#history.shift(); return record; }
}

function normalizeLimits(input) { const result = {}; for (const key of RESOURCE_KEYS) { const value = input[key]; if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) throw new TypeError(`${key} limit must be a non-negative finite number`); result[key] = value ?? null; } return freeze(result); }
function normalizeRequest(input) { const result = {}; for (const key of RESOURCE_KEYS) { const value = input[key] ?? 0; if (!Number.isFinite(value) || value < 0) throw new TypeError(`${key} must be a non-negative finite number`); result[key] = value; } return result; }
function firstViolation(current, request, limits, scope) { for (const key of RESOURCE_KEYS) { const limit = limits[key]; if (limit !== null && current[key] + request[key] > limit) return { resource: key, scope: scope ?? 'global', requested: request[key], available: Math.max(0, limit - current[key]) }; } return null; }
function assertWithinLimits(allocation, limits, scope) { const violation = firstViolation(zero(), allocation, limits, scope); if (violation) throw new Error(`Cannot configure ${scope} resource limit below current allocation: ${violation.resource}`); }
function zero() { return { cpuMs: 0, memoryBytes: 0, concurrency: 0, networkRequests: 0 }; }
function add(a, b) { return Object.fromEntries(RESOURCE_KEYS.map((key) => [key, a[key] + b[key]])); }
function minVector(a, b) { return Object.fromEntries(RESOURCE_KEYS.map((key) => [key, Math.min(a[key], b[key])])); }
function subtract(a, b) { return Object.fromEntries(RESOURCE_KEYS.map((key) => [key, Math.max(0, a[key] - b[key])])); }
function validateId(value) { if (typeof value !== 'string' || !value.trim()) throw new TypeError('executionId must be a non-empty string'); }
function clone(value) { return structuredClone(value); }
function freeze(value) { return Object.freeze(structuredClone(value)); }
export { SCHEMA_VERSION as RESOURCE_GOVERNANCE_SCHEMA_VERSION, RESOURCE_KEYS as RESOURCE_GOVERNANCE_KEYS };
