const SCHEMA_VERSION = '0.1.0';

export class FileMissionStore {
  constructor({ directory, fs = null, path = null, clock = () => new Date() } = {}) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('FileMissionStore requires directory');
    this.directory = directory; this.fs = fs; this.path = path; this.clock = clock;
  }
  async init() {
    if (!this.fs || !this.path) ({ default: this.fs } = await import('node:fs/promises'));
    if (!this.path) ({ default: this.path } = await import('node:path'));
    await this.fs.mkdir(this.directory, { recursive: true });
    return this;
  }
  async save(record, expectedVersion = null) {
    await this.init();
    const id = validateId(record?.missionId);
    const file = this.path.join(this.directory, id + '.json');
    let current = null;
    try { current = JSON.parse(await this.fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (expectedVersion !== null && (current?.version ?? 0) !== expectedVersion) throw conflict(current?.version ?? 0);
    const version = (current?.version ?? 0) + 1;
    const next = structuredClone({ ...record, schemaVersion: record.schemaVersion ?? SCHEMA_VERSION, version, updatedAt: this.clock().toISOString() });
    const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
    await this.fs.writeFile(tmp, JSON.stringify(next), 'utf8');
    const handle = await this.fs.open(tmp, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
    await this.fs.rename(tmp, file);
    return structuredClone(next);
  }
  async get(missionId) {
    await this.init();
    try { return JSON.parse(await this.fs.readFile(this.path.join(this.directory, validateId(missionId) + '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async list() {
    await this.init();
    const names = await this.fs.readdir(this.directory);
    const records = [];
    for (const name of names.filter(n => n.endsWith('.json'))) {
      try { records.push(JSON.parse(await this.fs.readFile(this.path.join(this.directory, name), 'utf8'))); } catch {}
    }
    return records.sort((a,b) => String(a.missionId).localeCompare(String(b.missionId)));
  }
}
function validateId(id) { if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(id)) throw new TypeError('Invalid missionId'); return id; }
function conflict(version) { return Object.assign(new Error('Mission state version conflict'), { code: 'MISSION_STATE_CONFLICT', retryable: true, version }); }
export { SCHEMA_VERSION as MISSION_STORE_SCHEMA_VERSION };
