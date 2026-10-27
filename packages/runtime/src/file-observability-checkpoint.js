import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomicJson } from './atomic-json.js';
import { withKernelFileLock } from './kernel-file-lock.js';

export class FileObservabilityCheckpoint {
  constructor(filePath, { maxBytes = 16 * 1024 * 1024, lockTimeoutMs = 5000 } = {}) {
    if (process.platform !== 'linux') throw new Error('FileObservabilityCheckpoint requires Linux flock');
    if (typeof filePath !== 'string' || !filePath || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 * 1024 ||
        !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) throw new TypeError('Invalid checkpoint configuration');
    Object.assign(this, { filePath: path.resolve(filePath), maxBytes, lockTimeoutMs });
  }

  async save(engine) {
    if (!engine || typeof engine.exportCheckpoint !== 'function') throw new TypeError('Verified observability engine required');
    const payload = engine.exportCheckpoint();
    const hash = digest(payload);
    const wrapper = { payload, hash };
    if (Buffer.byteLength(JSON.stringify(wrapper)) > this.maxBytes) throw fault('OBSERVABILITY_CHECKPOINT_CAPACITY');
    return this.#locked(async () => {
      const previous = await this.#load();
      if (previous && (previous.cursor.sequence > payload.cursor.sequence ||
          (previous.cursor.sequence === payload.cursor.sequence && previous.cursor.hash !== payload.cursor.hash))) throw fault('OBSERVABILITY_CHECKPOINT_STALE');
      if (!previous) await writeAtomicJson(`${this.filePath}.initialized`, { schemaVersion: '0.1.0', initialized: true });
      await writeAtomicJson(this.filePath, wrapper, { space: 0 });
      return { ...payload.cursor };
    });
  }

  async load() { return this.#locked(() => this.#load()); }

  async #locked(work) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    return withKernelFileLock(`${this.filePath}.lock`, this.lockTimeoutMs, work);
  }

  async #load() {
    const marker = await readJson(`${this.filePath}.initialized`, 128);
    if (marker && (marker.schemaVersion !== '0.1.0' || marker.initialized !== true)) throw fault('OBSERVABILITY_CHECKPOINT_CORRUPT');
    const wrapper = await readJson(this.filePath, this.maxBytes);
    if ((marker && !wrapper) || (!marker && wrapper)) throw fault('OBSERVABILITY_CHECKPOINT_MISSING');
    if (!wrapper) return null;
    if (!wrapper.payload || !/^[0-9a-f]{64}$/.test(wrapper.hash) || digest(wrapper.payload) !== wrapper.hash ||
        wrapper.payload.schemaVersion !== '0.1.0' || wrapper.payload.type !== 'observability-checkpoint' ||
        !Number.isSafeInteger(wrapper.payload.cursor?.sequence) || wrapper.payload.cursor.sequence < 0 ||
        !/^[0-9a-f]{64}$/.test(wrapper.payload.cursor.hash)) throw fault('OBSERVABILITY_CHECKPOINT_CORRUPT');
    return wrapper.payload;
  }
}

async function readJson(filePath, maxBytes) {
  let handle;
  try { handle = await open(filePath, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw fault('OBSERVABILITY_CHECKPOINT_CORRUPT');
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw fault('OBSERVABILITY_CHECKPOINT_CORRUPT');
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid JSON object');
      return parsed;
    } catch { throw fault('OBSERVABILITY_CHECKPOINT_CORRUPT'); }
  } finally { await handle.close(); }
}

function digest(payload) { return createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }
function fault(code) { return Object.assign(new Error(code), { code }); }
