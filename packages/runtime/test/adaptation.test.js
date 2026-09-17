import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptationEngine, EventBus, ExecutionAudit, ExecutionStateStore, PolicyEngine, VerificationEngine } from '../src/index.js';

function proposal(status = 'accepted', metadata = {}) {
  return { schemaVersion: '0.1.0', type: 'evolution-proposal', proposalId: 'proposal-1', suiteId: 'suite-1', status, revision: 2, signals: [{ kind: 'failure-pattern', capabilityId: 'cap.alpha', action: 'investigate-and-improve' }], metadata };
}

function adapterFor(state) {
  return {
    async apply() {
      state.value = 'adapted';
      return { output: { value: state.value }, rollback: async () => { state.value = 'original'; } };
    },
    async rollback() { state.value = 'original'; }
  };
}

test('applies accepted evolution through adapter, verification, policy and audit events', async () => {
  const state = { value: 'original' };
  const events = new EventBus();
  const audit = new ExecutionAudit({ events });
  const engine = new AdaptationEngine({ adapter: adapterFor(state), eventBus: events });
  const result = await engine.apply(proposal(), { approval: true });
  assert.equal(result.status, 'applied');
  assert.equal(state.value, 'adapted');
  assert.equal(result.verification.verified, true);
  const record = audit.get(result.adaptationId);
  assert.equal(record.status, 'succeeded');
  assert.equal(record.kind, 'adaptation');
  assert.deepEqual(record.events.map((event) => event.type), ['adaptation.started', 'adaptation.completed']);
  audit.close();
});

test('rejects adaptation before mutation when policy denies', async () => {
  let applied = false;
  const engine = new AdaptationEngine({
    adapter: { apply: async () => { applied = true; return { rollback: async () => {} }; }, rollback: async () => {} },
    policyEngine: new PolicyEngine({ policies: [() => ({ allowed: false, reason: 'blocked' })] })
  });
  const result = await engine.apply(proposal());
  assert.equal(result.error.code, 'ADAPTATION_POLICY_DENIED');
  assert.equal(applied, false);
});

test('does not adapt unaccepted proposals', async () => {
  let applied = false;
  const engine = new AdaptationEngine({ adapter: { apply: async () => { applied = true; return { rollback: async () => {} }; }, rollback: async () => {} } });
  const result = await engine.apply(proposal('proposed'));
  assert.equal(result.error.code, 'ADAPTATION_PROPOSAL_NOT_ACCEPTED');
  assert.equal(applied, false);
});

test('rolls back a mutation when verification fails', async () => {
  const state = { value: 'original' };
  const events = new EventBus();
  const engine = new AdaptationEngine({
    adapter: adapterFor(state),
    eventBus: events,
    verificationEngine: new VerificationEngine({ checks: [() => ({ ok: false, code: 'BAD_ADAPTATION', message: 'verification failed' })] })
  });
  const result = await engine.apply(proposal());
  assert.equal(result.status, 'rolled_back');
  assert.equal(state.value, 'original');
  const current = await engine.get(result.adaptationId);
  assert.equal(current.status, 'rolled_back');
  assert.equal(events.history({ type: 'adaptation.rolled_back' }).length, 1);
});

test('supports explicit rollback with optimistic concurrency', async () => {
  const state = { value: 'original' };
  const store = new ExecutionStateStore();
  const engine = new AdaptationEngine({ adapter: adapterFor(state), store });
  const result = await engine.apply(proposal());
  const current = await engine.get(result.adaptationId);
  const rollback = await engine.rollback(result.adaptationId, current.version);
  assert.equal(rollback.status, 'rolled_back');
  assert.equal(state.value, 'original');
  await assert.rejects(() => engine.rollback(result.adaptationId, current.version), (error) => error.code === 'EXECUTION_STATE_CONFLICT' || error.code === 'ADAPTATION_NOT_APPLIED');
});

test('preserves state-store persistence across engine instances', async () => {
  const state = { value: 'original' };
  const store = new ExecutionStateStore();
  const first = new AdaptationEngine({ adapter: adapterFor(state), store });
  const result = await first.apply(proposal());
  const second = new AdaptationEngine({ adapter: adapterFor(state), store });
  const restored = await second.get(result.adaptationId);
  assert.equal(restored.status, 'applied');
  assert.equal(restored.proposalId, 'proposal-1');
});

test('requires an adapter with reversible operations', () => {
  assert.throws(() => new AdaptationEngine(), /adapter with apply and rollback/);
});
