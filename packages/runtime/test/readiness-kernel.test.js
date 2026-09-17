import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeReadinessKernel } from '../src/readiness-kernel.js';

function lifecycle(state = 'running') { return { snapshot: () => ({ state }) }; }

test('evaluates required and optional components with dependency ordering', async () => {
  const calls = [];
  const kernel = new RuntimeReadinessKernel({ lifecycle: lifecycle(), components: [
    { id: 'database', probe: async () => { calls.push('database'); return { status: 'pass' }; } },
    { id: 'api', dependencies: ['database'], probe: async () => { calls.push('api'); return { status: 'pass' }; } },
    { id: 'metrics', required: false, probe: async () => ({ status: 'fail', reason: 'collector unavailable' }) }
  ] });
  const result = await kernel.evaluate({ correlationId: 'corr-1' });
  assert.equal(result.status, 'degraded');
  assert.deepEqual(calls, ['database', 'api']);
  assert.equal(result.correlationId, 'corr-1');
});

test('blocks dependents when a required dependency fails', async () => {
  let dependentCalled = false;
  const kernel = new RuntimeReadinessKernel({ lifecycle: lifecycle(), components: [
    { id: 'database', probe: async () => { throw Object.assign(new Error('down'), { code: 'DB_DOWN' }); } },
    { id: 'api', dependencies: ['database'], probe: async () => { dependentCalled = true; return { status: 'pass' }; } }
  ] });
  const result = await kernel.evaluate();
  assert.equal(result.status, 'failed');
  assert.equal(dependentCalled, false);
  assert.equal(result.checks[1].reason, 'dependency_failed');
});

test('maps lifecycle shutdown states to draining readiness', async () => {
  const result = await new RuntimeReadinessKernel({ lifecycle: lifecycle('draining') }).evaluate();
  assert.equal(result.status, 'draining');
});

test('honors cancellation before and during probe evaluation', async () => {
  const controller = new AbortController();
  controller.abort();
  const kernel = new RuntimeReadinessKernel({ lifecycle: lifecycle(), components: [{ id: 'slow', probe: async () => ({ status: 'pass' }) }] });
  const result = await kernel.evaluate({ signal: controller.signal });
  assert.equal(result.status, 'draining');
  assert.equal(result.reason, 'cancelled');
});

test('keeps readiness history bounded and immutable', async () => {
  let id = 0;
  const kernel = new RuntimeReadinessKernel({ lifecycle: lifecycle(), maxHistory: 2, idFactory: () => `r-${++id}` });
  await kernel.evaluate(); await kernel.evaluate(); await kernel.evaluate();
  const history = kernel.history();
  assert.equal(history.length, 2);
  assert.equal(history[0].readinessId, 'r-2');
  assert.throws(() => { history[0].checks.push({ id: 'x' }); }, TypeError);
});
