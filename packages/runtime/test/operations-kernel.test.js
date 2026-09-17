import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationsRuntimeKernel } from '../src/operations-kernel.js';

function lifecycleStub() {
  const state = { state: 'stopped', history: [] };
  return {
    async start() { state.state = 'running'; state.history.push('start'); },
    async drain() { state.state = 'draining'; state.history.push('drain'); },
    async stop() { state.state = 'stopped'; state.history.push('stop'); },
    async transition() {},
    snapshot() { return structuredClone(state); }
  };
}

test('reports runtime health from lifecycle state and probe', async () => {
  const kernel = new OperationsRuntimeKernel({ lifecycle: lifecycleStub(), healthProbe: async () => ({ status: 'pass', component: 'core' }) });
  const health = await kernel.health();
  assert.equal(health.status, 'stopped');
  assert.equal(health.checks[0].status, 'pass');
});

test('executes lifecycle operations with immutable correlated records', async () => {
  let id = 0;
  const kernel = new OperationsRuntimeKernel({ lifecycle: lifecycleStub(), idFactory: () => `op-${++id}` });
  const result = await kernel.execute('start', { actor: 'control-plane' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.operationId, 'op-1');
  assert.equal(result.lifecycle.state, 'running');
  assert.equal(kernel.history().length, 1);
});

test('serializes active operations and prevents concurrent control races', async () => {
  let release;
  const lifecycle = lifecycleStub();
  lifecycle.start = () => new Promise((resolve) => { release = () => { lifecycle.state = 'running'; resolve(); }; });
  const kernel = new OperationsRuntimeKernel({ lifecycle });
  const pending = kernel.execute('start');
  await assert.rejects(() => kernel.execute('stop'), { code: 'OPERATION_IN_PROGRESS' });
  release();
  await pending;
});

test('records failed operations without leaking mutable state', async () => {
  const lifecycle = lifecycleStub();
  lifecycle.start = async () => { throw Object.assign(new Error('boot failed'), { code: 'BOOT_FAILED', retryable: true }); };
  const kernel = new OperationsRuntimeKernel({ lifecycle });
  await assert.rejects(() => kernel.execute('start'), { code: 'BOOT_FAILED' });
  const history = kernel.history();
  assert.equal(history[0].status, 'failed');
  assert.equal(history[0].error.retryable, true);
});

test('bounds operation history', async () => {
  const kernel = new OperationsRuntimeKernel({ lifecycle: lifecycleStub(), maxHistory: 2 });
  await kernel.execute('start');
  await kernel.execute('stop');
  await kernel.execute('start');
  assert.equal(kernel.history().length, 2);
  assert.equal(kernel.history()[0].action, 'stop');
});
