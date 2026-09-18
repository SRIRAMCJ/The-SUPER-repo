import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimePolicyEnforcementKernel } from '../src/policy-enforcement.js';

const allow = { authorize: () => ({ allowed: true, reason: 'ok' }) };
const deny = { authorize: () => ({ allowed: false, reason: 'blocked' }) };

test('allows only when every configured enforcement layer allows', async () => {
  const kernel = new RuntimePolicyEnforcementKernel({ governance: allow, security: allow });
  const result = await kernel.evaluate({ id: 'runtime.start' }, { correlationId: 'corr-1' });
  assert.equal(result.decision, 'allow'); assert.equal(result.correlationId, 'corr-1'); assert.equal(result.checks.length, 2);
});

test('governance denial short-circuits security and records denial', async () => {
  let securityCalls = 0;
  const kernel = new RuntimePolicyEnforcementKernel({ governance: deny, security: { authorize: () => { securityCalls++; return { allowed: true }; } } });
  const result = await kernel.evaluate({ id: 'runtime.stop' });
  assert.equal(result.decision, 'deny'); assert.equal(securityCalls, 0); assert.equal(result.checks[0].source, 'governance');
});

test('supervisor failure is fail-closed', async () => {
  const kernel = new RuntimePolicyEnforcementKernel({ supervisor: { health: () => ({ state: 'failed' }) }, governance: allow });
  const result = await kernel.evaluate({ id: 'runtime.start' });
  assert.equal(result.allowed, false); assert.equal(result.checks[0].source, 'supervisor');
});

test('enforce blocks handler and exposes auditable decision metadata', async () => {
  let called = false;
  const kernel = new RuntimePolicyEnforcementKernel({ governance: deny });
  await assert.rejects(() => kernel.enforce({ id: 'runtime.cancel', secret: 'x' }, {}, () => { called = true; }), (error) => error.code === 'POLICY_DENIED' && Boolean(error.decisionId));
  assert.equal(called, false);
});

test('policy exceptions fail closed', async () => {
  const kernel = new RuntimePolicyEnforcementKernel({ governance: { authorize: () => { throw new Error('policy down'); } } });
  const result = await kernel.evaluate({ id: 'runtime.start' });
  assert.equal(result.decision, 'deny'); assert.equal(result.checks[0].result.error.code, 'POLICY_CHECK_FAILED');
});

test('history is bounded and deeply immutable', async () => {
  const kernel = new RuntimePolicyEnforcementKernel({ governance: allow, maxHistory: 2 });
  await kernel.evaluate({ id: 'a' }); await kernel.evaluate({ id: 'b' }); await kernel.evaluate({ id: 'c' });
  const snapshot = kernel.snapshot();
  assert.equal(snapshot.history.length, 2); assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(snapshot.history[0]), true);
});
