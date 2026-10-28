import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteWorkerAuthenticator, FileRemoteNonceStore } from '../src/index.js';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const key = Buffer.alloc(32, 7);

test('worker envelope authenticates a bounded request and rejects tamper and replay', () => {
  const client = new RemoteWorkerAuthenticator({ key, clock: () => 100_000, nonceFactory: () => 'nonce-1' });
  const worker = new RemoteWorkerAuthenticator({ key, clock: () => 100_005 });
  const envelope = client.sign({ requestId: 'req-1', nodeId: 'worker-1', payload: { capabilityId: 'repo.scan', input: { path: 'src' } } });
  const verified = worker.verify(structuredClone(envelope));
  assert.equal(verified.payload.capabilityId, 'repo.scan');
  awaitError(() => worker.verify(envelope), 'REMOTE_AUTH_REPLAY');
  const altered = structuredClone(envelope);
  altered.body.payload.input.path = 'secrets';
  awaitError(() => new RemoteWorkerAuthenticator({ key, clock: () => 100_005 }).verify(altered), 'REMOTE_AUTH_INVALID');
  awaitError(() => new RemoteWorkerAuthenticator({ key: Buffer.alloc(32, 8), clock: () => 100_005 }).verify(envelope), 'REMOTE_AUTH_INVALID');
});

test('worker envelope enforces freshness, active nonce capacity, and byte bounds', () => {
  let now = 100_000, nonce = 0;
  const client = new RemoteWorkerAuthenticator({ key, clock: () => now, nonceFactory: () => `nonce-${++nonce}`, maxSkewMs: 1000 });
  const worker = new RemoteWorkerAuthenticator({ key, clock: () => now, maxSkewMs: 1000, maxNonces: 1 });
  worker.verify(client.sign({ requestId: 'req-1', nodeId: 'worker-1', payload: {} }));
  awaitError(() => worker.verify(client.sign({ requestId: 'req-2', nodeId: 'worker-1', payload: {} })), 'REMOTE_AUTH_CAPACITY');
  now += 1001;
  worker.verify(client.sign({ requestId: 'req-3', nodeId: 'worker-1', payload: {} }));
  const stale = client.sign({ requestId: 'req-4', nodeId: 'worker-1', payload: {} });
  now += 1001;
  awaitError(() => worker.verify(stale), 'REMOTE_AUTH_EXPIRED');
  const small = new RemoteWorkerAuthenticator({ key, maxBytes: 512 });
  assert.throws(() => small.sign({ requestId: 'req-5', nodeId: 'worker-1', payload: { data: 'x'.repeat(600) } }), /byte limit/);
});

function awaitError(work, code) { assert.throws(work, { code }); }

test('future-dated nonce remains reserved until its actual freshness deadline', () => {
  let now = 100_000;
  const signer = new RemoteWorkerAuthenticator({ key, clock: () => 101_000, nonceFactory: () => 'future', maxSkewMs: 1000 });
  const verifier = new RemoteWorkerAuthenticator({ key, clock: () => now, maxSkewMs: 1000, maxNonces: 1 });
  const envelope = signer.sign({ requestId: 'future', nodeId: 'worker', payload: {} });
  verifier.verify(envelope);
  now = 101_001;
  awaitError(() => verifier.verify(envelope), 'REMOTE_AUTH_REPLAY');
});

test('shared durable nonce store rejects replay across verifier instances and restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-nonce-'));
  const filePath = path.join(directory, 'nonces.json');
  try {
    let now = 100_000, sequence = 0;
    const signer = new RemoteWorkerAuthenticator({ key, clock: () => now, nonceFactory: () => `nonce-${++sequence}`, maxSkewMs: 1000 });
    const envelope = signer.sign({ requestId: 'req', nodeId: 'worker', payload: {} });
    const store = () => new FileRemoteNonceStore({ filePath, clock: () => now, maxNonces: 1 });
    const verifier = () => new RemoteWorkerAuthenticator({ key, clock: () => now, maxSkewMs: 1000 });
    assert.equal((await verifier().verifyWithStore(envelope, store())).requestId, 'req');
    await assert.rejects(verifier().verifyWithStore(envelope, store()), { code: 'REMOTE_AUTH_REPLAY' });
    await assert.rejects(verifier().verifyWithStore(signer.sign({ requestId: 'req2', nodeId: 'worker', payload: {} }), store()), { code: 'REMOTE_AUTH_CAPACITY' });
    now += 1001;
    await verifier().verifyWithStore(signer.sign({ requestId: 'req3', nodeId: 'worker', payload: {} }), store());
    await unlink(filePath);
    await assert.rejects(verifier().verifyWithStore(signer.sign({ requestId: 'req4', nodeId: 'worker', payload: {} }), store()), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('simultaneous workers admit one copy of an envelope', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-nonce-race-'));
  try {
    const filePath = path.join(directory, 'nonces.json');
    const envelope = new RemoteWorkerAuthenticator({ key, clock: () => 100_000 }).sign({ requestId: 'race', nodeId: 'worker', payload: {} });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      new RemoteWorkerAuthenticator({ key, clock: () => 100_000 }).verifyWithStore(envelope,
        new FileRemoteNonceStore({ filePath, clock: () => 100_000 }))));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.reason?.code === 'REMOTE_AUTH_REPLAY').length, 7);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('worker response MAC binds node, request, nonce, and result', () => {
  const auth = new RemoteWorkerAuthenticator({ key, clock: () => 100_000, nonceFactory: () => 'nonce-1' });
  const request = auth.sign({ requestId: 'request-1', nodeId: 'node-1', payload: {} }).body;
  const response = auth.signResponse(request, { result: { value: 42 } });
  assert.deepEqual(auth.verifyResponse(response, request), { result: { value: 42 } });
  const tampered = structuredClone(response);
  tampered.body.payload.result.value = 43;
  awaitError(() => auth.verifyResponse(tampered, request), 'REMOTE_RESPONSE_INVALID');
  awaitError(() => auth.verifyResponse(response, { ...request, nonce: 'nonce-2' }), 'REMOTE_RESPONSE_MISMATCH');
  awaitError(() => auth.verifyResponse(response, { ...request, nodeId: 'node-2' }), 'REMOTE_RESPONSE_MISMATCH');
  awaitError(() => new RemoteWorkerAuthenticator({ key: Buffer.alloc(32, 8) }).verifyResponse(response, request), 'REMOTE_RESPONSE_INVALID');
});
