import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentExecutionAdmission, CapabilityRegistry, ExecutionCancellationRegistry, ExecutionEngine, TaskGraphExecutor, fingerprintAgentPlan } from '../src/index.js';

const NOW = new Date('2026-09-17T12:00:00.000Z');
function manifest(id, status = 'stable') { return { schemaVersion: '0.1.0', id, kind: 'tool', name: id, version: '1.0.0', status, description: id, provenance: { sourceType: 'test' } }; }
function registryFor(ids = ['tool.echo']) { const registry = new CapabilityRegistry(); for (const id of ids) registry.register(manifest(id), async (input) => input); return registry; }
function plan({ status = 'ready', reasons = [], capabilities = ['tool.echo'], createdAt = NOW.toISOString() } = {}) { const tasks = [{ id: 'task-1', title: 'Execute tool', description: '', dependsOn: [], agent: null, capabilities, priority: 0, input: null }]; return { schemaVersion: '0.1.0', type: 'agent-plan', planId: 'plan-test-001', createdAt, goal: 'run tool', graph: { taskCount: 1, order: ['task-1'], tasks }, requiredCapabilities: capabilities, executionDecision: { status, reasons } }; }
function admission(overrides = {}) { const registry = overrides.registry ?? registryFor(); const cancellation = new ExecutionCancellationRegistry(); const engine = overrides.executionEngine ?? new ExecutionEngine({ registry, cancellation, clock: () => new Date(NOW) }); const graph = overrides.taskGraphExecutor ?? new TaskGraphExecutor({ executeTask: async () => ({ status: 'succeeded' }), cancellation, clock: () => new Date(NOW) }); return new AgentExecutionAdmission({ registry, taskGraphExecutor: graph, executionEngine: engine, clock: () => new Date(NOW), idFactory: () => 'agent-exec-test', ...overrides }); }

test('admits a ready plan after capability revalidation', () => { const result = admission().admit(plan()); assert.equal(result.status, 'ready'); assert.deepEqual(result.reasons, []); });
test('blocks a plan when a capability disappears after planning', () => { const result = admission({ registry: registryFor([]) }).admit(plan()); assert.equal(result.status, 'blocked'); assert.equal(result.reasons[0].code, 'CAPABILITY_MISSING'); });
test('blocks a plan when governance changes before execution', () => { const governance = { authorize: () => ({ allowed: false, reason: 'Runtime policy changed' }) }; const result = admission({ governance }).admit(plan()); assert.equal(result.status, 'blocked'); assert.equal(result.reasons[0].code, 'GOVERNANCE_DENIED'); });
test('rejects stale plans deterministically', () => { const result = admission({ maxPlanAgeMs: 1000, clock: () => new Date('2026-09-17T12:00:02.000Z') }).admit(plan()); assert.equal(result.status, 'invalid'); assert.equal(result.reasons[0].code, 'PLAN_STALE'); });
test('rejects malformed plans before execution', () => { const result = admission().admit({ schemaVersion: '0.1.0', type: 'agent-plan', planId: 'x' }); assert.equal(result.status, 'invalid'); assert.ok(result.reasons.some((reason) => reason.code === 'PLAN_GOAL_INVALID')); assert.ok(result.reasons.some((reason) => reason.code === 'PLAN_GRAPH_INVALID')); });
test('executes an admitted plan through the task graph and execution engine', async () => { const registry = registryFor(); const cancellation = new ExecutionCancellationRegistry(); const engine = new ExecutionEngine({ registry, cancellation, clock: () => new Date(NOW) }); const graph = new TaskGraphExecutor({ executeTask: async () => ({ status: 'failed' }), cancellation, clock: () => new Date(NOW) }); const runtime = new AgentExecutionAdmission({ registry, taskGraphExecutor: graph, executionEngine: engine, clock: () => new Date(NOW), idFactory: () => 'agent-exec-test' }); const result = await runtime.execute(plan(), { value: 7 }, { correlationId: 'corr-1' }); assert.equal(result.status, 'succeeded'); assert.equal(result.executionId, 'agent-exec-test'); assert.equal(result.correlationId, 'corr-1'); assert.deepEqual(result.result.output, { value: 7 }); assert.ok(Object.isFrozen(result.envelope)); });
test('propagates task-graph cancellation into capability execution', async () => { const registry = new CapabilityRegistry(); registry.register(manifest('tool.wait'), async (_input, { signal }) => new Promise((resolve, reject) => { const abort = () => reject(signal.reason ?? Object.assign(new Error('cancelled'), { code: 'EXECUTION_CANCELLED' })); signal.addEventListener('abort', abort, { once: true }); })); const cancellation = new ExecutionCancellationRegistry(); const engine = new ExecutionEngine({ registry, cancellation, clock: () => new Date(NOW) }); const graph = new TaskGraphExecutor({ executeTask: async () => ({ status: 'failed' }), cancellation, clock: () => new Date(NOW) }); const runtime = new AgentExecutionAdmission({ registry, taskGraphExecutor: graph, executionEngine: engine, clock: () => new Date(NOW), idFactory: () => 'agent-exec-cancel' }); const execution = runtime.execute(plan({ capabilities: ['tool.wait'] })); await new Promise((resolve) => setImmediate(resolve)); assert.equal(graph.cancel('agent-exec-cancel', 'operator cancelled'), true); const result = await execution; assert.equal(result.status, 'cancelled'); assert.equal(result.result.error.code, 'EXECUTION_CANCELLED'); });
test('surfaces capability execution failures', async () => { const registry = new CapabilityRegistry(); registry.register(manifest('tool.fail'), async () => { throw Object.assign(new Error('boom'), { code: 'TOOL_FAILED' }); }); const cancellation = new ExecutionCancellationRegistry(); const engine = new ExecutionEngine({ registry, cancellation, clock: () => new Date(NOW) }); const graph = new TaskGraphExecutor({ executeTask: async () => ({ status: 'failed' }), cancellation, clock: () => new Date(NOW) }); const runtime = new AgentExecutionAdmission({ registry, taskGraphExecutor: graph, executionEngine: engine, clock: () => new Date(NOW), idFactory: () => 'agent-exec-fail' }); const result = await runtime.execute(plan({ capabilities: ['tool.fail'] })); assert.equal(result.status, 'failed'); assert.equal(result.result.results[0].error.code, 'TOOL_FAILED'); });
test('produces a stable plan fingerprint', () => { const value = fingerprintAgentPlan(plan()); assert.match(value, /^fnv1a-[0-9a-f]{8}$/); assert.equal(value, fingerprintAgentPlan(plan())); });

test('revalidates executable capabilities even when the summary omits them', async () => {
  const value = plan({ capabilities: ['tool.missing'] });
  value.requiredCapabilities = [];
  let dispatched = false;
  const runtime = admission({ taskGraphExecutor: { execute: async () => { dispatched = true; } } });
  const result = await runtime.execute(value);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasons[0].capabilityId, 'tool.missing');
  assert.equal(dispatched, false);
});

test('empty explicit capability lists use the same agent fallback at admission and execution', () => {
  const value = plan({ capabilities: [] });
  value.graph.tasks[0].agent = 'tool.missing';
  assert.equal(admission().admit(value).status, 'blocked');
});

test('rejects missing, invalid and future timestamps whenever age validation is configured', () => {
  for (const createdAt of [null, undefined, '', 'not-a-date', '2026-09-17T12:00:01Z']) {
    const value = plan();
    value.createdAt = createdAt;
    assert.equal(admission({ maxPlanAgeMs: 1000 }).admit(value).status, 'invalid');
  }
  assert.equal(admission({ maxPlanAgeMs: 0 }).admit(plan()).status, 'ready');
});

test('rejects malformed graphs and capability declarations before dispatch', async () => {
  const mutations = [
    (value) => { value.graph.order = ['unknown']; },
    (value) => { value.graph.tasks[0].dependsOn = ['task-1']; },
    (value) => { value.graph.tasks[0].capabilities = [null]; },
    (value) => { value.graph.tasks[0].capabilities = 'tool.echo'; },
    (value) => { value.graph.tasks[0].capabilities = []; },
    (value) => { value.requiredCapabilities = [null]; },
    (value) => { value.graph.tasks[0] = null; }
  ];
  for (const mutate of mutations) {
    let dispatched = false;
    const value = plan(); mutate(value);
    const runtime = admission({ taskGraphExecutor: { execute: async () => { dispatched = true; } } });
    assert.equal((await runtime.execute(value)).status, 'invalid');
    assert.equal(dispatched, false);
  }
});

test('governance must explicitly allow every task and cannot spoof decision identity', () => {
  for (const response of [undefined, null, {}, { allowed: 'yes' }, Promise.resolve({ allowed: true })]) {
    const result = admission({ governance: { authorize: () => response } }).admit(plan());
    assert.equal(result.status, 'blocked');
    assert.equal(result.reasons[0].capabilityId, 'tool.echo');
  }
  const result = admission({ governance: { authorize: () => ({ allowed: false, taskId: 'spoof', operationId: 'spoof' }) } }).admit(plan());
  assert.equal(result.reasons[0].taskId, 'task-1');
  assert.equal(result.reasons[0].capabilityId, 'tool.echo');
  assert.equal(admission({ governance: { authorize: () => { throw new Error('policy offline'); } } }).admit(plan()).status, 'blocked');
});

test('a caller mutation from an admission event cannot change the executed plan', async () => {
  const value = plan();
  const runtime = admission({ events: { emit(event) {
    if (event.type === 'agent.execution.admitted') value.graph.tasks[0].capabilities = ['tool.missing'];
  } } });
  const result = await runtime.execute(value, { value: 9 });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.result.output, { value: 9 });
});
