const SCHEMA_VERSION = '0.1.0';

export const RUNTIME_SUPERVISOR_SCHEMA_VERSION = SCHEMA_VERSION;
export const RUNTIME_SUPERVISOR_STATES = Object.freeze(['healthy', 'degraded', 'failed', 'recovering', 'unavailable']);

const HEALTHY = new Set(['healthy', 'ready', 'succeeded', 'pass', 'passed']);
const DEGRADED = new Set(['degraded', 'warning']);
const FAILED = new Set(['failed', 'error', 'critical']);
const RECOVERING = new Set(['recovering']);

export class RuntimeSupervisorKernel {
  constructor({ components = {}, clock = () => new Date(), idFactory = defaultId, historyLimit = 128 } = {}) {
    if (!components || typeof components !== 'object' || Array.isArray(components)) throw new TypeError('components must be an object');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(historyLimit) || historyLimit < 1) throw new TypeError('historyLimit must be a positive integer');
    this.clock = clock;
    this.idFactory = idFactory;
    this.historyLimit = historyLimit;
    this.components = normalizeComponents(components);
    this.order = topologicalOrder(this.components);
    this.#history = [];
  }
  #history;

  async evaluate({ correlationId = this.idFactory('supervision'), signal } = {}) {
    if (signal?.aborted) return this.#recordResult(buildCancelled(this.clock, correlationId));
    const results = {};
    for (const id of this.order) {
      if (signal?.aborted) return this.#recordResult(buildCancelled(this.clock, correlationId));
      const definition = this.components[id];
      const dependencyResults = definition.dependencies.map((dependency) => results[dependency]);
      const blocked = dependencyResults.find((result) => result.state === 'failed' || result.state === 'unavailable');
      if (blocked) {
        results[id] = componentResult(id, 'degraded', definition, { reason: 'dependency_unhealthy', dependencies: dependencyResults.map(compactDependency) });
        continue;
      }
      const degradedDependency = dependencyResults.find((result) => result.state === 'degraded' || result.state === 'recovering');
      if (degradedDependency) {
        results[id] = componentResult(id, 'degraded', definition, { reason: 'dependency_degraded', dependencies: dependencyResults.map(compactDependency) });
        continue;
      }
      results[id] = await inspectComponent(id, definition);
    }
    const values = Object.values(results);
    return this.#recordResult(deepFreeze({
      schemaVersion: SCHEMA_VERSION,
      type: 'runtime-supervisor-evaluation',
      id: this.idFactory('supervision-result'),
      correlationId,
      generatedAt: this.clock().toISOString(),
      state: aggregate(values),
      summary: summarize(values),
      dependencyGraph: this.order.map((id) => ({ id, dependencies: [...this.components[id].dependencies] })),
      components: results
    }));
  }

  async health(options = {}) {
    const result = await this.evaluate(options);
    return deepFreeze({ ...result, type: 'runtime-supervisor-health' });
  }

  async snapshot({ correlationId = this.idFactory('supervision') } = {}) {
    const latest = this.#history.at(-1);
    return deepFreeze({
      schemaVersion: SCHEMA_VERSION,
      type: 'runtime-supervisor-snapshot',
      generatedAt: this.clock().toISOString(),
      correlationId,
      state: latest?.state ?? 'unavailable',
      summary: latest?.summary ?? emptySummary(),
      dependencyGraph: this.order.map((id) => ({ id, dependencies: [...this.components[id].dependencies] })),
      components: latest?.components ?? {},
      history: this.#history
    });
  }

  history() { return deepFreeze(this.#history); }
  #recordResult(result) {
    this.#history.push(result);
    while (this.#history.length > this.historyLimit) this.#history.shift();
    return result;
  }
}

function normalizeComponents(input) {
  const output = {};
  for (const [id, definition] of Object.entries(input)) {
    if (!id.trim() || !definition || typeof definition !== 'object' || Array.isArray(definition)) throw new TypeError(`invalid component definition for ${id}`);
    const dependencies = definition.dependencies ?? [];
    if (!Array.isArray(dependencies) || dependencies.some((value) => typeof value !== 'string' || !value.trim())) throw new TypeError(`dependencies for ${id} must be string ids`);
    output[id] = { id, component: definition.component ?? definition, dependencies: [...new Set(dependencies)], critical: definition.critical !== false, required: definition.required !== false };
  }
  for (const definition of Object.values(output)) for (const dependency of definition.dependencies) {
    if (!output[dependency] && definition.required) throw new TypeError(`component ${definition.id} depends on unknown component ${dependency}`);
  }
  return Object.freeze(output);
}

function topologicalOrder(components) {
  const order = [], visiting = new Set(), visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new TypeError(`component dependency cycle detected at ${id}`);
    visiting.add(id);
    for (const dependency of components[id].dependencies) if (components[dependency]) visit(dependency);
    visiting.delete(id); visited.add(id); order.push(id);
  };
  for (const id of Object.keys(components).sort()) visit(id);
  return Object.freeze(order);
}

async function inspectComponent(id, definition) {
  const target = definition.component;
  try {
    const value = typeof target?.health === 'function' ? await target.health()
      : typeof target?.getHealth === 'function' ? await target.getHealth()
      : typeof target?.snapshot === 'function' ? await target.snapshot() : null;
    if (value === null) return componentResult(id, definition.required ? 'unavailable' : 'degraded', definition, { reason: 'health_interface_unavailable' });
    return componentResult(id, normalizeState(value.state ?? value.status ?? value.health?.state ?? value.health?.status), definition, { source: value.type ?? 'component_health' });
  } catch (error) {
    return componentResult(id, 'failed', definition, { reason: 'component_health_exception', error: normalizeError(error) });
  }
}

function componentResult(id, state, definition, details = {}) {
  return deepFreeze({ id, state, critical: definition.critical, required: definition.required, dependencies: [...definition.dependencies], ...details });
}
function normalizeState(value) {
  const state = String(value ?? '').toLowerCase();
  if (HEALTHY.has(state)) return 'healthy';
  if (DEGRADED.has(state)) return 'degraded';
  if (FAILED.has(state)) return 'failed';
  if (RECOVERING.has(state)) return 'recovering';
  return 'unavailable';
}
function aggregate(results) {
  if (!results.length) return 'unavailable';
  if (results.some((item) => item.state === 'failed' && item.critical)) return 'failed';
  if (results.some((item) => item.state === 'recovering')) return 'recovering';
  if (results.some((item) => item.state === 'failed' || item.state === 'degraded')) return 'degraded';
  if (results.some((item) => item.state === 'unavailable' && item.required)) return 'unavailable';
  return 'healthy';
}
function summarize(results) {
  return results.reduce((summary, item) => { summary.total++; summary[item.state]++; if (item.critical) summary.critical++; return summary; }, emptySummary());
}
function emptySummary() { return { total: 0, healthy: 0, degraded: 0, failed: 0, recovering: 0, unavailable: 0, critical: 0 }; }
function compactDependency(result) { return { id: result.id, state: result.state }; }
function buildCancelled(clock, correlationId) { return { schemaVersion: SCHEMA_VERSION, type: 'runtime-supervisor-evaluation', id: null, correlationId, generatedAt: clock().toISOString(), state: 'unavailable', reason: 'cancelled', summary: emptySummary(), dependencyGraph: [], components: {} }; }
function normalizeError(error) { return { code: error?.code ?? 'COMPONENT_HEALTH_FAILED', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function defaultId(prefix) { return `${prefix}-${Date.now().toString(36)}`; }
