import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeExecutionAdmission } from '../src/execution-admission.js';

function shutdown() { const active = new Set(); return { admit: ({ executionId }) => { active.add(executionId); return { state: 'running', executionId }; }, release: (id) => active.delete(id), isAdmitted: (id) => active.has(id), activeExecutions: () => [...active], state: () => ({ state: 'running' }), forceStop: () => { active.clear(); return { state: 'stopped' }; } }; }
const resources = () => ({ admit: ({ executionId }) => ({ allowed: true, executionId }), release: () => ({ released: true }), snapshot: () => ({}) });
const policyAllow = { evaluate: async () => ({ decisionId: 'd-1', allowed: true, decision: 'allow' }), snapshot: () => ({}) };
const policyDeny = { evaluate: async () => ({ decisionId: 'd-2', allowed: false, decision: 'deny', checks: [{ reason: 'blocked' }] }) };

test('policy denial blocks shutdown and resource admission', async () => {
  const s = shutdown(); let resourceCalls = 0;
  const r = { admit: (x) => { resourceCalls++; return resources().admit(x); }, release: () => ({}) };
  const kernel = new RuntimeExecutionAdmission({ shutdown: s, resources: r, policy: policyDeny });
  await assert.rejects(() => kernel.admit({ executionId: 'e1' }), (error) => error.code === 'POLICY_ADMISSION_DENIED' && error.decisionId === 'd-2');
  assert.equal(s.activeExecutions().length, 0); assert.equal(resourceCalls, 0);
});

test('allowed policy proceeds through shutdown and resources', async () => {
  const kernel = new RuntimeExecutionAdmission({ shutdown: shutdown(), resources: resources(), policy: policyAllow });
  const result = await kernel.admit({ executionId: 'e1', context: { operationId: 'runtime.execute' } });
  assert.equal(result.policy.decisionId, 'd-1'); assert.equal(result.resources.allowed, true);
});

test('policy denial is auditable and immutable', async () => {
  const kernel = new RuntimeExecutionAdmission({ shutdown: shutdown(), policy: policyDeny });
  await assert.rejects(() => kernel.admit({ executionId: 'e1' }));
  const history = kernel.history(); assert.equal(history[0].reason, 'policy_denied'); assert.equal(Object.isFrozen(history[0]), true);
});

test('AbortError is classified as cancelled and always releases admission', async () => {
  const s=shutdown(); const kernel=new RuntimeExecutionAdmission({ shutdown:s, policy:policyAllow });
  const result=await kernel.execute({ executionId:'e1', handler: async()=>{ const e=new Error('aborted'); e.name='AbortError'; throw e; } });
  assert.equal(result.status,'cancelled'); assert.equal(s.activeExecutions().length,0);
});
