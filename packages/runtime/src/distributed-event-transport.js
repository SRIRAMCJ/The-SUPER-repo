const SCHEMA_VERSION = '0.1.0';

export class DistributedEventTransport {
  #sequence = 0;
  #sourceSequences = new Map();
  #seen = new Set();
  #events = [];
  #subscribers = new Set();

  constructor({ nodeId, clock = () => new Date(), maxEvents = 10_000, maxSeen = 20_000 } = {}) {
    if (typeof nodeId !== 'string' || !nodeId.trim()) throw new TypeError('nodeId must be a non-empty string');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new TypeError('maxEvents must be a positive integer');
    if (!Number.isInteger(maxSeen) || maxSeen < maxEvents) throw new TypeError('maxSeen must be >= maxEvents');
    this.nodeId = nodeId.trim();
    this.clock = clock;
    this.maxEvents = maxEvents;
    this.maxSeen = maxSeen;
  }

  publish(event, { sourceSequence = null, sourceNodeId = this.nodeId, fencingToken = 0 } = {}) {
    validateEvent(event);
    validateNode(sourceNodeId);
    if (!Number.isInteger(fencingToken) || fencingToken < 0) throw new TypeError('fencingToken must be a non-negative integer');
    const eventId = String(event.id ?? '').trim();
    if (!eventId) throw new TypeError('event.id must be a non-empty string');
    if (this.#seen.has(eventId)) return freeze({ state: 'duplicate', event: this.#events.find((item) => item.id === eventId) ?? null });

    const previousSourceSequence = this.#sourceSequences.get(sourceNodeId) ?? 0;
    const nextSourceSequence = sourceSequence === null ? previousSourceSequence + 1 : sourceSequence;
    if (!Number.isInteger(nextSourceSequence) || nextSourceSequence < 1) throw new TypeError('sourceSequence must be a positive integer');
    if (nextSourceSequence <= previousSourceSequence) return freeze({ state: 'stale', sourceNodeId, sourceSequence: nextSourceSequence });
    this.#sourceSequences.set(sourceNodeId, nextSourceSequence);

    const normalized = freeze({
      schemaVersion: SCHEMA_VERSION,
      id: eventId,
      sequence: ++this.#sequence,
      sourceNodeId,
      sourceSequence: nextSourceSequence,
      fencingToken,
      timestamp: typeof event.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp)) ? event.timestamp : this.clock().toISOString(),
      type: event.type,
      ...(event.executionId ? { executionId: event.executionId } : {}),
      ...(event.capabilityId ? { capabilityId: event.capabilityId } : {}),
      ...(event.status ? { status: event.status } : {}),
    });
    this.#events.push(normalized);
    if (this.#events.length > this.maxEvents) this.#events.splice(0, this.#events.length - this.maxEvents);
    this.#seen.add(eventId);
    while (this.#seen.size > this.maxSeen) this.#seen.delete(this.#seen.values().next().value);
    for (const subscriber of this.#subscribers) subscriber(clone(normalized));
    return freeze({ state: 'published', event: normalized });
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  ingest(events = []) {
    if (!Array.isArray(events)) throw new TypeError('events must be an array');
    const results = [];
    for (const event of events) results.push(this.publish(event, { sourceSequence: event.sourceSequence, sourceNodeId: event.sourceNodeId, fencingToken: event.fencingToken }));
    return Object.freeze(results.map(clone));
  }

  history({ afterSequence = 0, limit = this.maxEvents } = {}) {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new TypeError('afterSequence must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
    return Object.freeze(this.#events.filter((event) => event.sequence > afterSequence).slice(-limit).map(clone));
  }

  snapshot() {
    return freeze({ schemaVersion: SCHEMA_VERSION, type: 'distributed-event-transport', nodeId: this.nodeId, sequence: this.#sequence, sourceSequences: Object.fromEntries(this.#sourceSequences), retainedEvents: this.#events.length, seenEventIds: this.#seen.size });
  }
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('event must be an object');
  if (typeof event.type !== 'string' || !event.type.trim()) throw new TypeError('event.type must be a non-empty string');
}
function validateNode(value) { if (typeof value !== 'string' || !value.trim()) throw new TypeError('sourceNodeId must be a non-empty string'); }
function clone(value) { return structuredClone(value); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
export { SCHEMA_VERSION as DISTRIBUTED_EVENT_TRANSPORT_SCHEMA_VERSION };
