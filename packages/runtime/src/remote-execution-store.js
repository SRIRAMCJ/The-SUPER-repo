import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = '0.1.0';
export const REMOTE_EXECUTION_STORE_SCHEMA_VERSION = SCHEMA_VERSION;

export class InMemoryRemoteExecutionStore {
  #snapshot = null;
  load() { return this.#snapshot ? structuredClone(this.#snapshot) : null; }
  save(snapshot) { this.#snapshot = structuredClone(snapshot); return structuredClone(this.#snapshot); }
}

export class FileRemoteExecutionStore {
  #filePath;
  constructor({ filePath } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('filePath is required');
    this.#filePath = path.resolve(filePath);
  }
  load() {
    try {
      return JSON.parse(fs.readFileSync(this.#filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
  save(snapshot) {
    const directory = path.dirname(this.#filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temp = `${this.#filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, this.#filePath);
    return structuredClone(snapshot);
  }
}
