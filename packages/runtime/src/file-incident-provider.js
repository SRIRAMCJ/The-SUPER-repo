import { open } from 'node:fs/promises';
import { readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeAtomicJson } from './atomic-json.js';
import { withKernelFileLock } from './kernel-file-lock.js';

// A deployment controller publishes a stable incident ID with atomic replacement.
// Absence or invalid state stops polling rather than inventing a new identity.
export class FileIncidentProvider {
  constructor(filePath, { maxBytes = 4096 } = {}) {
    if (typeof filePath !== 'string' || !filePath || !Number.isSafeInteger(maxBytes) || maxBytes < 64 || maxBytes > 1_000_000) throw new TypeError('filePath and bounded maxBytes are required');
    this.filePath = path.resolve(filePath);
    this.maxBytes = maxBytes;
  }

  async current({ signal } = {}) {
    const record = await readRecord(this.filePath, this.maxBytes, signal);
    return record.active ? record.incidentId : null;
  }

  provider() { return ({ signal } = {}) => this.current({ signal }); }
}

async function readRecord(filePath, maxBytes, signal) {
    const handle = await open(filePath, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw fault('INCIDENT_FILE_INVALID');
      const buffer = Buffer.allocUnsafe(maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        if (signal?.aborted) throw signal.reason ?? fault('INCIDENT_CANCELLED');
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > maxBytes) throw fault('INCIDENT_FILE_INVALID');
      let contents;
      try { contents = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)); }
      catch { throw fault('INCIDENT_FILE_INVALID'); }
      let record;
      try { record = JSON.parse(contents); } catch { throw fault('INCIDENT_FILE_INVALID'); }
      if (!record || Array.isArray(record) || record.schemaVersion !== '0.1.0' ||
          typeof record.incidentId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(record.incidentId) ||
          record.active !== true && record.active !== false) throw fault('INCIDENT_FILE_INVALID');
      return record;
    } finally { await handle.close(); }
}

function fault(code) { return Object.assign(new Error(code), { code }); }

// Explicit incident lifecycle for a single shared Linux filesystem. A health
// detector decides when to open or resolve; this class owns stable identity.
export class FileIncidentController {
  constructor(filePath, { lockTimeoutMs = 5000 } = {}) {
    if (process.platform !== 'linux') throw new Error('FileIncidentController requires Linux flock');
    if (typeof filePath !== 'string' || !filePath || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) throw new TypeError('filePath and positive lockTimeoutMs are required');
    this.filePath = path.resolve(filePath);
    this.lockTimeoutMs = lockTimeoutMs;
  }

  async open() {
    return this.#transaction(async (record) => {
      if (record?.active) return { record, result: record.incidentId };
      const next = { schemaVersion: '0.1.0', incidentId: randomUUID(), active: true };
      return { record: next, result: next.incidentId };
    });
  }

  async resolve(incidentId) {
    if (typeof incidentId !== 'string' || !incidentId) throw new TypeError('incidentId is required');
    return this.#transaction(async (record) => {
      if (!record || record.incidentId !== incidentId || !record.active) throw fault('INCIDENT_STALE');
      return { record: { ...record, active: false }, result: incidentId };
    });
  }

  async #transaction(update) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    return withKernelFileLock(`${this.filePath}.lock`, this.lockTimeoutMs, async () => {
      let marker = false;
      try { marker = (await readFile(`${this.filePath}.initialized`, 'utf8')) === 'initialized\n'; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      let record = null;
      try { record = await readRecord(this.filePath, 4096); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (marker) throw fault('INCIDENT_FILE_MISSING');
      }
      const { record: next, result } = await update(record);
      if (!marker) await writeMarker(`${this.filePath}.initialized`);
      if (next !== record) await writeAtomicJson(this.filePath, next);
      return result;
    });
  }
}

async function writeMarker(filePath) {
  const handle = await open(filePath, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST') throw fault('INCIDENT_FILE_INVALID');
    throw error;
  });
  try { await handle.writeFile('initialized\n'); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await open(path.dirname(filePath), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
