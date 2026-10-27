import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RemoteWorkerAuthenticator, FileRemoteNonceStore, UnixWorkerServer, UnixWorkerClient, FileFailoverStore, FileEventJournal } from '../src/index.js';

const key = Buffer.alloc(32, 13);
const controls = (directory) => ({ authorize: async () => ({ allowed: true }), auditJournal: new FileEventJournal(path.join(directory, 'audit')) });

test('Unix worker executes a registered capability with authenticated identity', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-worker-'));
  const socketPath = path.join(directory, 'worker.sock');
  const server = new UnixWorkerServer({ socketPath, nodeId: 'node-1', ...controls(directory), authenticator: new RemoteWorkerAuthenticator({ key }),
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
  const server = new UnixWorkerServer({ socketPath, nodeId: 'node-1', ...controls(directory), authenticator: new RemoteWorkerAuthenticator({ key }),
    nonceStore: new FileRemoteNonceStore({ filePath: path.join(directory, 'nonces.json') }),
    handlers: { task: () => { calls++; } } });
  try {
    await server.start();
    const client = new UnixWorkerClient({ socketPath, nodeId: 'node-1', authenticator: new RemoteWorkerAuthenticator({ key: Buffer.alloc(32, 14) }) });
    await assert.rejects(client.execute({ capabilityId: 'task' }), { code: 'REMOTE_AUTH_INVALID' });
    assert.equal(calls, 0);
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('configured file effect rejects a replaced worker lease at commit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-worker-effect-'));
  const socketPath = path.join(directory, 'worker.sock');
  const destination = path.join(directory, 'effect.json');
  const effectStore = new FileFailoverStore(path.join(directory, 'leases.json'));
  const server = new UnixWorkerServer({ socketPath, nodeId: 'node-1', ...controls(directory), authenticator: new RemoteWorkerAuthenticator({ key }),
    nonceStore: new FileRemoteNonceStore({ filePath: path.join(directory, 'nonces.json') }), effectStore,
    effects: { persist: destination }, handlers: { persist: (input, context) => context.writeEffect(input) } });
  try {
    await server.start();
    const client = new UnixWorkerClient({ socketPath, nodeId: 'node-1', authenticator: new RemoteWorkerAuthenticator({ key }) });
    const old = await effectStore.claim('execution-1', 'node-1');
    await assert.rejects(client.execute({ capabilityId: 'persist', input: { value: 1 } }), { code: 'REMOTE_FENCE_REQUIRED' });
    await effectStore.release('execution-1', old);
    const current = await effectStore.claim('execution-1', 'node-1');
    await assert.rejects(client.execute({ capabilityId: 'persist', input: { value: 2 }, fence: { key: 'execution-1', epoch: old.epoch, token: old.token } }), { code: 'FAILOVER_FENCE_REJECTED' });
    await assert.rejects(readFile(destination, 'utf8'), { code: 'ENOENT' });
    await client.execute({ capabilityId: 'persist', input: { value: 3 }, fence: { key: 'execution-1', epoch: current.epoch, token: current.token } });
    assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), { value: 3 });
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('worker denies policy before execution and records an allowed run durably', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-worker-policy-'));
  const socketPath = path.join(directory, 'worker.sock');
  const auditJournal = new FileEventJournal(path.join(directory, 'audit'));
  let calls = 0;
  const server = new UnixWorkerServer({ socketPath, nodeId: 'node-1', authenticator: new RemoteWorkerAuthenticator({ key }),
    nonceStore: new FileRemoteNonceStore({ filePath: path.join(directory, 'nonces.json') }), auditJournal,
    authorize: ({ input }) => ({ allowed: input.allowed === true }),
    handlers: { task: () => { calls++; return 'done'; } } });
  try {
    await server.start();
    const client = new UnixWorkerClient({ socketPath, nodeId: 'node-1', authenticator: new RemoteWorkerAuthenticator({ key }) });
    await assert.rejects(client.execute({ capabilityId: 'task', input: { allowed: false } }), { code: 'REMOTE_POLICY_DENIED' });
    assert.equal(calls, 0);
    assert.equal(await client.execute({ capabilityId: 'task', input: { allowed: true } }), 'done');
    assert.deepEqual((await auditJournal.replay()).events.map(({ event }) => event.type), ['remote.worker.started', 'remote.worker.succeeded']);
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }); }
});
