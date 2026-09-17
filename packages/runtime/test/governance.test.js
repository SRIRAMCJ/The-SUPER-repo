import test from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine, RuntimeGovernance, RuntimeLifecycleManager } from '../src/index.js';

const clock = () => new Date('2026-09-17T10:00:00.000Z');

test('governance gates control operations by lifecycle state', async () => {
  const lifecycle = new RuntimeLifecycleManager({ clock });
  const governance = new RuntimeGovernance({ lifecycle, clock });
  const operation = { id: 'runtime.cancel', classification: 'control' };
  assert.equal(governance.authorize(operation).allowed, false);
  await lifecycle.start();
  assert.equal(governance.authorize(operation).allowed, true);
  await lifecycle.drain();
  assert.equal(governance.authorize(operation).allowed, true);
  await lifecycle.stop();
  assert.equal(governance.authorize(operation).allowed, false);
});

test('governance delegates capability policy and records decisions', async () => {
  const lifecycle = new RuntimeLifecycleManager({ clock });
  const policyEngine = new PolicyEngine({ policies: [() => ({ allowed: false, reason: 'maintenance window' })] });
  const governance = new RuntimeGovernance({ lifecycle, policyEngine, clock });
  await lifecycle.start();
  const decision = governance.authorize({ id: 'runtime.cancel', classification: 'control' }, { approval: true });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'maintenance window');
  assert.equal(governance.getDecisions().length, 1);
  assert.equal(governance.snapshot().type, 'runtime-governance');
  await lifecycle.stop();
});

test('governance rules are configurable and snapshots are isolated', async () => {
  const lifecycle = new RuntimeLifecycleManager({ clock });
  await lifecycle.start();
  const governance = new RuntimeGovernance({ lifecycle, clock, rules: { control: ['running'] } });
  assert.equal(governance.authorize({ id: 'runtime.cancel', classification: 'control' }).allowed, true);
  await lifecycle.drain();
  assert.equal(governance.authorize({ id: 'runtime.cancel', classification: 'control' }).allowed, false);
  const snapshot = governance.snapshot();
  snapshot.rules.control.push('draining');
  assert.deepEqual(governance.snapshot().rules.control, ['running']);
  await lifecycle.stop();
});

test('governance validates configuration', () => {
  assert.throws(() => new RuntimeGovernance({ maxDecisions: 0 }), /maxDecisions/);
  assert.throws(() => new RuntimeGovernance({ rules: { control: 'running' } }), /must be an array/);
});
