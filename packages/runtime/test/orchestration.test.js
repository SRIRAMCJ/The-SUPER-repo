import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry, EventBus, ExecutionEngine, MissionEngine, PolicyEngine, WorkflowEngine } from '../src/index.js';

const base = (id, kind) => ({ schemaVersion:'0.1.0', id, kind, name:id, version:'0.1.0', status:'stable', description:id, provenance:{sourceType:'native'} });

test('workflow composes registered capabilities in order', async () => {
  const registry = new CapabilityRegistry();
  registry.register({...base('test/one','tool')}, async (input) => ({ value: input.value + 1 }));
  registry.register({...base('test/two','tool')}, async (input) => ({ value: input.value * 2 }));
  const engine = new WorkflowEngine({ registry, executionEngine:new ExecutionEngine({registry}) });
  const result = await engine.execute({...base('test/flow','workflow'), steps:[{id:'one',capability:'test/one'},{id:'two',capability:'test/two'}]}, {value:2});
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output, {value:6});
});

test('policy blocks critical capabilities without approval', () => {
  const policy = new PolicyEngine();
  const result = policy.authorize({...base('test/danger','tool'), risk:'critical'}, {});
  assert.equal(result.allowed, false);
});

test('mission resolves and executes its workflow', async () => {
  const registry = new CapabilityRegistry();
  const events = new EventBus();
  registry.register({...base('test/task','tool')}, async () => ({ok:true}));
  registry.register({...base('test/workflow','workflow'), steps:[{capability:'test/task'}]}, async () => null);
  const execution = new ExecutionEngine({registry, events});
  const workflow = new WorkflowEngine({registry, executionEngine:execution, events});
  const mission = new MissionEngine({workflowEngine:workflow, events});
  const result = await mission.execute({...base('test/mission','mission'), workflow:'test/workflow'});
  assert.equal(result.status, 'succeeded');
  assert.equal(result.output.ok, true);
  assert.equal(events.history({type:'mission.completed'}).length, 1);
});
