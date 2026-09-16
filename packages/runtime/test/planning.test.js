import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry, EventBus, ExecutionEngine, ExecutionPlanExecutor, PolicyEngine, RuntimePlanningBridge, VerificationEngine, WorkflowEngine } from '../src/index.js';

const tool = (id, requires = []) => ({
  schemaVersion: '0.1.0',
  id,
  kind: 'tool',
  name: id,
  version: '1.0.0',
  status: 'stable',
  description: `Test tool ${id}`,
  provenance: { sourceType: 'test' },
  requires
});

test('workflow executes a deterministic plan through the existing execution boundary', async () => {
  const registry = new CapabilityRegistry();
  const events = new EventBus();
  const calls = [];
  registry.register(tool('tool/dependency'), async (input, ctx) => {
    calls.push({ id: 'tool/dependency', input, ctx });
    return `${input}|dependency`;
  });
  registry.register(tool('tool/root', ['tool/dependency']), async (input, ctx) => {
    calls.push({ id: 'tool/root', input, ctx });
    return `${input}|root`;
  });

  const execution = new ExecutionEngine({ registry, events, verifier: new VerificationEngine() });
  const planExecutor = new ExecutionPlanExecutor({ executionEngine: execution, events });
  const planning = new RuntimePlanningBridge({ registry, planExecutor });
  const workflow = new WorkflowEngine({
    registry,
    executionEngine: execution,
    events,
    planBuilder: planning,
    planExecutor
  });

  const manifest = {
    schemaVersion: '0.1.0',
    id: 'workflow/test-planning',
    kind: 'workflow',
    name: 'Planning Test',
    version: '1.0.0',
    status: 'stable',
    description: 'Test workflow',
    provenance: { sourceType: 'test' },
    steps: [{ id: 'run-root', capability: 'tool/root' }]
  };
  const result = await workflow.execute(manifest, 'input', { requestId: 'plan-test' });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.output, 'input|dependency|root');
  assert.deepEqual(result.results[0].result.plan.order, ['tool/dependency', 'tool/root']);
  assert.equal(calls[0].ctx.planStep, 1);
  assert.equal(calls[1].ctx.planStep, 2);
  assert.equal(calls[1].ctx.requestId, 'plan-test');
  assert.equal(events.history({ type: 'plan.completed' }).length, 1);
  assert.equal(events.history({ type: 'execution.verified' }).length, 2);
});

test('workflow returns a structured planning failure when a dependency is unavailable', async () => {
  const registry = new CapabilityRegistry();
  registry.register(tool('tool/root', ['tool/missing']), async () => 'never');
  const execution = new ExecutionEngine({ registry });
  const planExecutor = new ExecutionPlanExecutor({ executionEngine: execution });
  const planning = new RuntimePlanningBridge({ registry, planExecutor });
  const workflow = new WorkflowEngine({ registry, executionEngine: execution, planBuilder: planning, planExecutor });
  const manifest = {
    schemaVersion: '0.1.0', id: 'workflow/test-failure', kind: 'workflow', name: 'Planning Failure', version: '1.0.0', status: 'stable',
    description: 'Test workflow', provenance: { sourceType: 'test' }, steps: [{ id: 'run-root', capability: 'tool/root' }]
  };

  const result = await workflow.execute(manifest, {});
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'MISSING_DEPENDENCY');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].result.status, 'failed');
});

test('planning bridge excludes declarative workflow manifests from executable plans', () => {
  const registry = new CapabilityRegistry();
  registry.register(tool('tool/root'), async () => 'ok');
  registry.register({
    schemaVersion: '0.1.0', id: 'workflow/declarative', kind: 'workflow', name: 'Declarative', version: '1.0.0', status: 'stable',
    description: 'Declarative workflow', provenance: { sourceType: 'test' }, steps: []
  });
  const execution = new ExecutionEngine({ registry });
  const planExecutor = new ExecutionPlanExecutor({ executionEngine: execution });
  const planning = new RuntimePlanningBridge({ registry, planExecutor });

  const result = planning.build({ capabilityId: 'tool/root' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.order, ['tool/root']);
});
