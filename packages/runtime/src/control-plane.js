export class RuntimeControlPlane {
  constructor({ eventBus = null, observability, stateStore = null, evolutionControlPlane = null, executionEngine = null, clock = () => new Date(), failureWindowMs = 300000, maxRecentExecutions = 100, maxRecentEvents = 100 } = {}) {
    if (!observability || typeof observability.getMetrics !== 'function') throw new TypeError('RuntimeControlPlane requires a compatible observability engine');
    if (eventBus && typeof eventBus.on !== 'function') throw new TypeError('RuntimeControlPlane requires a compatible event bus');
    if (stateStore && typeof stateStore.list !== 'function') throw new TypeError('RuntimeControlPlane requires a compatible state store');
    if (evolutionControlPlane && typeof evolutionControlPlane.list !== 'function') throw new TypeError('RuntimeControlPlane requires a compatible evolution control plane');
    if (executionEngine && typeof executionEngine.cancel !== 'function') throw new TypeError('RuntimeControlPlane requires an execution engine with cancel()');
    this.observability = observability;
    this.stateStore = stateStore;
    this.evolutionControlPlane = evolutionControlPlane;
    this.executionEngine = executionEngine;
    this.clock = clock;
    this.failureWindowMs = failureWindowMs;
    this.maxRecentExecutions = maxRecentExecutions;
    this.maxRecentEvents = maxRecentEvents;
    this.unsubscribe = eventBus ? eventBus.on('*', () => {}) : null;
  }

  getHealth() {
    const now = this.clock().getTime();
    const metrics = this.observability.getMetrics();
    const recentFailures = this.observability.getEvents().filter((event) => /\\.(failed|denied|cancelled|rolled_back|rejected)$/.test(event.type) && now - Date.parse(event.timestamp) <= this.failureWindowMs).length;
    const started = metric(metrics, 'executions.started');
    const failed = metric(metrics, 'executions.failed');
    const denied = metric(metrics, 'executions.denied');
    const failureRate = started ? (failed + denied) / started : 0;
    const status = recentFailures >= 5 || failureRate >= 0.25 ? 'critical' : recentFailures > 0 && metrics.activeExecutions > 0 ? 'degraded' : 'healthy';
    return freeze({ schemaVersion: '0.1.0', type: 'runtime-health', generatedAt: this.clock().toISOString(), status, activeExecutions: metrics.activeExecutions, recentFailures, failureWindowMs: this.failureWindowMs, executionFailureRate: Number(failureRate.toFixed(6)), counters: { started, completed: metric(metrics, 'executions.completed'), failed, denied } });
  }

  getExecutions({ executionId = null, status = null, limit = this.maxRecentExecutions } = {}) {
    if (!Number.isInteger(limit) || limit <= 0) throw new TypeError('limit must be a positive integer');
    const executions = new Map();
    for (const event of this.observability.getEvents()) {
      if (!event.executionId || (executionId && event.executionId !== executionId)) continue;
      const item = executions.get(event.executionId) ?? { executionId: event.executionId, capabilityId: event.capabilityId ?? null, startedAt: null, endedAt: null, status: 'unknown', lastEventType: null, lastEventAt: null };
      item.capabilityId ??= event.capabilityId ?? null;
      item.lastEventType = event.type;
      item.lastEventAt = event.timestamp;
      if (event.type.endsWith('.started') && !item.startedAt) { item.startedAt = event.timestamp; item.status = 'running'; }
      if (/\\.(completed|failed|cancelled|rolled_back|rejected)$/.test(event.type)) { item.endedAt = event.timestamp; item.status = event.type.split('.').at(-1); }
      executions.set(event.executionId, item);
    }
    return Object.freeze([...executions.values()].filter((item) => !status || item.status === status).sort((a, b) => String(b.lastEventAt).localeCompare(String(a.lastEventAt))).slice(0, limit).map(freeze));
  }

  async getEvolution() {
    const controls = this.evolutionControlPlane ? await this.evolutionControlPlane.list() : this.stateStore ? await this.stateStore.list({ type: 'evolution-control' }) : [];
    const events = this.observability.getEvents().filter((event) => event.type.startsWith('evolution.'));
    return freeze({ schemaVersion: '0.1.0', type: 'runtime-evolution-view', generatedAt: this.clock().toISOString(), active: controls.filter((control) => control.status === 'running').length, controls, recentEvents: events.slice(-this.maxRecentEvents) });
  }

  async cancelExecution(executionId, reason = 'Cancelled by runtime control plane') {
    if (typeof executionId !== 'string' || !executionId.trim()) throw new TypeError('executionId must be a non-empty string');
    if (!this.executionEngine) return freeze({ schemaVersion: '0.1.0', type: 'control-action-result', action: 'cancel_execution', status: 'unsupported', executionId, reason });
    return freeze({ schemaVersion: '0.1.0', type: 'control-action-result', action: 'cancel_execution', executionId, result: await this.executionEngine.cancel(executionId, reason) });
  }

  async snapshot() {
    return freeze({ schemaVersion: '0.1.0', type: 'runtime-control-plane-snapshot', generatedAt: this.clock().toISOString(), health: this.getHealth(), metrics: this.observability.getMetrics(), executions: this.getExecutions(), evolution: await this.getEvolution(), traces: this.observability.getTraces(), recentEvents: this.observability.getEvents().slice(-this.maxRecentEvents) });
  }

  close() { if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; } }
}

function metric(metrics, name) { return metrics.metrics.find((entry) => entry.name === name)?.value ?? 0; }
function freeze(value) { return Object.freeze(structuredClone(value)); }
