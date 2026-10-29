import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
function fault(code) { return Object.assign(new Error(code), { code }); }

// Opt-in single-host transactional coordinator. The lease row and effect row
// change in one SQLite transaction; no file lock helper is spawned per call.
export class SqliteCoordinationStore {
  constructor(filePath, { timeoutMs = 5000 } = {}) {
    if (typeof filePath !== 'string' || !filePath || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid SQLite coordinator configuration');
    this.db = new DatabaseSync(filePath, { timeout: timeoutMs });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, token TEXT, epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL, identity TEXT); CREATE TABLE IF NOT EXISTS effects (name TEXT PRIMARY KEY, value TEXT NOT NULL, epoch INTEGER NOT NULL);');
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  claim(name, owner, leaseMs = 30000, identity) {
    if (!ID.test(name) || !ID.test(owner) || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || !/^[a-f0-9]{64}$/.test(identity)) throw new TypeError('Invalid lease claim');
    return this.transaction(() => {
      const current = this.db.prepare('SELECT * FROM leases WHERE name=?').get(name);
      if (current && current.identity !== identity) throw fault('COORDINATOR_IDENTITY_CONFLICT');
      const now = Date.now();
      if (current?.expires_at > now) throw fault('COORDINATOR_LEASE_HELD');
      const epoch = (current?.epoch ?? 0) + 1;
      if (!Number.isSafeInteger(epoch)) throw fault('COORDINATOR_EPOCH_EXHAUSTED');
      const token = randomUUID();
      this.db.prepare('INSERT INTO leases VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, token=excluded.token, epoch=excluded.epoch, expires_at=excluded.expires_at, identity=excluded.identity').run(name, owner, token, epoch, now + leaseMs, identity);
      return { name, owner, token, epoch, expiresAt: now + leaseMs };
    });
  }
  writeFencedEffect(name, lease, value) {
    if (!ID.test(name) || typeof lease?.token !== 'string' || !Number.isSafeInteger(lease?.epoch)) throw new TypeError('Invalid effect fence');
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized) > 65536) throw new TypeError('Invalid effect value');
    return this.transaction(() => {
      const current = this.db.prepare('SELECT token, epoch, expires_at FROM leases WHERE name=?').get(name);
      if (!current || current.token !== lease.token || current.epoch !== lease.epoch || current.expires_at <= Date.now()) throw fault('COORDINATOR_FENCE_REJECTED');
      this.db.prepare('INSERT INTO effects VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value, epoch=excluded.epoch').run(name, serialized, lease.epoch);
      return { name, epoch: lease.epoch };
    });
  }
  readEffect(name) {
    if (!ID.test(name)) throw new TypeError('Invalid effect name');
    const record = this.db.prepare('SELECT value, epoch FROM effects WHERE name=?').get(name);
    return record ? { value: JSON.parse(record.value), epoch: record.epoch } : null;
  }
}
