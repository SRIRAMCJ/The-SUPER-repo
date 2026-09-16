import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime, CapabilityPlanner, CapabilityRegistry, EventBus } from '../src/index.js';

const base = (id, name, description, tags = []) => ({
  schemaVersion: '0.1.0', id, kind: 'agent', name, version: '0.1.0', status: 'alpha',
  description, provenance: { sourceType: 'native' }, role: description, capabilities: [], tags,
  execution: { mode: 'task', autonomy: 'bounded' }
});

test('capability planner ranks matching agents deterministically', () => {
  const registry = new CapabilityRegistry();
  registry.register(base('agent/repository-analyst', 'Repository Analyst', 'Analyze repository structure and engineering quality', ['repository', 'analysis']), async () => ({}));
  registry.register(base('agent/data-analyst', 'Data Analyst', 'Analyze datasets and statistical quality', ['data', 'analysis']), async () => ({}));
  const planner = new CapabilityPlanner({ registry, clock: () => new Date('2026-01-01T00:00:00.000Z') });

  const plan = planner.plan('analyze this repository for engineering quality');
  assert.equal(plan.type, 'capability-plan');
  assert.equal(plan.selection.capabilityId, 'agent/repository-analyst');
  assert.ok(plan.selection.score > 0.4);
  assert.equal(plan.createdAt, '2026-01-01T00:00:00.000Z');
});

test('agent runtime resolves mission and emits lifecycle', async () => {
  const registry = new CapabilityRegistry();
  const events = new EventBus();
  const mission = { schemaVersion: '0.1.0', id: 'mission/test', kind: 'mission', name: 'Test Mission', version: '0.1.0', status: 'alpha', description: 'Test mission', provenance: { sourceType: 'native' }, workflow: 'workflow/test' };
  const agent = { ...base('agent/test', 'Test Agent', 'Run a test task'), execution: { mode: 'task', autonomy: 'bounded', mission: mission.id } };
  registry.register(agent, async () => ({}));
  registry.register(mission);
  const workflow = { schemaVersion: '0.1.0', id: 'workflow/test', kind: 'workflow', name: 'Test Workflow', version: '0.1.0', status: 'alpha', description: 'Test workflow', provenance: { sourceType: 'native' }, steps: [] };
  registry.register(workflow);
  const missionEngine = { async execute(resolvedMission, input) { assert.equal(resolvedMission.id, mission.id); return { missionId: resolvedMission.id, status: 'succeeded', output: { echoed: input.value } }; } };
  const runtime = new AgentRuntime({ registry, missionEngine, events, clock: () => new Date('2026-01-01T00:00:00.000Z') });

  const result = await runtime.executeRequest('run the test agent', { value: 42 });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.output.echoed, 42);
  assert.equal(result.plan.selection.capabilityId, agent.id);
  assert.equal(events.history({ type: 'agent.started' }).length, 1);
  assert.equal(events.history({ type: 'agent.completed' }).length, 1);
});

test('agent runtime reports missing mission without throwing', async () => {
  const registry = new CapabilityRegistry();
  const agent = base('agent/no-mission', 'No Mission Agent', 'A test agent');
  registry.register(agent, async () => ({}));
  const runtime = new AgentRuntime({ registry, missionEngine: { execute: async () => ({ status: 'succeeded' }) } });
  const result = await runtime.execute(agent);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'AGENT_MISSION_MISSING');
});
