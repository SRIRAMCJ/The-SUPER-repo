const SCHEMA_VERSION = '0.2.1';
const READINESS_STATES = Object.freeze(['starting', 'ready', 'degraded', 'draining', 'stopped', 'failed', 'cancelled']);
const PROBE_STATES = Object.freeze(['unknown', 'healthy', 'unhealthy']);

function assertString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function freeze(value) { return deepFreeze(structuredClone(value)); }

export class RuntimeReadinessKernel {
  constructor({ lifecycle, dependencies = [], probes = {}, clock = () => Date.now(), idFactory = () => crypto.randomUUID(), historyLimit = 128, probeTimeoutMs = 2000 } = {}) {
    if (!lifecycle || (typeof lifecycle.getState !== 'function' && typeof lifecycle.snapshot !== 'function')) throw new TypeError('lifecycle must expose getState() or snapshot()');
    if (!Number.isInteger(historyLimit) || historyLimit < 1) throw new TypeError('historyLimit must be a positive integer');
    if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 1) throw new TypeError('probeTimeoutMs must be a positive integer');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    this.lifecycle = lifecycle;
    this.dependencies = new Map();
    this.probes = new Map();
    this.clock = clock;
    this.idFactory = idFactory;
    this.historyLimit = historyLimit;
    this.probeTimeoutMs = probeTimeoutMs;
    this.history = [];
    for (const dependency of dependencies) this.registerDependency(dependency);
    for (const [id, probe] of Object.entries(probes)) this.registerProbe(id, probe);
  }

  registerDependency({ id, required = true, check }) {
    assertString(id, 'dependency id');
    if (typeof check !== 'function') throw new TypeError('dependency check must be a function');
    this.dependencies.set(id, Object.freeze({ id, required: Boolean(required), check }));
    return this;
  }

  registerProbe(id, probe) {
    assertString(id, 'probe id');
    if (typeof probe !== 'function') throw new TypeError('probe must be a function');
    this.probes.set(id, probe);
    return this;
  }

  async evaluate({ correlationId = this.idFactory(), signal } = {}) {
    if (signal?.aborted) return this.#record('cancelled', correlationId, { reason: 'aborted' });
    const lifecycle = typeof this.lifecycle.getState === 'function' ? this.lifecycle.getState() : this.lifecycle.snapshot();
    const lifecycleState = lifecycle.state;
    const inactiveState = ['bootstrap', 'initializing'].includes(lifecycleState) ? 'starting'
      : ['draining', 'stopping'].includes(lifecycleState) ? 'draining'
      : lifecycleState === 'stopped' ? 'stopped'
      : lifecycleState === 'failed' ? 'failed'
      : lifecycleState === 'ready' || lifecycleState === 'running' ? null : 'failed';
    if (inactiveState) return this.#record(inactiveState, correlationId, { lifecycleState, dependencies: [], probes: [] });
    const dependencyResults = await Promise.all([...this.dependencies.values()].map(async (dependency) => ({
      id: dependency.id, required: dependency.required,
      ...await check(dependency.check, { signal, correlationId }, this.probeTimeoutMs)
    })));
    const probeResults = await Promise.all([...this.probes].map(async ([id, probe]) => ({
      id, ...await check(probe, { signal, correlationId }, this.probeTimeoutMs)
    })));
    if (signal?.aborted) return this.#record('cancelled', correlationId, { reason: 'aborted', lifecycleState: lifecycle.state, dependencies: dependencyResults, probes: probeResults });
    const state = dependencyResults.some((item) => item.state === 'unhealthy') || probeResults.some((item) => item.state === 'unhealthy') ? 'degraded' : 'ready';
    return this.#record(state, correlationId, { lifecycleState, dependencies: dependencyResults, probes: probeResults });
  }

  snapshot() { return freeze({ schemaVersion: SCHEMA_VERSION, history: this.history, latest: this.history.at(-1) ?? null }); }

  #record(state, correlationId, details) {
    const record = freeze({ schemaVersion: SCHEMA_VERSION, id: this.idFactory(), correlationId, timestamp: this.clock(), state, ...details });
    this.history.push(record);
    while (this.history.length > this.historyLimit) this.history.shift();
    return structuredClone(record);
  }
}

function normalizeError(error) { return { code: error?.code ?? 'READINESS_PROBE_FAILED', message: error instanceof Error ? error.message : String(error) }; }

async function check(fn, context, timeoutMs) {
  const controller = new AbortController();
  const parent = context.signal;
  const onParentAbort = () => controller.abort(parent.reason);
  parent?.addEventListener('abort', onParentAbort, { once: true });
  if (parent?.aborted) onParentAbort();
  let timer;
  let removeAbort = () => {};
  try {
    const aborted = new Promise((_, reject) => {
      const onAbort = () => reject(controller.signal.reason?.code === 'READINESS_TIMEOUT' ? controller.signal.reason : Object.assign(new Error('Readiness check cancelled'), { code: 'READINESS_CANCELLED' }));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      removeAbort = () => controller.signal.removeEventListener('abort', onAbort);
      if (controller.signal.aborted) onAbort();
    });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { const error = Object.assign(new Error('Readiness check timed out'), { code: 'READINESS_TIMEOUT' }); controller.abort(error); reject(error); }, timeoutMs); });
    const work = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw Object.assign(new Error('Readiness check cancelled'), { code: 'READINESS_CANCELLED' });
      return fn({ ...context, signal: controller.signal });
    });
    const result = await Promise.race([work, aborted, timeout]);
    return { state: result === true || result?.healthy === true ? 'healthy' : 'unhealthy' };
  } catch (error) {
    return { state: 'unhealthy', error: normalizeError(error) };
  } finally {
    clearTimeout(timer);
    removeAbort();
    parent?.removeEventListener('abort', onParentAbort);
  }
}

export { SCHEMA_VERSION as RUNTIME_READINESS_SCHEMA_VERSION, READINESS_STATES as RUNTIME_READINESS_STATES, PROBE_STATES as RUNTIME_PROBE_STATES };
