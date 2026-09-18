import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = '0.1.0';

export class ExecutionJournal {
  constructor({ filePath, clock = () => new Date(), maxRecords = 10_000 } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('filePath must be a non-empty string');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords must be a positive integer');
    this.filePath = path.resolve(filePath);
    this.clock = clock;
    this.maxRecords = maxRecords;
    this.writeQueue = Promise.resolve();
  }

  async append(record) {
    validateRecord(record);
    const entry = freeze({ schemaVersion: SCHEMA_VERSION, journalId: record.journalId ?? defaultId('journal'), timestamp: record.timestamp ?? this.clock().toISOString(), ...sanitize(record) });
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const handle = await open(this.filePath, 'a');
      try {
        await handle.writeFile(JSON.stringify(entry) + '\n', 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      await this.#compactIfNeeded();
    });
    await this.writeQueue;
    return clone(entry);
  }

  async replay() {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const records = content.split('\n').filter(Boolean).map(line => JSON.parse(line));
      records.forEach(validateRecord);
      return records.map(clone);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw Object.assign(new Error(`Execution journal replay failed: ${error.message}`), { code: 'JOURNAL_REPLAY_FAILED', retryable: true, cause: error });
    }
  }

  async state(executionId = null) {
    const records = await this.replay();
    const state = new Map();
    for (const record of records) {
      if (!record.executionId) continue;
      if (!state.has(record.executionId)) state.set(record.executionId, []);
      state.get(record.executionId).push(record);
    }
    const result = [...state.entries()].map(([id, events]) => ({ executionId: id, events }));
    return executionId ? (result.find(item => item.executionId === executionId) ?? null) : result;
  }

  async #compactIfNeeded() {
    const records = await this.replay();
    if (records.length <= this.maxRecords) return;
    const retained = records.slice(-this.maxRecords);
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await open(temporaryPath, 'w').then(async handle => { try { await handle.writeFile(retained.map(JSON.stringify).join('\n') + '\n', 'utf8'); await handle.sync(); } finally { await handle.close(); } });
    await rename(temporaryPath, this.filePath);
  }
}

export class DurableExecutionState {
  constructor({ journal, clock = () => new Date() } = {}) {
    if (!journal || typeof journal.append !== 'function' || typeof journal.replay !== 'function') throw new TypeError('journal must expose append() and replay()');
    this.journal = journal; this.clock = clock;
  }

  async record({ executionId, transactionId, status, operation, correlationId, idempotencyKey = null, result, error } = {}) {
    if (!executionId || !transactionId || !status) throw new TypeError('executionId, transactionId and status are required');
    return this.journal.append({ event: 'transaction.state', executionId, transactionId, status, operation, correlationId, idempotencyKey, result: clone(result), error: clone(error) });
  }

  async load() {
    const records = await this.journal.replay();
    const latest = new Map();
    for (const record of records) if (record.event === 'transaction.state' && record.transactionId) latest.set(record.transactionId, record);
    return [...latest.values()].map(clone);
  }
}

function validateRecord(record) { if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('Journal record must be an object'); }
function sanitize(value) { return redact(structuredClone(value)); }
function redact(value) { if (Array.isArray(value)) return value.map(redact); if (!value || typeof value !== 'object') return value; const out={}; for (const [key,child] of Object.entries(value)) out[key]=/pass(word)?|secret|token|api[_-]?key|private[_-]?key/i.test(key)?'[REDACTED]':redact(child); return out; }
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function freeze(value) { return Object.freeze(structuredClone(value)); }
function defaultId(prefix) { return `${prefix}-${Date.now().toString(36)}`; }

export { SCHEMA_VERSION as EXECUTION_JOURNAL_SCHEMA_VERSION };
