import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeSupervisorKernel } from '../src/supervisor.js';

const healthy = { health: () => ({ status: 'healthy' }) };
const failed = { health: () => ({ status: 'failed' }) };

test('aggregates healthy components in deterministic dependency order', async () => {
  const kernel = new RuntimeSupervisorKernel({ components: { b: healthy, a: healthy }, idFactory: (() => { let i=0; return () => `s-${++i}`; })() });
  const result = await kernel.health({ correlationId: 'corr-1' });
  assert.equal(result.state, 'healthy');
  assert.deepEqual(Object.keys(result.components), ['a', 'b']);
  assert.equal(result.correlationId, 'corr-1');
});

test('critical failure produces failed supervision state', async () => {
  const kernel = new RuntimeSupervisorKernel({ components: { runtime: { component: failed, critical: true } } });
  assert.equal((await kernel.evaluate()).state, 'failed');
});

test('noncritical failure produces degraded state', async () => {
  const kernel = new RuntimeSupervisorKernel({ components: { optional: { component: failed, critical: false } } });
  assert.equal((await kernel.evaluate()).state, 'degraded');
});

test('recovering state is propagated', async () => {
  const kernel = new RuntimeSupervisorKernel({ components: { runtime: { component: { health: () => ({ status: 'recovering' }) } } } });
  assert.equal((await kernel.evaluate()).state, 'recovering');
});

test('dependency failure prevents dependent inspection and degrades the dependent', async () => {
  let calls = 0;
  const kernel = new RuntimeSupervisorKernel({ components: {
    database: { component: failed },
    api: { component: { health: () => { calls++; return { status: 'healthy' }; } }, dependencies: ['database'], critical: false }
  }});
  const result = await kernel.evaluate();
  assert.equal(result.components.database.state, 'failed');
  assert.equal(result.components.api.state, 'degraded');
  assert.equal(calls, 0);
});

test('unknown dependencies and cycles are rejected', () => {
  assert.throws(() => new RuntimeSupervisorKernel({ components: { api: { component: healthy, dependencies: ['missing'] } } }), /unknown component/);
  assert.throws(() => new RuntimeSupervisorKernel({ components: { a: { component: healthy, dependencies: ['b'] }, b: { component: healthy, dependencies: ['a'] } } }), /cycle detected/);
});

test('component exceptions are isolated and normalized', async () => {
  const kernel = new RuntimeSupervisorKernel({ components: { broken: { component: { health: () => { throw new Error('boom'); } } } } });
  const result = await kernel.evaluate();
  assert.equal(result.state, 'failed');
  assert.equal(result.components.broken.error.code, 'COMPONENT_HEALTH_FAILED');
});

test('history is bounded and deeply immutable', async () => {
  const kernel = new RuntimeSupervisorKernel({ components: { a: healthy }, historyLimit: 2 });
  await kernel.evaluate(); await kernel.evaluate(); await kernel.evaluate();
  const snapshot = await kernel.snapshot();
  assert.equal(snapshot.history.length, 2);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.history[0]), true);
  assert.equal(Object.isFrozen(snapshot.components.a), true);
});

test('cancellation stops inspection', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const kernel = new RuntimeSupervisorKernel({ components: { a: { health: () => { calls++; return { status: 'healthy' }; } } } });
  const result = await kernel.evaluate({ signal: controller.signal, correlationId: 'cancelled' });
  assert.equal(result.reason, 'cancelled');
  assert.equal(calls, 0);
});
