import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, MemoryStore, MissionEngine } from '../src/index.js';

test('mission can route execution to an injected team runtime', async () => {
  const events = new EventBus();
  const memory = new MemoryStore();
  const calls = [];
  const teamRuntime = {
    async execute(team, input, context) {
      calls.push({ team, input, context });
      return { executionId: 'team-exec-1', status: 'succeeded', results: [{ status: 'succeeded' }], sharedContext: { version: 1, values: { done: true } } };
    }
  };
  const registry = {
    require(id) {
      assert.equal(id, 'team/review');
      return { manifest: { id, kind: 'team', members: ['agent/a'] } };
    }
  };
  const mission = new MissionEngine({ workflowEngine: { registry }, teamRuntime, events, memory });
  const result = await mission.execute({ id: 'mission/review', kind: 'mission', team: 'team/review' }, { repositoryPath: '.' }, { requestId: 'r1' });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.executionId, 'team-exec-1');
  assert.equal(calls[0].team.id, 'team/review');
  assert.equal(calls[0].context.requestId, 'r1');
  assert.equal(events.history({ type: 'mission.completed' }).length, 1);
  assert.equal(memory.entries().length, 1);
});

test('team mission fails structurally when team runtime is not configured', async () => {
  const events = new EventBus();
  const memory = new MemoryStore();
  const mission = new MissionEngine({ workflowEngine: { registry: { require() { return { manifest: { kind: 'team' } }; } } }, events, memory });
  const result = await mission.execute({ id: 'mission/team', kind: 'mission', team: 'team/missing' }, {});

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'MISSION_WORKFLOW_MISSING');
  assert.equal(events.history({ type: 'mission.failed' }).length, 1);
  assert.equal(memory.entries().length, 1);
});
