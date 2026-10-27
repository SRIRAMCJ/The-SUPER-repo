import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RemoteWorkerAuthenticator, FileRemoteNonceStore, UnixWorkerServer, UnixWorkerClient } from '../src/index.js';

const key = Buffer.alloc(32, 13);

test('Unix worker executes a registered capability with authenticated identity', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-worker-'));
  const socketPath = path.join(directory, 'worker.sock');
  const server = new UnixWorkerServer({ socketPath, nodeId: 'node-1', authenticator: new RemoteWorkerAuthenticator({ key }),
    nonceStore: new FileRemoteNonceStore({ filePath: path.join(directory, 'nonces.json') }),
    handlers: { 'math.double': (input, context) => ({ value: input.value * 2, nodeId: context.nodeId }) } });
  try {
    await server.start();
    let signed = 0;
    const authenticator = new RemoteWorkerAuthenticator({ key, nonceFactory: () => ['nonce-1', 'nonce-2', 'nonce-1'][signed++] });
    const client = new UnixWorkerClient({ socketPath, nodeId: 'node-1', authenticator });
    assert.deepEqual(await client.execute({ requestId: 'req-1', capabilityId: 'math.double', input: { value: 21 } }), { value: 42, nodeId: 'node-1' });
    await assert.rejects(client.execute({ requestId: 'req-2', capabilityId: 'unknown', input: {} }), { code: 'REMOTE_CAPABILITY_DENIED' });
    await assert.rejects(client.execute({ requestId: 'req-1', capabilityId: 'math.double', input: { value: 21 } }), { code: 'REMOTE_AUTH_REPLAY' });
    const wrong = new UnixWorkerClient({ socketPath, nodeId: 'node-2', authenticator: new RemoteWorkerAuthenticator({ key }) });
    await assert.rejects(wrong.execute({ capabilityId: 'math.double', input: { value: 1 } }), { code: 'REMOTE_NODE_MISMATCH' });
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('worker rejects an invalid key before calling a capability', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-worker-'));
  const socketPath = path.join(directory, 'worker.sock');
  let calls = 0;
  const server = new UnixWorkerServer({ socketPath, nodeId: 'node-1', authenticator: new RemoteWorkerAuthenticator({ key }),
    nonceStore: new FileRemoteNonceStore({ filePath: path.join(directory, 'nonces.json') }),
    handlers: { task: () => { calls++; } } });
  try {
    await server.start();
    const client = new UnixWorkerClient({ socketPath, nodeId: 'node-1', authenticator: new RemoteWorkerAuthenticator({ key: Buffer.alloc(32, 14) }) });
    await assert.rejects(client.execute({ capabilityId: 'task' }), { code: 'REMOTE_AUTH_INVALID' });
    assert.equal(calls, 0);
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }); }
});
