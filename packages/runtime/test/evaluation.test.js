import test from 'node:test';
import assert from 'node:assert/strict';
import { EvaluationEngine } from '../src/index.js';

test('runs evaluation cases deterministically and aggregates assertions', async () => {
  const calls = [];
  const evaluator = new EvaluationEngine({
    executionEngine: { execute: async (capabilityId, input, context) => {
      calls.push(context.evaluationCaseId);
      return { status: 'succeeded', output: `${capabilityId}:${input.value}`, verification: { verified: true } };
    } },
    clock: () => new Date('2026-01-01T00:00:00Z')
  });
  const result = await evaluator.run({
    id: 'suite.basic',
    cases: [
      { id: 'case.b', capabilityId: 'cap.echo', input: { value: 'b' }, expected: { status: 'succeeded', output: 'cap.echo:b', verificationVerified: true } },
      { id: 'case.a', capabilityId: 'cap.echo', input: { value: 'a' }, expected: { status: 'succeeded', outputContains: 'cap.echo:a' } }
    ]
  }, { source: 'test' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.caseCount, 2);
  assert.equal(result.passed, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(calls, ['case.a', 'case.b']);
});

test('returns structured failed assertions without hiding execution failures', async () => {
  const evaluator = new EvaluationEngine({ executionEngine: { execute: async () => ({ status: 'failed', error: { code: 'CAPABILITY_FAILED' } }) } });
  const result = await evaluator.run({ id: 'suite.failure', cases: [{ id: 'case.1', capabilityId: 'cap.x', expected: { status: 'succeeded', errorCode: 'CAPABILITY_FAILED' } }] });
  assert.equal(result.status, 'failed');
  assert.equal(result.passed, 0);
  assert.equal(result.results[0].assertions[0].ok, false);
  assert.equal(result.results[0].assertions[1].ok, true);
  assert.equal(result.results[0].actual.error.code, 'CAPABILITY_FAILED');
});

test('rejects invalid evaluation suites', async () => {
  const evaluator = new EvaluationEngine({ executionEngine: { execute: async () => ({ status: 'succeeded' }) } });
  await assert.rejects(() => evaluator.run({ id: 'empty', cases: [] }), { message: 'Evaluation suite requires at least one case' });
  await assert.rejects(() => evaluator.run({ id: 'duplicate', cases: [{ id: 'x', capabilityId: 'a' }, { id: 'x', capabilityId: 'b' }] }), { message: 'Evaluation cases require unique ids' });
});
