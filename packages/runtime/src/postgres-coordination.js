import { randomUUID, createHash } from 'node:crypto';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
function fault(code) { return Object.assign(new Error(code), { code }); }

// Pool is injected; deployment supplies a supported PostgreSQL client and TLS.
// Each transaction holds one connection until COMMIT or ROLLBACK.
export class PostgresCoordinationStore {
  constructor(pool, { maxNonces = 10000 } = {}) {
    if (typeof pool?.connect !== 'function' || !Number.isSafeInteger(maxNonces) || maxNonces < 1 || maxNonces > 1000000) throw new TypeError('Invalid PostgreSQL coordinator');
    this.pool = pool;
    this.maxNonces = maxNonces;
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS super_leases (
      name text PRIMARY KEY, owner text NOT NULL, token text, epoch bigint NOT NULL,
      expires_at timestamptz NOT NULL, identity text NOT NULL);
      CREATE TABLE IF NOT EXISTS super_effects (
      name text PRIMARY KEY, value jsonb NOT NULL, epoch bigint NOT NULL);
      CREATE TABLE IF NOT EXISTS super_nonces (
      digest text PRIMARY KEY, expires_at bigint NOT NULL);`);
    return this;
  }
  async consume(nonce, expiresAt) {
    if (!ID.test(nonce) || !Number.isSafeInteger(expiresAt)) throw new TypeError('Invalid nonce or expiry');
    const digest = createHash('sha256').update(nonce).digest('hex');
    return this.transaction(async (client) => {
      // Serializes the bounded capacity decision across independent hosts.
      await client.query("SELECT pg_advisory_xact_lock(845301, 1)");
      const { rows: [time] } = await client.query('SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now');
      const now = Number(time.now);
      if (expiresAt < now) throw fault('REMOTE_AUTH_EXPIRED');
      await client.query('DELETE FROM super_nonces WHERE expires_at < $1', [now]);
      // Both reads share one snapshot after expiry pruning, under the same lock.
      const { rows: [admission] } = await client.query(`WITH existing AS MATERIALIZED (
        SELECT EXISTS (SELECT 1 FROM super_nonces WHERE digest=$1) AS replay
      ) SELECT replay, CASE WHEN replay THEN NULL
        ELSE (SELECT count(*)::integer FROM super_nonces) END AS count
        FROM existing`, [digest]);
      if (admission.replay) throw fault('REMOTE_AUTH_REPLAY');
      if (admission.count >= this.maxNonces) throw fault('REMOTE_AUTH_CAPACITY');
      await client.query('INSERT INTO super_nonces (digest, expires_at) VALUES ($1, $2)', [digest, expiresAt]);
    });
  }
  async transaction(operation) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async claim(name, owner, leaseMs = 30000, identity) {
    if (!ID.test(name) || !ID.test(owner) || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || !HASH.test(identity)) throw new TypeError('Invalid lease claim');
    return this.transaction(async (client) => {
      await client.query(`INSERT INTO super_leases (name, owner, epoch, expires_at, identity)
        VALUES ($1, $2, 0, '-infinity', $3) ON CONFLICT (name) DO NOTHING`, [name, owner, identity]);
      const { rows: [current] } = await client.query('SELECT identity, epoch, expires_at > clock_timestamp() AS active FROM super_leases WHERE name=$1 FOR UPDATE', [name]);
      if (current.identity !== identity) throw fault('COORDINATOR_IDENTITY_CONFLICT');
      if (current.active) throw fault('COORDINATOR_LEASE_HELD');
      const token = randomUUID();
      const { rows: [next] } = await client.query(`UPDATE super_leases SET owner=$2, token=$3, epoch=epoch+1,
        expires_at=clock_timestamp()+($4::bigint * interval '1 millisecond')
        WHERE name=$1 AND epoch < 9007199254740991 RETURNING epoch, expires_at`, [name, owner, token, leaseMs]);
      if (!next) throw fault('COORDINATOR_EPOCH_EXHAUSTED');
      return { name, owner, token, epoch: Number(next.epoch), expiresAt: new Date(next.expires_at).getTime() };
    });
  }
  async writeFencedEffect(name, lease, value) {
    if (!ID.test(name) || typeof lease?.token !== 'string' || !Number.isSafeInteger(lease?.epoch)) throw new TypeError('Invalid effect fence');
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized) > 65536) throw new TypeError('Invalid effect value');
    return this.transaction(async (client) => {
      const { rows: [current] } = await client.query('SELECT token, epoch, expires_at > clock_timestamp() AS active FROM super_leases WHERE name=$1 FOR UPDATE', [name]);
      if (!current || current.token !== lease.token || Number(current.epoch) !== lease.epoch || !current.active) throw fault('COORDINATOR_FENCE_REJECTED');
      await client.query(`INSERT INTO super_effects (name, value, epoch) VALUES ($1, $2::jsonb, $3)
        ON CONFLICT (name) DO UPDATE SET value=excluded.value, epoch=excluded.epoch`, [name, serialized, lease.epoch]);
      return { name, epoch: lease.epoch };
    });
  }
  async readEffect(name) {
    if (!ID.test(name)) throw new TypeError('Invalid effect name');
    const { rows: [record] } = await this.pool.query('SELECT value, epoch FROM super_effects WHERE name=$1', [name]);
    return record ? { value: record.value, epoch: Number(record.epoch) } : null;
  }
}
