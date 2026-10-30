import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { X509Certificate, randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { RemoteWorkerAuthenticator, FileRemoteNonceStore, DurableIdempotencyStore, FileEventJournal,
  UnixWorkerServer, UnixWorkerClient, TlsWorkerBridge, TlsWorkerClient } from '../packages/runtime/src/index.js';
import { PostgresCoordinationStore, PostgresWorkerIdempotencyStore, PostgresWorkerAuditJournal } from '../packages/runtime/src/index.js';

const samples = Number(process.argv[2] ?? 30);
if (!Number.isSafeInteger(samples) || samples < 20 || samples > 200) throw new TypeError('samples must be 20–200');
const concurrency = Number(process.argv[3] ?? 4);
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new TypeError('concurrency must be 1–16');
const directory = await mkdtemp(path.join(os.tmpdir(), 'super-phase4-benchmark-'));
const openssl = promisify(execFile);
let worker, bridge, postgresPool;
const storeTimings = Object.create(null);
function measureStore(store, method, label) {
  const original = store[method].bind(store);
  store[method] = async (...args) => {
    const start = performance.now();
    try { return await original(...args); }
    finally {
      const item = storeTimings[label] ??= { count: 0, totalMs: 0 };
      item.count++;
      item.totalMs += performance.now() - start;
    }
  };
  return store;
}
function splitAuditAppend(pool, maxRecords) {
  return async (event) => {
    const payload = JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a], [b]) => a.localeCompare(b))));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [head] } = await client.query('SELECT sequence, hash FROM super_worker_audit_head WHERE id=1 FOR UPDATE');
      const { rows: [base] } = await client.query('SELECT sequence FROM super_worker_audit_base WHERE id=1');
      if (Number(head.sequence) - Number(base.sequence) >= maxRecords) throw Object.assign(new Error('AUDIT_CAPACITY'), { code: 'AUDIT_CAPACITY' });
      const sequence = Number(head.sequence) + 1;
      if (!Number.isSafeInteger(sequence)) throw Object.assign(new Error('AUDIT_CAPACITY'), { code: 'AUDIT_CAPACITY' });
      const hash = createHash('sha256').update(`${head.hash}\n${sequence}\n${payload}`).digest('hex');
      await client.query('INSERT INTO super_worker_audit VALUES ($1,$2,$3,$4::jsonb)', [sequence, head.hash, hash, payload]);
      await client.query('UPDATE super_worker_audit_head SET sequence=$1, hash=$2 WHERE id=1', [sequence, hash]);
      await client.query('COMMIT');
      return { sequence, hash };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  };
}
async function run(...args) { await openssl('openssl', args, { cwd: directory }); }
async function certificates() {
  await run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Benchmark CA', '-keyout', 'ca.key', '-out', 'ca.crt');
  for (const name of ['server', 'client']) {
    await run('req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name === 'server' ? 'localhost' : 'benchmark-client'}`,
      '-keyout', `${name}.key`, '-out', `${name}.csr`);
    await writeFile(path.join(directory, `${name}.ext`), name === 'server'
      ? 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n' : 'extendedKeyUsage=clientAuth\n');
    await run('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', `${name}.crt`, '-days', '1', '-sha256', '-extfile', `${name}.ext`);
  }
  const read = (name) => readFile(path.join(directory, name));
  const [ca, serverKey, serverCert, clientKey, clientCert] = await Promise.all([
    read('ca.crt'), read('server.key'), read('server.crt'), read('client.key'), read('client.crt')]);
  return { ca, serverKey, serverCert, clientKey, clientCert,
    serverFingerprint256: new X509Certificate(serverCert).fingerprint256,
    clientFingerprint256: new X509Certificate(clientCert).fingerprint256 };
}
async function measure(count, work) {
  const durations = [];
  const start = performance.now();
  for (let index = 0; index < count; index++) {
    const before = performance.now();
    await work(index);
    durations.push(performance.now() - before);
  }
  const elapsed = performance.now() - start;
  durations.sort((a, b) => a - b);
  return { medianMs: +durations[Math.floor(count / 2)].toFixed(2),
    p95Ms: +durations[Math.ceil(count * .95) - 1].toFixed(2),
    operationsPerSecond: +(count * 1000 / elapsed).toFixed(1) };
}
async function measureConcurrent(count, concurrency, work) {
  const durations = [];
  let next = 0;
  const start = performance.now();
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count) {
      const index = next++;
      const before = performance.now();
      await work(index);
      durations.push(performance.now() - before);
    }
  }));
  const elapsed = performance.now() - start;
  durations.sort((a, b) => a - b);
  return { concurrency, medianMs: +durations[Math.floor(count / 2)].toFixed(2),
    p95Ms: +durations[Math.ceil(count * .95) - 1].toFixed(2),
    operationsPerSecond: +(count * 1000 / elapsed).toFixed(1) };
}

try {
  const certs = await certificates();
  const key = Buffer.alloc(32, 23);
  const socketPath = path.join(directory, 'worker.sock');
  const postgresUrl = process.env.SUPER_TEST_POSTGRES_URL;
  if (postgresUrl) { const { Pool } = await import('pg'); postgresPool = new Pool({ connectionString: postgresUrl, max: 8 }); }
  const nonceStore = measureStore(postgresPool ? await new PostgresCoordinationStore(postgresPool).init() :
    new FileRemoteNonceStore({ filePath: path.join(directory, 'nonces.json'), maxNonces: samples * 3 + 10 }), 'consume', 'nonceConsume');
  const idempotencyStore = postgresPool ? await new PostgresWorkerIdempotencyStore(postgresPool).init() :
    await new DurableIdempotencyStore({ filePath: path.join(directory, 'idempotency.jsonl'), maxRecords: samples * 3 + 10 }).init();
  measureStore(idempotencyStore, 'claim', 'idempotencyClaim');
  measureStore(idempotencyStore, 'completeClaim', 'idempotencyComplete');
  const auditMode = process.env.SUPER_BENCHMARK_AUDIT_MODE ?? 'combined';
  if (!['combined', 'split'].includes(auditMode) || (auditMode === 'split' && !postgresPool)) throw new TypeError('Invalid audit benchmark mode');
  const auditStore = postgresPool ? await new PostgresWorkerAuditJournal(postgresPool).init() :
    new FileEventJournal(path.join(directory, 'audit'), { maxRecords: samples * 6 + 10 });
  if (auditMode === 'split') auditStore.append = splitAuditAppend(postgresPool, auditStore.maxRecords);
  const auditJournal = measureStore(auditStore, 'append', 'auditAppend');
  worker = new UnixWorkerServer({ socketPath, nodeId: 'node-1', authenticator: new RemoteWorkerAuthenticator({ key }),
    nonceStore, idempotencyStore, auditJournal,
    authorize: () => ({ allowed: true }), handlers: { echo: (input) => input } });
  await worker.start();
  bridge = new TlsWorkerBridge({ host: '127.0.0.1', port: 0, socketPath, key: certs.serverKey,
    cert: certs.serverCert, ca: certs.ca, clientFingerprints: [certs.clientFingerprint256] });
  await bridge.start();
  const authenticator = new RemoteWorkerAuthenticator({ key });
  const runId = randomUUID();
  const direct = new UnixWorkerClient({ socketPath, nodeId: 'node-1', authenticator });
  const tls = new TlsWorkerClient({ host: '127.0.0.1', port: bridge.address().port, servername: 'localhost',
    serverFingerprint256: certs.serverFingerprint256, key: certs.clientKey, cert: certs.clientCert,
    ca: certs.ca, nodeId: 'node-1', authenticator });
  await direct.execute({ requestId: `${runId}-warmup-unix`, capabilityId: 'echo', input: { value: 1 } });
  await tls.execute({ requestId: `${runId}-warmup-tls`, capabilityId: 'echo', input: { value: 1 } });
  const unix = await measure(samples, (index) => direct.execute({ requestId: `${runId}-unix-${index}`, capabilityId: 'echo', input: { value: index } }));
  const mutualTls = await measure(samples, (index) => tls.execute({ requestId: `${runId}-tls-${index}`, capabilityId: 'echo', input: { value: index } }));
  const mutualTlsConcurrent = await measureConcurrent(samples, concurrency, (index) => tls.execute({ requestId: `${runId}-tls-concurrent-${index}`, capabilityId: 'echo', input: { value: index } }));
  process.stdout.write(`${JSON.stringify({ platform: process.platform, node: process.version, storage: postgresPool ? 'postgresql' : 'local-files', auditMode, samples,
    unix, mutualTls, mutualTlsConcurrent,
    storeAverageMs: Object.fromEntries(Object.entries(storeTimings).map(([name, item]) => [name, +(item.totalMs / item.count).toFixed(2)])),
    note: 'Local loopback control requests with durable nonce, audit, and idempotency writes; store averages include lock contention; not network capacity.' }, null, 2)}\n`);
} finally {
  await bridge?.stop();
  await worker?.stop();
  await postgresPool?.end();
  await rm(directory, { recursive: true, force: true });
}
