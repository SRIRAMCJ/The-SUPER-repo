import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry } from '../src/registry.js';
import { ExecutionEngine } from '../src/executor.js';
import { RuntimeShutdownAdmission } from '../src/shutdown-admission.js';

function setup(handler, options = {}) {
  const registry = new CapabilityRegistry();
  registry.register({ schemaVersion: '0.1.0', id: 'test/slow', kind: 'tool', name: 'Slow', version: '1.0.0', status: 'stable', description: 'test', provenance: { sourceType: 'test' }, ...options }, handler);
  const gate = new RuntimeShutdownAdmission();
  return { gate, engine: new ExecutionEngine({ registry, shutdownAdmission: gate }) };
}

test('execution drain holds a lease until a timed out handler settles', async () => {
  let finish;
  const { gate, engine } = setup(() => new Promise((resolve) => { finish = resolve; }), { timeoutSeconds: 0.01 });
  const result = await engine.execute('test/slow', {}, { executionId: 'slow' });
  assert.equal(result.error.code, 'EXECUTION_TIMEOUT');
  gate.beginDrain({ deadlineMs: 1000 });
  assert.deepEqual(gate.activeExecutions(), ['slow']);
  assert.equal((await engine.execute('test/slow', {}, { executionId: 'second' })).error.code, 'ADMISSION_CLOSED');
  const drained = gate.waitForDrain();
  finish('late');
  assert.equal((await drained).state, 'stopped');
});

test('verification remains admitted and handler failures release the lease', async () => {
  let finishVerification;
  const { gate, engine } = setup(async () => 'result');
  engine.verifier = { verify: () => new Promise((resolve) => { finishVerification = resolve; }) };
  const work = engine.execute('test/slow', {}, { executionId: 'verify' });
  await new Promise((resolve) => setImmediate(resolve));
  gate.beginDrain({ deadlineMs: 1000 });
  assert.deepEqual(gate.activeExecutions(), ['verify']);
  finishVerification({ verified: true, checks: 0, failures: [] });
  assert.equal((await work).status, 'succeeded');
  assert.equal((await gate.waitForDrain()).state, 'stopped');

  gate.reopen();
  engine.verifier = null;
  engine.registry.register({ schemaVersion: '0.1.0', id: 'test/fail', kind: 'tool', name: 'Fail', version: '1.0.0', status: 'stable', description: 'test', provenance: { sourceType: 'test' } }, async () => { throw new Error('boom'); });
  assert.equal((await engine.execute('test/fail', {}, { executionId: 'fail' })).status, 'failed');
  assert.equal(gate.snapshot().activeCount, 0);
});
