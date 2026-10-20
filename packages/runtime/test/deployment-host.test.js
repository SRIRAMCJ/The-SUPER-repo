import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RuntimeDeploymentHost, RuntimeFailoverKernel, FileFailoverStore, RuntimeSupervisorKernel,
  RuntimeLifecycleManager, RuntimeShutdownAdmission, RuntimeShutdownCoordinator } from '../src/index.js';

async function eventually(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('condition was not reached');
}

test('deployment host recovers once per incident across restart and closes admission on shutdown', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'super-deployment-'));
  try {
    const file = path.join(directory, 'failover.json');
    let incident = 'first', calls = 0;
    const makeHost = (owner) => {
      const lifecycle = new RuntimeLifecycleManager({ components: [{ name: 'service', start: () => {}, stop: () => {} }] });
      const coordinator = new RuntimeShutdownCoordinator({ lifecycle, admission: new RuntimeShutdownAdmission() });
      const supervisor = new RuntimeSupervisorKernel({ components: { service: () => ({ state: 'failed' }) } });
      const failover = new RuntimeFailoverKernel({ supervisor, store: new FileFailoverStore(file), owner,
        recover: async ({ fence }) => { await fence.assertCurrent(); calls++; return { recovered: true }; }, leaseMs: 1000, renewEveryMs: 100 });
      return new RuntimeDeploymentHost({ coordinator, failover, name: 'service', incidentId: () => incident, intervalMs: 25 });
    };
    const first = makeHost('one');
    await first.start();
    await eventually(() => calls === 1);
    await first.shutdown();
    assert.equal(first.admission.state(), 'stopped');
    const restarted = makeHost('two');
    await restarted.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(calls, 1);
    incident = 'second';
    await eventually(() => calls === 2);
    await restarted.shutdown();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('shutdown aborts an in-flight recovery and waits for its orchestration to settle', async () => {
  const lifecycle = new RuntimeLifecycleManager();
  const coordinator = new RuntimeShutdownCoordinator({ lifecycle, admission: new RuntimeShutdownAdmission() });
  let entered;
  const running = new Promise((resolve) => { entered = resolve; });
  let cancelled = false;
  const host = new RuntimeDeploymentHost({ coordinator, failover: { attempt: async (_, __, { signal }) => {
    entered();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    cancelled = true;
  } }, name: 'service', incidentId: () => 'incident', intervalMs: 10 });
  await host.start();
  await running;
  const stopping = host.shutdown();
  assert.equal(host.admission.state(), 'draining');
  await stopping;
  assert.equal(cancelled, true);
  assert.equal(lifecycle.getState().state, 'stopped');
});

test('a stuck incident provider cannot hold shutdown open', async () => {
  const lifecycle = new RuntimeLifecycleManager();
  const coordinator = new RuntimeShutdownCoordinator({ lifecycle, admission: new RuntimeShutdownAdmission() });
  let entered;
  const running = new Promise((resolve) => { entered = resolve; });
  const host = new RuntimeDeploymentHost({ coordinator, failover: { attempt: () => assert.fail('unexpected recovery') },
    name: 'service', incidentId: () => { entered(); return new Promise(() => {}); }, intervalMs: 10, pollTimeoutMs: 100 });
  await host.start();
  await running;
  await host.shutdown({ deadlineMs: 1000 });
  assert.equal(lifecycle.getState().state, 'stopped');
});

test('an uncooperative recovery adapter cannot hold shutdown open', async () => {
  const lifecycle = new RuntimeLifecycleManager();
  const coordinator = new RuntimeShutdownCoordinator({ lifecycle, admission: new RuntimeShutdownAdmission() });
  let entered;
  const running = new Promise((resolve) => { entered = resolve; });
  const host = new RuntimeDeploymentHost({ coordinator, failover: { attempt: () => { entered(); return new Promise(() => {}); } },
    name: 'service', incidentId: () => 'incident', intervalMs: 10, attemptTimeoutMs: 100 });
  await host.start();
  await running;
  await host.shutdown({ deadlineMs: 1000 });
  assert.equal(lifecycle.getState().state, 'stopped');
});

test('a killed host loses its lease and a new host recovers after expiry', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'super-deployment-crash-'));
  let child;
  try {
    const file = path.join(directory, 'failover.json');
    const moduleUrl = new URL('../src/index.js', import.meta.url).href;
    const script = `import { RuntimeDeploymentHost, RuntimeFailoverKernel, FileFailoverStore, RuntimeSupervisorKernel, RuntimeLifecycleManager, RuntimeShutdownAdmission, RuntimeShutdownCoordinator } from ${JSON.stringify(moduleUrl)};
      const coordinator = new RuntimeShutdownCoordinator({ lifecycle: new RuntimeLifecycleManager(), admission: new RuntimeShutdownAdmission() });
      const failover = new RuntimeFailoverKernel({ supervisor: new RuntimeSupervisorKernel({ components: { service: () => ({ state: 'failed' }) } }), store: new FileFailoverStore(process.argv[1]), owner: 'crashed', leaseMs: 1000, renewEveryMs: 100, recover: async () => { console.log('claimed'); return new Promise(() => {}); } });
      await new RuntimeDeploymentHost({ coordinator, failover, name: 'service', incidentId: () => 'incident', intervalMs: 20 }).start();`;
    child = spawn(process.execPath, ['--input-type=module', '-e', script, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    await Promise.race([new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { if (chunk.toString().includes('claimed')) resolve(); });
      child.on('exit', (code) => reject(new Error(`host exited ${code}`)));
    }), new Promise((_, reject) => setTimeout(() => reject(new Error('host did not claim')), 3000))]);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('close', resolve));
    let recoveries = 0;
    const coordinator = new RuntimeShutdownCoordinator({ lifecycle: new RuntimeLifecycleManager(), admission: new RuntimeShutdownAdmission() });
    const failover = new RuntimeFailoverKernel({ supervisor: new RuntimeSupervisorKernel({ components: { service: () => ({ state: 'failed' }) } }),
      store: new FileFailoverStore(file), owner: 'replacement', leaseMs: 1000, renewEveryMs: 100,
      recover: async () => { recoveries++; return 'recovered'; } });
    const host = new RuntimeDeploymentHost({ coordinator, failover, name: 'service', incidentId: () => 'incident', intervalMs: 25 });
    await host.start();
    try { await eventually(() => recoveries === 1, 4000); }
    finally { await host.shutdown(); }
  } finally { child?.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
});
