const SCHEMA_VERSION = '0.1.0';
const STATES = new Set(['starting', 'ready', 'degraded', 'draining', 'stopped', 'failed']);

export class RuntimeReadinessKernel {
  #history = [];

  constructor({ lifecycle, components = [], clock = () => new Date(), idFactory = defaultId, maxHistory = 500 } = {}) {
    if (!lifecycle || typeof lifecycle.snapshot !== 'function') throw new TypeError('lifecycle must expose snapshot()');
    if (!Array.isArray(components)) throw new TypeError('components must be an array');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    this.lifecycle = lifecycle;
    this.components = components.map(validateComponent);
    this.clock = clock;
    this.idFactory = idFactory;
    this.maxHistory = maxHistory;
  }

  async evaluate({ signal = null, correlationId = null } = {}) {
    if (signal?.aborted) return this.recordResult({ correlationId, status: 'draining', reason: 'cancelled', checks: [] });
    const lifecycle = this.lifecycle.snapshot();
    const checks = [];
    const byId = new Map();
    for (const component of this.components) {
      if (signal?.aborted) return this.recordResult({ correlationId, status: 'draining', reason: 'cancelled', checks });
      const dependencyFailures = component.dependencies.filter((id) => {
        const prior = byId.get(id);
        return prior && prior.status === 'fail';
      });
      if (dependencyFailures.length) {
        const check = { id: component.id, status: 'fail', required: component.required, reason: 'dependency_failed', dependencies: dependencyFailures };
        checks.push(check); byId.set(component.id, check); continue;
      }
      try {
        const result = component.probe ? await component.probe({ signal, correlationId }) : { status: 'pass' };
        const check = { id: component.id, status: result?.status === 'pass' ? 'pass' : 'fail', required: component.required, details: sanitize(result) };
        checks.push(check); byId.set(component.id, check);
      } catch (error) {
        const check = { id: component.id, status: 'fail', required: component.required, reason: 'probe_failed', error: normalizeError(error) };
        checks.push(check); byId.set(component.id, check);
      }
    }
    const requiredFailures = checks.filter((check) => check.required && check.status === 'fail');
    const optionalFailures = checks.filter((check) => !check.required && check.status === 'fail');
    const status = deriveStatus(lifecycle.state, requiredFailures.length, optionalFailures.length);
    return this.recordResult({ correlationId, status, reason: null, checks, lifecycle });
  }

  history() { return Object.freeze(this.#history.map(clone)); }

  latest() { return clone(this.#history.at(-1) ?? null); }

  recordResult({ correlationId, status, reason = null, checks, lifecycle = this.lifecycle.snapshot() }) {
    if (!STATES.has(status)) throw new TypeError(`invalid readiness status: ${status}`);
    const result = freeze({ schemaVersion: SCHEMA_VERSION, readinessId: this.idFactory('readiness'), correlationId, generatedAt: this.nowIso(), status, reason, lifecycle: sanitize(lifecycle), checks: sanitize(checks) });
    this.#history.push(result);
    while (this.#history.length > this.maxHistory) this.#history.shift();
    return clone(result);
  }

  nowIso() { const value = this.clock(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('clock must return a valid Date'); return value.toISOString(); }
}

function validateComponent(component) {
  if (!component || typeof component !== 'object' || typeof component.id !== 'string' || !component.id) throw new TypeError('component.id is required');
  if (component.probe !== undefined && typeof component.probe !== 'function') throw new TypeError(`component ${component.id} probe must be a function`);
  if (component.dependencies !== undefined && (!Array.isArray(component.dependencies) || component.dependencies.some((id) => typeof id !== 'string'))) throw new TypeError(`component ${component.id} dependencies must be string[]`);
  return Object.freeze({ id: component.id, required: component.required !== false, dependencies: Object.freeze([...(component.dependencies ?? [])]), probe: component.probe ?? null });
}
function deriveStatus(state, requiredFailures, optionalFailures) {
  if (state === 'draining' || state === 'stopping') return 'draining';
  if (state === 'stopped') return 'stopped';
  if (state === 'failed') return 'failed';
  if (state === 'initializing' || state === 'bootstrap') return 'starting';
  if (requiredFailures > 0) return 'failed';
  if (optionalFailures > 0) return 'degraded';
  return 'ready';
}
function sanitize(value) { return value === undefined ? undefined : structuredClone(value); }
function normalizeError(error) { return { code: error?.code ?? 'READINESS_PROBE_FAILED', message: error instanceof Error ? error.message : String(error) }; }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function clone(value) { return value === undefined || value === null ? value : structuredClone(value); }
function defaultId(prefix = 'readiness') { return `${prefix}-${Date.now().toString(36)}`; }

export { SCHEMA_VERSION as RUNTIME_READINESS_SCHEMA_VERSION, STATES as RUNTIME_READINESS_STATES };
