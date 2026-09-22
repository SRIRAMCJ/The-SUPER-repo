import test from 'node:test';
import assert from 'node:assert/strict';
import { VerticalMissionEngine } from '../src/vertical-mission.js';

test('recover returns null for unknown durable mission', async () => {
  const store = { get: async () => null };
  const engine = new VerticalMissionEngine({
    planner: { plan: () => ({}) }, admission: { admit: () => ({ status: 'ready' }) },
    orchestrator: { execute: async () => ({ status: 'succeeded' }) }, missionStore: store
  });
  assert.equal(await engine.recover('missing'), null);
});

test('recover identifies non-terminal durable mission as resumable', async () => {
  const record = { missionId: 'm1', status: 'executing', goal: 'test', plan: { planId: 'p1' } };
  const engine = new VerticalMissionEngine({
    planner: { plan: () => ({}) }, admission: { admit: () => ({ status: 'ready' }) },
    orchestrator: { execute: async () => ({ status: 'succeeded' }) },
    missionStore: { get: async () => record }
  });
  const recovered = await engine.recover('m1');
  assert.equal(recovered.recovery.resumable, true);
  assert.equal(recovered.status, 'executing');
});

test('recover preserves terminal mission without marking it resumable', async () => {
  const engine = new VerticalMissionEngine({
    planner: { plan: () => ({}) }, admission: { admit: () => ({ status: 'ready' }) },
    orchestrator: { execute: async () => ({ status: 'succeeded' }) },
    missionStore: { get: async () => ({ missionId: 'm1', status: 'succeeded' }) }
  });
  const recovered = await engine.recover('m1');
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.recovery, undefined);
});
