import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = '0.1.0';

export class DurableObservabilityCheckpointStore {
  #filePath;
  #maxRecords;
  #lockPath;
  #lockTimeoutMs;
  #lockStaleMs;
  #clock;

  constructor({ filePath, maxRecords = 10_000, lockTimeoutMs = 5_000, lockStaleMs = 30_000, clock = () => new Date() } = {}) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath is required');
    if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords must be positive');
    this.#filePath = filePath;
    this.#maxRecords = maxRecords;
    this.#lockTimeoutMs = lockTimeoutMs;
    this.#lockStaleMs = lockStaleMs;
    this.#clock = clock;
  }

  init() {
    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
    if (!fs.existsSync(this.#filePath)) fs.writeFileSync(this.#filePath, '', 'utf8');
    return this;
  }

  append(checkpoint) {
    this.init();
    return this.#withLock(() => {
      const records = this.replay();
      const current = records.find((record) => record.sourceNodeId === checkpoint.sourceNodeId);
      if (current && checkpoint.fencingToken < current.fencingToken) return { state: 'stale_fence', checkpoint: current };
      if (current && checkpoint.sourceSequence < current.sourceSequence) return { state: 'stale', checkpoint: current };
      if (current && checkpoint.sourceSequence === current.sourceSequence && checkpoint.eventSequence === current.eventSequence && checkpoint.fencingToken === current.fencingToken) return { state: 'duplicate', checkpoint: current };
      if (current && checkpoint.sourceSequence === current.sourceSequence && checkpoint.eventSequence <= current.eventSequence) return { state: 'conflict', checkpoint: current };
      fs.appendFileSync(this.#filePath, JSON.stringify(checkpoint) + '\n', 'utf8');
      const fd = fs.openSync(this.#filePath, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.#compactIfNeeded();
      return { state: 'committed', checkpoint: structuredClone(checkpoint) };
    });
  }

  replay() {
    this.init();
    const latest = new Map();
    const lines = fs.readFileSync(this.#filePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch (error) { const err = new Error('checkpoint replay failed'); err.code = 'CHECKPOINT_REPLAY_FAILED'; err.cause = error; throw err; }
      if (!record || typeof record.sourceNodeId !== 'string') { const err = new Error('invalid checkpoint record'); err.code = 'CHECKPOINT_REPLAY_FAILED'; throw err; }
      const current = latest.get(record.sourceNodeId);
      if (!current || record.fencingToken > current.fencingToken || (record.fencingToken === current.fencingToken && record.sourceSequence >= current.sourceSequence)) latest.set(record.sourceNodeId, record);
    }
    return [...latest.values()].map((record) => structuredClone(record));
  }

  snapshot() {
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      type: 'durable-observability-checkpoint-store',
      filePath: this.#filePath,
      checkpoints: this.replay().length,
      maxRecords: this.#maxRecords,
    });
  }

  #compactIfNeeded() {
    const lines = fs.readFileSync(this.#filePath, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= this.#maxRecords) return;
    const records = this.replay();
    const temp = this.#filePath + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(temp, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
    const fd = fs.openSync(temp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.#filePath);
  }

  #withLock(fn) {
    const started = this.#clock().getTime();
    for (;;) {
      try {
        fs.mkdirSync(this.#lockPath || (this.#lockPath = this.#filePath + '.lock'));
        try { return fn(); } finally { fs.rmdirSync(this.#lockPath); }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const stat = fs.statSync(this.#lockPath);
        if (this.#clock().getTime() - stat.mtimeMs > this.#lockStaleMs) { fs.rmdirSync(this.#lockPath); continue; }
        if (this.#clock().getTime() - started >= this.#lockTimeoutMs) { const err = new Error('checkpoint lock timeout'); err.code = 'CHECKPOINT_LOCK_TIMEOUT'; throw err; }
        const end = Date.now() + 5;
        while (Date.now() < end) {}
      }
    }
  }
}

export { SCHEMA_VERSION as DURABLE_OBSERVABILITY_CHECKPOINT_SCHEMA_VERSION };
