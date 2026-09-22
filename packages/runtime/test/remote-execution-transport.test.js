import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRemoteExecutionTransport } from '../src/remote-execution-transport.js';

test('transport registers workers and tracks heartbeat health', () => {
  let now = 1000;
  const transport = new InMemoryRemoteExecutionTransport({ clock: () => now, leaseTtlMs: 100 });
  transport.registerWorker({ workerId: 'worker-a', execute: async () => ({ status: 'succeeded' }) });
  assert.equal(transport.listWorkers()[0].healthy, true);
  now = 1201;
  assert.equal(transport.listWorkers()[0].healthy, false);
  transport.heartbeat('worker-a');
  assert.equal(transport.listWorkers()[0].healthy, true);
});

test('transport creates a lease and correlates the remote execution id', async () => {
  const transport = new InMemoryRemoteExecutionTransport({ clock: () => 1000 });
  transport.registerWorker({ workerId: 'worker-a', execute: async request => ({ status: 'succeeded', output: { executionId: request.executionId } }) });
  const result = await transport.execute({ executionId: 'exec-1', command: 'node', args: [] });
  assert.equal(result.status, 'succeeded');
  assert.ok(result.remoteExecutionId);
  assert.equal(transport.inspect(result.remoteExecutionId).executionId, 'exec-1');
  assert.equal(transport.inspect(result.remoteExecutionId).status, 'succeeded');
});

test('transport fails closed when no healthy worker exists', async () => {
  const transport = new InMemoryRemoteExecutionTransport({ clock: () => 5000, leaseTtlMs: 10 });
  await assert.rejects(() => transport.execute({ executionId: 'exec-no-worker' }), error => error.code === 'NO_HEALTHY_WORKER' && error.retryable === true);
});

test('transport cancellation updates the execution lease', async () => {
  let release;
  const controller = new AbortController();
  const transport = new InMemoryRemoteExecutionTransport({ clock: () => 1000 });
  transport.registerWorker({
    workerId: 'worker-a',
    execute: async (_request, { signal }) => new Promise((resolve, reject) => {
      release = resolve;
      signal.addEventListener('abort', () => reject(new Error('cancelled by caller')), { once: true });
    }),
  });
  const pending = transport.execute({ executionId: 'exec-cancel' }, { signal: controller.signal });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(transport.inspect(result.remoteExecutionId).status, 'cancelled');
  release({ status: 'succeeded' });
});

test('transport rejects duplicate worker registration', () => {
  const transport = new InMemoryRemoteExecutionTransport();
  const execute = async () => ({ status: 'succeeded' });
  transport.registerWorker({ workerId: 'worker-a', execute });
  assert.throws(() => transport.registerWorker({ workerId: 'worker-a', execute }), error => error.code === 'WORKER_ALREADY_REGISTERED');
});


import { RemoteWorkerRegistry } from '../src/remote-worker-registry.js';
import { RemoteAuthKeyRing, createRemoteIdentity, createProtocolEnvelope, createSignedEnvelope } from '../src/index.js';
import { RemoteWorkerLeaseManager } from '../src/remote-worker-lease.js';

test('transport uses scheduler-issued lease and fencing token to dispatch to the selected worker', async () => {
  const registry = new RemoteWorkerRegistry();
  const leases = new RemoteWorkerLeaseManager();
  const transport = new InMemoryRemoteExecutionTransport({ workerRegistry: registry, leaseManager: leases });
  transport.registerWorker({
    workerId: 'worker-a',
    capabilities: ['runtime.execute'],
    execute: async (_request, context) => ({ status: 'succeeded', output: { workerId: context.workerId, fence: context.fencingToken } }),
  });

  const acquired = leases.acquire({ executionId: 'exec-fenced', workerId: 'worker-a' });
  const result = await transport.execute(
    { executionId: 'exec-fenced', capability: { id: 'runtime.execute' } },
    { workerId: 'worker-a', leaseId: acquired.lease.leaseId, fencingToken: acquired.lease.fencingToken },
  );

  assert.equal(result.status, 'succeeded');
  assert.equal(result.workerId, 'worker-a');
  assert.equal(result.fencingToken, acquired.lease.fencingToken);
  assert.equal(leases.get(result.leaseId).status, 'released');
});

test('transport rejects stale fenced ownership before dispatch', async () => {
  const registry = new RemoteWorkerRegistry();
  const leases = new RemoteWorkerLeaseManager();
  const transport = new InMemoryRemoteExecutionTransport({ workerRegistry: registry, leaseManager: leases });
  let calls = 0;
  transport.registerWorker({
    workerId: 'worker-a',
    capabilities: ['runtime.execute'],
    execute: async () => {
      calls += 1;
      return { status: 'succeeded' };
    },
  });

  const first = leases.acquire({ executionId: 'exec-stale', workerId: 'worker-a' });
  leases.fence(first.lease.leaseId);
  const second = leases.acquire({ executionId: 'exec-stale', workerId: 'worker-a' });

  await assert.rejects(
    () => transport.execute(
      { executionId: 'exec-stale', requestId: 'exec-stale-request-1', capability: { id: 'runtime.execute' } },
      { workerId: 'worker-a', leaseId: first.lease.leaseId, fencingToken: first.lease.fencingToken },
    ),
    (error) => error.code === 'LEASE_NOT_ACTIVE',
  );

  await assert.rejects(
    () => transport.execute(
      { executionId: 'exec-stale', requestId: 'exec-stale-request-2', capability: { id: 'runtime.execute' } },
      { workerId: 'worker-a', leaseId: second.lease.leaseId, fencingToken: first.lease.fencingToken },
    ),
    (error) => error.code === 'STALE_FENCING_TOKEN',
  );

  assert.equal(calls, 0);
  assert.notEqual(second.lease.fencingToken, first.lease.fencingToken);
});

test('transport fails closed when a requested worker lacks the capability', async () => {
  const registry = new RemoteWorkerRegistry();
  const leases = new RemoteWorkerLeaseManager();
  const transport = new InMemoryRemoteExecutionTransport({ workerRegistry: registry, leaseManager: leases });
  transport.registerWorker({ workerId: 'worker-other', capabilities: ['runtime.other'], execute: async () => ({ status: 'succeeded' }) });

  await assert.rejects(
    () => transport.execute(
      { executionId: 'exec-capability-mismatch', capability: { id: 'runtime.execute' } },
      { workerId: 'worker-other' },
    ),
    (error) => error.code === 'NO_HEALTHY_WORKER' && error.retryable === true,
  );
});


test('transport fences active execution ownership when a worker is unregistered', async () => {
  const registry = new RemoteWorkerRegistry();
  const leases = new RemoteWorkerLeaseManager();
  const transport = new InMemoryRemoteExecutionTransport({ workerRegistry: registry, leaseManager: leases });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  transport.registerWorker({
    workerId: 'worker-dead',
    capabilities: ['runtime.execute'],
    execute: async () => {
      await gate;
      return { status: 'succeeded' };
    },
  });

  const pending = transport.execute({ executionId: 'exec-unregister', capability: { id: 'runtime.execute' } });
  await new Promise((resolve) => setImmediate(resolve));
  const remote = transport.inspect('rex-1');
  assert.equal(remote.workerId, 'worker-dead');

  transport.unregisterWorker('worker-dead');
  release();

  await assert.rejects(() => pending, (error) => error.code === 'LEASE_NOT_ACTIVE');
  assert.equal(leases.get(remote.leaseId).status, 'fenced');
});

test('transport negotiates protocol and forwards protocol-safe request metadata', async () => {
  const transport = new InMemoryRemoteExecutionTransport({ clock: () => 1000 });
  let received;
  transport.registerWorker({
    workerId: 'protocol-worker',
    protocolVersions: ['1.0'],
    execute: async (request) => {
      received = request;
      return { status: 'succeeded', output: { ok: true } };
    },
  });
  const result = await transport.execute({
    executionId: 'exec-protocol',
    requestId: 'req-protocol-1',
    traceId: 'trace-1',
    deadlineAt: 2000,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(received.requestId, 'req-protocol-1');
  assert.equal(received.traceId, 'trace-1');
});

test('transport rejects duplicate protocol request ids before worker execution', async () => {
  const transport = new InMemoryRemoteExecutionTransport({ clock: () => 1000 });
  let calls = 0;
  transport.registerWorker({
    workerId: 'protocol-worker',
    execute: async () => {
      calls += 1;
      return { status: 'succeeded' };
    },
  });
  await transport.execute({ executionId: 'exec-protocol-1', requestId: 'same-request' });
  await assert.rejects(
    () => transport.execute({ executionId: 'exec-protocol-2', requestId: 'same-request' }),
    (error) => error.code === 'DUPLICATE_REQUEST',
  );
  assert.equal(calls, 1);
});

test('transport rejects incompatible worker protocol versions', () => {
  const transport = new InMemoryRemoteExecutionTransport({ supportedProtocolVersions: ['1.0'] });
  assert.throws(
    () => transport.registerWorker({
      workerId: 'legacy-worker',
      protocolVersions: ['2.0'],
      execute: async () => ({ status: 'succeeded' }),
    }),
    (error) => error.code === 'UNSUPPORTED_PROTOCOL_VERSION',
  );
});


test('transport authenticates worker identity during registration and controller identity during execution', async () => {
  const now = 10_000;
  const keyRing = new RemoteAuthKeyRing();
  keyRing.addKey({ keyId: 'auth-1', secret: '0123456789abcdef0123456789abcdef', active: true });
  const workerIdentity = createRemoteIdentity({ principalId: 'secure-worker', role: 'worker', instanceId: 'secure-worker-inc-1', issuedAt: now - 10, expiresAt: now + 60_000, keyId: 'auth-1' });
  const controllerIdentity = createRemoteIdentity({ principalId: 'secure-controller', role: 'controller', instanceId: 'controller-inc-1', issuedAt: now - 10, expiresAt: now + 60_000, keyId: 'auth-1' });
  const transport = new InMemoryRemoteExecutionTransport({ clock: () => now, authKeyRing: keyRing, authTrustedIdentities: [controllerIdentity] });

  const registrationEnvelope = createProtocolEnvelope({
    protocolVersion: '1.0',
    requestId: 'register-secure-worker',
    method: 'heartbeat',
    payload: { workerId: 'secure-worker', capabilities: ['runtime.execute'] },
    timestamp: now,
  });
  const registrationAuth = createSignedEnvelope({ identity: workerIdentity, envelope: registrationEnvelope, keyRing, nonce: 'register-nonce' });
  transport.registerWorker({
    workerId: 'secure-worker',
    capabilities: ['runtime.execute'],
    identity: workerIdentity,
    authentication: registrationAuth,
    execute: async () => ({ status: 'succeeded', output: { authenticated: true } }),
  });

  const request = {
    executionId: 'secure-exec',
    requestId: 'secure-request-1',
    capability: { id: 'runtime.execute' },
  };
  const executeEnvelope = createProtocolEnvelope({
    protocolVersion: '1.0',
    requestId: request.requestId,
    method: 'execute',
    executionId: request.executionId,
    payload: request,
    timestamp: now,
  });
  const executeAuth = createSignedEnvelope({ identity: controllerIdentity, envelope: executeEnvelope, keyRing, nonce: 'execute-nonce' });
  const result = await transport.execute({ ...request, authentication: executeAuth }, { workerId: 'secure-worker' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.output.authenticated, true);
});

test('transport fails closed on tampered authenticated execution requests', async () => {
  const now = 20_000;
  const keyRing = new RemoteAuthKeyRing();
  keyRing.addKey({ keyId: 'auth-1', secret: '0123456789abcdef0123456789abcdef', active: true });
  const workerIdentity = createRemoteIdentity({ principalId: 'worker-tamper', role: 'worker', instanceId: 'worker-tamper-inc-1', issuedAt: now - 10, expiresAt: now + 60_000, keyId: 'auth-1' });
  const controllerIdentity = createRemoteIdentity({ principalId: 'controller-tamper', role: 'controller', instanceId: 'controller-inc-1', issuedAt: now - 10, expiresAt: now + 60_000, keyId: 'auth-1' });
  const transport = new InMemoryRemoteExecutionTransport({ clock: () => now, authKeyRing: keyRing, authTrustedIdentities: [controllerIdentity] });
  const registrationEnvelope = createProtocolEnvelope({ requestId: 'register-worker-tamper', method: 'heartbeat', payload: { workerId: 'worker-tamper', capabilities: [] }, timestamp: now });
  const registrationAuth = createSignedEnvelope({ identity: workerIdentity, envelope: registrationEnvelope, keyRing, nonce: 'register-tamper' });
  transport.registerWorker({ workerId: 'worker-tamper', identity: workerIdentity, authentication: registrationAuth, execute: async () => ({ status: 'succeeded' }) });

  const signedRequest = { executionId: 'tamper-exec', requestId: 'tamper-request', capability: { id: 'runtime.execute' } };
  const signedEnvelope = createProtocolEnvelope({ requestId: signedRequest.requestId, method: 'execute', executionId: signedRequest.executionId, payload: signedRequest, timestamp: now });
  const authentication = createSignedEnvelope({ identity: controllerIdentity, envelope: signedEnvelope, keyRing, nonce: 'tamper-execute' });
  await assert.rejects(
    () => transport.execute({ ...signedRequest, capability: { id: 'runtime.other' }, authentication }),
    error => error.code === 'AUTH_ENVELOPE_MISMATCH',
  );
});

test('transport rejects controller credentials used for worker registration', () => {
  const now = 30_000;
  const keyRing = new RemoteAuthKeyRing();
  keyRing.addKey({ keyId: 'auth-1', secret: '0123456789abcdef0123456789abcdef', active: true });
  const controllerIdentity = createRemoteIdentity({ principalId: 'controller-only', role: 'controller', instanceId: 'controller-inc-1', issuedAt: now - 10, expiresAt: now + 60_000, keyId: 'auth-1' });
  const transport = new InMemoryRemoteExecutionTransport({ clock: () => now, authKeyRing: keyRing });
  const envelope = createProtocolEnvelope({ requestId: 'register-invalid-role', method: 'heartbeat', payload: { workerId: 'worker-role', capabilities: [] }, timestamp: now });
  const authentication = createSignedEnvelope({ identity: controllerIdentity, envelope, keyRing, nonce: 'invalid-role' });
  assert.throws(
    () => transport.registerWorker({ workerId: 'worker-role', identity: controllerIdentity, authentication, execute: async () => ({ status: 'succeeded' }) }),
    error => error.code === 'INVALID_WORKER_IDENTITY',
  );
});


test('transport rejects an authenticated but untrusted controller identity', async () => {
  const now = 40_000;
  const keyRing = new RemoteAuthKeyRing();
  keyRing.addKey({ keyId: 'auth-1', secret: '0123456789abcdef0123456789abcdef', active: true });
  const workerIdentity = createRemoteIdentity({ principalId: 'worker-untrusted', role: 'worker', instanceId: 'worker-untrusted-inc-1', issuedAt: now - 10, expiresAt: now + 60_000, keyId: 'auth-1' });
  const controllerIdentity = createRemoteIdentity({ principalId: 'controller-untrusted', role: 'controller', instanceId: 'controller-inc-1', issuedAt: now - 10, expiresAt: now + 60_000, keyId: 'auth-1' });
  const trustedController = createRemoteIdentity({ principalId: 'trusted-controller', role: 'controller', instanceId: 'trusted-controller-inc-1', issuedAt: now - 10, expiresAt: now + 60_000, keyId: 'auth-1' });
  const transport = new InMemoryRemoteExecutionTransport({ clock: () => now, authKeyRing: keyRing, authTrustedIdentities: [trustedController] });
  const registrationEnvelope = createProtocolEnvelope({ requestId: 'register-untrusted', method: 'heartbeat', payload: { workerId: workerIdentity.principalId, capabilities: ['runtime.execute'] }, timestamp: now });
  const registrationAuth = createSignedEnvelope({ identity: workerIdentity, envelope: registrationEnvelope, keyRing, nonce: 'register-untrusted' });
  transport.registerWorker({ workerId: workerIdentity.principalId, capabilities: ['runtime.execute'], identity: workerIdentity, authentication: registrationAuth, execute: async () => ({ status: 'succeeded' }) });
  const request = { executionId: 'untrusted-exec', requestId: 'untrusted-request', capability: { id: 'runtime.execute' } };
  const envelope = createProtocolEnvelope({ requestId: request.requestId, method: 'execute', executionId: request.executionId, payload: request, timestamp: now });
  const authentication = createSignedEnvelope({ identity: controllerIdentity, envelope, keyRing, nonce: 'untrusted-controller' });
  await assert.rejects(
    () => transport.execute({ ...request, authentication }, { workerId: workerIdentity.principalId }),
    error => error.code === 'UNTRUSTED_IDENTITY',
  );
});
