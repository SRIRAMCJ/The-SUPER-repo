import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry, EventBus, MissionEngine, TeamRuntime } from '../src/index.js';

test('mission execution requires TeamRuntime when a team is declared', async () => {
  const registry = new CapabilityRegistry();
  registry.register({ schemaVersion:'0.1.0', id:'team/a', kind:'team', name:'Team A', version:'1.0.0', status:'stable', description:'team', provenance:{sourceType:'test'}, members:[{agent:'agent/a'}] });
  const events = new EventBus();
  const mission = new MissionEngine({ workflowEngine: { registry }, events });
  const result = await mission.execute({ schemaVersion:'0.1.0', id:'mission/a', kind:'mission', name:'Mission A', version:'1.0.0', status:'stable', description:'mission', provenance:{sourceType:'test'}, team:'team/a' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'TEAM_RUNTIME_UNAVAILABLE');
});

test('team runtime emits a structured failure for an empty team', async () => {
  const registry = new CapabilityRegistry();
  const teamRuntime = new TeamRuntime({ registry, agentRuntime:{}, delegationEngine:{} });
  const result = await teamRuntime.execute({ schemaVersion:'0.1.0', id:'team/empty', kind:'team', name:'Empty', version:'1.0.0', status:'stable', description:'empty', provenance:{sourceType:'test'}, members:[] });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'TEAM_EMPTY');
});
