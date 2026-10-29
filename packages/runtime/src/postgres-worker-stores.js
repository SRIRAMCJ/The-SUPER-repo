import { randomUUID, createHash } from 'node:crypto';

function fault(code) { return Object.assign(new Error(code), { code }); }
const ZERO = '0'.repeat(64);
export class PostgresWorkerIdempotencyStore {
  constructor(pool, { ttlMs = 300000 } = {}) {
    if (typeof pool?.connect !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1000) throw new TypeError('Invalid PostgreSQL idempotency store');
    this.pool = pool; this.ttlMs = ttlMs;
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS super_worker_requests (
      key text PRIMARY KEY, fingerprint text NOT NULL, claim_token text NOT NULL,
      status text NOT NULL, response jsonb, expires_at timestamptz NOT NULL);`);
    return this;
  }
  async claim(key, fingerprint) {
    if (typeof key !== 'string' || !key || key.length > 4096 || typeof fingerprint !== 'string' || !fingerprint) throw new TypeError('Invalid request identity');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const token = randomUUID();
      const inserted = await client.query(`INSERT INTO super_worker_requests VALUES ($1,$2,$3,'pending',NULL,clock_timestamp()+($4::bigint * interval '1 millisecond')) ON CONFLICT DO NOTHING RETURNING claim_token, expires_at`, [key, fingerprint, token, this.ttlMs]);
      let state, record;
      if (inserted.rowCount) { state = 'claimed'; record = { claimToken: token, fingerprint, status: 'pending' }; }
      else {
        const { rows: [current] } = await client.query(`SELECT fingerprint, claim_token, status, response, expires_at <= clock_timestamp() AS expired FROM super_worker_requests WHERE key=$1 FOR UPDATE`, [key]);
        if (!current) throw fault('REMOTE_CLAIM_INVALID');
        state = current.fingerprint !== fingerprint ? 'conflict' : current.status === 'completed' ? 'replay' : current.expired ? 'recovery_required' : 'in_progress';
        record = { claimToken: current.claim_token, fingerprint: current.fingerprint, status: current.status, response: current.response };
      }
      await client.query('COMMIT');
      return { state, record };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async completeClaim(key, fingerprint, claimToken, response) {
    if (typeof key !== 'string' || typeof fingerprint !== 'string' || typeof claimToken !== 'string') throw new TypeError('Invalid claim completion');
    const { rowCount } = await this.pool.query(`UPDATE super_worker_requests SET status='completed', response=$4::jsonb,
      expires_at=clock_timestamp()+($5::bigint * interval '1 millisecond')
      WHERE key=$1 AND fingerprint=$2 AND claim_token=$3 AND status='pending' AND expires_at > clock_timestamp()`, [key, fingerprint, claimToken, JSON.stringify(response), this.ttlMs]);
    return rowCount === 1;
  }
}

export class PostgresWorkerAuditJournal {
  constructor(pool) { if (typeof pool?.connect !== 'function') throw new TypeError('Invalid PostgreSQL audit journal'); this.pool = pool; }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS super_worker_audit_head (id integer PRIMARY KEY, sequence bigint NOT NULL, hash text NOT NULL);
      CREATE TABLE IF NOT EXISTS super_worker_audit (sequence bigint PRIMARY KEY, previous_hash text NOT NULL, hash text NOT NULL, event jsonb NOT NULL);
      INSERT INTO super_worker_audit_head VALUES (1, 0, '${ZERO}') ON CONFLICT DO NOTHING;`);
    return this;
  }
  async append(event) {
    if (!event || typeof event.type !== 'string') throw new TypeError('Invalid audit event');
    const payload = JSON.stringify(event);
    if (!payload || Buffer.byteLength(payload) > 65536) throw new TypeError('Audit event too large');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [head] } = await client.query('SELECT sequence, hash FROM super_worker_audit_head WHERE id=1 FOR UPDATE');
      const sequence = Number(head.sequence) + 1;
      if (!Number.isSafeInteger(sequence)) throw fault('AUDIT_CAPACITY');
      const hash = createHash('sha256').update(`${head.hash}\n${sequence}\n${payload}`).digest('hex');
      await client.query('INSERT INTO super_worker_audit VALUES ($1,$2,$3,$4::jsonb)', [sequence, head.hash, hash, payload]);
      await client.query('UPDATE super_worker_audit_head SET sequence=$1, hash=$2 WHERE id=1', [sequence, hash]);
      await client.query('COMMIT');
      return { sequence, hash };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
}
