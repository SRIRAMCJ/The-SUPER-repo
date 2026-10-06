import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentPlanningKernel, AgentExecutionAdmission, CapabilityPlanner, CapabilityRegistry, ExecutionEngine, TaskDecomposer, TaskGraphExecutor } from '../src/index.js';

function fixture(governance = null) {
  const registry = new CapabilityRegistry();
  const calls = [];
  for (const [id, transform] of [['tool.z', (x) => x + 1], ['tool.a', (x) => x * 3]]) {
    registry.register({ schemaVersion: '0.1.0', id, kind: 'tool', name: id, version: '1.0.0', status: 'stable', description: id, provenance: { sourceType: 'test' } }, async (input) => { calls.push(id); return transform(input); });
  }
  const planning = new AgentPlanningKernel({ planner: new CapabilityPlanner({ registry }), decomposer: new TaskDecomposer(), registry, governance });
  const admission = new AgentExecutionAdmission({ registry, governance, executionEngine: new ExecutionEngine({ registry }), taskGraphExecutor: new TaskGraphExecutor({ executeTask: () => { throw new Error('Admission must provide the task executor'); } }) });
  return { planning, admission, calls };
}

test('explicit capability pipeline survives planning and executes in declared order', async () => {
  const { planning, admission, calls } = fixture();
  const plan = planning.plan({ goal: 'transform', tasks: [{ id: 'pipeline', title: 'Transform', capabilities: ['tool.z', 'tool.a'] }] });
  const result = await admission.execute(plan, 2);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls, ['tool.z', 'tool.a']);
  assert.equal(result.result.output, 9);
});

test('a policy change after planning blocks every handler at admission', async () => {
  let allowed = true;
  const { planning, admission, calls } = fixture({ authorize: () => ({ allowed }) });
  const plan = planning.plan({ goal: 'transform', tasks: [{ id: 'a', title: 'Transform', capabilities: ['tool.z'] }] });
  assert.equal(plan.executionDecision.status, 'ready');
  allowed = false;
  assert.equal((await admission.execute(plan, 2)).status, 'blocked');
  assert.deepEqual(calls, []);
});
