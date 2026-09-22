import test from 'node:test';
import assert from 'node:assert/strict';
import { VerticalMissionEngine } from '../src/vertical-mission.js';

const plan = (status = 'ready') => ({
  schemaVersion: '0.1.0', type: 'agent-plan', planId: 'plan-1', createdAt: new Date(1000).toISOString(),
  goal: 'complete engineering mission',
  graph: { taskCount: 1, order: ['task-1'], tasks: [{ id: 'task-1', dependsOn: [], capabilities: ['agent/test'] }] },
  requiredCapabilities: ['agent/test'], executionDecision: { status, reasons: status === 'ready' ? [] : [{ code: 'BLOCKED', message: 'blocked' }] }
});

function engine({ planStatus = 'ready', executionStatus = 'succeeded', verification = { verified: true, checks: 1, failures: [] } } = {}) {
  return new VerticalMissionEngine({
    planner: { plan: () => plan(planStatus) },
    admission: { admit: () => ({ status: planStatus, reasons: [] }) },
    orchestrator: { execute: async () => ({ executionId: 'exec-1', status: executionStatus, execution: { status: executionStatus, result: { output: { answer: 42 } } } }) },
    verifier: { verify: async () => verification }, clock: () => new Date(1000), idFactory: () => 'mission-1'
  });
}

test('vertical mission executes planning, admission, execution, verification, artifact and report', async () => {
  const result = await engine().execute({ goal: 'complete engineering mission' }, { input: true });
  assert.equal(result.status, 'succeeded'); assert.equal(result.report.type, 'mission-report');
  assert.equal(result.artifacts.length, 1); assert.equal(result.verification.verified, true);
});

test('blocked planning is rejected before execution', async () => {
  const result = await engine({ planStatus: 'blocked' }).execute({ goal: 'blocked mission' });
  assert.equal(result.status, 'rejected'); assert.equal(result.execution, null);
});

test('failed verification prevents successful delivery', async () => {
  const result = await engine({ verification: { verified: false, checks: 1, failures: [{ code: 'BAD_OUTPUT' }] } }).execute({ goal: 'verify mission' });
  assert.equal(result.status, 'failed'); assert.equal(result.artifacts.length, 0);
});

test('failed execution is surfaced without verification or artifact delivery', async () => {
  const result = await engine({ executionStatus: 'failed' }).execute({ goal: 'failed mission' });
  assert.equal(result.status, 'failed'); assert.equal(result.verification, null); assert.equal(result.artifacts.length, 0);
});
