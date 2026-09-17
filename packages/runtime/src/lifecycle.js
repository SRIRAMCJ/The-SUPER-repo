const SCHEMA_VERSION = '0.1.0';

const STATES = Object.freeze(['bootstrap', 'initializing', 'ready', 'running', 'draining', 'stopping', 'stopped', 'failed']);
const TRANSITIONS = Object.freeze({
  bootstrap: ['initializing', 'stopping', 'failed'],
  initializing: ['ready', 'stopping', 'failed'],
  ready: ['running', 'stopping', 'failed'],
  running: ['draining', 'stopping', 'failed'],
  draining: ['stopping', 'running', 'failed'],
  stopping: ['stopped', 'failed'],
  stopped: ['bootstrap'],
  failed: ['stopping', 'stopped', 'bootstrap']
});

export class RuntimeLifecycleManager {
  constructor({ components = [], clock = () => new Date(), onTransition = () => {}, maxHistory = 1000 } = {}) {
    if (!Array.isArray(components)) throw new TypeError('components must be an array');
    if (typeof clock !== 'function' || typeof onTransition !== 'function') throw new TypeError('clock and onTransition must be functions');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    this.components = normalizeComponents(components);
    this.clock = clock;
    this.onTransition = onTransition;
    this.maxHistory = maxHistory;
    this.state = 'bootstrap';
    this.history = [];
    this.activeOperation = null;
    this.startedComponents = new Set();
    this.sequence = 0;
    this.operationQueue = Promise.resolve();
  }

  getState() {
    return Object.freeze({ schemaVersion: SCHEMA_VERSION, state: this.state, activeOperation: this.activeOperation ? structuredClone(this.activeOperation) : null, sequence: this.sequence });
  }

  getHistory(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
    return Object.freeze(structuredClone(this.history.slice(-limit)));
  }

  getComponents() {
    return Object.freeze(this.components.map((component) => Object.freeze({ name: component.name, dependsOn: [...component.dependsOn] })));
  }

  start() {
    return this.#exclusive(() => this.#start());
  }

  async #start() {
    this.assertState(['bootstrap', 'stopped', 'failed'], 'start');
    await this.#transition('initializing', 'start');
    const started = [];
    try {
      for (const component of orderComponents(this.components)) {
        await this.invoke(component, 'start');
        started.push(component);
        this.startedComponents.add(component.name);
      }
      await this.#transition('ready', 'start');
      await this.#transition('running', 'start');
      return this.getState();
    } catch (error) {
      await this.#rollbackStarted(started);
      await this.fail('start', error);
      throw error;
    }
  }

  drain() {
    return this.#exclusive(async () => {
      this.assertState(['running'], 'drain');
      await this.#transition('draining', 'drain');
      for (const component of orderComponents(this.components)) await this.invoke(component, 'drain');
      return this.getState();
    });
  }

  stop() {
    return this.#exclusive(() => this.#stop());
  }

  async #stop() {
    this.assertState(['bootstrap', 'initializing', 'ready', 'running', 'draining', 'failed'], 'stop');
    if (this.state !== 'stopping') await this.#transition('stopping', 'stop');
    try {
      const ordered = orderComponents(this.components).reverse();
      for (const component of ordered) {
        if (this.startedComponents.has(component.name)) await this.invoke(component, 'stop');
      }
      this.startedComponents.clear();
      await this.#transition('stopped', 'stop');
      return this.getState();
    } catch (error) {
      await this.fail('stop', error);
      throw error;
    }
  }

  transition(nextState, reason = 'transition') {
    return this.#exclusive(() => this.#transition(nextState, reason));
  }

  async #transition(nextState, reason = 'transition') {
    if (!STATES.includes(nextState)) throw new TypeError(`Unknown lifecycle state: ${nextState}`);
    if (nextState === this.state) return this.getState();
    if (!TRANSITIONS[this.state].includes(nextState)) throw new Error(`Invalid lifecycle transition: ${this.state} -> ${nextState}`);
    const previous = this.state;
    this.state = nextState;
    this.sequence += 1;
    const entry = Object.freeze({ sequence: this.sequence, previous, state: nextState, reason, timestamp: this.clock().toISOString() });
    this.history.push(entry);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    await this.onTransition(structuredClone(entry));
    return this.getState();
  }

  async invoke(component, method) {
    const handler = component[method];
    if (typeof handler !== 'function') return;
    this.activeOperation = { component: component.name, operation: method, startedAt: this.clock().toISOString() };
    try { await handler.call(component.context ?? component); }
    finally { this.activeOperation = null; }
  }

  async #rollbackStarted(started) {
    for (const component of [...started].reverse()) {
      try {
        await this.invoke(component, 'stop');
        this.startedComponents.delete(component.name);
      } catch (rollbackError) {
        this.history.push(Object.freeze({ sequence: ++this.sequence, previous: this.state, state: this.state, reason: 'startup-rollback', error: errorMessage(rollbackError), timestamp: this.clock().toISOString() }));
        if (this.history.length > this.maxHistory) this.history.shift();
      }
    }
  }

  async fail(reason, error) {
    if (this.state !== 'failed' && TRANSITIONS[this.state].includes('failed')) await this.#transition('failed', reason);
    if (this.state === 'failed') {
      this.history.push(Object.freeze({ sequence: ++this.sequence, previous: 'failed', state: 'failed', reason, error: errorMessage(error), timestamp: this.clock().toISOString() }));
      if (this.history.length > this.maxHistory) this.history.shift();
    }
  }

  #exclusive(operation) {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.catch(() => undefined);
    return run;
  }

  assertState(allowed, operation) {
    if (!allowed.includes(this.state)) throw new Error(`Cannot ${operation} while runtime is ${this.state}`);
  }
}

function normalizeComponents(components) {
  const names = new Set();
  return components.map((component) => {
    if (!component || typeof component !== 'object') throw new TypeError('Each lifecycle component must be an object');
    const name = String(component.name ?? '').trim();
    if (!name) throw new TypeError('Lifecycle component requires a name');
    if (names.has(name)) throw new TypeError(`Duplicate lifecycle component: ${name}`);
    names.add(name);
    const dependsOn = component.dependsOn === undefined ? [] : component.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((item) => typeof item !== 'string')) throw new TypeError(`dependsOn for ${name} must be an array of strings`);
    if (typeof component.start !== 'function' && typeof component.stop !== 'function') throw new TypeError(`Lifecycle component ${name} requires start or stop`);
    return { ...component, name, dependsOn: [...dependsOn] };
  });
}

function orderComponents(components) {
  const byName = new Map(components.map((component) => [component.name, component]));
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (component) => {
    if (visited.has(component.name)) return;
    if (visiting.has(component.name)) throw new Error(`Lifecycle dependency cycle detected at ${component.name}`);
    visiting.add(component.name);
    for (const dependency of component.dependsOn) {
      const target = byName.get(dependency);
      if (!target) throw new Error(`Unknown lifecycle dependency: ${component.name} -> ${dependency}`);
      visit(target);
    }
    visiting.delete(component.name);
    visited.add(component.name);
    ordered.push(component);
  };
  for (const component of components) visit(component);
  return ordered;
}

function errorMessage(error) { return error instanceof Error ? error.message : String(error); }

export { STATES as RUNTIME_LIFECYCLE_STATES };
