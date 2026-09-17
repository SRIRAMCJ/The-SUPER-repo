const TERMINAL_SUFFIXES = new Set(['completed', 'failed', 'cancelled', 'rolled_back', 'rejected']);
const START_SUFFIXES = new Set(['started']);

export class ObservabilityEngine {
  constructor({ eventBus = null, clock = () => new Date(), maxEvents = 10000, maxTraces = 5000 } = {}) {
    if (eventBus && typeof eventBus.on !== 'function') throw new TypeError('ObservabilityEngine requires a compatible event bus');
    if (!Number.isInteger(maxEvents) || maxEvents <= 0) throw new TypeError('ObservabilityEngine maxEvents must be a positive integer');
    if (!Number.isInteger(maxTraces) || maxTraces <= 0) throw new TypeError('ObservabilityEngine maxTraces must be a positive integer');
    this.clock = clock;
    this.maxEvents = maxEvents;
    this.maxTraces = maxTraces;
    this.events = [];
    this.spans = new Map();
    this.metrics = new Map();
    this.activeExecutions = new Set();
    this.unsubscribe = eventBus ? eventBus.on('*', (event) => this.observe(event)) : null;
  }

  observe(event) {
    validateEvent(event);
    const normalized = normalizeEvent(event, this.clock);
    this.#recordEvent(normalized);
    this.#increment('events.total');
    this.#increment(`events.type.${normalized.type}`);

    const executionId = normalized.executionId;
    const suffix = normalized.type.split('.').at(-1);
    if (executionId && START_SUFFIXES.has(suffix)) this.#startSpan(normalized);
    if (executionId && TERMINAL_SUFFIXES.has(suffix)) this.#finishSpan(normalized);
    if (executionId && normalized.type === 'execution.started') this.activeExecutions.add(executionId);
    if (executionId && /^execution\.(completed|failed|cancelled)$/.test(normalized.type)) this.activeExecutions.delete(executionId);

    if (normalized.type === 'execution.completed') this.#increment('executions.completed');
    if (normalized.type === 'execution.failed') this.#increment('executions.failed');
    if (normalized.type === 'execution.denied') this.#increment('executions.denied');
    if (normalized.type === 'execution.progress') this.#increment('executions.progress_events');
    if (normalized.type === 'execution.started') this.#increment('executions.started');
    return normalized;
  }

  getMetrics() {
    const metrics = [...this.metrics.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => ({ name, value }));
    return Object.freeze({
      schemaVersion: '0.1.0',
      type: 'observability-metrics',
      generatedAt: this.clock().toISOString(),
      activeExecutions: this.activeExecutions.size,
      metrics: Object.freeze(metrics.map(Object.freeze))
    });
  }

  getTraces(filter = {}) {
    validateFilter(filter);
    const traces = [...this.spans.values()]
      .filter((span) => !filter.executionId || span.executionId === filter.executionId)
      .filter((span) => !filter.name || span.name === filter.name)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return traces.map(cloneFrozen);
  }

  getEvents(filter = {}) {
    validateFilter(filter);
    return this.events
      .filter((event) => Object.entries(filter).every(([key, value]) => event[key] === value))
      .map(cloneFrozen);
  }

  snapshot() {
    return Object.freeze({
      schemaVersion: '0.1.0',
      type: 'observability-snapshot',
      generatedAt: this.clock().toISOString(),
      metrics: this.getMetrics(),
      traces: this.getTraces(),
      eventCount: this.events.length
    });
  }

  close() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  #recordEvent(event) {
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }

  #increment(name, amount = 1) {
    this.metrics.set(name, (this.metrics.get(name) ?? 0) + amount);
  }

  #startSpan(event) {
    const key = spanKey(event);
    if (this.spans.has(key)) return;
    if (this.spans.size >= this.maxTraces) this.#evictOldestTrace();
    this.spans.set(key, {
      schemaVersion: '0.1.0',
      type: 'trace-span',
      spanId: `span_${event.id}`,
      executionId: event.executionId,
      name: event.type.slice(0, -'.started'.length),
      startedAt: event.timestamp,
      endedAt: null,
      durationMs: null,
      status: 'running',
      attributes: compactAttributes(event)
    });
  }

  #finishSpan(event) {
    const key = spanKeyForTerminal(event);
    const span = this.spans.get(key);
    if (!span || span.endedAt) return;
    const endedAt = event.timestamp;
    const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(span.startedAt));
    span.endedAt = endedAt;
    span.durationMs = durationMs;
    span.status = event.type.split('.').at(-1);
    this.#increment(`duration.count.${span.name}`);
    this.#increment(`duration.total_ms.${span.name}`, durationMs);
    const max = this.metrics.get(`duration.max_ms.${span.name}`) ?? 0;
    this.metrics.set(`duration.max_ms.${span.name}`, Math.max(max, durationMs));
    const minName = `duration.min_ms.${span.name}`;
    const min = this.metrics.get(minName);
    this.metrics.set(minName, min === undefined ? durationMs : Math.min(min, durationMs));
    this.#increment(`status.${span.name}.${span.status}`);
  }

  #evictOldestTrace() {
    const oldest = this.spans.keys().next().value;
    if (oldest) this.spans.delete(oldest);
  }
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('Observability event must be an object');
  if (typeof event.type !== 'string' || !event.type.trim()) throw new TypeError('Observability event requires type');
}

function validateFilter(filter) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new TypeError('Observability filter must be an object');
}

function normalizeEvent(event, clock) {
  const timestamp = typeof event.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp))
    ? event.timestamp
    : clock().toISOString();
  return Object.freeze({
    schemaVersion: event.schemaVersion ?? '0.1.0',
    id: event.id ?? `obs_${crypto.randomUUID().replaceAll('-', '')}`,
    timestamp,
    type: event.type,
    ...(event.executionId ? { executionId: event.executionId } : {}),
    ...(event.capabilityId ? { capabilityId: event.capabilityId } : {}),
    ...(event.status ? { status: event.status } : {})
  });
}

function compactAttributes(event) {
  return Object.freeze({
    ...(event.capabilityId ? { capabilityId: event.capabilityId } : {}),
    ...(event.status ? { status: event.status } : {})
  });
}

function spanKey(event) {
  return `${event.type.slice(0, -'.started'.length)}:${event.executionId}`;
}

function spanKeyForTerminal(event) {
  const parts = event.type.split('.');
  parts.pop();
  return `${parts.join('.')}:${event.executionId}`;
}

function cloneFrozen(value) {
  return Object.freeze(structuredClone(value));
}
