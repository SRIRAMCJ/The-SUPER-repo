import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ControlPlaneGateway, RuntimeGatewayDeployment, FileFailoverStore, RuntimeLifecycleManager,
  RuntimeShutdownAdmission, RuntimeShutdownCoordinator } from '../src/index.js';

async function eventually(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.fail('condition not reached');
}

test('deployed HTTP gateway recovers a failed health incident through fenced file effect', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'super-gateway-deployment-'));
  try {
    const store = new FileFailoverStore(path.join(directory, 'leases.json'));
    const effect = path.join(directory, 'recovery.json');
    const controlPlane = { getHealth: () => ({ status: 'critical' }), snapshot: async () => ({ status: 'critical' }) };
    const deployment = new RuntimeGatewayDeployment({ controlPlane, store, owner: 'gateway-1', intervalMs: 20,
      incidentId: () => 'failure-1', recover: async ({ fence }) => {
        await store.writeFencedJson(fence.key, fence, effect, { incident: fence.incidentId });
        return 'recovered';
      } });
    const address = await deployment.start();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      assert.equal(response.status, 200);
      await eventually(async () => { try { return JSON.parse(await readFile(effect, 'utf8')).incident === 'failure-1'; } catch { return false; } });
    } finally { await deployment.shutdown(); }
    assert.equal(deployment.lifecycle.getState().state, 'stopped');
    assert.equal(deployment.admission.state(), 'stopped');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('gateway admits HTTP requests until drain and rejects late traffic while active work settles', async () => {
  let entered, finish;
  const running = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { finish = resolve; });
  const controlPlane = { getHealth: () => ({ status: 'healthy' }), snapshot: () => ({}) };
  const admission = new RuntimeShutdownAdmission();
  const gateway = new ControlPlaneGateway({ controlPlane, shutdownAdmission: admission,
    commands: { list: () => [], execute: async () => { entered(); await hold; return { ok: true }; } } });
  const lifecycle = new RuntimeLifecycleManager({ components: [{ name: 'gateway', start: () => gateway.listen(), stop: () => gateway.close() }] });
  const coordinator = new RuntimeShutdownCoordinator({ lifecycle, admission });
  await coordinator.start();
  try {
    const origin = `http://127.0.0.1:${gateway.server.address().port}`;
    const first = fetch(`${origin}/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"command":"work"}' });
    await running;
    const stop = coordinator.shutdown({ deadlineMs: 2000 });
    assert.equal(admission.state(), 'draining');
    const late = await fetch(`${origin}/health`);
    assert.equal(late.status, 503);
    assert.equal((await late.json()).error.code, 'ADMISSION_CLOSED');
    finish();
    assert.equal((await first).status, 200);
    await stop;
  } finally {
    finish?.();
    if (lifecycle.getState().state !== 'stopped') await coordinator.shutdown().catch(() => {});
    await gateway.close();
  }
});

test('public bind requires explicit authorization callback', () => {
  assert.throws(() => new RuntimeGatewayDeployment({ controlPlane: { getHealth: () => ({ status: 'healthy' }), snapshot: () => ({}) },
    store: {}, owner: 'a', incidentId: () => 'one', recover: async () => {}, host: '0.0.0.0' }), /requires authorize/);
});
