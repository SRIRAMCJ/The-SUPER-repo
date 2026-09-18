import { promises as fs } from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = '0.1.0';
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export class DurableEventLog {
  #filePath;
  #clock;
  #maxEvents;
  #maxSeen;
  #lockRetryMs;
  #lockTimeoutMs;
  #lockStaleMs;
  #events = [];
  #seen = new Set();
  #sourceSequences = new Map();
  #sequence = 0;
  #initialized = false;

  constructor({
    filePath,
    clock = () => new Date(),
    maxEvents = 10_000,
    maxSeen = 20_000,
    lockRetryMs = 10,
    lockTimeoutMs = 5_000,
    lockStaleMs = 30_000,
  } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('filePath must be a non-empty string');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new TypeError('maxEvents must be a positive integer');
    if (!Number.isInteger(maxSeen) || maxSeen < maxEvents) throw new TypeError('maxSeen must be >= maxEvents');
    if (!Number.isInteger(lockRetryMs) || lockRetryMs < 1) throw new TypeError('lockRetryMs must be a positive integer');
    if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < lockRetryMs) throw new TypeError('lockTimeoutMs must be >= lockRetryMs');
    if (!Number.isInteger(lockStaleMs) || lockStaleMs < 1) throw new TypeError('lockStaleMs must be a positive integer');
    this.#filePath = path.resolve(filePath);
    this.#clock = clock;
    this.#maxEvents = maxEvents;
    this.#maxSeen = maxSeen;
    this.#lockRetryMs = lockRetryMs;
    this.#lockTimeoutMs = lockTimeoutMs;
    this.#lockStaleMs = lockStaleMs;
  }

  async init() {
    await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
    await this.#reload();
    this.#initialized = true;
    return this.snapshot();
  }

  async append(event, { sourceSequence, sourceNodeId, fencingToken = 0 } = {}) {
    this.#requireInitialized();
    validateEvent(event);
    validateNode(sourceNodeId);
    validateFence(fencingToken);
    const eventId = String(event.id ?? '').trim();
    if (!eventId) throw new TypeError('event.id must be a non-empty string');
    return this.#withLock(async () => {
      await this.#reload();
      if (this.#seen.has(eventId)) {
        const existing = this.#events.find((item) => item.id === eventId);
        return freeze({ state: 'duplicate', event: existing ?? null });
      }
      const previous = this.#sourceSequences.get(sourceNodeId) ?? 0;
      const next = sourceSequence === undefined || sourceSequence === null ? previous + 1 : sourceSequence;
      if (!Number.isInteger(next) || next < 1) throw new TypeError('sourceSequence must be a positive integer');
      if (next <= previous) return freeze({ state: 'stale', sourceNodeId, sourceSequence: next });
      const normalized = freeze({
        schemaVersion: SCHEMA_VERSION,
        id: eventId,
        sequence: this.#sequence + 1,
        sourceNodeId,
        sourceSequence: next,
        fencingToken,
        timestamp: validTimestamp(event.timestamp) ? event.timestamp : this.#clock().toISOString(),
        type: event.type,
        ...(event.executionId ? { executionId: event.executionId } : {}),
        ...(event.capabilityId ? { capabilityId: event.capabilityId } : {}),
        ...(event.status ? { status: event.status } : {}),
      });
      await this.#appendRecord({ op: 'append', event: normalized });
      this.#apply(normalized);
      await this.#compactIfNeeded();
      return freeze({ state: 'published', event: normalized });
    });
  }

  async appendBatch(events = []) {
    if (!Array.isArray(events)) throw new TypeError('events must be an array');
    const results = [];
    for (const item of events) {
      results.push(await this.append(item.event ?? item, {
        sourceSequence: item.sourceSequence ?? item.event?.sourceSequence,
        sourceNodeId: item.sourceNodeId ?? item.event?.sourceNodeId,
        fencingToken: item.fencingToken ?? item.event?.fencingToken ?? 0,
      }));
    }
    return Object.freeze(results.map(clone));
  }

  history({ afterSequence = 0, limit = this.#maxEvents } = {}) {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new TypeError('afterSequence must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
    return Object.freeze(this.#events.filter((event) => event.sequence > afterSequence).slice(0, limit).map(clone));
  }

  async replay({ afterSequence = 0, limit = this.#maxEvents } = {}) {
    await this.#reload();
    return this.history({ afterSequence, limit });
  }

  get(eventId) {
    const id = String(eventId ?? '').trim();
    if (!id) return null;
    const event = this.#events.find((item) => item.id === id);
    return event ? clone(event) : null;
  }

  async compact() {
    this.#requireInitialized();
    return this.#withLock(async () => {
      await this.#reload();
      await this.#writeSnapshot();
      return this.snapshot();
    });
  }

  snapshot() {
    return freeze({
      schemaVersion: SCHEMA_VERSION,
      type: 'durable-event-log',
      filePath: this.#filePath,
      sequence: this.#sequence,
      retainedEvents: this.#events.length,
      seenEventIds: this.#seen.size,
      sourceSequences: Object.fromEntries(this.#sourceSequences),
      initialized: this.#initialized,
    });
  }

  #requireInitialized() {
    if (!this.#initialized) throw new Error('DurableEventLog must be initialized with init()');
  }

  async #reload() {
    let text;
    try {
      text = await fs.readFile(this.#filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.#events = [];
        this.#seen = new Set();
        this.#sourceSequences = new Map();
        this.#sequence = 0;
        return;
      }
      throw error;
    }
    const events = [];
    let latestSequence = 0;
    for (const [index, line] of text.split('\\n').filter(Boolean).entries()) {
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        throw eventLogError('EVENT_LOG_REPLAY_FAILED', `Malformed record at line ${index + 1}`, error);
      }
      if (record?.op === 'snapshot') {
        validateSnapshotRecord(record, index + 1);
        events.length = 0;
        events.push(...record.events);
        latestSequence = record.sequence;
      } else if (record?.op === 'append') {
        validatePersistedEvent(record.event, index + 1);
        if (record.event.sequence <= latestSequence) {
          throw eventLogError('EVENT_LOG_REPLAY_FAILED', 'Non-monotonic event sequence during replay');
        }
        events.push(record.event);
        latestSequence = record.event.sequence;
      } else {
        throw eventLogError('EVENT_LOG_REPLAY_FAILED', `Unknown record operation at line ${index + 1}`);
      }
    }
    this.#events = events.slice(-this.#maxEvents);
    this.#seen = new Set(this.#events.map((event) => event.id));
    this.#sourceSequences = new Map();
    for (const event of this.#events) {
      const previous = this.#sourceSequences.get(event.sourceNodeId) ?? 0;
      if (event.sourceSequence <= previous) {
        throw eventLogError('EVENT_LOG_REPLAY_FAILED', `Non-monotonic source sequence for ${event.sourceNodeId}`);
      }
      this.#sourceSequences.set(event.sourceNodeId, event.sourceSequence);
    }
    this.#sequence = latestSequence;
  }

  async #appendRecord(record) {
    const payload = `${JSON.stringify(record)}\\n`;
    const handle = await fs.open(this.#filePath, 'a');
    try {
      await handle.write(payload, null, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  #apply(event) {
    this.#events.push(event);
    this.#seen.add(event.id);
    this.#sourceSequences.set(event.sourceNodeId, event.sourceSequence);
    this.#sequence = event.sequence;
    if (this.#events.length > this.#maxEvents) this.#events.splice(0, this.#events.length - this.#maxEvents);
    while (this.#seen.size > this.#maxSeen) {
      const oldest = this.#events.find((item) => this.#seen.has(item.id));
      if (!oldest) break;
      this.#seen.delete(oldest.id);
    }
  }

  async #compactIfNeeded() {
    if (this.#events.length < this.#maxEvents) return;
    await this.#writeSnapshot();
  }

  async #writeSnapshot() {
    const temporary = `${this.#filePath}.${process.pid}.tmp`;
    const record = {
      op: 'snapshot',
      schemaVersion: SCHEMA_VERSION,
      sequence: this.#sequence,
      events: this.#events.map(clone),
    };
    const handle = await fs.open(temporary, 'w');
    try {
      await handle.write(JSON.stringify(record) + '\\n', null, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, this.#filePath);
  }

  async #withLock(fn) {
    const lockPath = `${this.#filePath}.lock`;
    const started = Date.now();
    while (true) {
      try {
        await fs.mkdir(lockPath);
        try {
          return await fn();
        } finally {
          await fs.rm(lockPath, { recursive: true, force: true });
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > this.#lockStaleMs) {
            await fs.rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (statError.code !== 'ENOENT') throw statError;
        }
        if (Date.now() - started >= this.#lockTimeoutMs) {
          throw eventLogError('EVENT_LOG_LOCK_TIMEOUT', 'Timed out acquiring durable event log lock');
        }
        await sleep(this.#lockRetryMs);
      }
    }
  }
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('event must be an object');
  if (typeof event.type !== 'string' || !event.type.trim()) throw new TypeError('event.type must be a non-empty string');
}
function validateNode(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('sourceNodeId must be a non-empty string');
}
function validateFence(value) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError('fencingToken must be a non-negative integer');
}
function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function validatePersistedEvent(event, line) {
  validateEvent(event);
  if (typeof event.id !== 'string' || !event.id.trim()) throw eventLogError('EVENT_LOG_REPLAY_FAILED', `Invalid event id at line ${line}`);
  if (!Number.isInteger(event.sequence) || event.sequence < 1) throw eventLogError('EVENT_LOG_REPLAY_FAILED', `Invalid event sequence at line ${line}`);
  validateNode(event.sourceNodeId);
  if (!Number.isInteger(event.sourceSequence) || event.sourceSequence < 1) throw eventLogError('EVENT_LOG_REPLAY_FAILED', `Invalid source sequence at line ${line}`);
  validateFence(event.fencingToken);
}
function validateSnapshotRecord(record, line) {
  if (!Number.isInteger(record.sequence) || record.sequence < 0 || !Array.isArray(record.events)) {
    throw eventLogError('EVENT_LOG_REPLAY_FAILED', `Invalid snapshot at line ${line}`);
  }
  let previous = 0;
  for (const event of record.events) {
    validatePersistedEvent(event, line);
    if (event.sequence <= previous) throw eventLogError('EVENT_LOG_REPLAY_FAILED', 'Snapshot event sequences are not monotonic');
    previous = event.sequence;
  }
}
function eventLogError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}
function clone(value) { return structuredClone(value); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export { SCHEMA_VERSION as DURABLE_EVENT_LOG_SCHEMA_VERSION, TERMINAL_STATES as DURABLE_EVENT_LOG_TERMINAL_STATES };
