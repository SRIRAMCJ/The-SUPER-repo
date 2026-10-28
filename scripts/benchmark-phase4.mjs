import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { X509Certificate } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { RemoteWorkerAuthenticator, FileRemoteNonceStore, DurableIdempotencyStore, FileEventJournal,
  UnixWorkerServer, UnixWorkerClient, TlsWorkerBridge, TlsWorkerClient } from '../packages/runtime/src/index.js';

const samples = Number(process.argv[2] ?? 30);
if (!Number.isSafeInteger(samples) || samples < 20 || samples > 200) throw new TypeError('samples must be 20–200');
const directory = await mkdtemp(path.join(os.tmpdir(), 'super-phase4-benchmark-'));
const openssl = promisify(execFile);
let worker, bridge;
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

try {
  const certs = await certificates();
  const key = Buffer.alloc(32, 23);
  const socketPath = path.join(directory, 'worker.sock');
  worker = new UnixWorkerServer({ socketPath, nodeId: 'node-1', authenticator: new RemoteWorkerAuthenticator({ key }),
    nonceStore: new FileRemoteNonceStore({ filePath: path.join(directory, 'nonces.json'), maxNonces: samples * 3 + 10 }),
    idempotencyStore: await new DurableIdempotencyStore({ filePath: path.join(directory, 'idempotency.jsonl'), maxRecords: samples * 3 + 10 }).init(),
    auditJournal: new FileEventJournal(path.join(directory, 'audit'), { maxRecords: samples * 6 + 10 }),
    authorize: () => ({ allowed: true }), handlers: { echo: (input) => input } });
  await worker.start();
  bridge = new TlsWorkerBridge({ host: '127.0.0.1', port: 0, socketPath, key: certs.serverKey,
    cert: certs.serverCert, ca: certs.ca, clientFingerprints: [certs.clientFingerprint256] });
  await bridge.start();
  const authenticator = new RemoteWorkerAuthenticator({ key });
  const direct = new UnixWorkerClient({ socketPath, nodeId: 'node-1', authenticator });
  const tls = new TlsWorkerClient({ host: '127.0.0.1', port: bridge.address().port, servername: 'localhost',
    serverFingerprint256: certs.serverFingerprint256, key: certs.clientKey, cert: certs.clientCert,
    ca: certs.ca, nodeId: 'node-1', authenticator });
  await direct.execute({ requestId: 'warmup-unix', capabilityId: 'echo', input: { value: 1 } });
  await tls.execute({ requestId: 'warmup-tls', capabilityId: 'echo', input: { value: 1 } });
  const unix = await measure(samples, (index) => direct.execute({ requestId: `unix-${index}`, capabilityId: 'echo', input: { value: index } }));
  const mutualTls = await measure(samples, (index) => tls.execute({ requestId: `tls-${index}`, capabilityId: 'echo', input: { value: index } }));
  process.stdout.write(`${JSON.stringify({ platform: process.platform, node: process.version, samples,
    unix, mutualTls, note: 'Sequential local loopback control requests with durable nonce, audit, and idempotency writes; not network capacity.' }, null, 2)}\n`);
} finally {
  await bridge?.stop();
  await worker?.stop();
  await rm(directory, { recursive: true, force: true });
}
