import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = '0.1.0';
const STATES = Object.freeze(['healthy', 'degraded', 'failed', 'recovering', 'unavailable', 'cancelled']);
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);

// Local health aggregation. Checks report state; they do not trigger recovery or failover.
export class RuntimeSupervisorKernel {
  #levels;
  #definitions;
  #history = [];
  #evaluating = false;

  constructor({ components = {}, timeoutMs = 1000, maxParallel = 8, historyLimit = 128, clock = () => new Date(), idFactory = randomUUID } = {}) {
    if (!components || typeof components !== 'object' || Array.isArray(components) || Object.keys(components).length > 128) throw new TypeError('components must be an object with at most 128 entries');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxParallel) || maxParallel < 1 || !Number.isSafeInteger(historyLimit) || historyLimit < 1) throw new TypeError('timeoutMs, maxParallel and historyLimit must be positive integers');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    this.timeoutMs = timeoutMs;
    this.maxParallel = maxParallel;
    this.historyLimit = historyLimit;
    this.clock = clock;
    this.idFactory = idFactory;
    this.#definitions = normalize(components);
    this.#levels = levels(this.#definitions);
  }

  async evaluate({ correlationId = this.idFactory(), signal } = {}) {
    if (this.#evaluating) throw Object.assign(new Error('Supervisor evaluation already in progress'), { code: 'SUPERVISION_BUSY' });
    if (typeof correlationId !== 'string' || !correlationId.trim()) throw new TypeError('correlationId must be a non-empty string');
    this.#evaluating = true;
    try {
    const results = new Map();
    for (const level of this.#levels) {
      if (signal?.aborted) break;
      for (let i = 0; i < level.length; i += this.maxParallel) {
        if (signal?.aborted) break;
        const batch = level.slice(i, i + this.maxParallel);
        const values = await Promise.all(batch.map(async (id) => {
          const item = this.#definitions.get(id);
          const unhealthy = item.dependencies.filter((dependency) => results.get(dependency)?.state !== 'healthy');
          if (unhealthy.length) return { id, state: 'degraded', critical: item.critical, reason: 'dependency_unhealthy', dependencies: unhealthy };
          return { id, critical: item.critical, ...await inspect(item.check, this.timeoutMs, signal) };
        }));
        for (const result of values) results.set(result.id, result);
      }
    }
    const cancelled = Boolean(signal?.aborted);
    const entries = [...results].sort(([a], [b]) => a.localeCompare(b));
    const values = entries.map(([, result]) => result);
    const state = cancelled ? 'cancelled' : !values.length ? 'unavailable'
      : values.some((item) => item.critical && ['failed', 'unavailable'].includes(item.state)) ? 'failed'
      : values.some((item) => item.state === 'recovering') ? 'recovering'
      : values.some((item) => item.state !== 'healthy') ? 'degraded' : 'healthy';
    const generatedAt = this.clock();
    const id = this.idFactory();
    if (!(generatedAt instanceof Date) || !Number.isFinite(generatedAt.getTime()) || typeof id !== 'string' || !id.trim()) throw new TypeError('clock and idFactory must return a valid Date and non-empty string');
    const record = freeze({ schemaVersion: SCHEMA_VERSION, type: 'runtime-supervisor-evaluation', id, correlationId,
      generatedAt: generatedAt.toISOString(), state, components: Object.fromEntries(entries), checked: values.length, total: this.#definitions.size });
    this.#history.push(record);
    if (this.#history.length > this.historyLimit) this.#history.shift();
    return record;
    } finally { this.#evaluating = false; }
  }

  async health(options) { return this.evaluate(options); }
  history() { return Object.freeze([...this.#history]); }
  snapshot() { return freeze({ schemaVersion: SCHEMA_VERSION, latest: this.#history.at(-1) ?? null, history: this.#history }); }
}

function normalize(input) {
  const definitions = new Map();
  for (const [id, value] of Object.entries(input)) {
    if (!id.trim() || UNSAFE.has(id)) throw new TypeError(`invalid component id: ${id}`);
    const item = typeof value === 'function' ? { check: value } : value;
    const target = item?.component ?? item;
    const check = typeof item?.check === 'function' ? item.check : typeof target?.health === 'function' ? target.health.bind(target) : null;
    const dependencies = item?.dependencies ?? [];
    if (!check || !Array.isArray(dependencies) || dependencies.some((dep) => typeof dep !== 'string' || !dep.trim() || UNSAFE.has(dep)) || new Set(dependencies).size !== dependencies.length) throw new TypeError(`invalid component definition: ${id}`);
    definitions.set(id, { check, dependencies: [...dependencies], critical: item.critical !== false });
  }
  return definitions;
}

function levels(definitions) {
  const depths = new Map(), visiting = new Set();
  const visit = (id) => {
    if (depths.has(id)) return depths.get(id);
    if (visiting.has(id)) throw new TypeError(`component dependency cycle: ${id}`);
    const item = definitions.get(id);
    if (!item) throw new TypeError(`unknown component dependency: ${id}`);
    visiting.add(id);
    const depth = item.dependencies.length ? 1 + Math.max(...item.dependencies.map(visit)) : 0;
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };
  for (const id of definitions.keys()) visit(id);
  const output = [];
  for (const [id, depth] of depths) (output[depth] ??= []).push(id);
  return output.map((group) => group.sort());
}

async function inspect(check, timeoutMs, parent) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent?.addEventListener('abort', abort, { once: true });
  let timer;
  let removeAbort = () => {};
  try {
    const cancelled = new Promise((_, reject) => {
      const onAbort = () => reject(Object.assign(new Error('Health check cancelled'), { code: controller.signal.reason?.code === 'HEALTH_TIMEOUT' ? 'HEALTH_TIMEOUT' : 'HEALTH_CANCELLED' }));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      removeAbort = () => controller.signal.removeEventListener('abort', onAbort);
    });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { const error = Object.assign(new Error('Health check timed out'), { code: 'HEALTH_TIMEOUT' }); controller.abort(error); reject(error); }, timeoutMs); });
    const work = Promise.resolve().then(() => { if (controller.signal.aborted) throw Object.assign(new Error('Health check cancelled'), { code: 'HEALTH_CANCELLED' }); return check({ signal: controller.signal }); });
    const result = await Promise.race([work, timeout, cancelled]);
    const state = String(result?.state ?? result?.status ?? (result === true ? 'healthy' : '')).toLowerCase();
    return { state: STATES.includes(state) && state !== 'cancelled' ? state : 'unavailable' };
  } catch (error) { return { state: 'unavailable', reason: error?.code === 'HEALTH_TIMEOUT' ? 'timeout' : error?.code === 'HEALTH_CANCELLED' ? 'cancelled' : 'check_failed' }; }
  finally { clearTimeout(timer); removeAbort(); parent?.removeEventListener('abort', abort); }
}
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
export { SCHEMA_VERSION as RUNTIME_SUPERVISOR_SCHEMA_VERSION, STATES as RUNTIME_SUPERVISOR_STATES };
