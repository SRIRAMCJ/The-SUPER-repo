import test from 'node:test';
import assert from 'node:assert/strict';
import { BenchmarkRegressionEngine } from '../src/index.js';

const run = (id, passRate, passed, failed, suites = []) => ({
  type: 'benchmark-run', benchmarkSuiteId: id, caseCount: passed + failed, passed, failed, passRate, status: failed === 0 ? 'succeeded' : 'failed', suites
});

test('compares benchmark runs deterministically and reports suite changes', () => {
  const engine = new BenchmarkRegressionEngine();
  const result = engine.compare(
    run('bench', 0.8, 8, 2, [
      { suiteId: 'b', status: 'failed', passed: 1, failed: 1 },
      { suiteId: 'a', status: 'succeeded', passed: 7, failed: 0 }
    ]),
    run('bench', 0.7, 7, 3, [
      { suiteId: 'b', status: 'failed', passed: 0, failed: 2 },
      { suiteId: 'a', status: 'succeeded', passed: 7, failed: 0 },
      { suiteId: 'c', status: 'failed', passed: 0, failed: 1 }
    ])
  );
  assert.equal(result.status, 'passed');
  assert.ok(Math.abs(result.deltas.passRate + 0.1) < Number.EPSILON);
  assert.equal(result.deltas.failed, 1);
  assert.deepEqual(result.suites.map((suite) => suite.suiteId), ['a', 'b', 'c']);
  assert.equal(result.suites.find((suite) => suite.suiteId === 'b').status, 'changed');
  assert.equal(result.suites.find((suite) => suite.suiteId === 'c').candidatePresent, true);
});

test('fails when regression gates are violated', () => {
  const engine = new BenchmarkRegressionEngine();
  const result = engine.compare(run('bench', 0.9, 9, 1), run('bench', 0.7, 7, 3), {
    minPassRate: 0.8,
    maxPassRateDrop: 0.1,
    maxFailureIncrease: 1
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.violations.map((item) => item.code), ['MIN_PASS_RATE', 'PASS_RATE_DROP', 'FAILURE_INCREASE']);
});

test('rejects mismatched benchmarks and invalid gates', () => {
  const engine = new BenchmarkRegressionEngine();
  const mismatch = engine.compare(run('a', 1, 1, 0), run('b', 1, 1, 0));
  assert.equal(mismatch.error.code, 'BENCHMARK_MISMATCH');
  assert.throws(() => engine.compare(run('a', 1, 1, 0), run('a', 1, 1, 0), { minPassRate: 2 }), { message: 'Benchmark gate minPassRate must be a valid non-negative number' });
});
