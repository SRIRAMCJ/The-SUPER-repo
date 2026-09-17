import test from 'node:test';
import assert from 'node:assert/strict';
import { DelegationEngine, ExecutionCancellationRegistry, HandoffProtocol, MultiAgentCoordinationKernel, SharedContext } from '../src/index.js';

const NOW = new Date('2026-09-17T12:30:00.000Z');

function setup({ delegate, initial = {} } = {}) {
  const events = { values: [], emit(event) { this.values.push(event); } };
  const delegation = delegate ? { delegate } : new DelegationEngine({ agentRuntime: { registry: { require(id) { return { manifest: { id } }; } }, execute: async (_agent, input) => ({ status: 'succeeded', output: input }) }, handoffProtocol: new HandoffProtocol(), events, clock: () => new Date(NOW) });
  const context = new SharedContext(initial, { clock: () => new Date(NOW) });
  const cancellation = new ExecutionCancellationRegistry();
  const kernel = new MultiAgentCoordinationKernel({ delegation, handoff: new HandoffProtocol(), sharedContext: context, events, cancellation, clock: () => new Date(NOW), idFactory: () => 'coord-001', maxConcurrency: 2 });
  return { kernel, context, cancellation, events };
}

test('coordinates independent participants in parallel and commits isolated results', async () => {
  const calls = [];
  const { kernel, context, events } = setup({ delegate: async ({ toAgent, task }) => { calls.push(toAgent); return { status: 'succeeded', result: { output: `${task}:${toAgent}` } }; } });
  const result = await kernel.execute({ teamId: 'team-alpha', task: 'research', members: [{ id: 'a', agent: 'agent.a' }, { id: 'b', agent: 'agent.b' }], strategy: 'parallel' });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls.sort(), ['agent.a', 'agent.b']);
  assert.equal(result.results.length, 2);
  assert.equal(context.snapshot().version, 2);
  assert.ok(events.values.some((event) => event.type === 'multi-agent.coordination.completed'));
});

test('enforces participant dependency order', async () => {
  const order = [];
  const { kernel } = setup({ delegate: async ({ toAgent }) => { order.push(toAgent); return { status: 'succeeded', result: { output: toAgent } }; } });
  const result = await kernel.execute({ teamId: 'team-deps', members: [{ id: 'first', agent: 'agent.first' }, { id: 'second', agent: 'agent.second', dependsOn: ['first'] }], strategy: 'parallel' });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(order, ['agent.first', 'agent.second']);
});

test('rejects cyclic participant dependencies before execution', async () => {
  let called = false;
  const { kernel } = setup({ delegate: async () => { called = true; return { status: 'succeeded' }; } });
  await assert.rejects(() => kernel.execute({ teamId: 'team-cycle', members: [{ id: 'a', agent: 'agent.a', dependsOn: ['b'] }, { id: 'b', agent: 'agent.b', dependsOn: ['a'] }] }), (error) => error.code === 'PARTICIPANT_DEPENDENCY_INVALID');
  assert.equal(called, false);
});

test('propagates cancellation to an active coordination session', async () => {
  const { kernel } = setup({ delegate: async () => new Promise((resolve) => setTimeout(() => resolve({ status: 'succeeded' }), 50)) });
  const execution = kernel.execute({ teamId: 'team-cancel', members: [{ id: 'a', agent: 'agent.a' }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(kernel.cancel('coord-001', 'operator cancelled'), true);
  const result = await execution;
  assert.equal(result.status, 'cancelled');
});

test('keeps session snapshots immutable from caller mutation', async () => {
  const { kernel } = setup();
  const result = await kernel.execute({ teamId: 'team-snapshot', members: ['agent.a'] });
  assert.equal(result.status, 'succeeded');
  const snapshot = kernel.getSession(result.executionId);
  snapshot.participants[0].status = 'tampered';
  assert.equal(kernel.getSession(result.executionId).participants[0].status, 'succeeded');
  assert.ok(Object.isFrozen(result));
});
