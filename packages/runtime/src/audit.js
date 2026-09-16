export class ExecutionAudit {
  constructor({ events = null, clock = () => new Date() } = {}) {
    this.events = events;
    this.clock = clock;
    this.records = new Map();
    this.unsubscribe = events?.on('*', (event) => this.recordEvent(event));
  }

  recordEvent(event) {
    const executionId = event.executionId ?? event.missionExecutionId;
    if (!executionId) return;
    const record = this.records.get(executionId) ?? {
      executionId,
      kind: inferKind(event.type),
      capabilityId: event.capabilityId,
      startedAt: null,
      finishedAt: null,
      status: 'unknown',
      events: []
    };
    record.kind ??= inferKind(event.type);
    record.capabilityId ??= event.capabilityId;
    record.events.push(event);
    const timestamp = event.timestamp ?? this.clock().toISOString();

    if (isStartEvent(event.type)) {
      record.startedAt ??= timestamp;
      record.status = 'running';
    } else if (isSuccessEvent(event.type)) {
      record.finishedAt = timestamp;
      record.status = 'succeeded';
    } else if (isCancelledEvent(event.type)) {
      record.finishedAt = timestamp;
      record.status = 'cancelled';
      record.error = event.error;
    } else if (isFailureEvent(event.type)) {
      record.finishedAt = timestamp;
      record.status = 'failed';
      record.error = event.error;
    }
    this.records.set(executionId, record);
  }

  get(executionId) {
    const record = this.records.get(executionId);
    return record ? structuredClone(record) : null;
  }

  list() { return [...this.records.values()].map((record) => structuredClone(record)); }

  close() { this.unsubscribe?.(); }
}

const START_EVENTS = new Set(['execution.started', 'plan.started', 'plan.resumed', 'task-graph.started', 'task-graph.resumed', 'mission.started']);
const SUCCESS_EVENTS = new Set(['execution.completed', 'plan.completed', 'task-graph.completed', 'mission.completed']);
const CANCELLED_EVENTS = new Set(['execution.cancelled', 'task-graph.cancelled', 'mission.cancelled']);
const FAILURE_EVENTS = new Set(['execution.failed', 'plan.failed', 'task-graph.failed', 'mission.failed']);

function isStartEvent(type) { return START_EVENTS.has(type); }
function isSuccessEvent(type) { return SUCCESS_EVENTS.has(type); }
function isCancelledEvent(type) { return CANCELLED_EVENTS.has(type); }
function isFailureEvent(type) { return FAILURE_EVENTS.has(type); }

function inferKind(type) {
  if (type?.startsWith('task-graph.') || type?.startsWith('task.')) return 'task-graph';
  if (type?.startsWith('mission.')) return 'mission';
  if (type?.startsWith('plan.')) return 'plan';
  return 'execution';
}

export class MemoryStore {
  #items = [];

  append(record) {
    if (!record || typeof record !== 'object') throw new TypeError('Memory record must be an object');
    const item = Object.freeze(structuredClone({ ...record, recordedAt: record.recordedAt ?? new Date().toISOString() }));
    this.#items.push(item);
    return item;
  }

  query(predicate = () => true) { return this.#items.filter(predicate).map((item) => structuredClone(item)); }
  size() { return this.#items.length; }
}
