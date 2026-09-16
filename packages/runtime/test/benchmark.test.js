import test from 'node:test';
import assert from 'node:assert/strict';
import { BenchmarkEngine } from '../src/index.js';

test('runs benchmark suites deterministically and aggregates pass rate', async () => {
  const calls = [];
  const engine = new BenchmarkEngine({
    evaluationEngine: { run: async (suite, context) => {
      calls.push([suite.id, context.benchmarkSuiteId]);
      return { type: 'evaluation-run', suiteId: suite.id, caseCount: suite.cases.length, passed: suite.id === 'a' ? suite.cases.length : 0, failed: suite.id === 'a' ? 0 : suite.cases.length, status: suite.id === 'a' ? 'succeeded' : 'failed' };
    } },
    clock: () => new Date('2026-01-01T00:00:00Z')
  });
  const result = await engine.run({ id: 'benchmark.1', suites: [
    { id: 'b', cases: [{ id: 'b1' }] },
    { id: 'a', cases: [{ id: 'a1' }, { id: 'a2' }] }
  ]});
  assert.equal(result.status, 'failed');
  assert.equal(result.suiteCount, 2);
  assert.equal(result.caseCount, 3);
  assert.equal(result.passed, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.passRate, 2 / 3);
  assert.deepEqual(calls, [['a', 'a'], ['b', 'b']]);
});

test('rejects invalid benchmark definitions', async () => {
  const engine = new BenchmarkEngine({ evaluationEngine: { run: async () => ({}) } });
  await assert.rejects(() => engine.run({ id: 'empty', suites: [] }), { message: 'Benchmark requires at least one suite' });
  await assert.rejects(() => engine.run({ id: 'duplicate', suites: [{ id: 'x' }, { id: 'x' }] }), { message: 'Benchmark suites require unique ids' });
});
