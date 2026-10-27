import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { withKernelFileLock } from './kernel-file-lock.js';
import { writeAtomicJson } from './atomic-json.js';

const ZERO = '0'.repeat(64);
const DIGEST = /^[0-9a-f]{64}$/;

// Named checkpoint shared by processes. The lock spans delivery and checkpoint
// commit; a crash between those steps can repeat the event on the next run.
export class FileEventConsumer {
  #verified = false;

  constructor({ journal, checkpointPath, listener, batchSize = 100, lockTimeoutMs = 5000 } = {}) {
    if (process.platform !== 'linux') throw new Error('FileEventConsumer requires Linux flock');
    if (!journal || typeof journal.replay !== 'function' || typeof journal.readFrom !== 'function' ||
        typeof checkpointPath !== 'string' || !checkpointPath || typeof listener !== 'function' ||
        !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000 ||
        !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) throw new TypeError('Invalid event consumer configuration');
    Object.assign(this, { journal, checkpointPath: path.resolve(checkpointPath), listener, batchSize, lockTimeoutMs });
  }

  async runOnce() {
    await mkdir(path.dirname(this.checkpointPath), { recursive: true });
    return withKernelFileLock(`${this.checkpointPath}.lock`, this.lockTimeoutMs, async () => {
      const marker = await readJson(`${this.checkpointPath}.initialized`);
      if (marker && (marker.schemaVersion !== '0.1.0' || marker.initialized !== true)) throw fault('EVENT_CHECKPOINT_CORRUPT');
      const checkpoint = await readJson(this.checkpointPath);
      if ((marker && !checkpoint) || (!marker && checkpoint)) throw fault('EVENT_CHECKPOINT_MISSING');
      const cursor = checkpoint ?? { sequence: 0, hash: ZERO };
      if (!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 || !DIGEST.test(cursor.hash) ||
          (cursor.sequence === 0 && cursor.hash !== ZERO)) throw fault('EVENT_CHECKPOINT_CORRUPT');
      if (!this.#verified) {
        await this.journal.replay({ afterSequence: cursor.sequence, limit: 1 });
        this.#verified = true;
      }
      const batch = await this.journal.readFrom({ afterSequence: cursor.sequence, afterHash: cursor.hash, limit: this.batchSize });
      if (!marker) {
        await writeAtomicJson(`${this.checkpointPath}.initialized`, { schemaVersion: '0.1.0', initialized: true });
        await writeAtomicJson(this.checkpointPath, cursor);
      }
      for (const item of batch.events) {
        await this.listener(structuredClone(item.event), { sequence: item.sequence, hash: item.hash });
        await writeAtomicJson(this.checkpointPath, { sequence: item.sequence, hash: item.hash });
      }
      return { delivered: batch.events.length, sequence: batch.events.at(-1)?.sequence ?? cursor.sequence, head: batch.head.sequence };
    });
  }
}

async function readJson(filePath) {
  let handle;
  try { handle = await open(filePath, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256) throw fault('EVENT_CHECKPOINT_CORRUPT');
    const buffer = Buffer.allocUnsafe(257);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 256) throw fault('EVENT_CHECKPOINT_CORRUPT');
    try {
      const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw fault('EVENT_CHECKPOINT_CORRUPT');
      return record;
    } catch { throw fault('EVENT_CHECKPOINT_CORRUPT'); }
  } finally { await handle.close(); }
}

function fault(code) { return Object.assign(new Error(code), { code }); }
