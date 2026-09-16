import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, SharedContext, TeamExecutionCoordinator } from '../src/index.js';

const team = {
  id: 'team/research',
  kind: 'team',
  name: 'Research Team',
  task: 'analyze repository',
  members: [
    { agent: 'agent/architecture', task: 'inspect architecture' },
    { agent: 'agent/security', task: 'inspect security' },
    { agent: 'agent/testing', task: 'inspect tests' }
  ]
};

test('shared context enforces optimistic versioning', () => {
  const context = new SharedContext({ request: 'hello' });
  const first = context.snapshot();
  context.commit({ answer: 42 }, { expectedVersion: first.version, actor: 'agent/a' });
  assert.equal(context.get('answer'), 42);
  assert.throws(() => context.commit({ stale: true }, { expectedVersion: first.version }), (error) => error.code === 'CONTEXT_VERSION_CONFLICT');
});

test('parallel coordinator runs members concurrently and reconciles results', async () => {
  const events = new EventBus();
  const started = [];
  events.on('team.member.started', (event) => started.push(event.data.agentId));
  const delegationEngine = {
    async delegate({ toAgent }) {
      await new Promise((resolve) => setTimeout(resolve, toAgent === 'agent/architecture' ? 25 : 5));
      return { executionId: `exec-${toAgent}`, status: 'succeeded', result: { agent: toAgent, ok: true } };
    }
  };
  const coordinator = new TeamExecutionCoordinator({ delegationEngine, events });
  const shared = new SharedContext({ request: 'repo' });
  const result = await coordinator.execute({ team, members: team.members, input: {}, context: { executionId: 'team-exec' }, sharedContext: shared, strategy: 'parallel', maxConcurrency: 2 });
  assert.equal(result.strategy, 'parallel');
  assert.equal(result.results.length, 3);
  assert.ok(result.results.every((item) => item.status === 'succeeded'));
  assert.deepEqual(started.sort(), ['agent/architecture', 'agent/security', 'agent/testing'].sort());
  assert.equal(Object.keys(result.context.values).length, 4);
});

test('parallel coordinator honors bounded concurrency and fail-fast scheduling', async () => {
  let active = 0;
  let maxActive = 0;
  const delegationEngine = {
    async delegate({ toAgent }) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      if (toAgent === 'agent/fail') return { status: 'failed', error: { code: 'AGENT_FAILED', message: 'failed', retryable: false } };
      return { status: 'succeeded', result: { ok: true } };
    }
  };
  const coordinator = new TeamExecutionCoordinator({ delegationEngine });
  const members = ['agent/a', 'agent/fail', 'agent/c', 'agent/d'];
  const result = await coordinator.execute({ team: { ...team, members }, members, input: {}, context: { executionId: 'team-exec' }, sharedContext: new SharedContext(), strategy: 'parallel', maxConcurrency: 2, failFast: true });
  assert.ok(maxActive <= 2);
  assert.ok(result.results.some((item) => item.status === 'failed'));
});
