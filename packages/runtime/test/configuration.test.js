import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeConfigurationKernel } from '../src/configuration.js';

test('loads validated immutable configuration snapshots', () => {
  const kernel = new RuntimeConfigurationKernel({ initial: { runtime: { mode: 'production' } }, schema: (value) => value.runtime?.mode === 'production' });
  const current = kernel.current();
  assert.equal(current.values.runtime.mode, 'production');
  assert.equal(Object.isFrozen(current), false);
});

test('rejects invalid reload without replacing the active snapshot', () => {
  let id = 0;
  const kernel = new RuntimeConfigurationKernel({ initial: { enabled: true }, schema: (value) => value.enabled === true, idFactory: () => `id-${++id}` });
  const before = kernel.current();
  assert.throws(() => kernel.reload({ enabled: false }), { code: 'CONFIGURATION_INVALID' });
  assert.deepEqual(kernel.current().values, before.values);
});

test('applies atomic reload with optimistic version protection', () => {
  let id = 0;
  const kernel = new RuntimeConfigurationKernel({ initial: { limit: 1 }, idFactory: () => `id-${++id}` });
  const first = kernel.current();
  const next = kernel.reload({ limit: 2 }, { expectedVersion: first.version, source: 'control-plane' });
  assert.equal(next.values.limit, 2);
  assert.equal(kernel.history().length, 1);
  assert.throws(() => kernel.reload({ limit: 3 }, { expectedVersion: first.version }), { code: 'CONFIGURATION_CONFLICT' });
});

test('rejects secret-shaped and prototype keys in configuration and history metadata', () => {
  assert.throws(() => new RuntimeConfigurationKernel({ initial: { apiKey: 'sensitive' } }), { code: 'CONFIGURATION_INVALID' });
  const kernel = new RuntimeConfigurationKernel({ initial: { visible: 'ok' } });
  const previous = kernel.current();
  assert.throws(() => kernel.reload({ nested: { password: 'sensitive' } }), { code: 'CONFIGURATION_INVALID' });
  assert.throws(() => kernel.reload({ visible: 'ok' }, { metadata: { secretToken: 'sensitive' } }), { code: 'CONFIGURATION_INVALID' });
  assert.throws(() => kernel.reload(JSON.parse('{"__proto__":{"polluted":true}}')), { code: 'CONFIGURATION_INVALID' });
  assert.deepEqual(kernel.current(), previous);
});

test('retains bounded immutable change history', () => {
  let id = 0;
  const kernel = new RuntimeConfigurationKernel({ initial: { n: 0 }, historyLimit: 2, idFactory: () => `id-${++id}` });
  const version = kernel.current().version;
  kernel.reload({ n: 1 }, { expectedVersion: version });
  const version2 = kernel.current().version;
  kernel.reload({ n: 2 }, { expectedVersion: version2 });
  const version3 = kernel.current().version;
  kernel.reload({ n: 3 }, { expectedVersion: version3 });
  assert.equal(kernel.history().length, 2);
  assert.equal(Object.isFrozen(kernel.history()[0]), true);
});

test('versions remain monotonic even with a constant ID generator and callers cannot mutate active values', () => {
  const kernel = new RuntimeConfigurationKernel({ initial: { nested: { limit: 1 } }, idFactory: () => 'same-id' });
  const first = kernel.current();
  first.values.nested.limit = 99;
  const second = kernel.reload({ nested: { limit: 2 } }, { expectedVersion: first.version });
  assert.equal(second.version, first.version + 1);
  assert.equal(kernel.current().values.nested.limit, 2);
  assert.throws(() => kernel.reload({ nested: { limit: 3 } }, { expectedVersion: first.version }), { code: 'CONFIGURATION_CONFLICT' });
});

test('rejects cyclic values and preserves the last valid snapshot on schema failure', () => {
  const kernel = new RuntimeConfigurationKernel({ initial: { enabled: true }, schema: (value) => value.enabled === true });
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => kernel.reload(cyclic), { code: 'CONFIGURATION_INVALID' });
  assert.throws(() => kernel.reload({ enabled: false }), { code: 'CONFIGURATION_INVALID' });
  assert.equal(kernel.current().values.enabled, true);
  assert.equal(kernel.history().length, 0);
});

test('asynchronous schema validation fails closed without changing active configuration', async () => {
  const kernel = new RuntimeConfigurationKernel({ initial: { enabled: true } });
  kernel.schema = async () => { throw new Error('rejected'); };
  assert.throws(() => kernel.reload({ enabled: false }), { code: 'CONFIGURATION_INVALID' });
  await new Promise(setImmediate);
  assert.equal(kernel.current().values.enabled, true);
});
