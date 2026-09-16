import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry, EventBus, AgentRuntime, MissionEngine, WorkflowEngine, ExecutionEngine, ExecutionPlanExecutor, RuntimePlanningBridge, DelegationEngine, HandoffProtocol, TeamRuntime, TeamBuilder, CapabilityPlanner, VerificationEngine } from '../src/index.js';

const base = (id, kind, extra = {}) => ({ schemaVersion:'0.1.0', id, kind, name:id, version:'0.1.0', status:'stable', description:id, provenance:{sourceType:'native'}, ...extra });

function setup({ planned = false } = {}) {
  const registry = new CapabilityRegistry();
  const events = new EventBus();
  const execution = new ExecutionEngine({ registry, events, verifier: new VerificationEngine() });
  let planning = null;
  let planExecutor = null;
  let workflow;
  if (planned) {
    planExecutor = new ExecutionPlanExecutor({ executionEngine: execution, events });
    planning = new RuntimePlanningBridge({ registry, planExecutor });
    workflow = new WorkflowEngine({ registry, executionEngine: execution, events, planBuilder: planning, planExecutor });
  } else {
    workflow = new WorkflowEngine({ registry, executionEngine: execution, events });
  }
  const mission = new MissionEngine({ workflowEngine: workflow, events });
  const planner = new CapabilityPlanner({ registry });
  const agents = new AgentRuntime({ registry, planner, missionEngine: mission, events });
  const handoff = new HandoffProtocol();
  const delegation = new DelegationEngine({ agentRuntime: agents, handoffProtocol: handoff, events });
  const team = new TeamRuntime({ registry, agentRuntime: agents, delegationEngine: delegation, events });
  return { registry, events, execution, mission, agents, planner, delegation, team, planning, planExecutor };
}

test('team runtime delegates members and preserves shared state', async () => {
  const { registry, team, events } = setup();
  registry.register({...base('mission/a','mission'), workflow:'workflow/a'}, async () => null);
  registry.register({...base('workflow/a','workflow'), steps:[{capability:'tool/a'}]});
  registry.register({...base('tool/a','tool')}, async (input) => ({ count: (input.count ?? 0) + 1 }));
  registry.register({...base('agent/a','agent'), role:'researcher', execution:{mission:'mission/a'}}, async () => null);
  const result = await team.execute({...base('team/test','team'), task:'research', members:[{agent:'agent/a',task:'research'}]}, {count:1});
  assert.equal(result.status, 'succeeded');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].result.output.count, 2);
  assert.equal(events.history({type:'team.completed'}).length, 1);
  assert.equal(events.history({type:'delegation.completed'}).length, 1);
});

test('mission routes explicitly to a team and preserves mission lifecycle', async () => {
  const { registry, mission, team } = setup();
  registry.register({...base('workflow/a','workflow'), steps:[]});
  registry.register({...base('agent/a','agent'), execution:{mission:'mission/a'}}, async () => null);
  registry.register({...base('mission/a','mission'), workflow:'workflow/a'});
  registry.register({...base('team/a','team'), task:'inspect', members:['agent/a']});
  const result = await mission.execute({...base('mission/team','mission'), team:'team/a'}, {value:1});
  assert.equal(result.status, 'succeeded');
  assert.equal(result.teamId, 'team/a');
  assert.equal(result.results.length, 1);
});

test('team members execute planned workflows when their missions use planning-enabled workflow engines', async () => {
  const { registry, team, events } = setup({ planned: true });
  registry.register({...base('tool/a','tool')}, async (input, context) => ({ value:(input.value ?? 0) + 1, requestId:context.requestId }));
  registry.register({...base('workflow/a','workflow'), steps:[{capability:'tool/a'}]});
  registry.register({...base('mission/a','mission'), workflow:'workflow/a'});
  registry.register({...base('agent/research','agent'), role:'researcher', execution:{mission:'mission/a'}}, async () => null);
  const result = await team.execute({...base('team/research','team'), task:'research', members:['agent/research']}, {value:1}, {requestId:'team-plan'});
  assert.equal(result.status, 'succeeded');
  assert.equal(result.results[0].result.output.value, 2);
  assert.equal(result.results[0].result.output.requestId, 'team-plan');
  assert.equal(events.history({type:'plan.completed'}).length, 1);
});

test('delegation limit produces a structured failure', async () => {
  const { registry, delegation } = setup();
  registry.register({...base('agent/a','agent'), execution:{mission:'mission/a'}}, async () => null);
  const result = await delegation.delegate({toAgent:'agent/a', task:'x', context:{delegationCount:8}});
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'DELEGATION_LIMIT');
});

test('handoff rejects oversized payloads', () => {
  const handoff = new HandoffProtocol({ maxPayloadBytes: 100 });
  assert.throws(() => handoff.create({fromAgent:'a',toAgent:'b',task:'x',input:{large:'x'.repeat(200)}}), /exceeds/);
});

test('team builder creates a deterministic team from agent candidates', () => {
  const { registry, planner } = setup();
  registry.register({...base('agent/research','agent'), role:'researcher', description:'research repository and investigate issues'}, async () => null);
  registry.register({...base('agent/design','agent'), role:'designer', description:'design interfaces'}, async () => null);
  const builder = new TeamBuilder({ registry, planner });
  const result = builder.build('research repository', { maxMembers:2 });
  assert.equal(result.kind, 'team');
  assert.deepEqual(result.members.map((m) => m.agent), ['agent/research']);
});
