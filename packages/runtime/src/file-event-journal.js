import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomicJson } from './atomic-json.js';
import { withKernelFileLock } from './kernel-file-lock.js';

const ZERO = '0'.repeat(64);
const DIGEST = /^[0-9a-f]{64}$/;

// Bounded, append-only local journal. The head is committed after each record;
// an interrupted append leaves an orphan and requires explicit repair.
export class FileEventJournal {
  constructor(directory, { maxRecords = 10_000, maxEventBytes = 65_536, lockTimeoutMs = 5000 } = {}) {
    if (process.platform !== 'linux') throw new Error('FileEventJournal requires Linux flock');
    if (typeof directory !== 'string' || !directory ||
        !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1_000_000 ||
        !Number.isSafeInteger(maxEventBytes) || maxEventBytes < 64 || maxEventBytes > 1_000_000 ||
        !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) throw new TypeError('Invalid journal configuration');
    this.directory = path.resolve(directory);
    this.maxRecords = maxRecords;
    this.maxEventBytes = maxEventBytes;
    this.lockTimeoutMs = lockTimeoutMs;
  }

  async append(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string' || !event.type.trim()) throw new TypeError('Event requires a type');
    let payload;
    try { payload = JSON.stringify(event); } catch { throw fault('EVENT_JOURNAL_EVENT_INVALID'); }
    if (typeof payload !== 'string' || Buffer.byteLength(payload) > this.maxEventBytes) throw fault('EVENT_JOURNAL_EVENT_INVALID');
    const copy = JSON.parse(payload);
    return this.#locked(async () => {
      const head = await this.#head(true);
      if (head.sequence >= this.maxRecords) throw fault('EVENT_JOURNAL_CAPACITY');
      if (head.sequence) await this.#verifyRecord(head.sequence, head.hash);
      if (await exists(this.#recordPath(head.sequence + 1))) throw fault('EVENT_JOURNAL_CORRUPT');
      const sequence = head.sequence + 1;
      const hash = digest(head.hash, sequence, payload);
      await writeAtomicJson(this.#recordPath(sequence), { sequence, previousHash: head.hash, hash, event: copy });
      await writeAtomicJson(this.#headPath(), { sequence, hash });
      return { sequence, hash };
    });
  }

  async replay({ afterSequence = 0, limit = 100 } = {}) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError('Invalid replay cursor or limit');
    return this.#locked(async () => {
      const head = await this.#head(false);
      let previousHash = ZERO;
      const events = [];
      for (let sequence = 1; sequence <= head.sequence; sequence++) {
        const record = await this.#verifyRecord(sequence);
        if (record.previousHash !== previousHash) throw fault('EVENT_JOURNAL_CORRUPT');
        previousHash = record.hash;
        if (sequence > afterSequence && events.length < limit) events.push({ sequence, event: record.event });
      }
      if (previousHash !== head.hash || await exists(this.#recordPath(head.sequence + 1))) throw fault('EVENT_JOURNAL_CORRUPT');
      return { events, head: { ...head } };
    });
  }

  #headPath() { return path.join(this.directory, 'head.json'); }
  #recordPath(sequence) { return path.join(this.directory, `${String(sequence).padStart(12, '0')}.json`); }

  async #locked(work) {
    await mkdir(this.directory, { recursive: true });
    return withKernelFileLock(path.join(this.directory, 'journal.lock'), this.lockTimeoutMs, work);
  }

  async #head(initialize) {
    const markerPath = path.join(this.directory, 'initialized.json');
    const marker = await readJson(markerPath, 128);
    if (marker && (marker.schemaVersion !== '0.1.0' || marker.initialized !== true)) throw fault('EVENT_JOURNAL_CORRUPT');
    let head = await readJson(this.#headPath(), 256);
    if (!head) {
      if (marker) throw fault('EVENT_JOURNAL_MISSING');
      if (await exists(this.#recordPath(1))) throw fault('EVENT_JOURNAL_CORRUPT');
      if (!initialize) return { sequence: 0, hash: ZERO };
      await writeAtomicJson(markerPath, { schemaVersion: '0.1.0', initialized: true });
      head = { sequence: 0, hash: ZERO };
      await writeAtomicJson(this.#headPath(), head);
    } else if (!marker) throw fault('EVENT_JOURNAL_CORRUPT');
    if (!Number.isSafeInteger(head.sequence) || head.sequence < 0 || head.sequence > this.maxRecords || !DIGEST.test(head.hash) ||
        (head.sequence === 0 && head.hash !== ZERO)) throw fault('EVENT_JOURNAL_CORRUPT');
    return head;
  }

  async #verifyRecord(sequence, expectedHash) {
    const record = await readJson(this.#recordPath(sequence), this.maxEventBytes + 512);
    if (!record || record.sequence !== sequence || !DIGEST.test(record.previousHash) || !DIGEST.test(record.hash) ||
        !record.event || typeof record.event !== 'object' || Array.isArray(record.event) || typeof record.event.type !== 'string' || !record.event.type.trim()) throw fault('EVENT_JOURNAL_CORRUPT');
    const payload = JSON.stringify(record.event);
    if (Buffer.byteLength(payload) > this.maxEventBytes || digest(record.previousHash, sequence, payload) !== record.hash ||
        (expectedHash && record.hash !== expectedHash)) throw fault('EVENT_JOURNAL_CORRUPT');
    return record;
  }
}

async function readJson(filePath, maxBytes) {
  let handle;
  try { handle = await open(filePath, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw fault('EVENT_JOURNAL_CORRUPT');
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw fault('EVENT_JOURNAL_CORRUPT');
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fault('EVENT_JOURNAL_CORRUPT');
      return parsed;
    }
    catch { throw fault('EVENT_JOURNAL_CORRUPT'); }
  } finally { await handle.close(); }
}

async function exists(filePath) {
  let handle;
  try { handle = await open(filePath, 'r'); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  finally { await handle?.close(); }
}

function digest(previousHash, sequence, payload) {
  return createHash('sha256').update(`${previousHash}\n${sequence}\n${payload}`).digest('hex');
}
function fault(code) { return Object.assign(new Error(code), { code }); }
