import { randomUUID, createHash } from 'node:crypto';

function fault(code) { return Object.assign(new Error(code), { code }); }
const ZERO = '0'.repeat(64);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
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
  async reconcileClaim(key, fingerprint, claimToken, response, { reason } = {}) {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1024 ||
        typeof key !== 'string' || typeof fingerprint !== 'string' || typeof claimToken !== 'string') throw new TypeError('Invalid reconciliation');
    const payload = JSON.stringify(response);
    if (!payload || Buffer.byteLength(payload) > 65536) throw new TypeError('Invalid reconciliation response');
    const { rowCount } = await this.pool.query(`UPDATE super_worker_requests SET status='completed', response=$4::jsonb,
      expires_at=clock_timestamp()+($5::bigint * interval '1 millisecond')
      WHERE key=$1 AND fingerprint=$2 AND claim_token=$3 AND status='pending' AND expires_at <= clock_timestamp()`, [key, fingerprint, claimToken, payload, this.ttlMs]);
    return rowCount === 1;
  }
  async releaseClaim(key, fingerprint, claimToken, reason) {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1024 ||
        typeof key !== 'string' || typeof fingerprint !== 'string' || typeof claimToken !== 'string') throw new TypeError('Invalid release');
    const { rowCount } = await this.pool.query(`DELETE FROM super_worker_requests
      WHERE key=$1 AND fingerprint=$2 AND claim_token=$3 AND status='pending' AND expires_at <= clock_timestamp()`, [key, fingerprint, claimToken]);
    return rowCount === 1;
  }
}

export class PostgresWorkerAuditJournal {
  constructor(pool, { maxRecords = 10000 } = {}) {
    if (typeof pool?.connect !== 'function' || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1000000) throw new TypeError('Invalid PostgreSQL audit journal');
    this.pool = pool; this.maxRecords = maxRecords;
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS super_worker_audit_head (id integer PRIMARY KEY, sequence bigint NOT NULL, hash text NOT NULL);
      CREATE TABLE IF NOT EXISTS super_worker_audit (sequence bigint PRIMARY KEY, previous_hash text NOT NULL, hash text NOT NULL, event jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS super_worker_audit_base (id integer PRIMARY KEY, sequence bigint NOT NULL, hash text NOT NULL);
      INSERT INTO super_worker_audit_head VALUES (1, 0, '${ZERO}') ON CONFLICT DO NOTHING;
      INSERT INTO super_worker_audit_base VALUES (1, 0, '${ZERO}') ON CONFLICT DO NOTHING;`);
    return this;
  }
  async append(event) {
    if (!event || typeof event.type !== 'string') throw new TypeError('Invalid audit event');
    const payload = JSON.stringify(canonical(event));
    if (!payload || Buffer.byteLength(payload) > 65536) throw new TypeError('Audit event too large');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [head] } = await client.query('SELECT sequence, hash FROM super_worker_audit_head WHERE id=1 FOR UPDATE');
      const { rows: [base] } = await client.query('SELECT sequence FROM super_worker_audit_base WHERE id=1');
      if (Number(head.sequence) - Number(base.sequence) >= this.maxRecords) throw fault('AUDIT_CAPACITY');
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
  async replay({ afterSequence = 0, limit = 100 } = {}) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new TypeError('Invalid audit cursor');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { rows: [head] } = await client.query('SELECT sequence, hash FROM super_worker_audit_head WHERE id=1');
      const { rows: [base] } = await client.query('SELECT sequence, hash FROM super_worker_audit_base WHERE id=1');
      if (afterSequence < Number(base.sequence)) throw fault('AUDIT_GAP');
      const { rows } = await client.query('SELECT sequence, previous_hash, hash, event FROM super_worker_audit WHERE sequence > $1 ORDER BY sequence', [base.sequence]);
      let previous = base.hash, sequence = Number(base.sequence);
      const events = [];
      for (const row of rows) {
        sequence++;
        const payload = JSON.stringify(canonical(row.event));
        const hash = createHash('sha256').update(`${previous}\n${sequence}\n${payload}`).digest('hex');
        if (Number(row.sequence) !== sequence || row.previous_hash !== previous || row.hash !== hash) throw fault('AUDIT_CORRUPT');
        previous = hash;
        if (sequence > afterSequence && events.length < limit) events.push({ sequence, event: row.event });
      }
      if (sequence !== Number(head.sequence) || previous !== head.hash || afterSequence > sequence) throw fault('AUDIT_CORRUPT');
      await client.query('COMMIT');
      return { events, head: { sequence, hash: previous } };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async compactThrough(sequence, expectedHash) {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new TypeError('Invalid audit retention anchor');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [head] } = await client.query('SELECT sequence, hash FROM super_worker_audit_head WHERE id=1 FOR UPDATE');
      const { rows: [base] } = await client.query('SELECT sequence, hash FROM super_worker_audit_base WHERE id=1 FOR UPDATE');
      if (sequence < Number(base.sequence) || sequence > Number(head.sequence)) throw fault('AUDIT_CURSOR_INVALID');
      let previous = base.hash, cursor = Number(base.sequence);
      const { rows } = await client.query('SELECT sequence, previous_hash, hash, event FROM super_worker_audit WHERE sequence > $1 ORDER BY sequence', [base.sequence]);
      for (const row of rows) {
        cursor++;
        const payload = JSON.stringify(canonical(row.event));
        if (Number(row.sequence) !== cursor || row.previous_hash !== previous || row.hash !== createHash('sha256').update(`${previous}\n${cursor}\n${payload}`).digest('hex')) throw fault('AUDIT_CORRUPT');
        previous = row.hash;
        if (cursor === sequence && previous !== expectedHash) throw fault('AUDIT_CURSOR_INVALID');
      }
      if (cursor !== Number(head.sequence) || previous !== head.hash || (sequence === Number(base.sequence) && base.hash !== expectedHash)) throw fault('AUDIT_CORRUPT');
      await client.query('UPDATE super_worker_audit_base SET sequence=$1, hash=$2 WHERE id=1', [sequence, expectedHash]);
      await client.query('DELETE FROM super_worker_audit WHERE sequence <= $1', [sequence]);
      await client.query('COMMIT');
      return { sequence, hash: expectedHash };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
}
