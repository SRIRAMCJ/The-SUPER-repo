import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, ExecutionStateStore, EvolutionEngine, PolicyEngine } from '../src/index.js';

function evaluation(results) {
  return { schemaVersion: '0.1.0', type: 'evaluation-run', evaluationId: 'eval-1', suiteId: 'suite-1', status: results.every((item) => item.status === 'passed') ? 'succeeded' : 'failed', results };
}

function failedCase(caseId, capabilityId, assertionNames = ['output']) {
  return { caseId, capabilityId, status: 'failed', assertions: assertionNames.map((name) => ({ name, ok: false, expected: true, actual: false })) };
}

function passedCase(caseId, capabilityId) {
  return { caseId, capabilityId, status: 'passed', assertions: [{ name: 'status', ok: true, expected: 'succeeded', actual: 'succeeded' }] };
}

test('derives deterministic failure-pattern signals from evaluation results', async () => {
  const engine = new EvolutionEngine();
  const proposal = await engine.propose(evaluation([
    failedCase('b', 'cap.alpha', ['output']),
    failedCase('a', 'cap.alpha', ['output']),
    failedCase('c', 'cap.beta', ['status']),
    passedCase('d', 'cap.gamma')
  ]), { source: 'evaluation', risk: 'low' });
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.revision, 1);
  assert.equal(proposal.signals.length, 2);
  assert.deepEqual(proposal.signals[0].caseIds, ['a', 'b']);
  assert.equal(proposal.signals[0].occurrenceCount, 2);
  assert.equal(proposal.signals[0].action, 'investigate-and-improve');
});

test('records no-change when evaluation has no failures', async () => {
  const engine = new EvolutionEngine();
  const proposal = await engine.propose(evaluation([passedCase('a', 'cap.alpha')]));
  assert.equal(proposal.status, 'no_change');
  assert.equal(proposal.signals.length, 0);
});

test('accepts a proposal only after policy authorization and preserves history', async () => {
  const events = new EventBus();
  const engine = new EvolutionEngine({ eventBus: events });
  const proposal = await engine.propose(evaluation([failedCase('a', 'cap.alpha')]));
  const result = await engine.accept(proposal.proposalId, { approval: true });
  assert.equal(result.status, 'accepted');
  assert.equal(result.revision, 2);
  const current = await engine.get(proposal.proposalId);
  assert.equal(current.status, 'accepted');
  assert.equal(current.history.length, 2);
  assert.equal(events.history({ type: 'evolution.proposal.accepted' }).length, 1);
});

test('rejects critical evolution without explicit approval', async () => {
  const engine = new EvolutionEngine({ policyEngine: new PolicyEngine() });
  const proposal = await engine.propose(evaluation([failedCase('a', 'cap.alpha')]), { risk: 'critical' });
  const result = await engine.accept(proposal.proposalId);
  assert.equal(result.status, 'rejected');
  assert.match(result.reason, /explicit approval/);
  const current = await engine.get(proposal.proposalId);
  assert.equal(current.status, 'proposed');
});

test('supports explicit rejection and auditable rollback', async () => {
  const engine = new EvolutionEngine();
  const proposal = await engine.propose(evaluation([failedCase('a', 'cap.alpha')]));
  const rejected = await engine.reject(proposal.proposalId, 'Requires human review');
  assert.equal(rejected.status, 'rejected');
  const rollback = await engine.rollback(proposal.proposalId, 1, 1);
  assert.equal(rollback.status, 'rolled_back');
  assert.equal(rollback.targetRevision, 1);
  assert.equal(rollback.restoredStatus, 'proposed');
  const current = await engine.get(proposal.proposalId);
  assert.equal(current.revision, 3);
  assert.equal(current.status, 'proposed');
  assert.equal(current.history.length, 3);
  assert.equal(current.history[2].action, 'rollback');
});

test('enforces optimistic concurrency for evolution decisions', async () => {
  const engine = new EvolutionEngine();
  const proposal = await engine.propose(evaluation([failedCase('a', 'cap.alpha')]));
  await engine.accept(proposal.proposalId, { approval: true }, 0);
  await assert.rejects(() => engine.reject(proposal.proposalId, 'stale', 0), (error) => error.code === 'EXECUTION_STATE_CONFLICT');
});

test('supports a shared persistent state store', async () => {
  const store = new ExecutionStateStore();
  const first = new EvolutionEngine({ store });
  const proposal = await first.propose(evaluation([failedCase('a', 'cap.alpha')]));
  const second = new EvolutionEngine({ store });
  const restored = await second.get(proposal.proposalId);
  assert.deepEqual(restored.signals, proposal.signals);
});

test('returns structured failures for missing proposals and invalid evaluation data', async () => {
  const engine = new EvolutionEngine();
  const missing = await engine.accept('missing', { approval: true });
  assert.equal(missing.error.code, 'EVOLUTION_PROPOSAL_NOT_FOUND');
  await assert.rejects(() => engine.propose({ type: 'evaluation-run', suiteId: 'suite', results: [{ caseId: 'a', capabilityId: 'cap', status: 'unknown' }] }), /passed or failed status/);
});
