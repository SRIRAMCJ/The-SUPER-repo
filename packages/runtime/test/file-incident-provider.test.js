import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileIncidentProvider, FileFailoverStore, RuntimeDeploymentHost, RuntimeFailoverKernel,
  RuntimeSupervisorKernel, RuntimeLifecycleManager, RuntimeShutdownCoordinator, RuntimeShutdownAdmission } from '../src/index.js';
import { writeAtomicJson } from '../src/atomic-json.js';

test('stable file incident survives restart and rotates only when publisher changes it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'super-incident-'));
  try {
    const file = path.join(directory, 'incident.json');
    const store = new FileFailoverStore(path.join(directory, 'failover.json'));
    const publish = (incidentId, active = true) => writeAtomicJson(file, { schemaVersion: '0.1.0', incidentId, active });
    await publish('incident-1');
    let calls = 0;
    const makeHost = (owner) => {
      const coordinator = new RuntimeShutdownCoordinator({ lifecycle: new RuntimeLifecycleManager(), admission: new RuntimeShutdownAdmission() });
      const failover = new RuntimeFailoverKernel({ supervisor: new RuntimeSupervisorKernel({ components: { service: () => ({ state: 'failed' }) } }),
        store, owner, leaseMs: 1000, renewEveryMs: 100, recover: async () => { calls++; return 'recovered'; } });
      return new RuntimeDeploymentHost({ coordinator, failover, incidentId: new FileIncidentProvider(file).provider(), name: 'service', intervalMs: 20 });
    };
    const first = makeHost('first');
    await first.start();
    await eventually(() => calls === 1);
    await first.shutdown();
    const second = makeHost('second');
    await second.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(calls, 1);
      await publish('incident-2', false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(calls, 1);
      await publish('incident-2');
      await eventually(() => calls === 2);
    } finally { await second.shutdown(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('incident provider rejects missing, invalid, and oversized state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'super-incident-'));
  try {
    const file = path.join(directory, 'incident.json');
    const provider = new FileIncidentProvider(file, { maxBytes: 128 });
    await assert.rejects(provider.current(), { code: 'ENOENT' });
    for (const value of ['{', JSON.stringify({ schemaVersion: '0.1.0', incidentId: 'bad id', active: true }), 'x'.repeat(129)]) {
      await writeFile(file, value);
      await assert.rejects(provider.current(), { code: 'INCIDENT_FILE_INVALID' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function eventually(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('condition not reached');
}
