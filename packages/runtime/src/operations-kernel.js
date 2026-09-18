const SCHEMA_VERSION = '0.1.0';
const STATES = new Set(['healthy', 'degraded', 'draining', 'stopped']);
const ACTIONS = new Set(['start', 'drain', 'stop', 'restart']);

export class OperationsRuntimeKernel {
  #history = [];
  #active = null;

  constructor({ lifecycle, clock = () => new Date(), idFactory = defaultId, maxHistory = 500, healthProbe = null } = {}) {
    if (!lifecycle || typeof lifecycle.snapshot !== 'function' || typeof lifecycle.transition !== 'function') throw new TypeError('lifecycle must expose snapshot() and transition()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    if (healthProbe !== null && typeof healthProbe !== 'function') throw new TypeError('healthProbe must be a function');
    this.lifecycle = lifecycle;
    this.clock = clock;
    this.idFactory = idFactory;
    this.maxHistory = maxHistory;
    this.healthProbe = healthProbe;
  }

  async health() {
    const snapshot = this.lifecycle.snapshot();
    let status = mapLifecycleHealth(snapshot.state);
    const checks = [];
    if (this.healthProbe) {
      try {
        const result = await this.healthProbe();
        checks.push({ id: 'custom', status: result?.status === 'pass' ? 'pass' : 'fail', details: sanitize(result) });
        if (result?.status === 'fail') status = 'degraded';
      } catch (error) {
        status = 'degraded';
        checks.push({ id: 'custom', status: 'fail', details: { code: error?.code ?? 'HEALTH_PROBE_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
    }
    return freeze({ schemaVersion: SCHEMA_VERSION, type: 'runtime-health', generatedAt: this.nowIso(), status, lifecycle: snapshot, checks });
  }

  async execute(action, metadata = {}) {
    if (!ACTIONS.has(action)) throw failure('OPERATION_UNSUPPORTED', `Unsupported operation: ${action}`);
    if (this.#active) throw failure('OPERATION_IN_PROGRESS', `Operation already active: ${this.#active.action}`, true);
    const operation = { operationId: this.idFactory('op'), action, startedAt: this.nowIso(), status: 'running', metadata: sanitize(metadata) };
    this.#active = freeze(operation);
    this.#history.push(this.#active);
    this.trim();
    try {
      if (action === 'start') await this.lifecycle.start();
      if (action === 'drain') await this.lifecycle.drain();
      if (action === 'stop') await this.lifecycle.stop();
      if (action === 'restart') { await this.lifecycle.stop(); await this.lifecycle.start(); }
      const completed = freeze({ ...operation, status: 'succeeded', finishedAt: this.nowIso(), lifecycle: sanitize(this.lifecycle.snapshot()) });
      this.#history[this.#history.length - 1] = completed;
      return clone(completed);
    } catch (error) {
      const failed = freeze({ ...operation, status: 'failed', finishedAt: this.nowIso(), error: normalizeError(error), lifecycle: sanitize(this.lifecycle.snapshot()) });
      this.#history[this.#history.length - 1] = failed;
      throw Object.assign(new Error(failed.error.message), { code: failed.error.code, operation: clone(failed) });
    } finally {
      this.#active = null;
    }
  }

  status() { return clone(this.lifecycle.snapshot()); }
  history() { return Object.freeze(this.#history.map(clone)); }
  activeOperation() { return clone(this.#active); }
  trim() { while (this.#history.length > this.maxHistory) this.#history.shift(); }
  nowIso() { const value = this.clock(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('clock must return a valid Date'); return value.toISOString(); }
}

function mapLifecycleHealth(state) { if (state === 'ready' || state === 'running') return 'healthy'; if (state === 'initializing' || state === 'draining' || state === 'stopping') return 'degraded'; if (state === 'stopped') return 'stopped'; return 'degraded'; }
function sanitize(value) { return value === undefined ? undefined : structuredClone(value); }
function failure(code, message, retryable = false) { return Object.assign(new Error(message), { code, retryable }); }
function normalizeError(error) { return { code: error?.code ?? 'OPERATION_FAILED', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function clone(value) { return value === undefined || value === null ? value : structuredClone(value); }
function defaultId(prefix = 'op') { return `${prefix}-${Date.now().toString(36)}`; }

export { SCHEMA_VERSION as OPERATIONS_RUNTIME_SCHEMA_VERSION, STATES as OPERATIONS_RUNTIME_STATES, ACTIONS as OPERATIONS_RUNTIME_ACTIONS };
