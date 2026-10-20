import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry } from '../src/registry.js';
import { ToolRuntime } from '../src/tool-runtime.js';
import { RuntimeResourceGovernance } from '../src/resource-governance.js';

function setup(handler, options = {}) {
  const registry = new CapabilityRegistry();
  registry.register({ schemaVersion: '0.1.0', id: 'tool/reserved', kind: 'tool', name: 'Reserved tool', version: '1.0.0', status: 'stable', description: 'test', provenance: { sourceType: 'test' }, ...options }, handler);
  const resources = new RuntimeResourceGovernance({ limits: { concurrency: 1 } });
  return { runtime: new ToolRuntime({ registry, resourceGovernance: resources }), resources };
}

test('resource admission limits simultaneous tools and releases after success', async () => {
  let finish;
  const { runtime, resources } = setup(async () => new Promise((resolve) => { finish = resolve; }));
  const first = runtime.execute('tool/reserved', {}, { executionId: 'one' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resources.totals().totals.concurrency, 1);
  assert.equal((await runtime.execute('tool/reserved', {}, { executionId: 'two' })).error.code, 'RESOURCE_DENIED');
  finish('done');
  assert.equal((await first).status, 'succeeded');
  assert.equal(resources.totals().totals.concurrency, 0);
});

test('timed out work holds its reservation until the underlying handler settles', async () => {
  let finish;
  const { runtime, resources } = setup(async () => new Promise((resolve) => { finish = resolve; }));
  const timedOut = await runtime.execute('tool/reserved', {}, { executionId: 'stuck', timeoutMs: 5 });
  assert.equal(timedOut.status, 'timed_out');
  assert.equal(resources.totals().totals.concurrency, 1);
  assert.equal((await runtime.execute('tool/reserved', {}, { executionId: 'next' })).error.code, 'RESOURCE_DENIED');
  finish('late');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resources.totals().totals.concurrency, 0);
});

test('failed handlers release reservations and manifest budgets cannot be reduced by caller context', async () => {
  const { runtime, resources } = setup(async () => { throw new Error('failed'); }, { resourceRequest: { concurrency: 1 } });
  assert.equal((await runtime.execute('tool/reserved', {}, { resourceRequest: { concurrency: 0 } })).status, 'failed');
  assert.equal(resources.totals().totals.concurrency, 0);
});
