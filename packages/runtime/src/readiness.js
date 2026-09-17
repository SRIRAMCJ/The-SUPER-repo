const SCHEMA_VERSION = '0.1.0';
const READINESS_STATES = Object.freeze(['starting', 'ready', 'degraded', 'draining', 'stopped', 'failed']);
const PROBE_STATES = Object.freeze(['unknown', 'healthy', 'unhealthy']);

function assertString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

function freeze(value) {
  return Object.freeze(structuredClone(value));
}

export class RuntimeReadinessKernel {
  constructor({ lifecycle, dependencies = [], probes = {}, clock = () => Date.now(), idFactory = () => crypto.randomUUID(), historyLimit = 128 } = {}) {
    if (!lifecycle || typeof lifecycle.snapshot !== 'function') throw new TypeError('lifecycle is required');
    if (!Number.isInteger(historyLimit) || historyLimit < 1) throw new TypeError('historyLimit must be a positive integer');
    this.lifecycle = lifecycle;
    this.dependencies = new Map();
    this.probes = new Map();
    this.clock = clock;
    this.idFactory = idFactory;
    this.historyLimit = historyLimit;
    this.history = [];
    for (const dependency of dependencies) this.registerDependency(dependency);
    for (const [id, probe] of Object.entries(probes)) this.registerProbe(id, probe);
  }

  registerDependency({ id, required = true, check }) {
    assertString(id, 'dependency id');
    if (typeof check !== 'function') throw new TypeError('dependency check must be a function');
    this.dependencies.set(id, { id, required: Boolean(required), check });
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
    const lifecycle = this.lifecycle.snapshot();
    const dependencyResults = [];
    let requiredFailure = false;
    for (const dependency of this.dependencies.values()) {
      try {
        const result = await dependency.check({ signal, correlationId });
        const healthy = result === true || result?.healthy === true;
        dependencyResults.push({ id: dependency.id, required: dependency.required, state: healthy ? 'healthy' : 'unhealthy' });
        if (dependency.required && !healthy) requiredFailure = true;
      } catch (error) {
        dependencyResults.push({ id: dependency.id, required: dependency.required, state: 'unhealthy', error: error instanceof Error ? error.message : String(error) });
        if (dependency.required) requiredFailure = true;
      }
    }
    const probeResults = [];
    for (const [id, probe] of this.probes) {
      try {
        const result = await probe({ signal, correlationId });
        probeResults.push({ id, state: result === true || result?.healthy === true ? 'healthy' : 'unhealthy' });
      } catch (error) {
        probeResults.push({ id, state: 'unhealthy', error: error instanceof Error ? error.message : String(error) });
      }
    }
    const lifecycleState = lifecycle.state;
    let state = 'ready';
    if (['bootstrap', 'initializing'].includes(lifecycleState)) state = 'starting';
    else if (lifecycleState === 'draining') state = 'draining';
    else if (lifecycleState === 'stopped') state = 'stopped';
    else if (lifecycleState === 'failed') state = 'failed';
    else if (requiredFailure || probeResults.some((item) => item.state === 'unhealthy')) state = 'degraded';
    return this.#record(state, correlationId, { lifecycleState, dependencies: dependencyResults, probes: probeResults });
  }

  snapshot() {
    return freeze({ schemaVersion: SCHEMA_VERSION, history: this.history.slice(), latest: this.history.at(-1) ?? null });
  }

  #record(state, correlationId, details) {
    const record = freeze({ schemaVersion: SCHEMA_VERSION, id: this.idFactory(), correlationId, timestamp: this.clock(), state, ...details });
    this.history.push(record);
    while (this.history.length > this.historyLimit) this.history.shift();
    return record;
  }
}

export { SCHEMA_VERSION as RUNTIME_READINESS_SCHEMA_VERSION, READINESS_STATES as RUNTIME_READINESS_STATES, PROBE_STATES as RUNTIME_PROBE_STATES };
