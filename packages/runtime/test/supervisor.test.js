import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeSupervisorKernel } from '../src/supervisor.js';

test('independent health checks run together while dependents wait for results', async () => {
  const order = [];
  let resolveA, resolveB;
  const supervisor = new RuntimeSupervisorKernel({ components: {
    a: () => { order.push('a'); return new Promise((resolve) => { resolveA = resolve; }); },
    b: () => { order.push('b'); return new Promise((resolve) => { resolveB = resolve; }); },
    api: { dependencies: ['a', 'b'], check: () => { order.push('api'); return { status: 'healthy' }; } }
  }});
  const evaluating = supervisor.evaluate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['a', 'b']);
  resolveA({ status: 'healthy' }); resolveB(true);
  const result = await evaluating;
  assert.deepEqual(order, ['a', 'b', 'api']);
  assert.equal(result.state, 'healthy');
  assert.deepEqual(Object.keys(result.components), ['a', 'api', 'b']);
});

test('critical failure blocks dependent inspection and reports failed state', async () => {
  let checked = false;
  const supervisor = new RuntimeSupervisorKernel({ components: {
    database: { check: () => { throw new Error('secret connection detail'); } },
    api: { dependencies: ['database'], check: () => { checked = true; return true; } }
  }});
  const result = await supervisor.evaluate();
  assert.equal(result.state, 'failed');
  assert.equal(result.components.database.reason, 'check_failed');
  assert.equal(result.components.api.reason, 'dependency_unhealthy');
  assert.equal(checked, false);
  assert.equal(JSON.stringify(result).includes('secret connection detail'), false);
});

test('timeouts are bounded and an uncooperative check cannot block its dependent', async () => {
  const supervisor = new RuntimeSupervisorKernel({ components: { stuck: () => new Promise(() => {}), dependent: { dependencies: ['stuck'], check: () => true } }, timeoutMs: 10 });
  const result = await supervisor.evaluate();
  assert.equal(result.components.stuck.reason, 'timeout');
  assert.equal(result.components.dependent.state, 'degraded');
  assert.equal(result.state, 'failed');
});

test('noncritical failure degrades; history is bounded and isolated', async () => {
  const supervisor = new RuntimeSupervisorKernel({ components: { optional: { critical: false, check: () => ({ status: 'failed' }) } }, historyLimit: 2 });
  await supervisor.evaluate(); await supervisor.evaluate(); await supervisor.evaluate();
  assert.equal(supervisor.snapshot().history.length, 2);
  assert.equal(supervisor.snapshot().latest.state, 'degraded');
  assert.throws(() => { supervisor.history()[0].state = 'healthy'; }, TypeError);
});

test('invalid graphs and unsafe component names fail at construction', () => {
  assert.throws(() => new RuntimeSupervisorKernel({ components: { a: { dependencies: ['b'], check: () => true } } }), /unknown component/);
  assert.throws(() => new RuntimeSupervisorKernel({ components: { a: { dependencies: ['b'], check: () => true }, b: { dependencies: ['a'], check: () => true } } }), /cycle/);
  assert.throws(() => new RuntimeSupervisorKernel({ components: JSON.parse('{"__proto__":{"check":true}}') }), /invalid component id/);
});

test('cancellation skips remaining checks without hanging', async () => {
  const controller = new AbortController();
  let calls = 0;
  const supervisor = new RuntimeSupervisorKernel({ components: { a: () => { calls++; return true; } } });
  controller.abort();
  const result = await supervisor.evaluate({ signal: controller.signal });
  assert.equal(result.state, 'cancelled');
  assert.equal(calls, 0);
});

test('overlapping evaluations are rejected and subsequent probes resume', async () => {
  let finish;
  const supervisor = new RuntimeSupervisorKernel({ components: { a: () => new Promise((resolve) => { finish = resolve; }) } });
  const first = supervisor.evaluate();
  await assert.rejects(supervisor.evaluate(), { code: 'SUPERVISION_BUSY' });
  await new Promise((resolve) => setImmediate(resolve));
  finish(true);
  assert.equal((await first).state, 'healthy');
  assert.equal((await supervisor.evaluate({ correlationId: 123 }).catch((error) => error)).name, 'TypeError');
});

test('parallel check limit prevents a large health fanout', async () => {
  const started = [];
  const finish = [];
  const check = (id) => () => { started.push(id); return new Promise((resolve) => { finish.push(resolve); }); };
  const supervisor = new RuntimeSupervisorKernel({ components: { a: check('a'), b: check('b'), c: check('c') }, maxParallel: 2 });
  const pending = supervisor.evaluate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['a', 'b']);
  finish[0](true); finish[1](true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['a', 'b', 'c']);
  finish[2](true);
  assert.equal((await pending).state, 'healthy');
});
