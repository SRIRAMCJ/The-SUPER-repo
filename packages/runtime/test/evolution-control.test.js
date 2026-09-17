import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptationEngine, EventBus, ExecutionAudit, ExecutionStateStore, EvolutionControlPlane, PolicyEngine, isTerminalExecutionStatus } from '../src/index.js';

function proposal(status = 'accepted') {
  return { proposalId: 'proposal-1', suiteId: 'suite-1', status, revision: 2, metadata: { risk: 'low' } };
}

function adapterFor(state) {
  return {
    async apply({ context }) {
      const stage = context.rolloutStage;
      state.values.push(stage.id);
      return { output: { stage: stage.id }, rollback: async () => { state.values.pop(); } };
    },
    async rollback() { state.values.pop(); }
  };
}

test('runs deterministic staged rollout and records control/audit lifecycle', async () => {
  const state = { values: [] };
  const events = new EventBus();
  const audit = new ExecutionAudit({ events });
  const control = new EvolutionControlPlane({ adaptationEngine: new AdaptationEngine({ adapter: adapterFor(state), eventBus: events }), eventBus: events });
  const result = await control.run(proposal(), { healthCheck: async ({ stage }) => ({ healthy: true, stage: stage.id }) });
  assert.equal(result.status, 'completed');
  assert.equal(result.stageCount, 3);
  assert.deepEqual(state.values, ['canary', 'progressive', 'full']);
  const record = audit.get(result.controlId);
  assert.equal(record.kind, 'evolution-control');
  assert.equal(record.status, 'succeeded');
  assert.deepEqual(record.events.map((event) => event.type), [
    'evolution.control.started',
    'evolution.control.stage.started',
    'evolution.control.stage.healthy',
    'evolution.control.stage.started',
    'evolution.control.stage.healthy',
    'evolution.control.stage.started',
    'evolution.control.stage.healthy',
    'evolution.control.completed'
  ]);
  audit.close();
});

test('halts on unhealthy stage and rolls back all prior adaptations', async () => {
  const state = { values: [] };
  const control = new EvolutionControlPlane({ adaptationEngine: new AdaptationEngine({ adapter: adapterFor(state) }) });
  const result = await control.run(proposal(), { healthCheck: async ({ stage }) => ({ healthy: stage.id === 'canary' }) });
  assert.equal(result.status, 'rolled_back');
  assert.equal(state.values.length, 0);
  assert.equal(result.error.code, 'ROLLOUT_UNHEALTHY');
});

test('records a rolled-back control as a terminal audit outcome', async () => {
  const state = { values: [] };
  const events = new EventBus();
  const audit = new ExecutionAudit({ events });
  const control = new EvolutionControlPlane({ adaptationEngine: new AdaptationEngine({ adapter: adapterFor(state), eventBus: events }), eventBus: events });
  const result = await control.run(proposal(), { stages: [{ id: 'full', fraction: 1 }], healthCheck: async () => ({ healthy: false, code: 'BAD_HEALTH', reason: 'regression' }) });
  assert.equal(result.status, 'rolled_back');
  assert.equal(audit.get(result.controlId).status, 'rolled_back');
  assert.equal(isTerminalExecutionStatus('rolled_back'), true);
  audit.close();
});

test('does not mutate when control policy denies', async () => {
  let applied = false;
  const adaptationEngine = { apply: async () => { applied = true; return { status: 'applied' }; }, rollback: async () => ({ status: 'rolled_back' }) };
  const control = new EvolutionControlPlane({
    adaptationEngine,
    policyEngine: new PolicyEngine({ policies: [() => ({ allowed: false, reason: 'blocked' })] })
  });
  const result = await control.run(proposal(), { healthCheck: async () => ({ healthy: true }) });
  assert.equal(result.error.code, 'EVOLUTION_CONTROL_POLICY_DENIED');
  assert.equal(applied, false);
});

test('requires accepted proposals and valid terminal rollout stage', async () => {
  const control = new EvolutionControlPlane({ adaptationEngine: { apply: async () => ({ status: 'applied' }), rollback: async () => ({ status: 'rolled_back' }) } });
  await assert.rejects(() => control.run(proposal('proposed'), { healthCheck: async () => ({ healthy: true }) }), /accepted proposal/);
  await assert.rejects(() => control.run(proposal(), { stages: [{ id: 'canary', fraction: 0.1 }], healthCheck: async () => ({ healthy: true }) }), /final rollout stage/);
});

test('persists control state for later inspection', async () => {
  const store = new ExecutionStateStore();
  const control = new EvolutionControlPlane({ adaptationEngine: { apply: async () => ({ status: 'applied', adaptationId: 'adapt-1', revision: 2 }), rollback: async () => ({ status: 'rolled_back' }) }, store });
  const result = await control.run(proposal(), { stages: [{ id: 'full', fraction: 1 }], healthCheck: async () => ({ healthy: true }) });
  const restored = await control.get(result.controlId);
  assert.equal(restored.status, 'completed');
  assert.equal(restored.adaptations[0].adaptationId, 'adapt-1');
});
