import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TlsWorkerBridge, TlsWorkerClient, UnixWorkerServer, RemoteWorkerAuthenticator, FileRemoteNonceStore,
  FileEventJournal, DurableIdempotencyStore } from '../src/index.js';

const run = promisify(execFile);
const key = Buffer.alloc(32, 19);

async function certificates(directory) {
  const openssl = async (...args) => run('openssl', args, { cwd: directory });
  await openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=SUPER Test CA',
    '-keyout', 'ca.key', '-out', 'ca.crt');
  for (const name of ['server', 'client', 'other']) {
    await openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name === 'server' ? 'localhost' : name}`,
      '-keyout', `${name}.key`, '-out', `${name}.csr`);
    await writeFile(path.join(directory, `${name}.ext`), name === 'server'
      ? 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n'
      : 'extendedKeyUsage=clientAuth\n');
    await openssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', `${name}.crt`, '-days', '1', '-sha256', '-extfile', `${name}.ext`);
  }
  const read = (name) => readFile(path.join(directory, name));
  const [ca, serverKey, serverCert, clientKey, clientCert, otherKey, otherCert] = await Promise.all([
    read('ca.crt'), read('server.key'), read('server.crt'), read('client.key'), read('client.crt'), read('other.key'), read('other.crt')]);
  return { ca, serverKey, serverCert, clientKey, clientCert, otherKey, otherCert,
    serverFingerprint256: new X509Certificate(serverCert).fingerprint256,
    clientFingerprint256: new X509Certificate(clientCert).fingerprint256 };
}

test('mutual TLS bridge authenticates certificates and forwards a governed worker request', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-tls-worker-'));
  let worker, bridge;
  try {
    const certs = await certificates(directory);
    const socketPath = path.join(directory, 'worker.sock');
    let calls = 0;
    worker = new UnixWorkerServer({ socketPath, nodeId: 'node-1', authenticator: new RemoteWorkerAuthenticator({ key }),
      nonceStore: new FileRemoteNonceStore({ filePath: path.join(directory, 'nonces.json') }),
      idempotencyStore: await new DurableIdempotencyStore({ filePath: path.join(directory, 'idempotency.jsonl') }).init(),
      auditJournal: new FileEventJournal(path.join(directory, 'audit')),
      authorize: () => ({ allowed: true }), handlers: { double: (input) => { calls++; return input.value * 2; } } });
    await worker.start();
    bridge = new TlsWorkerBridge({ host: '127.0.0.1', port: 0, socketPath, key: certs.serverKey,
      cert: certs.serverCert, ca: certs.ca, clientFingerprints: [certs.clientFingerprint256] });
    await bridge.start();
    const common = { host: '127.0.0.1', port: bridge.address().port, servername: 'localhost',
      serverFingerprint256: certs.serverFingerprint256, ca: certs.ca, nodeId: 'node-1',
      authenticator: new RemoteWorkerAuthenticator({ key }) };
    const client = new TlsWorkerClient({ ...common, key: certs.clientKey, cert: certs.clientCert });
    assert.equal(await client.execute({ requestId: 'tls-1', capabilityId: 'double', input: { value: 21 } }), 42);
    assert.equal(calls, 1);
    const badPin = new TlsWorkerClient({ ...common, key: certs.clientKey, cert: certs.clientCert,
      serverFingerprint256: certs.clientFingerprint256 });
    await assert.rejects(badPin.execute({ capabilityId: 'double', input: { value: 1 } }), /fingerprint mismatch/);
    const unlisted = new TlsWorkerClient({ ...common, key: certs.otherKey, cert: certs.otherCert });
    await assert.rejects(unlisted.execute({ capabilityId: 'double', input: { value: 1 } }));
    assert.equal(calls, 1);
  } finally {
    await bridge?.stop();
    await worker?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
