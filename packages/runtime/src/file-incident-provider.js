import { open } from 'node:fs/promises';
import path from 'node:path';

// A deployment controller publishes a stable incident ID with atomic replacement.
// Absence or invalid state stops polling rather than inventing a new identity.
export class FileIncidentProvider {
  constructor(filePath, { maxBytes = 4096 } = {}) {
    if (typeof filePath !== 'string' || !filePath || !Number.isSafeInteger(maxBytes) || maxBytes < 64 || maxBytes > 1_000_000) throw new TypeError('filePath and bounded maxBytes are required');
    this.filePath = path.resolve(filePath);
    this.maxBytes = maxBytes;
  }

  async current({ signal } = {}) {
    const handle = await open(this.filePath, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.maxBytes) throw fault('INCIDENT_FILE_INVALID');
      const buffer = Buffer.allocUnsafe(this.maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        if (signal?.aborted) throw signal.reason ?? fault('INCIDENT_CANCELLED');
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > this.maxBytes) throw fault('INCIDENT_FILE_INVALID');
      let contents;
      try { contents = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)); }
      catch { throw fault('INCIDENT_FILE_INVALID'); }
      let record;
      try { record = JSON.parse(contents); } catch { throw fault('INCIDENT_FILE_INVALID'); }
      if (!record || Array.isArray(record) || record.schemaVersion !== '0.1.0' ||
          typeof record.incidentId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(record.incidentId) ||
          record.active !== true && record.active !== false) throw fault('INCIDENT_FILE_INVALID');
      return record.active ? record.incidentId : null;
    } finally { await handle.close(); }
  }

  provider() { return ({ signal } = {}) => this.current({ signal }); }
}

function fault(code) { return Object.assign(new Error(code), { code }); }
