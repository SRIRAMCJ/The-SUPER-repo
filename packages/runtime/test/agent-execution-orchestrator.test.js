import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentExecutionAdmission, AgentExecutionOrchestrator, CapabilityRegistry, ExecutionCancellationRegistry, ExecutionEngine, ReflectionEngine, TaskGraphExecutor, createBasicOutputCritic } from '../src/index.js';

const NOW = new Date('2026-09-17T12:00:00.000Z');
function manifest(id) { return { schemaVersion: '0.1.0', id, kind: 'tool', name: id, version: '1.0.0', status: 'stable', description: id, provenance: { sourceType: 'test' } }; }
function plan(tasks = [{ id: 'task-1', title: 'echo', description: '', dependsOn: [], agent: null, capabilities: ['tool.echo'], priority: 0, input: null }]) { return { schemaVersion: '0.1.0', type: 'agent-plan', planId: 'plan-orch-001', createdAt: NOW.toISOString(), goal: 'run echo', graph: { taskCount: tasks.length, order: tasks.map((task) => task.id), tasks }, requiredCapabilities: [...new Set(tasks.flatMap((task) => task.capabilities))], executionDecision: { status: 'ready', reasons: [] } }; }
function setup({ handler = async (input) => input, reflection = null, recovery = null, events = null } = {}) {
  const registry = new CapabilityRegistry();
  registry.register(manifest('tool.echo'), handler);
  const cancellation = new ExecutionCancellationRegistry();
  const engine = new ExecutionEngine({ registry, cancellation, clock: () => new Date(NOW) });
  const graph = new TaskGraphExecutor({ executeTask: async () => ({ status: 'failed' }), cancellation, clock: () => new Date(NOW) });
  const admission = new AgentExecutionAdmission({ registry, taskGraphExecutor: graph, executionEngine: engine, clock: () => new Date(NOW), idFactory: () => 'agent-orch-001', events });
  const orchestrator = new AgentExecutionOrchestrator({ admission, reflection, recovery, events, clock: () => new Date(NOW), idFactory: () => 'agent-orch-001' });
  return { registry, cancellation, graph, admission, orchestrator };
}

test('runs the complete execution and reflection lifecycle', async () => {
  const events = { values: [], emit(event) { this.values.push(event); } };
  const reflection = new ReflectionEngine({ critics: [createBasicOutputCritic()], clock: () => new Date(NOW) });
  const { orchestrator } = setup({ reflection, events });
  const result = await orchestrator.execute(plan(), { value: 42 }, { correlationId: 'corr-orch' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.executionId, 'agent-orch-001');
  assert.equal(result.correlationId, 'corr-orch');
  assert.equal(result.reflection.status, 'accepted');
  assert.equal(result.session.status, 'succeeded');
  assert.ok(events.values.some((event) => event.type === 'agent.orchestration.completed'));
});

test('preserves dependency-aware task graph execution', async () => {
  const order = [];
  const tasks = [
    { id: 'a', title: 'a', description: '', dependsOn: [], agent: null, capabilities: ['tool.echo'], priority: 0, input: 'a' },
    { id: 'b', title: 'b', description: '', dependsOn: ['a'], agent: null, capabilities: ['tool.echo'], priority: 0, input: 'b' }
  ];
  const { orchestrator, admission } = setup({ handler: async (input) => { order.push(input); return input; } });
  const result = await orchestrator.execute({ ...plan(tasks), graph: { taskCount: 2, order: ['a', 'b'], tasks }, requiredCapabilities: ['tool.echo'] });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(result.execution.result.results.length, 2);
  assert.ok(admission);
});

test('does not execute a blocked admission', async () => {
  const { orchestrator } = setup();
  const result = await orchestrator.execute({ ...plan(), executionDecision: { status: 'blocked', reasons: [{ code: 'GOVERNANCE_DENIED', message: 'denied' }] } });
  assert.equal(result.status, 'failed');
  assert.equal(result.admission.status, 'blocked');
  assert.equal(result.attempt, 0);
});

test('cancellation reaches the orchestration terminal state', async () => {
  const { orchestrator, graph } = setup({ handler: async (_input, { signal }) => new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? Object.assign(new Error('cancelled'), { code: 'EXECUTION_CANCELLED' }));
    signal.addEventListener('abort', abort, { once: true });
  }) });
  const execution = orchestrator.execute(plan());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(graph.cancel('agent-orch-001', 'operator cancelled'), true);
  const result = await execution;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.execution.result.error.code, 'EXECUTION_CANCELLED');
});

test('retryable failures are handed to recovery with bounded attempts', async () => {
  let calls = 0;
  const recoveryCalls = [];
  const recovery = { async recover(taskPlan, executionId, context) { recoveryCalls.push({ taskPlan, executionId, context }); return { executionId, status: 'succeeded', output: 'recovered', results: [] }; } };
  const { orchestrator } = setup({ handler: async () => { calls += 1; throw Object.assign(new Error('temporary'), { code: 'TEMPORARY', retryable: true }); }, recovery });
  const result = await orchestrator.execute(plan(), {}, {}, {});
  assert.equal(result.status, 'failed');
  assert.equal(calls, 1);
  assert.equal(recoveryCalls.length, 0);

  const bounded = new AgentExecutionOrchestrator({ admission: setup({ handler: async () => { throw Object.assign(new Error('temporary'), { code: 'TEMPORARY', retryable: true }); } }).admission, recovery, maxRecoveryAttempts: 1, clock: () => new Date(NOW), idFactory: () => 'agent-retry' });
  const recovered = await bounded.execute(plan(), {}, {});
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.recoveryAttempts, 1);
  assert.equal(recoveryCalls.length, 1);
});

test('reflection rejection becomes a distinct terminal state', async () => {
  const reflection = { async evaluate() { return { schemaVersion: '0.1.0', type: 'reflection-result', status: 'rejected', evaluations: [{ criticId: 'quality', status: 'rejected', reason: 'quality threshold' }], summary: { critics: 1, rejected: 1, warnings: 0 } }; } };
  const { orchestrator } = setup({ reflection });
  const result = await orchestrator.execute(plan());
  assert.equal(result.status, 'rejected');
  assert.equal(result.reflection.status, 'rejected');
  assert.equal(result.session.status, 'rejected');
});

test('session snapshots are isolated and terminal state is stable', async () => {
  const { orchestrator } = setup();
  const result = await orchestrator.execute(plan());
  const snapshot = orchestrator.getSession(result.executionId);
  snapshot.history.push({ status: 'tampered' });
  assert.equal(orchestrator.getSession(result.executionId).history.some((entry) => entry.status === 'tampered'), false);
  assert.equal(orchestrator.getSession(result.executionId).status, 'succeeded');
  assert.ok(Object.isFrozen(result));
});
