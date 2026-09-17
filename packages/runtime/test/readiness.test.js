import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeReadinessKernel } from '../src/readiness.js';

function lifecycle(state) {
  return { snapshot: () => ({ state }) };
}

test('readiness reports ready when lifecycle and required dependencies are healthy', async () => {
  const kernel = new RuntimeReadinessKernel({
    lifecycle: lifecycle('ready'),
    dependencies: [{ id: 'db', check: async () => true }],
    probes: { api: async () => ({ healthy: true }) },
    clock: () => 100,
    idFactory: (() => { let i = 0; return () => `r-${++i}`; })()
  });
  const result = await kernel.evaluate({ correlationId: 'corr-1' });
  assert.equal(result.state, 'ready');
  assert.equal(result.dependencies[0].state, 'healthy');
  assert.equal(result.probes[0].state, 'healthy');
  assert.equal(result.correlationId, 'corr-1');
});

test('required dependency failure produces degraded readiness', async () => {
  const kernel = new RuntimeReadinessKernel({ lifecycle: lifecycle('ready'), dependencies: [{ id: 'db', check: () => false }] });
  const result = await kernel.evaluate();
  assert.equal(result.state, 'degraded');
});

test('lifecycle states take precedence for startup, draining, stopped and failed', async () => {
  for (const [input, expected] of [['initializing', 'starting'], ['draining', 'draining'], ['stopped', 'stopped'], ['failed', 'failed']]) {
    const result = await new RuntimeReadinessKernel({ lifecycle: lifecycle(input) }).evaluate();
    assert.equal(result.state, expected);
  }
});

test('evaluation cancellation is terminal and does not invoke checks', async () => {
  let invoked = false;
  const controller = new AbortController();
  controller.abort();
  const kernel = new RuntimeReadinessKernel({ lifecycle: lifecycle('ready'), dependencies: [{ id: 'db', check: () => { invoked = true; return true; } }] });
  const result = await kernel.evaluate({ signal: controller.signal });
  assert.equal(result.state, 'cancelled');
  assert.equal(invoked, false);
});

test('history is bounded and snapshots are immutable', async () => {
  const kernel = new RuntimeReadinessKernel({ lifecycle: lifecycle('ready'), historyLimit: 2, idFactory: (() => { let i = 0; return () => `r-${++i}`; })() });
  await kernel.evaluate();
  await kernel.evaluate();
  await kernel.evaluate();
  const snapshot = kernel.snapshot();
  assert.equal(snapshot.history.length, 2);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.history[0]), true);
});

test('dependency exceptions are isolated and classified as unhealthy', async () => {
  const kernel = new RuntimeReadinessKernel({ lifecycle: lifecycle('ready'), dependencies: [{ id: 'db', check: () => { throw new Error('db down'); } }] });
  const result = await kernel.evaluate();
  assert.equal(result.state, 'degraded');
  assert.equal(result.dependencies[0].state, 'unhealthy');
  assert.equal(result.dependencies[0].error, 'db down');
});
