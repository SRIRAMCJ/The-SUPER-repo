import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeConfigurationKernel } from '../src/configuration.js';

test('loads validated immutable configuration snapshots', () => {
  const kernel = new RuntimeConfigurationKernel({ initial: { runtime: { mode: 'production' } }, schema: (value) => value.runtime?.mode === 'production' } });
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

test('redacts secret-shaped keys from snapshots and history metadata', () => {
  const kernel = new RuntimeConfigurationKernel({ initial: { apiKey: 'super-secret', nested: { password: 'pw', visible: 'ok' } }, metadata: undefined });
  const current = kernel.current();
  assert.equal(current.values.apiKey, '[REDACTED]');
  assert.equal(current.values.nested.password, '[REDACTED]');
  assert.equal(current.values.nested.visible, 'ok');
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
