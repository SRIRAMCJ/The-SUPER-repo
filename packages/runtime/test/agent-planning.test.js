import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentPlanningKernel, CapabilityPlanner, CapabilityRegistry, RuntimeGovernance, RuntimeLifecycleManager, TaskDecomposer } from '../src/index.js';

const manifest = (id, name = id) => ({ schemaVersion: '0.1.0', id, kind: 'agent', name, version: '1.0.0', status: 'stable', description: `${name} capability`, provenance: { sourceType: 'test' } });
const clock = () => new Date('2026-09-17T10:00:00.000Z');
function kernel(registry, options = {}) { return new AgentPlanningKernel({ planner: new CapabilityPlanner({ registry, clock }), decomposer: new TaskDecomposer({ clock }), registry, clock, ...options }); }

test('builds a deterministic goal to dependency graph plan', () => {
  const registry = new CapabilityRegistry();
  registry.register(manifest('agent.codegen', 'Code Generation'), () => {});
  const k = kernel(registry);
  const first = k.plan({ goal: 'generate code', context: { input: { language: 'js' } } });
  const second = k.plan({ goal: 'generate code', context: { input: { language: 'js' } } });
  assert.equal(first.executionDecision.status, 'ready');
  assert.equal(first.planId, second.planId);
  assert.deepEqual(first.graph.order, ['task-1']);
  assert.deepEqual(first.requiredCapabilities, ['agent.codegen']);
  assert.equal(Object.isFrozen(first.graph), true);
});

test('preserves and validates explicit dependency order', () => {
  const registry = new CapabilityRegistry();
  registry.register(manifest('agent.build', 'Build'), () => {});
  const k = kernel(registry);
  const plan = k.plan({ goal: 'build', tasks: [
    { id: 'compile', title: 'Compile', capabilities: ['agent.build'] },
    { id: 'package', title: 'Package', capabilities: ['agent.build'], dependsOn: ['compile'] }
  ] });
  assert.equal(plan.executionDecision.status, 'ready');
  assert.deepEqual(plan.graph.order, ['compile', 'package']);
});

test('returns invalid for cyclic dependency graphs', () => {
  const registry = new CapabilityRegistry();
  registry.register(manifest('agent.build'), () => {});
  const plan = kernel(registry).plan({ goal: 'build', tasks: [
    { id: 'a', title: 'A', capabilities: ['agent.build'], dependsOn: ['b'] },
    { id: 'b', title: 'B', capabilities: ['agent.build'], dependsOn: ['a'] }
  ] });
  assert.equal(plan.executionDecision.status, 'invalid');
  assert.equal(plan.executionDecision.reasons[0].code, 'TASK_DEPENDENCY_CYCLE');
});

test('blocks plans with missing capabilities', () => {
  const registry = new CapabilityRegistry();
  const plan = kernel(registry).plan({ goal: 'ship', tasks: [{ id: 'ship', title: 'Ship', capabilities: ['agent.release'] }] });
  assert.equal(plan.executionDecision.status, 'blocked');
  assert.equal(plan.unresolvedRequirements[0].code, 'CAPABILITY_MISSING');
});

test('blocks plans denied by runtime governance', async () => {
  const registry = new CapabilityRegistry();
  registry.register(manifest('agent.deploy', 'Deploy'), () => {});
  const lifecycle = new RuntimeLifecycleManager({ clock });
  await lifecycle.start();
  const governance = new RuntimeGovernance({ lifecycle, clock, rules: { control: ['ready'] } });
  const plan = kernel(registry, { governance }).plan({ goal: 'deploy', tasks: [{ id: 'deploy', title: 'Deploy', capabilities: ['agent.deploy'] }] });
  assert.equal(plan.executionDecision.status, 'blocked');
  assert.equal(plan.unresolvedRequirements[0].code, 'GOVERNANCE_DENIED');
  await lifecycle.stop();
});

test('rejects malformed planning requests with structured invalid decisions', () => {
  const registry = new CapabilityRegistry();
  const plan = kernel(registry).plan({ goal: '' });
  assert.equal(plan.executionDecision.status, 'invalid');
  assert.equal(plan.executionDecision.reasons[0].code, 'GOAL_INVALID');
});

test('preserves ordered capability pipelines instead of sorting or dropping them', () => {
  const registry = new CapabilityRegistry();
  registry.register(manifest('agent.z'), () => {});
  registry.register(manifest('agent.a'), () => {});
  const tasks = [{ id: 'pipeline', title: 'Pipeline', capabilities: ['agent.z', 'agent.a'] }];
  const plan = kernel(registry).plan({ goal: 'pipeline', tasks });
  tasks[0].capabilities.reverse();
  assert.deepEqual(plan.graph.tasks[0].capabilities, ['agent.z', 'agent.a']);
  assert.deepEqual(plan.requiredCapabilities, ['agent.a', 'agent.z']);
});

test('blocks disabled capabilities and tasks without an executor', () => {
  const registry = new CapabilityRegistry();
  registry.register({ ...manifest('agent.disabled'), status: 'disabled' }, () => {});
  const k = kernel(registry);
  assert.equal(k.plan({ goal: 'run', tasks: [{ id: 'a', title: 'A', capabilities: ['agent.disabled'] }] }).executionDecision.status, 'blocked');
  assert.equal(k.plan({ goal: 'run', tasks: [{ id: 'a', title: 'A' }] }).executionDecision.status, 'blocked');
});

test('malformed capabilities are rejected, never silently discarded', () => {
  const registry = new CapabilityRegistry();
  for (const capabilities of ['agent.a', [null], [' '], [123]]) {
    const result = kernel(registry).plan({ goal: 'run', tasks: [{ id: 'a', title: 'A', capabilities }] });
    assert.equal(result.executionDecision.status, 'invalid');
    assert.equal(result.executionDecision.reasons[0].code, 'TASK_CAPABILITY_INVALID');
  }
});
